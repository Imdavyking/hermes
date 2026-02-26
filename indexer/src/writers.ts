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
function readU256(low: string, high: string): string {
  const lo = BigInt(low || "0");
  const hi = BigInt(high || "0");
  return ((hi << 128n) | lo).toString();
}

// -------------------------------------------------------
// Factory
// -------------------------------------------------------
export function createWriters(ctx: Context) {
  // -------------------------------------------------------
  // DEPOSIT
  // rawEvent.data: [commitment.low, commitment.high, leaf_index, timestamp]
  // event (if ABI):  { commitment, leaf_index, timestamp }
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
      // ABI-decoded path
      commitment = toHexAddress(event.commitment);
      leafIndex = Number(event.leaf_index);
      timestamp = Number(event.timestamp);
    } else if (rawEvent) {
      // Raw fallback
      commitment = toHexAddress(readU256(rawEvent.data[0], rawEvent.data[1]));
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
  // event (if ABI):  { recipient, nullifier_hash }
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
      nullifierHash = toHexAddress(event.nullifier_hash);
    } else if (rawEvent) {
      recipient = toHexAddress(rawEvent.data[0]);
      nullifierHash = toHexAddress(
        readU256(rawEvent.data[1], rawEvent.data[2]),
      );
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
      id = toHexAddress(event.order_id);
      wbtcSeller = toHexAddress(event.wbtc_seller);
      aliceStrkDest = toHexAddress(event.alice_strk_destination);
      wbtcAmount = readU256(event.wbtc_amount, "0");
      quotedStrkAmount = readU256(event.quoted_strk_amount, "0");
      hashlock = toHexAddress(event.hashlock);
      expiry = Number(event.expiry);
      rateExpiry = Number(event.rate_expiry);
    } else if (rawEvent) {
      const d = rawEvent.data;
      id = toHexAddress(readU256(d[0], d[1]));
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
      wbtcOrderId = toHexAddress(event.wbtc_order_id);
      strkOrderId = toHexAddress(event.strk_order_id);
      bob = toHexAddress(event.bob);
      strkAmount = readU256(event.strk_amount_locked, "0");
      bobExpiry = Number(event.bob_expiry);
    } else if (rawEvent) {
      const d = rawEvent.data;
      wbtcOrderId = toHexAddress(readU256(d[0], d[1]));
      strkOrderId = toHexAddress(readU256(d[2], d[3]));
      bob = toHexAddress(d[4]);
      strkAmount = readU256(d[5], d[6]);
      bobExpiry = Number(d[7]);
    } else return;

    // Update the WbtcOrder
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

    // Create the paired StrkOrder
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
      ? toHexAddress(event.order_id)
      : toHexAddress(readU256(rawEvent.data[0], rawEvent.data[1]));

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
      ? toHexAddress(event.order_id)
      : toHexAddress(readU256(rawEvent.data[0], rawEvent.data[1]));

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
      ? toHexAddress(event.order_id)
      : toHexAddress(readU256(rawEvent.data[0], rawEvent.data[1]));

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
      ? toHexAddress(event.order_id)
      : toHexAddress(readU256(rawEvent.data[0], rawEvent.data[1]));

    const order = await StrkOrder.loadEntity(orderId, ctx.indexerName);
    if (order) {
      order.is_refunded = true;
      order.refunded_at_block = block.block_number;
      await order.save();
    }
  };

  // -------------------------------------------------------
  // STRK ORDER POSTED (direct off-chain order)
  // rawEvent.data: [order_id, strk_seller, strk_buyer,
  //                 strk_amount.low, strk_amount.high, hashlock, expiry]
  // -------------------------------------------------------
  const handleStrkOrderPosted: starknet.Writer = async ({
    event,
    rawEvent,
    block,
    txId,
  }) => {
    if (!block) return;

    let id: string;
    let strkSeller: string;
    let strkBuyer: string;
    let strkAmount: string;
    let hashlock: string;
    let expiry: number;

    if (event) {
      id = toHexAddress(event.order_id);
      strkSeller = toHexAddress(event.strk_seller);
      strkBuyer = toHexAddress(event.strk_buyer);
      strkAmount = readU256(event.strk_amount, "0");
      hashlock = toHexAddress(event.hashlock);
      expiry = Number(event.expiry);
    } else if (rawEvent) {
      const d = rawEvent.data;
      id = toHexAddress(d[0]);
      strkSeller = toHexAddress(d[1]);
      strkBuyer = toHexAddress(d[2]);
      strkAmount = readU256(d[3], d[4]);
      hashlock = toHexAddress(d[5]);
      expiry = Number(d[6]);
    } else return;

    const order = new StrkOrder(id, ctx.indexerName);
    order.strk_seller = strkSeller;
    order.strk_buyer = strkBuyer;
    order.strk_amount = strkAmount;
    order.hashlock = hashlock;
    order.expiry = expiry;
    order.wbtc_order_id = null;
    order.is_withdrawn = false;
    order.is_refunded = false;
    order.posted_at_block = block.block_number;
    order.posted_tx_hash = txId;

    await order.save();
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
    handleStrkOrderPosted,
    handleOwnershipTransferred,
  };
}
