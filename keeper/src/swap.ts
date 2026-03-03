/**
 * STRK → BTC Testnet Swap Test
 *
 * Uses the same patterns as the K1 AtomicSwapper production implementation:
 * - RpcProviderWithRetries for resilient RPC connections
 * - SwapperFactory pattern (not deprecated newSwapper)
 * - Balance check before swapping
 * - OutOfBoundsError handled with clear min/max message
 * - Full refund path on failure
 */

import * as fs from "fs";
import * as dotenv from "dotenv";
import { TEST_NETWORK } from "@scure/btc-signer";
import {
  SingleAddressBitcoinWallet,
  SwapperFactory,
  fromHumanReadableString,
  FeeType,
  MempoolBitcoinRpc,
  BitcoinNetwork,
  ToBTCSwap,
} from "@atomiqlabs/sdk";
import {
  RpcProviderWithRetries,
  StarknetInitializer,
  StarknetInitializerType,
  StarknetKeypairWallet,
  StarknetSigner,
} from "@atomiqlabs/chain-starknet";
import {
  SqliteStorageManager,
  SqliteUnifiedStorage,
} from "@atomiqlabs/storage-sqlite";

dotenv.config();

// ─────────────────────────────────────────────────────────
// CONFIG — edit here or use .env
// ─────────────────────────────────────────────────────────
const CONFIG = {
  // Network
  bitcoinNetwork: BitcoinNetwork.TESTNET, // for swapper.newSwapper()
  btcSignerNetwork: TEST_NETWORK, // for SingleAddressBitcoinWallet (@scure/btc-signer)

  starknetRpcUrl:
    process.env.STARKNET_RPC_URL ||
    "https://starknet-sepolia.public.blastapi.io/rpc/v0_8",
  bitcoinRpcUrl:
    process.env.BITCOIN_RPC_URL || "https://mempool.space/testnet/api/",

  // Wallet — pulled from .env or auto-generated key files
  starknetPrivateKey: process.env.STARKNET_PRIVATE_KEY || null,
  bitcoinPrivateKey: process.env.BITCOIN_PRIVATE_KEY || null,

  // Swap — LP minimum is ~23.6 STRK, use 25 to be safe
  strkAmount: process.env.STRK_AMOUNT || "25",
  exactIn: true,

  // Key persistence files (used if no .env keys provided)
  starknetKeyFile: "starknet.key",
  bitcoinKeyFile: "bitcoin.key",
};

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

function loadOrCreateKey(filePath: string, generator: () => string): string {
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath).toString().trim();
  }
  const key = generator();
  fs.writeFileSync(filePath, key);
  console.log(`🔑 Generated new key, saved to ${filePath}`);
  return key;
}

function printSeparator(label: string) {
  console.log(`\n${"─".repeat(50)}`);
  console.log(`  ${label}`);
  console.log("─".repeat(50));
}

// STRK has 18 decimals — convert raw bigint to human-readable for display
function rawToStrk(raw: bigint): string {
  return (Number(raw) / 1e18).toFixed(4);
}

// ─────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────

async function main() {
  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║   atomiq.exchange — STRK → BTC Testnet  ║");
  console.log("╚══════════════════════════════════════════╝\n");

  // ── 1. RPC Providers ─────────────────────────────────
  printSeparator("1. Initializing RPC Providers");

  const starknetRpc = new RpcProviderWithRetries({
    nodeUrl: CONFIG.starknetRpcUrl,
  });
  const bitcoinRpc = new MempoolBitcoinRpc(CONFIG.bitcoinRpcUrl);

  console.log(`✅ StarkNet RPC: ${CONFIG.starknetRpcUrl}`);
  console.log(`✅ Bitcoin RPC:  ${CONFIG.bitcoinRpcUrl}`);

  // ── 2. Wallets ────────────────────────────────────────
  printSeparator("2. Setting Up Wallets");

  const starknetPrivateKey =
    CONFIG.starknetPrivateKey ||
    loadOrCreateKey(
      CONFIG.starknetKeyFile,
      StarknetKeypairWallet.generateRandomPrivateKey,
    );

  const starknetWallet = new StarknetKeypairWallet(
    starknetRpc,
    starknetPrivateKey,
  );
  const starknetSigner = new StarknetSigner(starknetWallet);
  console.log(`✅ StarkNet address: ${starknetSigner.getAddress()}`);
  console.log(
    `   Explorer: https://sepolia.voyager.online/contract/${starknetSigner.getAddress()}`,
  );

  const bitcoinPrivateKey =
    CONFIG.bitcoinPrivateKey ||
    loadOrCreateKey(
      CONFIG.bitcoinKeyFile,
      SingleAddressBitcoinWallet.generateRandomPrivateKey,
    );

  const bitcoinWallet = new SingleAddressBitcoinWallet(
    bitcoinRpc,
    CONFIG.btcSignerNetwork,
    bitcoinPrivateKey,
  );
  const bitcoinAddress = bitcoinWallet.getReceiveAddress();
  console.log(`✅ Bitcoin address: ${bitcoinAddress}`);
  console.log(
    `   Mempool: https://mempool.space/testnet/address/${bitcoinAddress}`,
  );

  // ── 3. SDK Factory & Swapper ──────────────────────────
  printSeparator("3. Initializing atomiq SDK");

  const factory = new SwapperFactory<[StarknetInitializerType]>([
    StarknetInitializer,
  ]);
  const Tokens = factory.Tokens;

  const swapper = factory.newSwapper({
    chains: {
      STARKNET: { rpcUrl: starknetRpc },
    },
    bitcoinNetwork: CONFIG.bitcoinNetwork,
    swapStorage: (chainId: string) =>
      new SqliteUnifiedStorage(`CHAIN_${chainId}.sqlite3`),
    chainStorageCtor: (name: string) =>
      new SqliteStorageManager(`STORE_${name}.sqlite3`),
    pricingFeeDifferencePPM: 2_000_000n,
  });

  await swapper.init();
  console.log("✅ atomiq SDK initialized!");

  // ── 4. Parse & Validate Amount ────────────────────────
  printSeparator("4. Validating Swap Amount");

  const requiredAmount =
    fromHumanReadableString(CONFIG.strkAmount, Tokens.STARKNET.STRK) ??
    undefined;

  if (requiredAmount === undefined) {
    throw new Error(`Invalid STRK amount: ${CONFIG.strkAmount}`);
  }
  console.log(
    `✅ Swap amount: ${CONFIG.strkAmount} STRK (${requiredAmount} raw)`,
  );

  // ── 5. Check Spendable Balance ────────────────────────
  printSeparator("5. Checking Spendable Balance");

  try {
    // balance.amount is a human-readable string (e.g. "99.951999999")
    // compare as float, not bigint
    const balance = await swapper.Utils.getSpendableBalance(
      starknetSigner,
      Tokens.STARKNET.STRK,
    );
    const balanceFloat = parseFloat(balance.amount.toString());
    const requiredFloat = parseFloat(CONFIG.strkAmount);

    console.log(`💰 Spendable STRK balance: ${balanceFloat} STRK`);

    if (balanceFloat < requiredFloat) {
      console.error(
        `\n❌ Insufficient balance. Have: ${balanceFloat} STRK, Need: ${requiredFloat} STRK`,
      );
      console.log(
        `   Fund your StarkNet address: ${starknetSigner.getAddress()}`,
      );
      console.log(`   Faucet: https://starknet-faucet.vercel.app/`);
      await swapper.stop();
      return;
    }

    console.log(`✅ Sufficient balance to swap ${CONFIG.strkAmount} STRK`);
  } catch (err) {
    console.warn(
      `⚠️  Could not check balance (continuing anyway): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // ── 6. Swap Limits (informational only) ──────────────
  printSeparator("6. Checking Swap Limits");

  // Note: getSwapLimits() reflects cached SDK limits, not live LP limits.
  // The live LP minimum (~23.6 STRK) is only enforced at quote time.
  const limits = swapper.getSwapLimits(
    Tokens.STARKNET.STRK,
    Tokens.BITCOIN.BTC,
  );
  console.log("📊 STRK → BTC cached limits:");
  console.log(`   Input  min: ${limits.input.min?.toString() || "N/A"}`);
  console.log(`   Input  max: ${limits.input.max?.toString() || "N/A"}`);
  console.log(`   Output min: ${limits.output.min?.toString() || "N/A"}`);
  console.log(`   Output max: ${limits.output.max?.toString() || "N/A"}`);
  console.log(`⚠️  Note: LP live minimum is ~23.6 STRK regardless of above`);

  // ── 7. Check Pending Swaps ────────────────────────────
  printSeparator("7. Checking Pending Swaps");

  try {
    const refundable = await swapper.getRefundableSwaps(
      "STARKNET",
      starknetSigner.getAddress(),
    );
    if (refundable.length > 0) {
      console.log(
        `⚠️  Found ${refundable.length} refundable swap(s) — refunding...`,
      );
      for (const s of refundable) {
        console.log(`   - Swap ID: ${s.getId()}, State: ${s.getState()}`);
        const refundTxId = await (s as ToBTCSwap<any>).refund(starknetSigner);
        console.log(`   ✅ Refunded: ${refundTxId}`);
      }
    } else {
      console.log("✅ No pending refundable swaps");
    }

    const claimable = await swapper.getClaimableSwaps(
      "STARKNET",
      starknetSigner.getAddress(),
    );
    if (claimable.length > 0) {
      console.log(
        `ℹ️  Found ${claimable.length} claimable swap(s) — review manually`,
      );
    } else {
      console.log("✅ No pending claimable swaps");
    }
  } catch (err) {
    console.warn(
      `⚠️  Could not check pending swaps: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // ── 8. Create Swap Quote ──────────────────────────────
  printSeparator("8. Getting Swap Quote");

  console.log(`⏳ Requesting quote for ${CONFIG.strkAmount} STRK → BTC...`);

  console.log({ requiredAmount });

  let swap: ToBTCSwap<any>;
  try {
    // Cast to ToBTCSwap — swapper.swap() returns a union of all swap types.
    // Without the cast TypeScript resolves to the wrong overload (FromBTCLNAutoSwap)
    // which does not have commit() or refund().
    swap = (await swapper.swap(
      Tokens.STARKNET.STRK, // From
      Tokens.BITCOIN.BTC, // To
      requiredAmount, // Amount (bigint)
      CONFIG.exactIn, // exactIn
      starknetSigner.getAddress(), // Source StarkNet address
      bitcoinAddress, // Destination Bitcoin address
    )) as ToBTCSwap<any>;

    // swap<C extends ChainIds<T>>(srcToken: SCToken<C>, dstToken: BtcToken<false>, amount: bigint | string, exactIn: boolean | SwapAmountType, src: string, dstAddress: string, options?: ToBTCOptions): Promise<ToBTCSwap<T[C]>>;
  } catch (err: any) {
    // OutOfBoundsError — LP rejected the amount, show human-readable min/max
    if (err?.min !== undefined && err?.max !== undefined) {
      console.error(`\n❌ Amount out of LP bounds:`);
      console.error(`   Min: ${rawToStrk(err.min)} STRK  (${err.min} raw)`);
      console.error(`   Max: ${rawToStrk(err.max)} STRK  (${err.max} raw)`);
      console.error(`   Your amount: ${CONFIG.strkAmount} STRK`);
      console.error(
        `   Fix: set STRK_AMOUNT to a value between ${rawToStrk(err.min)} and ${rawToStrk(err.max)}`,
      );
    } else {
      console.error(`\n❌ Failed to get quote: ${err?.message ?? String(err)}`);
    }
    await swapper.stop();
    return;
  }

  console.log("\n📋 Quote received:");
  console.log(`   Input:   ${swap.getInput()} STRK`);
  console.log(`   Output:  ${swap.getOutput()} sats`);
  console.log(`   Expires: ${new Date(swap.getQuoteExpiry()).toISOString()}`);

  console.log("\n💸 Fee Breakdown:");
  swap.getFeeBreakdown().forEach((fee: any) => {
    console.log(`   - ${FeeType[fee.type]}: ${fee.fee.amountInSrcToken}`);
  });

  const txns = await swap.txsCommit();

  for (const tx of txns) {
    if (tx.type === "INVOKE") {
      console.log("Calldata:", tx.tx);
      // tx.tx contains the full EscrowData including claim_data
      // Extract and pass to your Cairo contract
    }
  }

  // ── 9. Commit STRK (Lock in Escrow) ──────────────────
  printSeparator("9. Committing STRK to Escrow");

  console.log("⏳ Sending StarkNet transaction to lock STRK in escrow...");
  const commitTxId = await swap.commit(starknetSigner);

  console.log(`✅ StarkNet transaction confirmed!`);
  console.log(`   Tx ID:    ${commitTxId}`);
  console.log(`   Explorer: https://sepolia.voyager.online/tx/${commitTxId}`);

  // ── 10. Wait for LP to Pay BTC ───────────────────────
  printSeparator("10. Waiting for BTC Payment from LP");

  console.log("⏳ Waiting for LP to release BTC...");
  console.log(`   Your Bitcoin address: ${bitcoinAddress}`);
  console.log(
    `   Track: https://mempool.space/testnet/address/${bitcoinAddress}`,
  );

  const success = await swap.waitForPayment();

  // ── 11. Result ────────────────────────────────────────
  printSeparator("11. Result");

  if (!success) {
    console.log("❌ Swap failed or timed out — refunding STRK...");
    try {
      const refundTxId = await swap.refund(starknetSigner);
      console.log(`✅ Refund successful!`);
      console.log(`   Tx ID:    ${refundTxId}`);
      console.log(
        `   Explorer: https://sepolia.voyager.online/tx/${refundTxId}`,
      );
    } catch (refundErr) {
      console.error(
        `❌ Refund failed: ${
          refundErr instanceof Error ? refundErr.message : String(refundErr)
        }`,
      );
    }
  } else {
    const btcTxId = swap.getOutputTxId();
    console.log("✅ Swap successful!");
    console.log(`   Bitcoin Tx ID: ${btcTxId}`);
    console.log(`   Track: https://mempool.space/testnet/tx/${btcTxId}`);
  }

  await swapper.stop();
  console.log("\n🏁 Done.\n");
}

main().catch((err) => {
  console.error("\n❌ Fatal error:", err);
  process.exit(1);
});
