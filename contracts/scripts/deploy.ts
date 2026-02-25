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

  const { sierraCode: pstrkSierra, casmCode: pstrkCasm } =
    await getCompiledCode("contracts_MockSTRK");

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

  // 3. Declare pSTRK
  const pstrkDeclare = await account.declareIfNot({
    contract: pstrkSierra,
    casm: pstrkCasm,
  });
  if (pstrkDeclare.transaction_hash) {
    await provider.waitForTransaction(pstrkDeclare.transaction_hash);
  }
  const pstrkClassHash = pstrkDeclare.class_hash;
  console.log("pSTRK class hash:", pstrkClassHash);

  // 4. Declare + Deploy PrivateSwap with all three class hashes
  const privateSwapCalldata = new CallData(privateSwapSierra.abi);
  const constructorCalldata = privateSwapCalldata.compile("constructor", {
    pstrk_class_hash: pstrkClassHash,
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
    providerOrAccount: provider,
  });

  console.log("✅ PrivateSwap deployed at:", privateSwapContract.address);
  console.log("wBTC address:", await privateSwapContract.wBTC_address());
  console.log("STRK address:", await privateSwapContract.strk_address());
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
