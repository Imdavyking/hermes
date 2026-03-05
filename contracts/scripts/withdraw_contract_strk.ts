import { uint256, CallData } from "starknet";
import { account, provider } from "./config";

async function main() {
  // ── 1. Read STRK address from contract ───────────────────────────────────

  const config = {
    contractAddress:
      "0x239ff2dfb282380b45db1cb4ee4a204d770976dfaeeba17080d9f81befbd6ad",
  };

  const strkAddress =
    "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
  console.log(`STRK token address: ${strkAddress}`);

  // ── 2. Read contract's STRK balance via raw callContract ─────────────────
  const balanceResult = await provider.callContract({
    contractAddress: strkAddress,
    entrypoint: "balance_of",
    calldata: CallData.compile([config.contractAddress]),
  });

  const result = balanceResult as unknown as string[];
  const balance = uint256.uint256ToBN({ low: result[0], high: result[1] });
  console.log(
    `Contract STRK balance: ${balance} (${Number(balance) / 1e18} STRK)`,
  );

  if (balance === BigInt(0)) {
    console.log("Nothing to withdraw.");
    return;
  }

  // ── 3. Withdraw all to admin via raw execute ──────────────────────────────
  const recipient = account.address;
  console.log(`Withdrawing to: ${recipient}`);

  const balanceU256 = uint256.bnToUint256(balance);

  const tx = await account.execute([
    {
      contractAddress: config.contractAddress,
      entrypoint: "withdraw_strk_admin",
      calldata: CallData.compile([balanceU256, recipient]),
    },
  ]);
  console.log(`Tx submitted: ${tx.transaction_hash}`);

  const receipt = await account.waitForTransaction(tx.transaction_hash);
  const reverted = (receipt as any).revert_reason;
  if (reverted) throw new Error(`Transaction reverted: ${reverted}`);

  console.log(`✓ Withdrew ${Number(balance) / 1e18} STRK to ${recipient}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
