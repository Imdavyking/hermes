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

const sepoliaContext: Context = {
  indexerName: "sepolia",
  provider: new RpcProvider({ nodeUrl: config.network_node_url }),
};
const sepoliaIndexer = new starknet.StarknetIndexer(
  createWriters(sepoliaContext),
);
checkpoint.addIndexer("sepolia", config, sepoliaIndexer);

// ── Version-based reset ───────────────────────────────────────────────────────
async function initializeCheckpoint() {
  const GIT_COMMIT =
    process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT;

  if (!GIT_COMMIT) {
    console.log("No GIT_COMMIT found, resetting (local dev).");
    await checkpoint.resetMetadata();
    await checkpoint.reset();
    return;
  }

  const currentVersionTag = `commit:${GIT_COMMIT}|contract:${config.sources[0].contract}|start:${config.start}`;
  const { knex } = checkpoint.getBaseContext();

  const isInitialized = await knex.schema.hasTable("_metadatas");
  if (isInitialized) {
    const row = await knex
      .select("*")
      .from("_metadatas")
      .where({ id: "version_tag", indexer: "_global" })
      .first();

    const storedTag = row?.value ?? null;

    if (storedTag === currentVersionTag) {
      console.log("Version unchanged, continuing.", { currentVersionTag });
      return;
    }

    console.log("Version changed, resetting.", {
      currentVersionTag,
      storedTag,
    });
  }

  await checkpoint.resetMetadata();
  await checkpoint.reset();

  await knex("_metadatas").insert({
    id: "version_tag",
    indexer: "_global",
    value: currentVersionTag,
  });
}

async function run() {
  const app = express();
  app.use(express.json({ limit: "4mb" }));
  app.use(express.urlencoded({ limit: "4mb", extended: false }));
  app.use(cors({ maxAge: 86400 }));
  app.use("/", checkpoint.graphql);

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Listening at http://localhost:${PORT}`));

  await initializeCheckpoint();
  await checkpoint.start();
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
