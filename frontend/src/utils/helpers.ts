import * as bcu from "bigint-crypto-utils";
import type { GetTransactionReceiptResponse } from "starknet";
export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
const U256_LIMB_COUNT = 3;
const LIMB_BITS = 120n;
const LIMB_MASK = (1n << LIMB_BITS) - 1n;

export function toU256Limbs(n: bigint): string[] {
  if (typeof n !== "bigint") throw Error("use bigint");
  const limbs = [];
  let val = n;
  for (let i = 0; i < U256_LIMB_COUNT; i++) {
    limbs.push((val & LIMB_MASK).toString());
    val = val >> LIMB_BITS;
  }
  return limbs;
}

export function fromU256Limbs(limbs: string[]): bigint {
  if (!Array.isArray(limbs))
    throw new Error(`Expected array, got ${typeof limbs}: ${limbs}`);
  let result = 0n;
  for (let i = 0; i < limbs.length; i++) {
    result += BigInt(limbs[i]) << (LIMB_BITS * BigInt(i));
  }
  return result;
}

// Convert limbs to BigInt array for StarkNet call
export const limbsToBigInt = (limbs: string[]) => limbs.map((l) => BigInt(l));
export const limbsToBigIntFull = (limbs: string[]): bigint => {
  const SHIFT = 120n;
  return limbs.reduce(
    (acc, limb, i) => acc + BigInt(limb) * 2n ** (SHIFT * BigInt(i)),
    0n,
  );
};
export const randomNonceBytesHex = (length: number): `0x${string}` => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let hex: `0x${string}` = "0x";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
};

export const getRandomR = (n: bigint): bigint => {
  let r = 0n;
  do {
    r = bcu.randBetween(n);
  } while (bcu.gcd(r, n) !== 1n);
  return r;
};


export function assertReceiptSuccess(receipt: GetTransactionReceiptResponse) {
  if (receipt.isReverted()) {
    throw new Error(receipt.revert_reason ?? "Transaction reverted");
  }
  if (receipt.isError()) {
    throw new Error("Transaction error");
  }
}