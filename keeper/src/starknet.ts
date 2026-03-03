import { Account, Contract, RpcProvider, uint256 } from "starknet";
import {
  SwapperFactory,
  fromHumanReadableString,
  MempoolBitcoinRpc,
  BitcoinNetwork,
  ToBTCSwap,
} from "@atomiqlabs/sdk";
import {
  StarknetInitializer,
  StarknetInitializerType,
  StarknetSigner,
} from "@atomiqlabs/chain-starknet";
import { Call } from "starknet";
import { config } from "./config";
import abi from "./abis/private_swap.abi.json";

// ── Provider ──────────────────────────────────────────────────────────────────

export const provider = new RpcProvider({
  nodeUrl: config.rpcUrl,
});

// ── Keeper account ────────────────────────────────────────────────────────────
// This wallet only needs STRK for gas. It holds no user funds.

export const account = new Account(
  provider,
  config.keeperAddress,
  config.keeperPrivateKey,
);

// ── Contract (read-only — uses provider, not account) ─────────────────────────

export const contract = new Contract(abi, config.contractAddress, provider);

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
    bitcoinNetwork: BitcoinNetwork.TESTNET,
    bitcoinRpc: new MempoolBitcoinRpc("https://mempool.space/testnet/api/"),
  });
  await _swapper.init();
  return _swapper;
}

// ── Atomiq calldata parser ────────────────────────────────────────────────────
//
// Parses the EscrowData fields from an Atomiq `initialize` calldata array.
//
// Starknet serialization layout (0-indexed):
//   [0]  offerer
//   [1]  claimer
//   [2]  token
//   [3]  refund_handler
//   [4]  claim_handler
//   [5]  flags
//   [6]  claim_data      ← payment hash
//   [7]  refund_data     ← expiry as felt252
//   [8]  amount.low
//   [9]  amount.high
//   [10] fee_token
//   [11] security_deposit.low
//   [12] security_deposit.high
//   [13] claimer_bounty.low
//   [14] claimer_bounty.high
//   [15] success_action discriminant (0 = None)
//   [16] sig_len
//   [17..17+sig_len-1] signature felts

interface ParsedAtomiqCalldata {
  paymentHash: string; // felt252 hex string
  expiry: string; // felt252 hex string
  flags: string; // u128 hex string
  strkAmount: bigint; // amount.low (amount.high assumed 0 for realistic DCA sizes)
  signatureStart: number; // index of sig_len field
}

function parseAtomiqCalldata(calldata: string[]): ParsedAtomiqCalldata {
  return {
    flags: calldata[5],
    paymentHash: calldata[6],
    expiry: calldata[7],
    strkAmount: BigInt(calldata[8]),
    signatureStart: 16,
  };
}

// ── getExecutePayload ─────────────────────────────────────────────────────────
//
// Checks whether a DCA order is due on-chain, fetches a fresh Atomiq STRK→BTC
// quote, and returns the fully-formed `execute_dca` Call object.
//
// Returns null if:
//   - checker() reports the order is not yet due
//   - the order has no BTC destination stored
//   - the Atomiq quote or calldata cannot be obtained
//
// The keeper calls this for every candidate order and submits all non-null
// results in a single multicall transaction.

export async function getExecutePayload(orderId: string): Promise<Call | null> {
  try {
    const orderIdU256 = uint256.bnToUint256(BigInt(orderId));

    // 1. Confirm the order is due on-chain (source of truth).
    //    Guards against indexer lag and concurrent execution by another keeper.
    const checkerResult = (await contract.call("checker", [orderIdU256], {
      blockIdentifier: "latest",
    })) as [boolean, unknown];

    if (!checkerResult[0]) return null;

    // 2. Read the user's Bitcoin destination address from contract storage.
    const btcDestination = (await contract.call(
      "get_dca_btc_destination",
      [orderIdU256],
      { blockIdentifier: "latest" },
    )) as string;

    if (!btcDestination) {
      console.warn(`Order ${orderId}: no BTC destination stored — skipping`);
      return null;
    }

    // 3. Fetch an Atomiq STRK → BTC quote for the user's Bitcoin address.
    //    The contract address is the offerer — it must hold the STRK.
    //    strkPerInterval from config controls how much STRK is committed each tick.
    const sdk = await getSwapper();

    const amount = fromHumanReadableString(
      config.strkPerInterval,
      Tokens.STARKNET.STRK,
    );
    if (!amount) throw new Error("Invalid strkPerInterval in config");

    const swap = (await sdk.swap(
      Tokens.STARKNET.STRK,
      Tokens.BITCOIN.BTC,
      amount,
      true, // exactIn — spend exactly `amount` STRK
      config.contractAddress, // offerer: the PrivateSwap contract holds the STRK
      btcDestination, // recipient: user's Bitcoin address
    )) as ToBTCSwap<unknown>;

    // 4. Obtain the commit transaction(s) from the Atomiq SDK.
    const txns = await swap.txsCommit();
    const initializeTx = txns.find(
      (t: { type: string; tx: { entrypoint: string } }) =>
        t.type === "INVOKE" && t.tx.entrypoint === "initialize",
    );
    if (!initializeTx) {
      throw new Error(
        `Order ${orderId}: no 'initialize' tx in Atomiq calldata`,
      );
    }

    const rawCalldata: string[] = (
      initializeTx as { tx: { calldata: string[] } }
    ).tx.calldata;

    const parsed = parseAtomiqCalldata(rawCalldata);

    // 5. Extract the LP signature — Array<felt252> serialized as [length, ...felts].
    const sigLenIndex = parsed.signatureStart;
    const sigLen = parseInt(rawCalldata[sigLenIndex], 10);
    const signature = rawCalldata.slice(
      sigLenIndex + 1,
      sigLenIndex + 1 + sigLen,
    );

    // 6. Build the execute_dca calldata.
    //    Starknet serializes u256 as (low, high) and Array<felt252> as (len, ...elems).
    const strkAmountU256 = uint256.bnToUint256(parsed.strkAmount);

    return {
      contractAddress: config.contractAddress,
      entrypoint: "execute_dca",
      calldata: [
        orderIdU256.low.toString(),
        orderIdU256.high.toString(),
        strkAmountU256.low.toString(),
        strkAmountU256.high.toString(),
        parsed.paymentHash,
        parsed.expiry,
        parsed.flags,
        sigLen.toString(),
        ...signature,
      ],
    };
  } catch (err) {
    console.warn(`getExecutePayload failed for order ${orderId}:`, err);
    return null;
  }
}
