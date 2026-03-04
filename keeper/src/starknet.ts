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

export function parseAtomiqCalldata(calldata: string[]): any {
  const sigLenIndex = 16;
  const sigLen = parseInt(calldata[sigLenIndex], 10);
  const signature = calldata.slice(sigLenIndex + 1, sigLenIndex + 1 + sigLen);

  return {
    escrow: {
      offerer: `0x${BigInt(calldata[0]).toString(16)}`,
      claimer: `0x${BigInt(calldata[1]).toString(16)}`,
      token: `0x${BigInt(calldata[2]).toString(16)}`,
      refund_handler: `0x${BigInt(calldata[3]).toString(16)}`,
      claim_handler: `0x${BigInt(calldata[4]).toString(16)}`,
      flags: calldata[5],
      claim_data: calldata[6],
      refund_data: calldata[7],
      amount: { low: calldata[8], high: calldata[9] },
      fee_token: `0x${BigInt(calldata[10]).toString(16)}`,
      security_deposit: { low: calldata[11], high: calldata[12] },
      claimer_bounty: { low: calldata[13], high: calldata[14] },
      success_action: calldata[15],
    },
    signature,
    timeout: calldata[sigLenIndex + sigLen + 1],
    extra_data: calldata[sigLenIndex + sigLen + 2],
  };
}

export async function getExecuteNowPayload(
  orderId: string,
): Promise<Call[] | null> {
  try {
    const orderIdU256 = uint256.bnToUint256(BigInt(orderId));

    // Skip checker() — execute_dca_now bypasses the interval check.
    // We still need the oracle-priced strk_amount so fetch the DCA order
    // and compute it manually here.
    const order = (await contract.call("get_dca_order", [orderIdU256], {
      blockIdentifier: "latest",
    })) as { usdc_per_interval: { low: string; high: string } };

    const [strkUsd, strkDec] = (await contract.call("get_strk_usd_price", [], {
      blockIdentifier: "latest",
    })) as [{ low: string; high: string }, string];

    const STRK_PRECISION = 10n ** 18n;
    const USDC_PRECISION = 10n ** 6n;
    const usdcPerInterval =
      BigInt(order.usdc_per_interval.low) +
      BigInt(order.usdc_per_interval.high) * 2n ** 128n;
    const strkUsdBn = BigInt(strkUsd.low) + BigInt(strkUsd.high) * 2n ** 128n;
    const strkDecBn = BigInt(strkDec);
    const strkAmountBn =
      (usdcPerInterval * STRK_PRECISION * 10n ** strkDecBn) /
      (strkUsdBn * USDC_PRECISION);

    const btcDestination = (await contract.call(
      "get_dca_btc_destination",
      [orderIdU256],
      { blockIdentifier: "latest" },
    )) as string;

    if (!btcDestination) {
      console.warn(`Order ${orderId}: no BTC destination stored — skipping`);
      return null;
    }

    const sdk = await getSwapper();

    const swap = (await sdk.swap(
      Tokens.STARKNET.STRK,
      Tokens.BITCOIN.BTC,
      strkAmountBn,
      true,
      config.keeperAddress,
      btcDestination,
    )) as ToBTCSwap<any>;

    const txns = await swap.txsCommit();

    const approveTx = txns.find(
      (t: { type: string; tx: { entrypoint: string } }) =>
        t.type === "INVOKE" && t.tx.entrypoint === "approve",
    );

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

    const calls: Call[] = [];

    if (approveTx) {
      calls.push({
        contractAddress: (approveTx as { tx: { contractAddress: string } }).tx
          .contractAddress,
        entrypoint: "approve",
        calldata: (approveTx as { tx: { calldata: string[] } }).tx.calldata,
      });
    }

    calls.push({
      contractAddress: config.contractAddress,
      entrypoint: "execute_dca_now", // ← only difference
      calldata: [
        orderIdU256.low.toString(),
        orderIdU256.high.toString(),
        ...rawCalldata,
      ],
    });

    return calls;
  } catch (err) {
    console.warn(`getExecuteNowPayload failed for order ${orderId}:`, err);
    return null;
  }
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
export async function getExecutePayload(
  orderId: string,
): Promise<Call[] | null> {
  try {
    const orderIdU256 = uint256.bnToUint256(BigInt(orderId));

    const checkerResult = (await contract.call("checker", [orderIdU256], {
      blockIdentifier: "latest",
    })) as [boolean, { strk_amount: { low: string; high: string } }];

    if (!checkerResult[0]) return null;

    const strkAmountBn =
      BigInt(checkerResult[1].strk_amount.low) +
      BigInt(checkerResult[1].strk_amount.high) * 2n ** 128n;

    if (strkAmountBn === 0n) {
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

    const sdk = await getSwapper();

    const swap = (await sdk.swap(
      Tokens.STARKNET.STRK,
      Tokens.BITCOIN.BTC,
      strkAmountBn,
      true,
      config.keeperAddress,
      btcDestination,
    )) as ToBTCSwap<any>;

    const txns = await swap.txsCommit();

    // Extract approve tx (STRK → Atomiq escrow)
    const approveTx = txns.find(
      (t: { type: string; tx: { entrypoint: string } }) =>
        t.type === "INVOKE" && t.tx.entrypoint === "approve",
    );

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

    const calls: Call[] = [];

    // Include approve if present
    if (approveTx) {
      calls.push({
        contractAddress: (approveTx as { tx: { contractAddress: string } }).tx
          .contractAddress,
        entrypoint: "approve",
        calldata: (approveTx as { tx: { calldata: string[] } }).tx.calldata,
      });
    }

    calls.push({
      contractAddress: config.contractAddress,
      entrypoint: "execute_dca",
      calldata: [
        orderIdU256.low.toString(),
        orderIdU256.high.toString(),
        ...rawCalldata,
      ],
    });

    return calls;
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
