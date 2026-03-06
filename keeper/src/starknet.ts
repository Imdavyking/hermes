import { Account, Contract, RpcProvider, uint256 } from "starknet";
import { SwapperFactory, BitcoinNetwork, ToBTCSwap } from "@atomiqlabs/sdk";
import {
  StarknetInitializer,
  StarknetInitializerType,
} from "@atomiqlabs/chain-starknet";
import { Call } from "starknet";
import { config } from "./config";
import abi from "./abis/private_swap.abi.json";
import {
  SqliteStorageManager,
  SqliteUnifiedStorage,
} from "@atomiqlabs/storage-sqlite";

// ── Provider ──────────────────────────────────────────────────────────────────

export const provider = new RpcProvider({
  nodeUrl: config.rpcUrl,
});

// ── Keeper account ────────────────────────────────────────────────────────────
// This wallet only needs STRK for gas. It holds no user funds.

export const account = new Account({
  provider,
  address: config.keeperAddress,
  signer: config.keeperPrivateKey,
});

// ── Contract (read-only — uses provider, not account) ─────────────────────────

export const contract = new Contract({
  abi,
  address: config.contractAddress,
  providerOrAccount: provider,
});

// ── Atomiq constants ──────────────────────────────────────────────────────────

const ATOMIQ_ESCROW_ADDRESS =
  "0x017bf50dd28b6d823a231355bb25813d4396c8e19d2df03026038714a22f0413";
const ESCROW_STATE_SOFT_CLAIMED = 2n;
const ESCROW_STATE_CLAIMED = 3n;
const ESCROW_STATE_REFUNDABLE = 4n;

const ESCROW_STATE_LABEL: Record<string, string> = {
  "1": "COMMITED (in-flight)",
  "2": "SOFT_CLAIMED (payment seen, not yet on-chain)",
  "3": "CLAIMED ✓ — BTC delivered",
  "4": "REFUNDABLE — LP failed",
};

// ── Atomiq swapper (module-level singleton) ───────────────────────────────────
// Initialised once on first use; reused across all keeper ticks.

const factory = new SwapperFactory<[StarknetInitializerType]>([
  StarknetInitializer,
]);
const Tokens = factory.Tokens;

let _swapper: ReturnType<typeof factory.newSwapper> | null = null;

async function getSwapper(): Promise<ReturnType<typeof factory.newSwapper>> {
  if (_swapper) return _swapper;
  _swapper = factory.newSwapper({
    chains: { STARKNET: { rpcUrl: config.rpcUrl } },
    bitcoinNetwork: BitcoinNetwork.TESTNET4,
    swapStorage: (chainId: string) =>
      new SqliteUnifiedStorage(`CHAIN_${chainId}.sqlite3`),
    chainStorageCtor: (name: string) =>
      new SqliteStorageManager(`STORE_${name}.sqlite3`),
  });
  await _swapper.init();
  return _swapper;
}

// ── Atomiq escrow state ───────────────────────────────────────────────────────
//
// Calls IAtomiqEscrowStorage::get_state with the full EscrowData struct so we
// can determine whether an escrow is still in-flight, claimed, or refundable
// before attempting refund_dca_interval on-chain.
//
// EscrowData Cairo ABI order:
//   offerer, claimer, token, refund_handler, claim_handler  — ContractAddress (felt252)
//   flags                                                   — u128
//   claim_data, refund_data                                 — felt252
//   amount                                                  — u256 (low, high)
//   fee_token                                               — ContractAddress (felt252)
//   security_deposit                                        — u256 (low, high)
//   claimer_bounty                                          — u256 (low, high)
//   success_action                                          — Option<EscrowExecution>
//                                                             None  → [0x1]
//                                                             Some  → [0x0, hash, expiry, fee.low, fee.high]
//
// EscrowState return layout: [init_blockheight, finish_blockheight, state]
//   state: 1=COMMITED, 2=SOFT_CLAIMED, 3=CLAIMED, 4=REFUNDABLE

function serializeSuccessAction(successAction: {
  Some: unknown;
  None: boolean;
}): string[] {
  if (successAction.None) {
    return ["0x1"];
  }
  const exec = successAction.Some as {
    hash: bigint;
    expiry: bigint;
    fee: bigint;
  };
  return [
    "0x0",
    exec.hash.toString(),
    exec.expiry.toString(),
    (exec.fee & 0xffffffffffffffffffffffffffffffffn).toString(),
    (exec.fee >> 128n).toString(),
  ];
}

async function getAtomiqEscrowState(
  escrow: Record<string, unknown>,
): Promise<bigint> {
  const successAction = escrow.success_action as {
    Some: unknown;
    None: boolean;
  };

  const calldata = [
    escrow.offerer,
    escrow.claimer,
    escrow.token,
    escrow.refund_handler,
    escrow.claim_handler,
    escrow.flags,
    escrow.claim_data,
    escrow.refund_data,
    // u256 amount: low, high
    (
      BigInt(escrow.amount as bigint) & 0xffffffffffffffffffffffffffffffffn
    ).toString(),
    (BigInt(escrow.amount as bigint) >> 128n).toString(),
    escrow.fee_token,
    // u256 security_deposit: low, high
    (
      BigInt(escrow.security_deposit as bigint) &
      0xffffffffffffffffffffffffffffffffn
    ).toString(),
    (BigInt(escrow.security_deposit as bigint) >> 128n).toString(),
    // u256 claimer_bounty: low, high
    (
      BigInt(escrow.claimer_bounty as bigint) &
      0xffffffffffffffffffffffffffffffffn
    ).toString(),
    (BigInt(escrow.claimer_bounty as bigint) >> 128n).toString(),
    // Option<EscrowExecution>
    ...serializeSuccessAction(successAction),
  ].map(String);

  const raw = await provider.callContract({
    contractAddress: ATOMIQ_ESCROW_ADDRESS,
    entrypoint: "get_state",
    calldata,
  });

  const [_init_blockheight, _finish_blockheight, state] =
    raw as unknown as string[];

  console.log(
    `    Atomiq escrow state: ${state} — ${ESCROW_STATE_LABEL[state.toString()] ?? "unknown"}`,
  );

  return BigInt(state);
}

// ── Shared Atomiq quote builder ───────────────────────────────────────────────
//
// Fetches an Atomiq STRK→BTC quote for a given strk amount and btc destination,
// and returns the fully-formed execute_dca Call array.

async function buildAtomiqCalls(
  orderId: string,
  orderIdU256: ReturnType<typeof uint256.bnToUint256>,
  strkAmountBn: bigint,
  btcDestination: string,
  entrypoint: "execute_dca",
): Promise<Call[] | null> {
  const sdk = await getSwapper();

  const swap = (await sdk.swap(
    Tokens.STARKNET.STRK,
    Tokens.BITCOIN.BTC,
    strkAmountBn,
    true,
    config.contractAddress,
    btcDestination,
  )) as ToBTCSwap<any>;

  const txns = await swap.txsCommit();

  const invoke = txns.find((t: any) => t.type === "INVOKE");
  if (!invoke)
    throw new Error(`Order ${orderId}: no INVOKE tx in Atomiq calldata`);

  const innerCalls: any[] = invoke.tx;
  const initializeTx = innerCalls.find(
    (c: any) => c.entrypoint === "initialize",
  );
  if (!initializeTx)
    throw new Error(
      `Order ${orderId}: no 'initialize' call in Atomiq calldata`,
    );

  return [
    {
      contractAddress: config.contractAddress,
      entrypoint,
      calldata: [
        orderIdU256.low.toString(),
        orderIdU256.high.toString(),
        ...initializeTx.calldata,
      ],
    },
  ];
}

// ── getExecutePayload ─────────────────────────────────────────────────────────
//
// Checks whether a DCA order is due on-chain via checker(), fetches a fresh
// Atomiq STRK→BTC quote, and returns the fully-formed execute_dca Call array.
//
// Returns null if:
//   - checker() reports the order is not yet due (includes pending-refund guard)
//   - the order has no BTC destination stored
//   - the Atomiq quote or calldata cannot be obtained

export async function getExecutePayload(
  orderId: string,
): Promise<Call[] | null> {
  try {
    const orderIdU256 = uint256.bnToUint256(BigInt(orderId));

    const [canExec, { strk_amount }] = (await contract.call(
      "checker",
      [orderIdU256],
      {
        blockIdentifier: "latest",
      },
    )) as [boolean, { strk_amount: bigint }];

    if (!canExec) return null;

    if (strk_amount === 0n) {
      console.warn(
        `Order ${orderId}: checker returned strk_amount=0 — skipping`,
      );
      return null;
    }

    const btcDestination = (await contract.call(
      "get_dca_btc_destination",
      [orderIdU256],
      { blockIdentifier: "latest" },
    )) as string;

    if (!btcDestination) {
      console.warn(`Order ${orderId}: no BTC destination stored — skipping`);
      return null;
    }

    return buildAtomiqCalls(
      orderId,
      orderIdU256,
      strk_amount,
      btcDestination,
      "execute_dca",
    );
  } catch (err) {
    console.warn(`getExecutePayload failed for order ${orderId}:`, err);
    return null;
  }
}

// ── getRefundPayload ──────────────────────────────────────────────────────────
//
// Checks whether an order has a pending Atomiq escrow that has settled
// (claimed or refundable) and returns a refund_dca_interval Call if so.
//
// Uses IAtomiqEscrowStorage::get_state as the authoritative check — not
// wall-clock expiry — so we only submit the on-chain tx when it will succeed.
//
// Returns null if:
//   - no pending escrow exists for the order
//   - the escrow is still in-flight (state 1 or 2)

export async function getRefundPayload(orderId: string): Promise<Call | null> {
  try {
    const orderIdU256 = uint256.bnToUint256(BigInt(orderId));

    const needsRefund = (await contract.call(
      "dca_interval_needs_refund",
      [orderIdU256],
      { blockIdentifier: "latest" },
    )) as boolean;

    if (!needsRefund) return null;

    const escrow = (await contract.call(
      "get_dca_pending_escrow",
      [orderIdU256],
      { blockIdentifier: "latest" },
    )) as Record<string, unknown>;

    const state = await getAtomiqEscrowState(escrow);

    if (
      state !== ESCROW_STATE_SOFT_CLAIMED &&
      state !== ESCROW_STATE_CLAIMED &&
      state !== ESCROW_STATE_REFUNDABLE
    ) {
      console.log(
        `  Order ${orderId}: escrow still in-flight — skipping refund this tick`,
      );
      return null;
    }

    return {
      contractAddress: config.contractAddress,
      entrypoint: "refund_dca_interval",
      calldata: [orderIdU256.low.toString(), orderIdU256.high.toString()],
    };
  } catch (err) {
    console.warn(`getRefundPayload failed for order ${orderId}:`, err);
    return null;
  }
}
