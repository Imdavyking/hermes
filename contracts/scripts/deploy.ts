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
  // Also load MockBTC — reuses the same MockSTRK artifact since the
  // contract is identical in structure (ERC20 + mint), just configured
  // as wBTC (8 decimals, name "wBTC") in its constructor.
  const { sierraCode: mockBtcSierra, casmCode: mockBtcCasm } =
    await getCompiledCode("contracts_MockWBTC");
  const mockBtcDeployResponse = await account.declareAndDeploy({
    contract: mockBtcSierra,
    casm: mockBtcCasm,
    salt: stark.randomAddress(),
  });
  await provider.waitForTransaction(
    mockBtcDeployResponse.deploy.transaction_hash,
  );

  const mockBtcAddress = mockBtcDeployResponse.deploy.contract_address;
  console.log("✅ MockBTC deployed at:", mockBtcAddress);

  // 5. Register MockBTC on PrivateSwap via set_mock_wbtc (owner-only)
  console.log("\n--- Calling set_mock_wbtc ---");
  const setMockTx = await privateSwapContract.set_mock_wbtc(mockBtcAddress);
  await provider.waitForTransaction(setMockTx.transaction_hash);
  console.log("✅ set_mock_wbtc confirmed, tx:", setMockTx.transaction_hash);

  // Mint some MockBTC to the deployer address for testing
  const mockBtcContract = new Contract({
    abi: mockBtcSierra.abi,
    address: mockBtcAddress,
    providerOrAccount: account,
  });

  const mintAmount = BigInt(1_000_000_000); // 10k wBTC with 8 decimals
  const mintTx = await mockBtcContract.mint(account.address, mintAmount);
  await provider.waitForTransaction(mintTx.transaction_hash);
  console.log(
    `✅ Minted ${mintAmount} MockBTC to deployer, tx:`,
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
