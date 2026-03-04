import { config } from "./config";
import { runKeeper } from "./keeper";

console.log("Umbra DCA Keeper starting");
console.log(`  Contract:      ${config.contractAddress}`);
console.log(`  GraphQL:       ${config.graphqlUrl}`);
console.log(`  Poll interval: ${config.pollIntervalMs / 1000}s`);
console.log(`  Max batch:     ${config.maxBatchSize} calls/tx`);
console.log("");

// Run immediately on startup, then on the configured interval.
async function tick() {
  try {
    await runKeeper();
  } catch (err) {
    // Top-level safety net — runKeeper() handles its own errors internally
    // but we never want an uncaught exception to kill the process.
    console.error("Unexpected error in keeper:", err);
  }
}

tick();
setInterval(tick, config.pollIntervalMs);
