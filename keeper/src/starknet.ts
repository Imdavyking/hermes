import { Account, Contract, RpcProvider, uint256 } from "starknet";
import { SwapperFactory, BitcoinNetwork, ToBTCSwap } from "@atomiqlabs/sdk";
import {
  StarknetInitializer,
  StarknetInitializerType,
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
  expiry: string; // felt252 hex string — also the Atomiq escrow timeout
  flags: string; // u128 hex string
  strkAmount: bigint; // amount.low (amount.high assumed 0 for realistic DCA sizes)
  signatureStart: number;
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
// The STRK amount to swap comes from checker()'s payload.strk_amount — the
// contract computes it on-chain as the live oracle-priced STRK equivalent of
// the order's usdc_per_interval (STRK/USD Pragma feed only, BTC cancels out):
//
//   strk_amount = usdc_per_interval * STRK_PRECISION * 10^strk_dec
//                 / (strk_usd * USDC_PRECISION)
//
// This means the keeper never needs to replicate oracle math or hold a
// hardcoded config value for the per-interval STRK amount.
//
// Returns null if:
//   - checker() reports the order is not yet due (includes pending-refund guard)
//   - the order has no BTC destination stored
//   - the Atomiq quote or calldata cannot be obtained

export async function getExecutePayload(orderId: string): Promise<Call | null> {
  try {
    const orderIdU256 = uint256.bnToUint256(BigInt(orderId));

    // 1. Confirm the order is due on-chain (source of truth).
    //    checker() returns false when dca_interval_needs_refund is set, so we
    //    don't need a separate pending-refund check here.
    //    payload.strk_amount is the live STRK equivalent of usdc_per_interval;
    //    it is non-zero only when can_exec is true.
    const checkerResult = (await contract.call("checker", [orderIdU256], {
      blockIdentifier: "latest",
    })) as [boolean, { strk_amount: { low: string; high: string } }];

    if (!checkerResult[0]) return null;

    // Reconstruct the u256 strk_amount from the low/high felts returned by
    // the Cairo ExecPayload struct.
    const strkAmountBn =
      BigInt(checkerResult[1].strk_amount.low) +
      BigInt(checkerResult[1].strk_amount.high) * 2n ** 128n;

    if (strkAmountBn === 0n) {
      // Defensive: checker should never return can_exec=true with amount=0,
      // but bail out here rather than sending a zero-value swap to Atomiq.
      console.warn(
        `Order ${orderId}: checker returned strk_amount=0 — skipping`,
      );
      return null;
    }

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

    // 3. Fetch an Atomiq STRK → BTC quote using the on-chain STRK amount.
    //    The SDK accepts a bigint denominated in the token's base unit (wei for
    //    STRK, i.e. 10^-18). strkAmountBn is already in that unit because the
    //    contract arithmetic uses STRK_PRECISION = 10^18.
    const sdk = await getSwapper();

    const swap = (await sdk.swap(
      Tokens.STARKNET.STRK,
      Tokens.BITCOIN.BTC,
      strkAmountBn, // exactIn, base-unit bigint
      true,
      config.contractAddress,
      btcDestination,
    )) as ToBTCSwap<any>;

    // 4. Extract the `initialize` transaction from the Atomiq SDK.
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

    // 5. Extract the LP signature.
    const sigLenIndex = parsed.signatureStart;
    const sigLen = parseInt(rawCalldata[sigLenIndex], 10);
    const signature = rawCalldata.slice(
      sigLenIndex + 1,
      sigLenIndex + 1 + sigLen,
    );

    // 6. Build the execute_dca calldata.
    //    Use the amount the SDK actually quoted (parsed from Atomiq calldata)
    //    rather than strkAmountBn — the SDK may have adjusted it slightly for
    //    fees or rounding, and the escrow must match exactly.
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

// ── getRefundPayload ──────────────────────────────────────────────────────────
//
// Checks whether an order has a stale Atomiq escrow that needs to be refunded
// (i.e. the LP never sent BTC and the escrow timeout has elapsed).
//
// Returns a `refund_dca_interval` Call if:
//   - dca_interval_needs_refund is true for the order
//   - the stored escrow's expiry (refund_data) has elapsed
//
// Returns null if:
//   - no pending escrow exists
//   - the escrow expiry has not yet elapsed (too early to refund)
//
// The keeper calls this in a first pass before getExecutePayload() so that
// rolled-back intervals are immediately eligible for re-execution in the
// same keeper tick.

export async function getRefundPayload(orderId: string): Promise<Call | null> {
  try {
    const orderIdU256 = uint256.bnToUint256(BigInt(orderId));

    // 1. Check whether this order has a pending failed interval.
    const needsRefund = (await contract.call(
      "dca_interval_needs_refund",
      [orderIdU256],
      { blockIdentifier: "latest" },
    )) as boolean;

    if (!needsRefund) return null;

    // 2. Read the stored pending escrow to check its expiry.
    //    The contract's get_dca_pending_escrow() view derives the storage key
    //    from order_id and the stored pending interval index.
    const escrow = (await contract.call(
      "get_dca_pending_escrow",
      [orderIdU256],
      { blockIdentifier: "latest" },
    )) as {
      refund_data: string; // felt252 — the Atomiq escrow expiry timestamp
      amount: { low: string; high: string };
    };

    // refund_data was written as expiry.into() in execute_dca(),
    // so it is the Unix timestamp after which Atomiq::refund() is callable.
    const expirySeconds = BigInt(escrow.refund_data);
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));

    if (nowSeconds < expirySeconds) {
      const remaining = expirySeconds - nowSeconds;
      console.log(
        `Order ${orderId}: escrow not yet expired (${remaining}s remaining — skipping refund)`,
      );
      return null;
    }

    // 3. Build the refund_dca_interval calldata.
    //    The contract reads the stored escrow itself — we only need order_id.
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
