import type { GetTransactionReceiptResponse } from "starknet";
export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function assertReceiptSuccess(receipt: GetTransactionReceiptResponse) {
  if (receipt.isReverted()) {
    throw new Error(receipt.revert_reason ?? "Transaction reverted");
  }
  if (receipt.isError()) {
    throw new Error("Transaction error");
  }
}
