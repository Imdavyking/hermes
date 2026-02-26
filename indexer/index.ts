import express from "express";
import Checkpoint from "@snapshot-labs/checkpoint";
import config from "./config.json";
import * as writers from "./writers";
import schema from "./schema.gql";

stark

const indexer = new starknet.StarknetIndexer(writers);
const checkpoint = new Checkpoint(config, indexer, schema);

const app = express();
app.use("/graphql", checkpoint.graphql);
checkpoint.start();

app.listen(3000, () => console.log("Running at http://localhost:3000/graphql"));
