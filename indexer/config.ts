import { CheckpointConfig } from "@snapshot-labs/checkpoint";

export const config: CheckpointConfig = {
  network: process.env.RPC_URL || "https://starknet-sepolia.public.blastapi.io",
  sources: [
    {
      contract: process.env.CONTRACT_ADDRESS!,
      start: Number(process.env.START_BLOCK) || 0,
      deploy_fn: "handleDeploy",
      events: [
        { name: "Deposit", fn: "handleDeposit" },
        { name: "Withdrawal", fn: "handleWithdrawal" },
        { name: "WbtcOrderPosted", fn: "handleWbtcOrderPosted" },
        { name: "WbtcOrderFilled", fn: "handleWbtcOrderFilled" },
        { name: "WbtcWithdrawn", fn: "handleWbtcWithdrawn" },
        { name: "StrkWithdrawn", fn: "handleStrkWithdrawn" },
        { name: "WbtcRefunded", fn: "handleWbtcRefunded" },
        { name: "StrkRefunded", fn: "handleStrkRefunded" },
        { name: "StrkOrderPosted", fn: "handleStrkOrderPosted" },
        { name: "OwnershipTransferred", fn: "handleOwnershipTransferred" },
      ],
    },
  ],
};
