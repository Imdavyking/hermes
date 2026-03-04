import { uint256 } from "starknet";
import { account, contract, getExecuteNowPayload } from "./starknet";

const ORDER_ID = "1";
// Atomiq escrow state values (mirrors the Cairo constants)
const ESCROW_STATE_SOFT_CLAIMED = 2n;
const ESCROW_STATE_CLAIMED = 3n;
const ESCROW_STATE_REFUNDABLE = 4n;
const ATOMIQ_ESCROW_ADDRESS =
  "0x017bf50dd28b6d823a231355bb25813d4396c8e19d2df03026038714a22f0413";

async function getAtomiqEscrowState(
  escrow: Record<string, unknown>,
): Promise<bigint> {
  const raw = await account.callContract({
    contractAddress: ATOMIQ_ESCROW_ADDRESS,
    entrypoint: "get_state",
    calldata: [
      escrow.offerer,
      escrow.claimer,
      escrow.token,
      escrow.refund_handler,
      escrow.claim_handler,
      escrow.flags,
      escrow.claim_data,
      escrow.refund_data,
      // u256 amount: low, high
      (
        BigInt(escrow.amount as bigint) & 0xffffffffffffffffffffffffffffffffn
      ).toString(),
      (BigInt(escrow.amount as bigint) >> 128n).toString(),
      escrow.fee_token,
      // u256 security_deposit: low, high
      (
        BigInt(escrow.security_deposit as bigint) &
        0xffffffffffffffffffffffffffffffffn
      ).toString(),
      (BigInt(escrow.security_deposit as bigint) >> 128n).toString(),
      // u256 claimer_bounty: low, high
      (
        BigInt(escrow.claimer_bounty as bigint) &
        0xffffffffffffffffffffffffffffffffn
      ).toString(),
      (BigInt(escrow.claimer_bounty as bigint) >> 128n).toString(),
      // Option::None for success_action → discriminant 1
      "0x1",
    ].map(String),
  });

  // callContract returns string[] — cast away the incorrect type
  const result = raw as unknown as string[];

  // EscrowState layout: [init_blockheight, finish_blockheight, state]
  const initBlockheight = BigInt(result[0]);
  const finishBlockheight = BigInt(result[1]);
  const state = BigInt(result[2]);

  const stateLabel: Record<string, string> = {
    "1": "COMMITED (in-flight)",
    "2": "SOFT_CLAIMED (payment seen, not yet on-chain)",
    "3": "CLAIMED ✓ — BTC delivered",
    "4": "REFUNDABLE — LP failed",
  };

  console.log("Atomiq EscrowState:", {
    init_blockheight: initBlockheight.toString(),
    finish_blockheight: finishBlockheight.toString(),
    state: `${state} — ${stateLabel[state.toString()] ?? "unknown"}`,
  });

  return state;
}

async function demo() {
  console.log(`Demo: force-executing DCA order ${ORDER_ID}...`);

  const orderIdU256 = uint256.bnToUint256(BigInt(ORDER_ID));

  // ── Step 1: clear any pending escrow ──────────────────────────────────────
  const needsRefund: boolean =
    await contract.dca_interval_needs_refund(orderIdU256);
  if (needsRefund) {
    const pendingEscrow = await contract.get_dca_pending_escrow(orderIdU256);
    console.log("Pending escrow detected, checking Atomiq state...");

    console.log({ pendingEscrow });

    let escrowState: bigint;
    try {
      escrowState = await getAtomiqEscrowState(pendingEscrow);
    } catch (e) {
      console.error("Could not read Atomiq escrow state:", e);
      return;
    }

    const stateLabel: Record<string, string> = {
      "1": "COMMITED (in-flight)",
      "2": "SOFT_CLAIMED (payment seen off-chain, not yet on-chain)",
      "3": "CLAIMED ✓",
      "4": "REFUNDABLE",
    };
    console.log(
      `Atomiq escrow state: ${escrowState} — ${stateLabel[escrowState.toString()] ?? "unknown"}`,
    );

    if (
      escrowState !== ESCROW_STATE_CLAIMED &&
      escrowState !== ESCROW_STATE_REFUNDABLE &&
      escrowState !== ESCROW_STATE_SOFT_CLAIMED
    ) {
      console.log(
        "\n⏳ Escrow is still in-flight. Cannot proceed until the LP claims or the escrow becomes refundable.",
        "\n   Re-run this script once the Atomiq LP has processed the swap.",
        `\n   Interval index: ${await contract.get_dca_pending_interval_index(orderIdU256)}`,
      );
      return;
    }

    console.log("Escrow settled — calling refund_dca_interval...");
    const refundTx = await account.execute([
      {
        contractAddress: contract.address,
        entrypoint: "refund_dca_interval",
        calldata: [orderIdU256.low, orderIdU256.high],
      },
    ]);
    console.log("refund_dca_interval tx:", refundTx.transaction_hash);
    const refundReceipt = await account.waitForTransaction(
      refundTx.transaction_hash,
    );
    if (!refundReceipt.isSuccess()) {
      console.error("✗ refund_dca_interval reverted:", refundReceipt);
      return;
    }
    console.log(
      escrowState === ESCROW_STATE_CLAIMED
        ? "✓ Interval confirmed — BTC was delivered, next interval unlocked."
        : "✓ Interval rolled back — keeper will retry automatically.",
    );
  }

  // ── Step 2: execute the next interval ─────────────────────────────────────
  const calls = await getExecuteNowPayload(ORDER_ID);
  if (!calls) {
    console.error("Failed to build payload");
    return;
  }

  console.log(`Submitting ${calls.length} call(s)...`);
  const tx = await account.execute(calls);
  console.log("tx:", tx.transaction_hash);
  const receipt = await account.waitForTransaction(tx.transaction_hash);
  console.log(receipt.isSuccess() ? "✓ confirmed" : "✗ reverted", receipt);
}

demo().catch(console.error);
