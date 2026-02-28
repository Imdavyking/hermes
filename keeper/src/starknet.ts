import { Account, Contract, RpcProvider, uint256 } from "starknet";
import { config } from "./config";
import abi from "./abis/private_swap.abi.json";

// ── Provider ──────────────────────────────────────────────────────────────────

export const provider = new RpcProvider({
  nodeUrl: config.rpcUrl,
  blockIdentifier: "latest",
});
// ── Keeper account ────────────────────────────────────────────────────────────
// This wallet only needs STRK for gas. It holds no user funds.

export const account = new Account(
  provider,
  config.keeperAddress,
  config.keeperPrivateKey,
);

// ── Contract ──────────────────────────────────────────────────────────────────

export const contract = new Contract(abi, config.contractAddress, provider);

// ── Helpers ───────────────────────────────────────────────────────────────────

// Calls checker(order_id) on-chain to confirm the order is still due.
// This guards against race conditions between the GraphQL query and tx submission:
// another keeper (or a previous batch) may have already executed the order.
// starknet.ts

import { Call } from "starknet";

// Returns the ExecPayload if the order is due, null otherwise.
// The payload is the canonical calldata from the contract itself —
// the keeper fires it blindly with zero protocol-specific knowledge.
export async function getExecutePayload(orderId: string): Promise<Call | null> {
  try {
    const orderIdU256 = uint256.bnToUint256(BigInt(orderId));

    const result = (await contract.call("checker", [orderIdU256], {
      blockIdentifier: "latest",
    })) as unknown as [
      boolean,
      { target: bigint; selector: bigint; calldata: bigint[] },
    ];

    const canExec = result[0];
    const payload = result[1];

    if (!canExec) return null;

    return {
      contractAddress: `0x${payload.target.toString(16)}`,
      entrypoint: `0x${payload.selector.toString(16)}`,
      calldata: payload.calldata,
    };
  } catch (err) {
    console.warn(`checker() failed for order ${orderId}:`, err);
    return null;
  }
}
