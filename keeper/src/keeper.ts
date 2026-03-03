import { account, getExecutePayload } from "./starknet";
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

  // 2. Filter to those whose interval has elapsed (cheap, off-chain).
  const candidates = allOrders.filter((o) => isDue(o, now));
  console.log(`  Candidates due for execution: ${candidates.length}`);

  if (candidates.length === 0) return;

  // 3. For each candidate: confirm on-chain via checker() and fetch the
  //    Atomiq quote to build the execute_dca calldata.
  //    getExecutePayload returns null if the order was already executed,
  //    is no longer active, or the Atomiq quote failed.
  const calls = (
    await Promise.all(
      candidates.map(async (o) => {
        const call = await getExecutePayload(o.id);
        if (!call) {
          console.log(`  Order ${o.id} skipped (not due or quote failed)`);
        }
        return call;
      }),
    )
  ).filter((call): call is Call => call !== null);

  console.log(`  Confirmed on-chain and quoted: ${calls.length}`);

  if (calls.length === 0) return;

  // 4. Chunk into batches and submit as Starknet multicalls.
  //    One tx per batch — one gas payment covers all execute_dca calls.
  //    Batch size is capped to avoid hitting block gas limits.
  const chunks: Call[][] = [];
  for (let i = 0; i < calls.length; i += config.maxBatchSize) {
    chunks.push(calls.slice(i, i + config.maxBatchSize));
  }

  console.log(
    `  Submitting ${chunks.length} batch(es) of up to ${config.maxBatchSize} calls`,
  );

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`  Batch ${i + 1}/${chunks.length}: ${chunk.length} call(s)`);

    try {
      // Dry-run first — surfaces fee estimation errors before broadcasting.
      await account.estimateInvokeFee(chunk);

      const tx = await account.execute(chunk);
      console.log(`  Batch ${i + 1} submitted: ${tx.transaction_hash}`);

      const receipt = await account.waitForTransaction(tx.transaction_hash);
      if (receipt.isSuccess()) {
        console.log(`  Batch ${i + 1} confirmed ✓`);
      } else {
        // Individual reverts inside a multicall revert the entire tx.
        // Log and continue — still-due orders will be retried on the next tick.
        console.error(`  Batch ${i + 1} reverted. Receipt:`, receipt);
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

      console.error(`  Batch ${i + 1} failed to submit:`, executionError);
      // Do not rethrow — a failed batch should not stop the keeper loop.
    }
  }
}
