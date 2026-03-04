import { CheckpointConfig } from "@snapshot-labs/checkpoint";
import PrivateSwapAbi from "./abis/private_swap.abi.json";

if (!process.env.RPC_URL) {
  throw new Error("RPC_URL environment variable is not set");
}

if (!process.env.CONTRACT_ADDRESS) {
  throw new Error("CONTRACT_ADDRESS environment variable is not set");
}

if (!process.env.START_BLOCK) {
  throw new Error("START_BLOCK environment variable is not set");
}

export const config: CheckpointConfig = {
  network_node_url: process.env.RPC_URL,
  sources: [
    {
      contract: process.env.CONTRACT_ADDRESS,
      start: Number(process.env.START_BLOCK),
      abi: "PrivateSwapAbi",
      events: [
        { name: "Deposit", fn: "handleDeposit" },
        { name: "Withdrawal", fn: "handleWithdrawal" },
        { name: "WbtcOrderPosted", fn: "handleWbtcOrderPosted" },
        { name: "WbtcOrderFilled", fn: "handleWbtcOrderFilled" },
        { name: "WbtcWithdrawn", fn: "handleWbtcWithdrawn" },
        { name: "StrkWithdrawn", fn: "handleStrkWithdrawn" },
        { name: "WbtcRefunded", fn: "handleWbtcRefunded" },
        { name: "StrkRefunded", fn: "handleStrkRefunded" },
        { name: "OwnershipTransferred", fn: "handleOwnershipTransferred" },
        { name: "DCAOrderCreated", fn: "handleDCAOrderCreated" },
        { name: "DCAExecuted", fn: "handleDCAExecuted" },
        { name: "DCAIntervalClaimed", fn: "handleDCAIntervalClaimed" },
        { name: "DCAIntervalRefunded", fn: "handleDCAIntervalRefunded" },
        { name: "DCACancelled", fn: "handleDCACancelled" },
      ],
    },
  ],
  abis: { PrivateSwapAbi },
};
