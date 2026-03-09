import { hash } from "starknet";
import { account, provider } from "./config";

const UDC_ADDRESS =
  "0x041a78e741e5af2fec34b695679bc6891742439f7afb8484ecd7766661ad02bf";

const CONTRACT_DEPLOYED_KEY = hash.getSelectorFromName("ContractDeployed");

// All accounts you've ever deployed from
const DEPLOYER_SUFFIXES = [
  account.address,
  "0x02ceed65a4bd731034c01113685c831b01c15d7d432f71afb1cf1634b53a2125",
].map((a) => a.replace("0x", "").slice(-62).toLowerCase());

console.log({ DEPLOYER_SUFFIXES });

function isOurDeployer(address: string): boolean {
  const normalized = address.replace("0x", "").toLowerCase();
  return DEPLOYER_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

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

    for (const event of result.events) {
      if (event.data.length < 2) continue;

      // Case 1: deployer field is one of our wallets directly
      if (isOurDeployer(event.data[1])) {
        contracts.push(event.data[0]);
        console.log(
          `  [direct] block ${event.block_number} → ${event.data[0]}`,
        );
        continue;
      }

      // Case 2: UDC deployed on our behalf — check tx sender
      const txHash = event.transaction_hash;
      if (checkedTxs.has(txHash)) continue;
      checkedTxs.add(txHash);

      try {
        const tx = await provider.getTransaction(txHash);
        const sender = (tx as any).sender_address ?? "";
        if (isOurDeployer(sender)) {
          contracts.push(event.data[0]);
          console.log(
            `  [via udc] block ${event.block_number} → ${event.data[0]}`,
          );
        }
      } catch (err) {
        console.warn(`  Failed to fetch tx ${txHash}:`, err);
      }
    }

    continuationToken = result.continuation_token;
  } while (continuationToken);

  return contracts;
}

async function main() {
  console.log(`Fetching contracts deployed by any known account...`);
  const contracts = await getDeployedContracts();
  console.log(`\nFound ${contracts.length} contracts:`);
  contracts.forEach((c) => console.log(`  ${c}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
