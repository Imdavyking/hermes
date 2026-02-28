import { Account, Contract, RpcProvider, uint256 } from "starknet";
import { config } from "./config";
import abi from "./abis/private_swap.abi.json";

// ── Provider ──────────────────────────────────────────────────────────────────

export const provider = new RpcProvider({ nodeUrl: config.rpcUrl });

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
export async function isOrderDue(orderId: string): Promise<boolean> {
  try {
    const orderIdU256 = uint256.bnToUint256(BigInt(orderId));
    const [canExec] = await contract.checker(orderIdU256);
    return Boolean(canExec);
  } catch (err) {
    // If the RPC call fails for any reason, skip this order rather than
    // risking a failed batch transaction.
    console.warn(`checker() failed for order ${orderId}:`, err);
    return false;
  }
}

// Builds a populate call for execute_dca(order_id).
export function buildExecuteCall(orderId: string) {
  return contract.populate("execute_dca", [
    uint256.bnToUint256(BigInt(orderId)),
  ]);
}
