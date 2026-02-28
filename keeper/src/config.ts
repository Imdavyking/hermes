import * as dotenv from "dotenv";
dotenv.config();

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const config = {
  rpcUrl: required("RPC_URL"),
  keeperAddress: required("KEEPER_ADDRESS"),
  keeperPrivateKey: required("KEEPER_PRIVATE_KEY"),
  contractAddress: required("CONTRACT_ADDRESS"),
  graphqlUrl: required("GRAPHQL_URL"),
  pollIntervalMs: Number(optional("POLL_INTERVAL_MS", "300000")),
  maxBatchSize: Number(optional("MAX_BATCH_SIZE", "20")),
} as const;
