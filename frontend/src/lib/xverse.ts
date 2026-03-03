// lib/xverse.ts
// Connects Xverse wallet and returns the user's Bitcoin payment address.
// No signing, no balance fetching — address is used as DCA wBTC destination.

import {
  request,
  AddressPurpose,
  RpcErrorCode,
  getProviders,
} from "sats-connect";

export function isXverseInstalled(): boolean {
  const providers = getProviders();
  return providers.some((p) => p.name?.toLowerCase().includes("xverse"));
}

/**
 * Prompts the user to connect their Xverse wallet and returns their
 * Bitcoin payment address (P2WPKH / P2SH-P2WPKH).
 *
 * The returned address is stored as `btc_destination` in the DCA order
 * so the Atomiq LP can deliver wBTC directly to the user's Bitcoin wallet
 * on each interval execution.
 */
export async function connectXverse(): Promise<string> {
  if (!isXverseInstalled()) {
    throw new Error(
      "Xverse wallet not found. Install it from xverse.app then refresh.",
    );
  }
  const response = await request("getAccounts", {
    purposes: [AddressPurpose.Payment],
    message: "Connect your Bitcoin wallet to receive DCA wBTC purchases",
  });

  if (response.status === "success") {
    const payment = response.result.find(
      (a: any) => a.purpose === AddressPurpose.Payment,
    );
    if (!payment) {
      throw new Error(
        "No Bitcoin payment address found. Make sure Xverse has a funded wallet.",
      );
    }
    return payment.address;
  }

  if (response.error?.code === RpcErrorCode.USER_REJECTION) {
    throw new Error("User rejected the connection request.");
  }

  throw new Error(
    response.error?.message ?? "Failed to connect Xverse wallet.",
  );
}
