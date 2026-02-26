import { CheckpointConfig } from "@snapshot-labs/checkpoint";

export const config: CheckpointConfig = {
  network: process.env.RPC_URL || "https://starknet-sepolia.public.blastapi.io",
  sources: [
    {
      contract: "0x6672ba9611e8c31ad69f54cb5a8ec0eccdead4bf330b06ab0db585b4a0be1dc",
      start: 6917720,
      events: [
        { name: "Deposit",            fn: "handleDeposit" },
        { name: "Withdrawal",         fn: "handleWithdrawal" },
        { name: "WbtcOrderPosted",    fn: "handleWbtcOrderPosted" },
        { name: "WbtcOrderFilled",    fn: "handleWbtcOrderFilled" },
        { name: "WbtcWithdrawn",      fn: "handleWbtcWithdrawn" },
        { name: "StrkWithdrawn",      fn: "handleStrkWithdrawn" },
        { name: "WbtcRefunded",       fn: "handleWbtcRefunded" },
        { name: "StrkRefunded",       fn: "handleStrkRefunded" },
        { name: "StrkOrderPosted",    fn: "handleStrkOrderPosted" },
        { name: "OwnershipTransferred", fn: "handleOwnershipTransferred" },
      ],
    },
  ],
};
