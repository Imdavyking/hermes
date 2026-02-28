import { account, buildExecuteCall, isOrderDue } from "./starknet";
import { fetchActiveOrders, ActiveDcaOrder } from "./apollo";
import { config } from "./config";

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
  const candidates = allOrders.filter((o) => isDue(o, now));
  console.log(`  Candidates due for execution: ${candidates.length}`);

  if (candidates.length === 0) return;

  // 3. Confirm each candidate on-chain via checker() to guard against:
  //    - Indexer lag (order was already executed by another keeper)
  //    - Race conditions between query and tx submission
  const confirmed = (
    await Promise.all(
      candidates.map(async (o) => {
        const due = await isOrderDue(o.id);
        if (!due) {
          console.log(`  Order ${o.id} skipped (checker returned false)`);
        }
        return due ? o : null;
      })
    )
  ).filter((o): o is ActiveDcaOrder => o !== null);

  console.log(`  Confirmed on-chain: ${confirmed.length}`);

  if (confirmed.length === 0) return;

  // 4. Build execute_dca calls and chunk into batches.
  //    Starknet multicall is a first-class primitive — one tx, one gas payment.
  //    We cap batch size to avoid hitting block gas limits.
  const chunks: ActiveDcaOrder[][] = [];
  for (let i = 0; i < confirmed.length; i += config.maxBatchSize) {
    chunks.push(confirmed.slice(i, i + config.maxBatchSize));
  }

  console.log(
    `  Submitting ${chunks.length} batch(es) of up to ${config.maxBatchSize} calls`
  );

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const calls = chunk.map((o) => buildExecuteCall(o.id));

    console.log(
      `  Batch ${i + 1}/${chunks.length}: executing order IDs [${chunk.map((o) => o.id).join(", ")}]`
    );

    try {
      const tx = await account.execute(calls);
      console.log(`  Batch ${i + 1} submitted: ${tx.transaction_hash}`);

      const receipt = await account.waitForTransaction(tx.transaction_hash);
      if (receipt.isSuccess()) {
        console.log(`  Batch ${i + 1} confirmed ✓`);
      } else {
        // Individual reverts inside a multicall cause the whole tx to revert.
        // Log and continue — the next tick will retry any still-due orders.
        console.error(`  Batch ${i + 1} reverted. Receipt:`, receipt);
      }
    } catch (err) {
      console.error(`  Batch ${i + 1} failed to submit:`, err);
      // Do not rethrow — a single failed batch should not stop the keeper loop.
    }
  }
}
