import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import Checkpoint, { starknet, LogLevel } from "@snapshot-labs/checkpoint";
import { RpcProvider } from "starknet";
import { config } from "./config";
import { createWriters } from "./writers";
import overrides from "./overrides.json";

export type Context = {
  indexerName: string;
  provider: RpcProvider;
};

const dir = __dirname.endsWith("dist/src") ? "../" : "";
const schemaFile = path.join(__dirname, `${dir}../src/schema.gql`);
const schema = fs.readFileSync(schemaFile, "utf8");

const checkpoint = new Checkpoint(schema, {
  logLevel: LogLevel.Debug,
  prettifyLogs: true,
  dbConnection: process.env.DATABASE_URL,
  overridesConfig: overrides,
  resetOnConfigChange: true,
});

// Register the Sepolia indexer
const sepoliaContext: Context = {
  indexerName: "sepolia",
  provider: new RpcProvider({ nodeUrl: config.network_node_url }),
};
const sepoliaIndexer = new starknet.StarknetIndexer(
  createWriters(sepoliaContext),
);
checkpoint.addIndexer("sepolia", config, sepoliaIndexer);

async function run() {
  await checkpoint.reset();

  const app = express();
  app.use(express.json({ limit: "4mb" }));
  app.use(express.urlencoded({ limit: "4mb", extended: false }));
  app.use(cors({ maxAge: 86400 }));
  app.use("/", checkpoint.graphql);

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Listening at http://localhost:${PORT}`));

  await checkpoint.start();
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
