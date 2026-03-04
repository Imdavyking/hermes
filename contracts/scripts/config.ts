import { Account, RpcProvider } from "starknet";
import * as dotenv from "dotenv";
dotenv.config();
export const provider = new RpcProvider({ nodeUrl: process.env.RPC_ENDPOINT });
export const account = new Account({
  provider: provider,
  signer: process.env.DEPLOYER_PRIVATE_KEY!,
  address: process.env.DEPLOYER_ADDRESS!,
});
