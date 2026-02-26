import { starknet } from "@snapshot-labs/checkpoint";
import {
  Deposit,
  Withdrawal,
  WbtcOrder,
  StrkOrder,
  OwnershipTransfer,
} from "../.checkpoint/models";
import { toHexAddress } from "./shared";
import { Context } from "./index";

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

// u256 is encoded as two consecutive felts: [low, high]
// Returns a DECIMAL string suitable for BigDecimalU256 / numeric columns.
function readU256(low: string, high: string): string {
  const lo = BigInt(low || "0");
  const hi = BigInt(high || "0");
  return ((hi << 128n) | lo).toString(); // decimal string ✓
}

// When the ABI decoder gives us a single already-combined u256 value,
// convert it to decimal (it may arrive as a hex string or bigint).
function toDecimal(value: string | bigint | number): string {
  return BigInt(value).toString();
}

// -------------------------------------------------------
// Factory
// -------------------------------------------------------
export function createWriters(ctx: Context) {
  // -------------------------------------------------------
  // DEPOSIT
  // rawEvent.data: [commitment.low, commitment.high, leaf_index, timestamp]
  // -------------------------------------------------------
  const handleDeposit: starknet.Writer = async ({
    event,
    rawEvent,
    block,
    txId,
  }) => {
    if (!block) return;

    let commitment: string;
    let leafIndex: number;
    let timestamp: number;

    if (event) {
      commitment = toDecimal(event.commitment); // was toHexAddress — FIXED
      leafIndex = Number(event.leaf_index);
      timestamp = Number(event.timestamp);
    } else if (rawEvent) {
      commitment = readU256(rawEvent.data[0], rawEvent.data[1]);
      leafIndex = Number(rawEvent.data[2]);
      timestamp = Number(rawEvent.data[3]);
    } else return;

    const deposit = new Deposit(commitment, ctx.indexerName);
    deposit.commitment = commitment;
    deposit.leaf_index = leafIndex;
    deposit.timestamp = timestamp;
    deposit.block_number = block.block_number;
    deposit.tx_hash = txId;

    await deposit.save();
  };

  // -------------------------------------------------------
  // WITHDRAWAL
  // rawEvent.data: [recipient, nullifier_hash.low, nullifier_hash.high]
  // -------------------------------------------------------
  const handleWithdrawal: starknet.Writer = async ({
    event,
    rawEvent,
    block,
    txId,
  }) => {
    if (!block) return;

    let recipient: string;
    let nullifierHash: string;

    if (event) {
      recipient = toHexAddress(event.recipient);
      nullifierHash = toDecimal(event.nullifier_hash); // was toHexAddress — FIXED
    } else if (rawEvent) {
      recipient = toHexAddress(rawEvent.data[0]);
      nullifierHash = readU256(rawEvent.data[1], rawEvent.data[2]);
    } else return;

    const withdrawal = new Withdrawal(nullifierHash, ctx.indexerName);
    withdrawal.recipient = recipient;
    withdrawal.nullifier_hash = nullifierHash;
    withdrawal.block_number = block.block_number;
    withdrawal.tx_hash = txId;

    await withdrawal.save();
  };

  // -------------------------------------------------------
  // WBTC ORDER POSTED
  // rawEvent.data: [order_id.low, order_id.high, wbtc_seller,
  //                 alice_strk_destination, wbtc_amount.low, wbtc_amount.high,
  //                 quoted_strk_amount.low, quoted_strk_amount.high,
  //                 hashlock, expiry, rate_expiry]
  // -------------------------------------------------------
  const handleWbtcOrderPosted: starknet.Writer = async ({
    event,
    rawEvent,
    block,
    txId,
  }) => {
    if (!block) return;

    let id: string;
    let wbtcSeller: string;
    let aliceStrkDest: string;
    let wbtcAmount: string;
    let quotedStrkAmount: string;
    let hashlock: string;
    let expiry: number;
    let rateExpiry: number;

    if (event) {
      id = toDecimal(event.order_id); // was toHexAddress — FIXED
      wbtcSeller = toHexAddress(event.wbtc_seller);
      aliceStrkDest = toHexAddress(event.alice_strk_destination);
      // ABI gives combined u256 — convert directly to decimal
      wbtcAmount = toDecimal(event.wbtc_amount); // was readU256(val, "0") — FIXED
      quotedStrkAmount = toDecimal(event.quoted_strk_amount); // same — FIXED
      hashlock = toHexAddress(event.hashlock);
      expiry = Number(event.expiry);
      rateExpiry = Number(event.rate_expiry);
    } else if (rawEvent) {
      const d = rawEvent.data;
      id = readU256(d[0], d[1]);
      wbtcSeller = toHexAddress(d[2]);
      aliceStrkDest = toHexAddress(d[3]);
      wbtcAmount = readU256(d[4], d[5]);
      quotedStrkAmount = readU256(d[6], d[7]);
      hashlock = toHexAddress(d[8]);
      expiry = Number(d[9]);
      rateExpiry = Number(d[10]);
    } else return;

    const order = new WbtcOrder(id, ctx.indexerName);
    order.wbtc_seller = wbtcSeller;
    order.alice_strk_destination = aliceStrkDest;
    order.wbtc_amount = wbtcAmount;
    order.quoted_strk_amount = quotedStrkAmount;
    order.hashlock = hashlock;
    order.expiry = expiry;
    order.rate_expiry = rateExpiry;
    order.is_filled = false;
    order.is_withdrawn = false;
    order.is_refunded = false;
    order.posted_at_block = block.block_number;
    order.posted_tx_hash = txId;

    await order.save();
  };

  // -------------------------------------------------------
  // WBTC ORDER FILLED
  // rawEvent.data: [wbtc_order_id.low, wbtc_order_id.high,
  //                 strk_order_id.low, strk_order_id.high,
  //                 bob, strk_amount_locked.low, strk_amount_locked.high,
  //                 bob_expiry]
  // -------------------------------------------------------
  const handleWbtcOrderFilled: starknet.Writer = async ({
    event,
    rawEvent,
    block,
    txId,
  }) => {
    if (!block) return;

    let wbtcOrderId: string;
    let strkOrderId: string;
    let bob: string;
    let strkAmount: string;
    let bobExpiry: number;

    if (event) {
      wbtcOrderId = toDecimal(event.wbtc_order_id); // was toHexAddress — FIXED
      strkOrderId = toDecimal(event.strk_order_id); // was toHexAddress — FIXED
      bob = toHexAddress(event.bob);
      strkAmount = toDecimal(event.strk_amount_locked); // was readU256(val, "0") — FIXED
      bobExpiry = Number(event.bob_expiry);
    } else if (rawEvent) {
      const d = rawEvent.data;
      wbtcOrderId = readU256(d[0], d[1]);
      strkOrderId = readU256(d[2], d[3]);
      bob = toHexAddress(d[4]);
      strkAmount = readU256(d[5], d[6]);
      bobExpiry = Number(d[7]);
    } else return;

    const order = await WbtcOrder.loadEntity(wbtcOrderId, ctx.indexerName);
    if (order) {
      order.wbtc_buyer = bob;
      order.strk_order_id = strkOrderId;
      order.strk_amount_locked = strkAmount;
      order.bob_expiry = bobExpiry;
      order.is_filled = true;
      order.filled_at_block = block.block_number;
      await order.save();
    }

    const strkOrder = new StrkOrder(strkOrderId, ctx.indexerName);
    strkOrder.strk_seller = bob;
    strkOrder.strk_buyer = order?.alice_strk_destination ?? "0x0";
    strkOrder.strk_amount = strkAmount;
    strkOrder.hashlock = order?.hashlock ?? "0x0";
    strkOrder.expiry = bobExpiry;
    strkOrder.wbtc_order_id = wbtcOrderId;
    strkOrder.is_withdrawn = false;
    strkOrder.is_refunded = false;
    strkOrder.posted_at_block = block.block_number;
    strkOrder.posted_tx_hash = txId;

    await strkOrder.save();
  };

  // -------------------------------------------------------
  // WBTC WITHDRAWN
  // rawEvent.data: [order_id.low, order_id.high, wbtc_buyer]
  // -------------------------------------------------------
  const handleWbtcWithdrawn: starknet.Writer = async ({
    event,
    rawEvent,
    block,
  }) => {
    if (!block) return;

    const orderId = event
      ? toDecimal(event.order_id) // was toHexAddress — FIXED
      : readU256(rawEvent.data[0], rawEvent.data[1]);

    const order = await WbtcOrder.loadEntity(orderId, ctx.indexerName);
    if (order) {
      order.is_withdrawn = true;
      order.withdrawn_at_block = block.block_number;
      await order.save();
    }
  };

  // -------------------------------------------------------
  // STRK WITHDRAWN
  // rawEvent.data: [order_id.low, order_id.high, strk_buyer]
  // -------------------------------------------------------
  const handleStrkWithdrawn: starknet.Writer = async ({
    event,
    rawEvent,
    block,
  }) => {
    if (!block) return;

    const orderId = event
      ? toDecimal(event.order_id) // was toHexAddress — FIXED
      : readU256(rawEvent.data[0], rawEvent.data[1]);

    const order = await StrkOrder.loadEntity(orderId, ctx.indexerName);
    if (order) {
      order.is_withdrawn = true;
      order.withdrawn_at_block = block.block_number;
      await order.save();
    }
  };

  // -------------------------------------------------------
  // WBTC REFUNDED
  // rawEvent.data: [order_id.low, order_id.high, wbtc_seller]
  // -------------------------------------------------------
  const handleWbtcRefunded: starknet.Writer = async ({
    event,
    rawEvent,
    block,
  }) => {
    if (!block) return;

    const orderId = event
      ? toDecimal(event.order_id) // was toHexAddress — FIXED
      : readU256(rawEvent.data[0], rawEvent.data[1]);

    const order = await WbtcOrder.loadEntity(orderId, ctx.indexerName);
    if (order) {
      order.is_refunded = true;
      order.refunded_at_block = block.block_number;
      await order.save();
    }
  };

  // -------------------------------------------------------
  // STRK REFUNDED
  // rawEvent.data: [order_id.low, order_id.high, strk_seller]
  // -------------------------------------------------------
  const handleStrkRefunded: starknet.Writer = async ({
    event,
    rawEvent,
    block,
  }) => {
    if (!block) return;

    const orderId = event
      ? toDecimal(event.order_id) // was toHexAddress — FIXED
      : readU256(rawEvent.data[0], rawEvent.data[1]);

    const order = await StrkOrder.loadEntity(orderId, ctx.indexerName);
    if (order) {
      order.is_refunded = true;
      order.refunded_at_block = block.block_number;
      await order.save();
    }
  };

  // -------------------------------------------------------
  // OWNERSHIP TRANSFERRED
  // rawEvent.data: [previous_owner, new_owner]
  // -------------------------------------------------------
  const handleOwnershipTransferred: starknet.Writer = async ({
    event,
    rawEvent,
    block,
    txId,
  }) => {
    if (!block) return;

    const previousOwner = event
      ? toHexAddress(event.previous_owner)
      : toHexAddress(rawEvent.data[0]);
    const newOwner = event
      ? toHexAddress(event.new_owner)
      : toHexAddress(rawEvent.data[1]);

    const transfer = new OwnershipTransfer(txId, ctx.indexerName);
    transfer.previous_owner = previousOwner;
    transfer.new_owner = newOwner;
    transfer.block_number = block.block_number;
    transfer.tx_hash = txId;

    await transfer.save();
  };

  return {
    handleDeposit,
    handleWithdrawal,
    handleWbtcOrderPosted,
    handleWbtcOrderFilled,
    handleWbtcWithdrawn,
    handleStrkWithdrawn,
    handleWbtcRefunded,
    handleStrkRefunded,
    handleOwnershipTransferred,
  };
}
