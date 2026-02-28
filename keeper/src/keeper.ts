import { account, getExecutePayload } from "./starknet";
import { fetchActiveOrders, ActiveDcaOrder } from "./apollo";
import { config } from "./config";
import { Call } from "starknet";

// ── Helpers ───────────────────────────────────────────────────────────────────

function isDue(order: ActiveDcaOrder, now: number): boolean {
  const lastExecution = Number(order.last_execution);
  const intervalSeconds = Number(order.interval_seconds);
  const executedIntervals = Number(order.executed_intervals);
  const totalIntervals = Number(order.total_intervals);

  // Indexer is eventually consistent — double-check completion locally
  // before hitting the RPC checker.
  if (executedIntervals >= totalIntervals) return false;

  return now >= lastExecution + intervalSeconds;
}

// ── Core run ──────────────────────────────────────────────────────────────────

export async function runKeeper(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  console.log(`[${new Date().toISOString()}] Keeper tick`);

  // 1. Fetch all active orders from the indexer.
  let allOrders: ActiveDcaOrder[];
  try {
    allOrders = await fetchActiveOrders();
  } catch (err) {
    console.error("Failed to fetch orders from indexer:", err);
    return;
  }

  console.log(`  Active orders in indexer: ${allOrders.length}`);

  // 2. Filter to those whose interval has elapsed (cheap, off-chain).
  //    This avoids hitting the RPC for every single active order on every tick.
  const candidates = allOrders.filter((o) => isDue(o, now) || true);
  console.log(`  Candidates due for execution: ${candidates.length}`);

  const call = await getExecutePayload("1");
  console.log({ call });

  if (candidates.length === 0) return;

  // 3. Confirm each candidate on-chain via checker() and collect the payload.
  //    Guards against indexer lag and race conditions — checker() is the
  //    contract's own source of truth for whether an order is executable.
  //    null means the order was skipped (already executed, inactive, etc).
  const calls = (
    await Promise.all(
      candidates.map(async (o) => {
        const call = await getExecutePayload(o.id);
        if (!call)
          console.log(`  Order ${o.id} skipped (checker returned false)`);
        return call;
      }),
    )
  ).filter((call): call is Call => call !== null);

  console.log(`  Confirmed on-chain: ${calls.length}`);

  if (calls.length === 0) return;

  // 4. Chunk into batches and submit.
  //    Starknet multicall is a first-class primitive — one tx, one gas payment.
  //    We cap batch size to avoid hitting block gas limits.
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
      console.log({ chunk });
      await account.estimateInvokeFee(chunk);
      const tx = await account.execute(chunk);
      console.log(`  Batch ${i + 1} submitted: ${tx.transaction_hash}`);

      const receipt = await account.waitForTransaction(tx.transaction_hash);
      if (receipt.isSuccess()) {
        console.log(`  Batch ${i + 1} confirmed ✓`);
      } else {
        // Individual reverts inside a multicall cause the whole tx to revert.
        // Log and continue — the next tick will retry any still-due orders.
        console.error(`  Batch ${i + 1} reverted. Receipt:`, receipt);
      }
    } catch (err: any) {
      const executionError =
        err?.baseError?.data?.execution_error?.error?.error?.error ??
        err?.baseError?.data?.execution_error?.error ??
        err?.message ??
        err?.error?.error ??
        String(err);
      console.error(`  Batch ${i + 1} failed to submit:`, executionError);
      // Do not rethrow — a single failed batch should not stop the keeper loop.
    }
  }
}
