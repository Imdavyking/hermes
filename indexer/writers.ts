import { starknet } from "@snapshot-labs/checkpoint";
import {
  Deposit,
  Withdrawal,
  WbtcOrder,
  StrkOrder,
  OwnershipTransfer,
} from "../.checkpoint/models";

// -------------------------------------------------------
// Helper: convert a felt252/u256 hex value to a
// consistent lowercase hex string for use as an ID or field.
// -------------------------------------------------------
function toHex(value: string): string {
  if (!value) return "0x0";
  const hex = BigInt(value).toString(16);
  return "0x" + hex;
}

// -------------------------------------------------------
// Helper: read a u256 from two consecutive felts in event.data.
// Starknet encodes u256 as [low, high] — two 128-bit felts.
// Returns a decimal string to avoid precision loss.
// -------------------------------------------------------
function readU256(low: string, high: string): string {
  const lo = BigInt(low || "0");
  const hi = BigInt(high || "0");
  return ((hi << 128n) | lo).toString();
}

// -------------------------------------------------------
// DEPOSIT
// event data layout:
//   [0] commitment.low
//   [1] commitment.high
//   [2] leaf_index
//   [3] timestamp
// -------------------------------------------------------
export const handleDeposit: starknet.Writer = async ({ event, block, tx }) => {
  if (!event) return;

  const commitment = readU256(event.data[0], event.data[1]);
  const id = toHex(commitment);

  const deposit = new Deposit(id);
  deposit.commitment = id;
  deposit.leaf_index = Number(event.data[2]);
  deposit.timestamp = BigInt(event.data[3]);
  deposit.block_number = block.block_number;
  deposit.tx_hash = tx.transaction_hash;

  await deposit.save();
};

// -------------------------------------------------------
// WITHDRAWAL (ZK direct withdrawal)
// event data layout:
//   [0] recipient
//   [1] nullifier_hash.low
//   [2] nullifier_hash.high
// -------------------------------------------------------
export const handleWithdrawal: starknet.Writer = async ({ event, block, tx }) => {
  if (!event) return;

  const nullifierHash = readU256(event.data[1], event.data[2]);
  const id = toHex(nullifierHash);

  const withdrawal = new Withdrawal(id);
  withdrawal.recipient = toHex(event.data[0]);
  withdrawal.nullifier_hash = id;
  withdrawal.block_number = block.block_number;
  withdrawal.tx_hash = tx.transaction_hash;

  await withdrawal.save();
};

// -------------------------------------------------------
// WBTC ORDER POSTED
// event data layout:
//   [0]  order_id.low
//   [1]  order_id.high
//   [2]  wbtc_seller
//   [3]  alice_strk_destination
//   [4]  wbtc_amount.low
//   [5]  wbtc_amount.high
//   [6]  quoted_strk_amount.low
//   [7]  quoted_strk_amount.high
//   [8]  hashlock
//   [9]  expiry
//   [10] rate_expiry
// -------------------------------------------------------
export const handleWbtcOrderPosted: starknet.Writer = async ({ event, block, tx }) => {
  if (!event) return;

  const orderId = readU256(event.data[0], event.data[1]);
  const id = toHex(orderId);

  const order = new WbtcOrder(id);
  order.wbtc_seller = toHex(event.data[2]);
  order.alice_strk_destination = toHex(event.data[3]);
  order.wbtc_amount = readU256(event.data[4], event.data[5]);
  order.quoted_strk_amount = readU256(event.data[6], event.data[7]);
  order.hashlock = toHex(event.data[8]);
  order.expiry = BigInt(event.data[9]);
  order.rate_expiry = BigInt(event.data[10]);

  // Defaults
  order.is_filled = false;
  order.is_withdrawn = false;
  order.is_refunded = false;
  order.posted_at_block = block.block_number;
  order.posted_tx_hash = tx.transaction_hash;

  await order.save();
};

// -------------------------------------------------------
// WBTC ORDER FILLED
// event data layout:
//   [0] wbtc_order_id.low
//   [1] wbtc_order_id.high
//   [2] strk_order_id.low
//   [3] strk_order_id.high
//   [4] bob
//   [5] strk_amount_locked.low
//   [6] strk_amount_locked.high
//   [7] bob_expiry
// -------------------------------------------------------
export const handleWbtcOrderFilled: starknet.Writer = async ({ event, block, tx }) => {
  if (!event) return;

  const wbtcOrderId = toHex(readU256(event.data[0], event.data[1]));
  const strkOrderId = toHex(readU256(event.data[2], event.data[3]));

  // Update the WbtcOrder
  const order = await WbtcOrder.loadEntity(wbtcOrderId);
  if (order) {
    order.wbtc_buyer = toHex(event.data[4]);
    order.strk_order_id = strkOrderId;
    order.strk_amount_locked = readU256(event.data[5], event.data[6]);
    order.bob_expiry = BigInt(event.data[7]);
    order.is_filled = true;
    order.filled_at_block = block.block_number;
    await order.save();
  }

  // Create the StrkOrder record
  const strkOrder = new StrkOrder(strkOrderId);
  strkOrder.strk_seller = toHex(event.data[4]); // bob
  // strk_buyer is alice_strk_destination — load from wbtc order if available
  strkOrder.strk_buyer = order ? order.alice_strk_destination : "0x0";
  strkOrder.strk_amount = readU256(event.data[5], event.data[6]);
  strkOrder.hashlock = order ? order.hashlock : "0x0";
  strkOrder.expiry = BigInt(event.data[7]);
  strkOrder.wbtc_order_id = wbtcOrderId;
  strkOrder.is_withdrawn = false;
  strkOrder.is_refunded = false;
  strkOrder.posted_at_block = block.block_number;
  strkOrder.posted_tx_hash = tx.transaction_hash;

  await strkOrder.save();
};

// -------------------------------------------------------
// WBTC WITHDRAWN (Bob claims his wBTC)
// event data layout:
//   [0] order_id.low
//   [1] order_id.high
//   [2] wbtc_buyer
// -------------------------------------------------------
export const handleWbtcWithdrawn: starknet.Writer = async ({ event, block, tx }) => {
  if (!event) return;

  const orderId = toHex(readU256(event.data[0], event.data[1]));
  const order = await WbtcOrder.loadEntity(orderId);
  if (order) {
    order.is_withdrawn = true;
    order.withdrawn_at_block = block.block_number;
    await order.save();
  }
};

// -------------------------------------------------------
// STRK WITHDRAWN (Alice claims her STRK)
// event data layout:
//   [0] order_id.low
//   [1] order_id.high
//   [2] strk_buyer
// -------------------------------------------------------
export const handleStrkWithdrawn: starknet.Writer = async ({ event, block, tx }) => {
  if (!event) return;

  const orderId = toHex(readU256(event.data[0], event.data[1]));
  const order = await StrkOrder.loadEntity(orderId);
  if (order) {
    order.is_withdrawn = true;
    order.withdrawn_at_block = block.block_number;
    await order.save();
  }
};

// -------------------------------------------------------
// WBTC REFUNDED (Alice reclaims wBTC after expiry)
// event data layout:
//   [0] order_id.low
//   [1] order_id.high
//   [2] wbtc_seller
// -------------------------------------------------------
export const handleWbtcRefunded: starknet.Writer = async ({ event, block, tx }) => {
  if (!event) return;

  const orderId = toHex(readU256(event.data[0], event.data[1]));
  const order = await WbtcOrder.loadEntity(orderId);
  if (order) {
    order.is_refunded = true;
    order.refunded_at_block = block.block_number;
    await order.save();
  }
};

// -------------------------------------------------------
// STRK REFUNDED (Bob reclaims STRK after expiry)
// event data layout:
//   [0] order_id.low
//   [1] order_id.high
//   [2] strk_seller
// -------------------------------------------------------
export const handleStrkRefunded: starknet.Writer = async ({ event, block, tx }) => {
  if (!event) return;

  const orderId = toHex(readU256(event.data[0], event.data[1]));
  const order = await StrkOrder.loadEntity(orderId);
  if (order) {
    order.is_refunded = true;
    order.refunded_at_block = block.block_number;
    await order.save();
  }
};

// -------------------------------------------------------
// STRK ORDER POSTED (direct/off-chain coordinated order)
// event data layout:
//   [0] order_id (felt252)
//   [1] strk_seller
//   [2] strk_buyer
//   [3] strk_amount.low
//   [4] strk_amount.high
//   [5] hashlock
//   [6] expiry
// -------------------------------------------------------
export const handleStrkOrderPosted: starknet.Writer = async ({ event, block, tx }) => {
  if (!event) return;

  const id = toHex(event.data[0]);

  const order = new StrkOrder(id);
  order.strk_seller = toHex(event.data[1]);
  order.strk_buyer = toHex(event.data[2]);
  order.strk_amount = readU256(event.data[3], event.data[4]);
  order.hashlock = toHex(event.data[5]);
  order.expiry = BigInt(event.data[6]);
  order.wbtc_order_id = null;
  order.is_withdrawn = false;
  order.is_refunded = false;
  order.posted_at_block = block.block_number;
  order.posted_tx_hash = tx.transaction_hash;

  await order.save();
};

// -------------------------------------------------------
// OWNERSHIP TRANSFERRED
// event data layout:
//   [0] previous_owner
//   [1] new_owner
// -------------------------------------------------------
export const handleOwnershipTransferred: starknet.Writer = async ({ event, block, tx }) => {
  if (!event) return;

  const transfer = new OwnershipTransfer(tx.transaction_hash);
  transfer.previous_owner = toHex(event.data[0]);
  transfer.new_owner = toHex(event.data[1]);
  transfer.block_number = block.block_number;
  transfer.tx_hash = tx.transaction_hash;

  await transfer.save();
};
