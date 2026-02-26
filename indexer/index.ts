import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import Checkpoint, { LogLevel } from "@snapshot-labs/checkpoint";
import { config } from "./config.ts";
import { writers } from "./writers";
import checkpointBlocks from "./checkpoints.json";

const dir = __dirname.endsWith("dist/src") ? "../" : "";
const schemaFile = path.join(__dirname, `${dir}../src/schema.gql`);
const schema = fs.readFileSync(schemaFile, "utf8");

const checkpointOptions = {
  logLevel: LogLevel.Info,
  // prettifyLogs: true, // uncomment for local dev
};

// Initialize checkpoint
const checkpoint = new Checkpoint(config, writers, schema, checkpointOptions);

// Reset entities, seed checkpoints, then start indexing
checkpoint
  .reset()
  .then(() => checkpoint.seedCheckpoints(checkpointBlocks))
  .then(() => {
    checkpoint.start();
  });

const app = express();
app.use(express.json({ limit: "4mb" }));
app.use(express.urlencoded({ limit: "4mb", extended: false }));
app.use(cors({ maxAge: 86400 }));

// Mount Checkpoint's GraphQL API on /
app.use("/", checkpoint.graphql);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening at http://localhost:${PORT}`));
