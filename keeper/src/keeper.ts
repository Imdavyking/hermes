import { account, getExecutePayload, getRefundPayload } from "./starknet";
import { fetchActiveOrders, ActiveDcaOrder } from "./apollo";
import { config } from "./config";
import { Call } from "starknet";

// ── Helpers ───────────────────────────────────────────────────────────────────

// Cheap off-chain pre-filter: returns true if the interval has elapsed
// according to the indexer's last-known state.
//
// This avoids calling checker() for every active order on every tick.
// The on-chain checker() call inside getExecutePayload() is the authoritative
// guard — this is purely an optimisation to reduce RPC traffic.
function isDue(order: ActiveDcaOrder, now: number): boolean {
  const lastExecution = Number(order.last_execution);
  const intervalSeconds = Number(order.interval_seconds);
  const executedIntervals = Number(order.executed_intervals);
  const totalIntervals = Number(order.total_intervals);

  // Indexer is eventually consistent — guard against stale completion data.
  if (executedIntervals >= totalIntervals) return false;

  return now >= lastExecution + intervalSeconds;
}

// submitBatch
// ─────────────────────────────────────────────────────────────────────────────
// Dry-runs a set of calls via estimateInvokeFee, then submits and waits for
// the transaction receipt. Returns true on success, false on any failure.
// Does not throw — all errors are logged and the keeper loop continues.

async function submitBatch(calls: Call[], label: string): Promise<boolean> {
  try {
    await account.estimateInvokeFee(calls);

    const tx = await account.execute(calls);
    console.log(`  ${label} submitted: ${tx.transaction_hash}`);

    const receipt = await account.waitForTransaction(tx.transaction_hash);
    if (receipt.isSuccess()) {
      console.log(`  ${label} confirmed ✓`);
      return true;
    } else {
      console.error(`  ${label} reverted. Receipt:`, receipt);
      return false;
    }
  } catch (err: unknown) {
    // Unwrap the Starknet execution error chain for a readable message.
    const executionError =
      (
        err as {
          baseError?: {
            data?: {
              execution_error?: { error?: { error?: { error?: string } } };
            };
          };
        }
      )?.baseError?.data?.execution_error?.error?.error?.error ??
      (
        err as {
          baseError?: { data?: { execution_error?: { error?: string } } };
        }
      )?.baseError?.data?.execution_error?.error ??
      (err as { message?: string })?.message ??
      String(err);

    console.error(`  ${label} failed to submit:`, executionError);
    return false;
  }
}

// ── Core run ──────────────────────────────────────────────────────────────────

export async function runKeeper(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  console.log(`[${new Date().toISOString()}] Keeper tick`);

  // 1. Fetch all active DCA orders from the indexer.
  let allOrders: ActiveDcaOrder[];
  try {
    allOrders = await fetchActiveOrders();
  } catch (err) {
    console.error("Failed to fetch orders from indexer:", err);
    return;
  }

  console.log(`  Active orders in indexer: ${allOrders.length}`);

  // ── Pass 1: Refund settled Atomiq escrows ─────────────────────────────────
  //
  // Before trying to execute new intervals we check every active order for a
  // pending settled escrow. getRefundPayload calls IAtomiqEscrowStorage::get_state
  // to determine whether the escrow is settled (claimed or refundable):
  //
  //   state 3 (CLAIMED):    LP delivered BTC — clear the pending flag so the
  //                         next interval can execute. No rollback.
  //
  //   state 4 (REFUNDABLE): LP failed — roll back the interval counter and
  //                         reclaim STRK. Keeper retries automatically.
  //
  //   state 1/2 (in-flight): skip — nothing to do yet, retry next tick.
  //
  // Refund calls are batched into a single tx to minimise gas overhead.
  //
  // Why refund BEFORE execute?
  //   If we executed first, orders with a pending refund would be blocked by
  //   the DCA_INTERVAL_PENDING guard and skipped for the entire tick, delaying
  //   the user's DCA by a full interval period unnecessarily. After a
  //   successful refund (especially a rollback), the order becomes immediately
  //   eligible for re-execution in Pass 2 of the same tick.
  //
  // If the refund tx reverts we skip Pass 2 entirely — on-chain state may be
  // inconsistent and retrying execute could double-spend. We'll reassess on
  // the next tick once the indexer has caught up.

  console.log("  Pass 1: scanning for settled escrows to refund...");

  const refundCalls = (
    await Promise.all(
      allOrders.map(async (o) => {
        const call = await getRefundPayload(o.id);
        if (call) {
          console.log(
            `  Order ${o.id}: settled escrow detected — queuing refund`,
          );
        }
        return call;
      }),
    )
  ).filter((c): c is Call => c !== null);

  if (refundCalls.length > 0) {
    console.log(
      `  Submitting ${refundCalls.length} refund call(s) in a single tx...`,
    );

    const refundOk = await submitBatch(refundCalls, "Refund batch");

    if (!refundOk) {
      // A failed refund batch means on-chain state is uncertain.
      // Skip the execute pass entirely this tick — we'll retry next tick
      // once the indexer has caught up and we can reassess each order.
      console.error(
        "  Refund batch failed — skipping execute pass this tick for safety.",
      );
      return;
    }
  } else {
    console.log("  No settled escrows found.");
  }

  // ── Pass 2: Execute due intervals ────────────────────────────────────────
  //
  // Filter to candidates whose interval has elapsed (cheap, off-chain pre-filter).
  // The authoritative on-chain check (checker()) happens inside getExecutePayload().
  // After a successful refund pass above, previously-blocked orders will now
  // pass checker() and appear in this list.

  console.log("  Pass 2: scanning for intervals due for execution...");

  const candidates = allOrders.filter((o) => isDue(o, now));
  console.log(`  Candidates due for execution: ${candidates.length}`);

  if (candidates.length === 0) return;

  // For each candidate: confirm on-chain via checker() and fetch an Atomiq
  // quote to build the execute_dca calldata. Returns null if skipped.
  const calls = (
    await Promise.all(
      candidates.map(async (o) => {
        const calls = await getExecutePayload(o.id);
        if (!calls) {
          console.log(`  Order ${o.id} skipped (not due or quote failed)`);
        }
        return calls;
      }),
    )
  )
    .filter((calls): calls is Call[] => calls !== null)
    .flat();

  console.log(`  Confirmed on-chain and quoted: ${calls.length}`);

  if (calls.length === 0) return;

  // Chunk into batches and submit as Starknet multicalls.
  // One tx per batch — one gas payment covers all execute_dca calls.
  // Batch size is capped to avoid hitting block gas limits.
  const chunks: Call[][] = [];
  for (let i = 0; i < calls.length; i += config.maxBatchSize) {
    chunks.push(calls.slice(i, i + config.maxBatchSize));
  }

  console.log(
    `  Submitting ${chunks.length} execute batch(es) of up to ${config.maxBatchSize} calls`,
  );

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(
      `  Execute batch ${i + 1}/${chunks.length}: ${chunk.length} call(s)`,
    );

    // A failed execute batch is non-fatal — still-due orders will be retried
    // on the next tick. We do NOT return early here so remaining batches still
    // get a chance to submit.
    await submitBatch(chunk, `Execute batch ${i + 1}/${chunks.length}`);
  }
}
