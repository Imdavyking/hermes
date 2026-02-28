/// <reference types="vite/client" />
import { constants } from "starknet";

export const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS;
export const GRAPH_QL_ENDPOINT = import.meta.env.VITE_GRAPH_QL_ENDPOINT;
export const NATIVE_TOKEN =
  "0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
export const CHAIN_ID = constants.NetworkName.SN_SEPOLIA;
export const ARGENT_WEBWALLET_URL =
  process.env.NEXT_PUBLIC_ARGENT_WEBWALLET_URL ||
  "https://sepolia-web.argent.xyz";
export const FIELD_MODULUS = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617",
);
export const U64_MAX = 18446744073709551615n;
export const U128_MAX = 340282366920938463463374607431768211455n;
