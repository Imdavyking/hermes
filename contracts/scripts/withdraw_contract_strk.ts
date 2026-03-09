import { hash, uint256, CallData } from "starknet";
import { account, provider } from "./config";

const UDC_ADDRESS =
  "0x02ceed65a4bd731034c01113685c831b01c15d7d432f71afb1cf1634b53a2125";

const STRK_ADDRESS =
  "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

const CONTRACT_DEPLOYED_KEY = hash.getSelectorFromName("ContractDeployed");
const CONCURRENCY = 3;
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 1000;

const DEPLOYER_SUFFIXES = [account.address].map((a) =>
  a.replace("0x", "").slice(-62).toLowerCase(),
);

console.log({ DEPLOYER_SUFFIXES });

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

function isOurDeployer(address: string): boolean {
  const normalized = address.replace("0x", "").toLowerCase();
  return DEPLOYER_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(txHash: string): Promise<any> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await provider.getTransaction(txHash);
    } catch (err: any) {
      if (attempt === MAX_RETRIES) throw err;
      const delay = RETRY_DELAY_MS * attempt;
      console.warn(
        `  Retry ${attempt}/${MAX_RETRIES} for ${txHash} in ${delay}ms...`,
      );
      await sleep(delay);
    }
  }
}

async function limit<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
): Promise<T[]> {
  const results: T[] = [];
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]();
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// -------------------------------------------------------
// Step 1 — discover deployed contracts
// -------------------------------------------------------

async function getDeployedContracts(): Promise<string[]> {
  const contracts: string[] = [];
  let continuationToken: string | undefined = undefined;
  const checkedTxs = new Set<string>();

  do {
    const result = await provider.getEvents({
      address: UDC_ADDRESS,
      keys: [[CONTRACT_DEPLOYED_KEY]],
      from_block: { block_number: 7000000 },
      to_block: "latest",
      chunk_size: 1000,
      continuation_token: continuationToken,
    });

    const pendingTxLookups: {
      txHash: string;
      contractAddress: string;
      blockNumber: number;
    }[] = [];

    for (const event of result.events) {
      if (event.data.length < 2) continue;

      if (isOurDeployer(event.data[1])) {
        contracts.push(event.data[0]);
        console.log(
          `  [direct] block ${event.block_number} → ${event.data[0]}`,
        );
        continue;
      }

      const txHash = event.transaction_hash;
      if (checkedTxs.has(txHash)) continue;
      checkedTxs.add(txHash);

      pendingTxLookups.push({
        txHash,
        contractAddress: event.data[0],
        blockNumber: event.block_number ?? 0,
      });
    }

    const tasks = pendingTxLookups.map(
      ({ txHash, contractAddress, blockNumber }) =>
        async () => {
          try {
            const tx = await fetchWithRetry(txHash);
            const sender = (tx as any).sender_address ?? "";
            if (isOurDeployer(sender)) {
              contracts.push(contractAddress);
              console.log(
                `  [via udc] block ${blockNumber} → ${contractAddress}`,
              );
            }
          } catch (err) {
            console.warn(`  Giving up on tx ${txHash}:`, (err as any).message);
          }
        },
    );

    await limit(tasks, CONCURRENCY);
    continuationToken = result.continuation_token;
  } while (continuationToken);

  return contracts;
}

// -------------------------------------------------------
// Step 2 — check balance and withdraw
// -------------------------------------------------------

async function getStrkBalance(contractAddress: string): Promise<bigint> {
  const result = await provider.callContract({
    contractAddress: STRK_ADDRESS,
    entrypoint: "balance_of",
    calldata: CallData.compile([contractAddress]),
  });
  const r = result as unknown as string[];
  return uint256.uint256ToBN({ low: r[0], high: r[1] });
}

async function withdrawStrk(contractAddress: string): Promise<void> {
  const balance = await getStrkBalance(contractAddress);
  const strkAmount = Number(balance) / 1e18;
  console.log(`\n  ${contractAddress}`);
  console.log(`  Balance: ${strkAmount} STRK`);

  if (balance === BigInt(0)) {
    console.log(`  Skipping — empty.`);
    return;
  }

  try {
    const tx = await account.execute([
      {
        contractAddress,
        entrypoint: "withdraw_strk_admin",
        calldata: CallData.compile([
          uint256.bnToUint256(balance),
          account.address,
        ]),
      },
    ]);
    console.log(`  Tx: ${tx.transaction_hash}`);

    const receipt = await account.waitForTransaction(tx.transaction_hash);
    const reverted = (receipt as any).revert_reason;
    if (reverted) throw new Error(`Reverted: ${reverted}`);

    console.log(`  ✓ Withdrew ${strkAmount} STRK`);
  } catch (err: any) {
    console.warn(`  ✗ Withdraw failed: ${err.message}`);
  }
}

// -------------------------------------------------------
// Main
// -------------------------------------------------------

async function main() {
  console.log(`Scanning contracts deployed by ${account.address}...\n`);
  const contracts = await getDeployedContracts();
  console.log(`\nFound ${contracts.length} contracts. Checking balances...\n`);

  // Sequential — each withdraw waits for confirmation before next
  // to avoid nonce collisions on the same account
  for (const contractAddress of contracts) {
    await withdrawStrk(contractAddress);
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
