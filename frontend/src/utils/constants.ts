/// <reference types="vite/client" />
import { constants } from "starknet";

export const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS;
export const GRAPH_QL_ENDPOINT = import.meta.env.VITE_GRAPH_QL_ENDPOINT;
export const CHAIN_ID = constants.NetworkName.SN_SEPOLIA;
export const ARGENT_WEBWALLET_URL =
  process.env.NEXT_PUBLIC_ARGENT_WEBWALLET_URL ||
  "https://sepolia-web.argent.xyz";
