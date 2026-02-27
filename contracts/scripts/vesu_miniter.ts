import { Account, Contract, RpcProvider } from "starknet";
import * as dotenv from "dotenv";
dotenv.config();

const VESU_WBTC =
  "0x63d32a3fa6074e72e7a1e06fe78c46a0c8473217773e19f11d8c8cbfc4ff8ca";

async function main() {
  const provider = new RpcProvider({ nodeUrl: process.env.RPC_ENDPOINT });
  const account = new Account({
    provider: provider,
    signer: process.env.DEPLOYER_PRIVATE_KEY!,
    address: process.env.DEPLOYER_ADDRESS!,
  });
  const abi = [
    {
      name: "mint",
      type: "function",
      inputs: [
        {
          name: "recipient",
          type: "core::starknet::contract_address::ContractAddress",
        },
        { name: "amount", type: "core::integer::u256" },
      ],
      outputs: [],
      state_mutability: "external",
    },
  ] as const;

  const contract = new Contract({
    abi,
    address: VESU_WBTC,
    providerOrAccount: account,
  });

  try {
    console.log("Attempting mint...");
    const tx = await contract.mint(account.address, 1000);
    console.log("Tx hash:", tx.transaction_hash);
    await provider.waitForTransaction(tx.transaction_hash);
    console.log("✅ Mint succeeded — public mint exists!");
  } catch (e: any) {
    console.log("❌ Mint failed:", e?.message ?? e);
  }
}

main();
