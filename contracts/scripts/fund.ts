import { Account, Contract, RpcProvider, uint256 } from "starknet";
import * as dotenv from "dotenv";
dotenv.config();

// STRK token contract on Starknet
const STRK_ADDRESS =
  "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

const RECIPIENT =
  "0x0407C98032c3A826952D9E25C1e4a999f72471E2946751446675F8F381470CC5";
const AMOUNT = BigInt(100) * BigInt(10 ** 18); // 100 STRK (18 decimals)

async function main() {
  const provider = new RpcProvider({ nodeUrl: process.env.RPC_ENDPOINT });
  const account = new Account({
    provider: provider,
    signer: process.env.DEPLOYER_PRIVATE_KEY!,
    address: process.env.DEPLOYER_ADDRESS!,
  });

  console.log("Sending from:", account.address);

  const strkAbi = [
    {
      name: "transfer",
      type: "function",
      inputs: [
        {
          name: "recipient",
          type: "core::starknet::contract_address::ContractAddress",
        },
        { name: "amount", type: "core::integer::u256" },
      ],
      outputs: [{ name: "success", type: "core::bool" }],
      state_mutability: "external",
    },
  ];

  const strkContract = new Contract({
    abi: strkAbi,
    address: STRK_ADDRESS,
    providerOrAccount: account,
  });

  const amount = uint256.bnToUint256(AMOUNT);

  console.log(
    `Transferring ${AMOUNT / BigInt(10 ** 18)} STRK to ${RECIPIENT}...`,
  );

  const tx = await strkContract.invoke("transfer", [RECIPIENT, amount]);

  console.log("Transaction hash:", tx.transaction_hash);
  await provider.waitForTransaction(tx.transaction_hash);
  console.log("✅ Transfer complete");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
