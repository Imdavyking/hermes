import { CallData, Contract, stark } from "starknet";
import * as dotenv from "dotenv";
import { getCompiledCode } from "./utils";
import * as fs from "fs";
import * as path from "path";
import { account, provider } from "./config";
dotenv.config();

async function main() {
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
  // Also load MockUSDC
  // contract is identical in structure (ERC20 + mint), just configured
  // as usdc (6 decimals, name "usdc") in its constructor.
  const { sierraCode: mockUSDCSierra, casmCode: mockUSDCCasm } =
    await getCompiledCode("contracts_MockUSDc");
  const mockUSDCDeployResponse = await account.declareAndDeploy({
    contract: mockUSDCSierra,
    casm: mockUSDCCasm,
    constructorCalldata: [],
    salt: stark.randomAddress(),
  });
  await provider.waitForTransaction(
    mockUSDCDeployResponse.deploy.transaction_hash,
  );

  const mockUSDCAddress = mockUSDCDeployResponse.deploy.contract_address;
  console.log("✅ MockUSDC deployed at:", mockUSDCAddress);

  // 5. Register MockUSDC on PrivateSwap via set_mock_usdc (owner-only)
  console.log("\n--- Calling set_mock_usdc ---");
  const setMockTx = await privateSwapContract.set_usdc(mockUSDCAddress);
  await provider.waitForTransaction(setMockTx.transaction_hash);
  console.log("✅ set_mock_usdc confirmed, tx:", setMockTx.transaction_hash);

  // Mint some MockUSDC to the deployer address for testing
  const mockUSDCContract = new Contract({
    abi: mockUSDCSierra.abi,
    address: mockUSDCAddress,
    providerOrAccount: account,
  });

  const usdcDecimals = await mockUSDCContract.decimals();
  const mintAmount = BigInt(10_000 * 10 ** Number(usdcDecimals)); // 10k USDC
  const mintTx = await mockUSDCContract.mint(account.address, mintAmount);
  await provider.waitForTransaction(mintTx.transaction_hash);
  console.log(
    `✅ Minted ${mintAmount} MockUSDC to deployer, tx:`,
    mintTx.transaction_hash,
  );

  function updateEnvFile(filePath: string, key: string, value: string) {
    const fullPath = path.resolve(filePath);
    if (!fs.existsSync(fullPath)) {
      console.warn(`  Skipped (not found): ${fullPath}`);
      return;
    }
    let content = fs.readFileSync(fullPath, "utf8");
    const regex = new RegExp(`^${key}=.*$`, "m");
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content += `\n${key}=${value}`;
    }
    fs.writeFileSync(fullPath, content);
    console.log(`  Updated ${filePath}`);
  }

  const contractAddress = privateSwapContract.address;

  console.log("\n--- Updating .env files ---");
  updateEnvFile("../frontend/.env", "VITE_CONTRACT_ADDRESS", contractAddress);
  updateEnvFile(
    "../frontend/.env.example",
    "VITE_CONTRACT_ADDRESS",
    contractAddress,
  );
  updateEnvFile("../indexer/.env", "CONTRACT_ADDRESS", contractAddress);
  updateEnvFile("../indexer/.env.example", "CONTRACT_ADDRESS", contractAddress);
  updateEnvFile("../keeper/.env", "CONTRACT_ADDRESS", contractAddress);
  updateEnvFile("../keeper/.env.example", "CONTRACT_ADDRESS", contractAddress);
  console.log("✅ All .env files updated with:", contractAddress);

  //// --- END OF MOCK DEPLOYMENT ---
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
