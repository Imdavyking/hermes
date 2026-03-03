/**
 * Direct LP quote — no SDK, no Binance, no price check
 * Calls the Atomiq LP node directly to get EscrowData
 */

import * as crypto from "crypto";

// ── Constants ──────────────────────────────────────────────
const LP_URL = "https://node3.gethopa.com:8443";
const CHAIN = "STARKNET";
const STRK_ADDRESS =
  "0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

// ── Types ──────────────────────────────────────────────────
interface LPResponse {
  code: number;
  msg: string;
  data: {
    amount: string;
    address: string;
    satsPervByte: string;
    networkFee: string;
    swapFee: string;
    totalFee: string;
    total: string;
    minRequiredExpiry: string;
    data: any; // EscrowData — the full struct for escrow.initialize()
    signature: any; // LP's signature
  } | null;
}

interface FeeRateResponse {
  code: number;
  msg: string;
  data: {
    feeRate: number;
  } | null;
}

// ── Step 1: Get fee rate ───────────────────────────────────
async function getFeeRate(): Promise<string> {
  const res = await fetch(
    `${LP_URL}/tobtc/feeRate?chain=${CHAIN}&token=${STRK_ADDRESS}`,
  );
  const json = (await res.json()) as FeeRateResponse;
  console.log("Fee rate response:", JSON.stringify(json, null, 2));
  return json.data?.feeRate?.toString() ?? "1";
}

// ── Step 2: Get quote from LP directly ────────────────────
async function getQuote(
  bitcoinAddress: string,
  starknetAddress: string,
  amount: bigint,
  feeRate: string,
): Promise<LPResponse> {
  const nonce = BigInt("0x" + crypto.randomBytes(8).toString("hex"));

  const body = {
    address: bitcoinAddress,
    amount: amount.toString(10),
    exactIn: true,
    confirmationTarget: 3,
    confirmations: 2,
    nonce: nonce.toString(10),
    token: STRK_ADDRESS,
    offerer: starknetAddress,
    feeRate,
  };

  console.log("\n📤 Sending to LP:");
  console.log(JSON.stringify(body, null, 2));

  const res = await fetch(
    `${LP_URL}/tobtc/payInvoice?chain=${encodeURIComponent(CHAIN)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  const json = (await res.json()) as LPResponse;
  return json;
}

// ── Main ───────────────────────────────────────────────────
async function main() {
  const starknetAddress =
    "0x066e4d18f13e519b4ef72d6a5047136f1e479c0bb54599863e0c664297a2d085";
  const bitcoinAddress = "tb1qu97uhs6e3p3wghufqdft4tv9w5220jttqfkcnx";
  const amount = 30_000_000_000_000_000_000n; // 30 STRK

  console.log("⏳ Fetching fee rate...");
  const feeRate = await getFeeRate();
  console.log("✅ Fee rate:", feeRate);

  console.log("\n⏳ Requesting quote from LP...");
  const quote = await getQuote(
    bitcoinAddress,
    starknetAddress,
    amount,
    feeRate,
  );

  console.log("\n📦 Raw LP response:");
  console.log(JSON.stringify(quote, null, 2));

  if (quote.code !== 20000) {
    console.error("❌ LP error:", quote.msg, quote.data);
    return;
  }

  // ── Fields needed for Cairo contract ──────────────────
  console.log("\n🔑 Fields needed for escrow.initialize():");
  console.log(
    "   data (EscrowData):",
    JSON.stringify(quote.data?.data, null, 2),
  );
  console.log(
    "   signature:        ",
    JSON.stringify(quote.data?.signature, null, 2),
  );
  console.log("   amount (STRK in): ", quote.data?.amount);
  console.log("   total (STRK in):  ", quote.data?.total);
  console.log("   minRequiredExpiry:", quote.data?.minRequiredExpiry);
  console.log("   networkFee (sats):", quote.data?.networkFee);
  console.log("   swapFee:          ", quote.data?.swapFee);
}

main().catch(console.error);
