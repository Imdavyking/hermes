import { account, getExecuteNowPayload } from "./starknet";

const ORDER_ID = "1"; // whichever order you created

async function demo() {
  console.log(`Demo: force-executing DCA order ${ORDER_ID}...`);

  const calls = await getExecuteNowPayload(ORDER_ID);
  if (!calls) {
    console.error("Failed to build payload");
    return;
  }

  console.log(`Submitting ${calls.length} call(s)...`);
  const tx = await account.execute(calls);
  console.log("tx:", tx.transaction_hash);

  const receipt = await account.waitForTransaction(tx.transaction_hash);
  console.log(receipt.isSuccess() ? "✓ confirmed" : "✗ reverted", receipt);
}

demo().catch(console.error);
