export function toHexAddress(address: string | bigint | number): string {
  let addy: bigint;
  if (typeof address === "string" || typeof address === "number") {
    addy = BigInt(address);
  } else {
    addy = address;
  }
  const hexString = addy.toString(16);
  const paddedHex = hexString.padStart(64, "0");
  return `0x${paddedHex}`;
}

// Starknet encodes u256 as { low, high } — decoded by Checkpoint automatically
// when an ABI is provided. Without ABI, they come as two raw consecutive felts.
// With ABI (our setup), they come as a single decoded bigint.
export function u256ToString(value: bigint | string): string {
  return BigInt(value).toString();
}
