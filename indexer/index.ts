import "dotenv/config";
import express from "express";
import Checkpoint, { starknet } from "@snapshot-labs/checkpoint";
import { config } from "./config";
import * as writers from "./writers";
import fs from "fs";
import path from "path";

const schema = fs.readFileSync(path.join(__dirname, "./schema.gql"), "utf-8");

async function main() {
  // Create the Starknet indexer with our event writers
  const indexer = new starknet.StarknetIndexer(writers);

  // Initialize Checkpoint with config, indexer, schema, and DB connection
  const checkpoint = new Checkpoint(config, indexer, schema, {
    dbConnection: process.env.DATABASE_URL!,
  });

  // Generate ORM models from schema (runs once on startup)
  checkpoint
    .reset()
    .then(() => checkpoint.seedCheckpoints(checkpointBlocks))
    .then(() => {
      // start the indexer
      checkpoint.start();
    });

  // Start indexing from the configured start block
  checkpoint.start();

  // Mount GraphQL endpoint
  const app = express();
  app.use("/graphql", checkpoint.graphql);

  // Health check
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      contract:
        "0x6672ba9611e8c31ad69f54cb5a8ec0eccdead4bf330b06ab0db585b4a0be1dc",
    });
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  PrivateSwap Indexer running
  GraphQL:  http://localhost:${PORT}/graphql
  Health:   http://localhost:${PORT}/health
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
