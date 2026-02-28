import {
  Account,
  CallData,
  Contract,
  RpcProvider,
  hash,
  stark,
} from "starknet";
import * as dotenv from "dotenv";
import { getCompiledCode } from "./utils";
dotenv.config();

async function main() {
  const provider = new RpcProvider({ nodeUrl: process.env.RPC_ENDPOINT });
  const account = new Account({
    provider: provider,
    signer: process.env.DEPLOYER_PRIVATE_KEY!,
    address: process.env.DEPLOYER_ADDRESS!,
  });

  console.log("Account connected:", account.address);

  // Load compiled contracts
  const { sierraCode: verifierSierra, casmCode: verifierCasm } =
    await getCompiledCode(
      "../../verifier/target/dev/verifier_UltraKeccakZKHonkVerifier",
    );

  const { sierraCode: privateSwapSierra, casmCode: privateSwapCasm } =
    await getCompiledCode("contracts_PrivateSwap");

  // 1. Declare Verifier
  const verifierDeclare = await account.declareIfNot({
    contract: verifierSierra,
    casm: verifierCasm,
  });
  if (verifierDeclare.transaction_hash) {
    await provider.waitForTransaction(verifierDeclare.transaction_hash);
  }
  const verifierClassHash = verifierDeclare.class_hash;
  console.log("Verifier class hash:", verifierClassHash);

  // 4. Declare + Deploy PrivateSwap with all three class hashes
  const privateSwapCalldata = new CallData(privateSwapSierra.abi);
  const constructorCalldata = privateSwapCalldata.compile("constructor", {
    verifier_class_hash: verifierClassHash,
  });

  const deployResponse = await account.declareAndDeploy({
    contract: privateSwapSierra,
    casm: privateSwapCasm,
    constructorCalldata,
    salt: stark.randomAddress(),
  });
  await provider.waitForTransaction(deployResponse.deploy.transaction_hash);

  const privateSwapContract = new Contract({
    abi: privateSwapSierra.abi,
    address: deployResponse.deploy.contract_address,
    providerOrAccount: account,
  });

  await provider.waitForTransaction(deployResponse.deploy.transaction_hash);

  console.log("✅ PrivateSwap deployed at:", privateSwapContract.address);
  console.log("wBTC address:", await privateSwapContract.wBTC_address());
  console.log("STRK address:", await privateSwapContract.strk_address());
  // --- MOCKING
  // Also load MockUSDT
  // contract is identical in structure (ERC20 + mint), just configured
  // as usdt (6 decimals, name "usdt") in its constructor.
  const { sierraCode: mockUSDTSierra, casmCode: mockUSDTCasm } =
    await getCompiledCode("contracts_MockUSDT");
  const mockUSDTDeployResponse = await account.declareAndDeploy({
    contract: mockUSDTSierra,
    casm: mockUSDTCasm,
    salt: stark.randomAddress(),
  });
  await provider.waitForTransaction(
    mockUSDTDeployResponse.deploy.transaction_hash,
  );

  const mockUSDTAddress = mockUSDTDeployResponse.deploy.contract_address;
  console.log("✅ MockUSDT deployed at:", mockUSDTAddress);

  // 5. Register MockUSDT on PrivateSwap via set_mock_usdt (owner-only)
  console.log("\n--- Calling set_mock_usdt ---");
  const setMockTx = await privateSwapContract.set_usdc(mockUSDTAddress);
  await provider.waitForTransaction(setMockTx.transaction_hash);
  console.log("✅ set_mock_usdt confirmed, tx:", setMockTx.transaction_hash);

  // Mint some MockUSDT to the deployer address for testing
  const mockUSDTContract = new Contract({
    abi: mockUSDTSierra.abi,
    address: mockUSDTAddress,
    providerOrAccount: account,
  });

  const usdtDecimals = await mockUSDTContract.decimals();
  const mintAmount = BigInt(10_000 * 10 ** usdtDecimals); // 10k USDT
  const mintTx = await mockUSDTContract.mint(account.address, mintAmount);
  await provider.waitForTransaction(mintTx.transaction_hash);
  console.log(
    `✅ Minted ${mintAmount} MockUSDT to deployer, tx:`,
    mintTx.transaction_hash,
  );

  //// --- END OF MOCK DEPLOYMENT ---
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
