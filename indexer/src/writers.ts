import { starknet } from "@snapshot-labs/checkpoint";
import {
  Deposit,
  Withdrawal,
  WbtcOrder,
  StrkOrder,
  OwnershipTransfer,
  DcaOrder,
  DcaExecution,
} from "../.checkpoint/models";
import { toHexAddress } from "./shared";
import { Context } from "./index";

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

function readU256(low: string, high: string): string {
  const lo = BigInt(low || "0");
  const hi = BigInt(high || "0");
  return ((hi << 128n) | lo).toString();
}

function toDecimal(value: string | bigint | number): string {
  return BigInt(value).toString();
}

// -------------------------------------------------------
// ByteArray decoder
//
// StarkNet serialises ByteArray as:
//   felt252   chunk_count      (number of complete 31-byte chunks)
//   felt252[] data             (chunk_count elements, each a 31-byte word)
//   felt252   pending_word     (partial last chunk, right-aligned)
//   u32       pending_word_len (byte count of pending_word, 0–30)
// -------------------------------------------------------
function readByteArray(
  data: string[],
  offset: number,
): { value: string; nextOffset: number } {
  const chunkCount = Number(data[offset]);
  let str = "";

  for (let i = 0; i < chunkCount; i++) {
    const hex = BigInt(data[offset + 1 + i])
      .toString(16)
      .padStart(62, "0"); // 31 bytes = 62 hex nibbles
    for (let b = 0; b < 31; b++) {
      str += String.fromCharCode(parseInt(hex.slice(b * 2, b * 2 + 2), 16));
    }
  }

  const pendingWord = data[offset + 1 + chunkCount];
  const pendingLen = Number(data[offset + 2 + chunkCount]);

  if (pendingLen > 0) {
    const hex = BigInt(pendingWord)
      .toString(16)
      .padStart(pendingLen * 2, "0");
    for (let b = 0; b < pendingLen; b++) {
      str += String.fromCharCode(parseInt(hex.slice(b * 2, b * 2 + 2), 16));
    }
  }

  return {
    value: str,
    nextOffset: offset + 3 + chunkCount, // chunk_count + chunks + pending_word + pending_word_len
  };
}

// -------------------------------------------------------
// Decode a ByteArray from a parsed event object.
//
// When Checkpoint decodes a Cairo ByteArray event field it produces:
//   { data: string[], pending_word: string, pending_word_len: number }
//
// We reconstruct the flat felt array expected by readByteArray so we
// can reuse the same decoder for both the event and rawEvent paths.
// -------------------------------------------------------
function decodeByteArrayObject(bta: {
  data: string[];
  pending_word: string;
  pending_word_len: number;
}): string {
  const feltArray = [
    String(bta.data.length),
    ...bta.data.map(String),
    String(bta.pending_word),
    String(bta.pending_word_len),
  ];
  return readByteArray(feltArray, 0).value;
}

// -------------------------------------------------------
// DcaExecution status values
//
//   pending  — DCAExecuted fired, STRK committed to Atomiq, BTC not yet confirmed
//   claimed  — DCAIntervalClaimed fired, LP delivered BTC to the user's address
//   refunded — DCAIntervalRefunded fired, LP failed, interval rolled back + STRK reclaimed
// -------------------------------------------------------
const STATUS_PENDING = "pending";
const STATUS_CLAIMED = "claimed";
const STATUS_REFUNDED = "refunded";

// -------------------------------------------------------
// Factory
// -------------------------------------------------------
export function createWriters(ctx: Context) {
  // DEPOSIT
  // rawEvent.data: [commitment.low, commitment.high, leaf_index, timestamp]
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
      commitment = toDecimal(event.commitment);
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

  // WITHDRAWAL
  // rawEvent.data: [recipient, nullifier_hash.low, nullifier_hash.high]
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
      nullifierHash = toDecimal(event.nullifier_hash);
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

  // WBTC ORDER POSTED
  // rawEvent.data: [order_id.low, order_id.high, wbtc_seller,
  //   alice_strk_destination, wbtc_amount.low, wbtc_amount.high,
  //   quoted_strk_amount.low, quoted_strk_amount.high,
  //   hashlock, expiry, rate_expiry]
  const handleWbtcOrderPosted: starknet.Writer = async ({
    event,
    rawEvent,
    block,
    txId,
  }) => {
    if (!block) return;
    let id: string, wbtcSeller: string, aliceStrkDest: string;
    let wbtcAmount: string, quotedStrkAmount: string, hashlock: string;
    let expiry: number, rateExpiry: number;
    if (event) {
      id = toDecimal(event.order_id);
      wbtcSeller = toHexAddress(event.wbtc_seller);
      aliceStrkDest = toHexAddress(event.alice_strk_destination);
      wbtcAmount = toDecimal(event.wbtc_amount);
      quotedStrkAmount = toDecimal(event.quoted_strk_amount);
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

  // WBTC ORDER FILLED
  // rawEvent.data: [wbtc_order_id.low, wbtc_order_id.high,
  //   strk_order_id.low, strk_order_id.high,
  //   bob, strk_amount_locked.low, strk_amount_locked.high, bob_expiry]
  const handleWbtcOrderFilled: starknet.Writer = async ({
    event,
    rawEvent,
    block,
    txId,
  }) => {
    if (!block) return;
    let wbtcOrderId: string, strkOrderId: string, bob: string;
    let strkAmount: string;
    let bobExpiry: number;
    if (event) {
      wbtcOrderId = toDecimal(event.wbtc_order_id);
      strkOrderId = toDecimal(event.strk_order_id);
      bob = toHexAddress(event.bob);
      strkAmount = toDecimal(event.strk_amount_locked);
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

  // WBTC WITHDRAWN
  const handleWbtcWithdrawn: starknet.Writer = async ({
    event,
    rawEvent,
    block,
  }) => {
    if (!block) return;
    const orderId = event
      ? toDecimal(event.order_id)
      : readU256(rawEvent.data[0], rawEvent.data[1]);
    const order = await WbtcOrder.loadEntity(orderId, ctx.indexerName);
    if (order) {
      order.is_withdrawn = true;
      order.withdrawn_at_block = block.block_number;
      await order.save();
    }
  };

  // STRK WITHDRAWN
  const handleStrkWithdrawn: starknet.Writer = async ({
    event,
    rawEvent,
    block,
  }) => {
    if (!block) return;
    const orderId = event
      ? toDecimal(event.order_id)
      : readU256(rawEvent.data[0], rawEvent.data[1]);
    const order = await StrkOrder.loadEntity(orderId, ctx.indexerName);
    if (order) {
      order.is_withdrawn = true;
      order.withdrawn_at_block = block.block_number;
      await order.save();
    }
  };

  // WBTC REFUNDED
  const handleWbtcRefunded: starknet.Writer = async ({
    event,
    rawEvent,
    block,
  }) => {
    if (!block) return;
    const orderId = event
      ? toDecimal(event.order_id)
      : readU256(rawEvent.data[0], rawEvent.data[1]);
    const order = await WbtcOrder.loadEntity(orderId, ctx.indexerName);
    if (order) {
      order.is_refunded = true;
      order.refunded_at_block = block.block_number;
      await order.save();
    }
  };

  // STRK REFUNDED
  const handleStrkRefunded: starknet.Writer = async ({
    event,
    rawEvent,
    block,
  }) => {
    if (!block) return;
    const orderId = event
      ? toDecimal(event.order_id)
      : readU256(rawEvent.data[0], rawEvent.data[1]);
    const order = await StrkOrder.loadEntity(orderId, ctx.indexerName);
    if (order) {
      order.is_refunded = true;
      order.refunded_at_block = block.block_number;
      await order.save();
    }
  };

  // OWNERSHIP TRANSFERRED
  // rawEvent.data: [previous_owner, new_owner]
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

  // =======================================================
  // DCA
  // =======================================================

  // DCA ORDER CREATED
  //
  // rawEvent.data layout:
  //   [0]   order_id.low
  //   [1]   order_id.high
  //   [2]   owner
  //   [3]   usdc_per_interval.low
  //   [4]   usdc_per_interval.high
  //   [5]   interval_seconds
  //   [6]   total_intervals
  //   [7]   total_usdc_deposited.low
  //   [8]   total_usdc_deposited.high
  //   [9]   total_strk_fee_deposited.low   (not stored)
  //   [10]  total_strk_fee_deposited.high  (not stored)
  //   [11…] btc_destination ByteArray (chunk_count, ...chunks, pending_word, pending_word_len)
  const handleDCAOrderCreated: starknet.Writer = async ({
    event,
    rawEvent,
    block,
    txId,
  }) => {
    if (!block) return;
    let orderId: string;
    let owner: string;
    let usdcPerInterval: string;
    let intervalSeconds: number;
    let totalIntervals: number;
    let totalUsdcDeposited: string;
    let btcDestination: string;
    if (event) {
      orderId = toDecimal(event.order_id);
      owner = toHexAddress(event.owner);
      usdcPerInterval = toDecimal(event.usdc_per_interval);
      intervalSeconds = Number(event.interval_seconds);
      totalIntervals = Number(event.total_intervals);
      totalUsdcDeposited = toDecimal(event.total_usdc_deposited);
      // event.btc_destination is a decoded ByteArray object:
      //   { data: string[], pending_word: string, pending_word_len: number }
      btcDestination = decodeByteArrayObject(event.btc_destination);
    } else if (rawEvent) {
      const d = rawEvent.data;
      orderId = readU256(d[0], d[1]);
      owner = toHexAddress(d[2]);
      usdcPerInterval = readU256(d[3], d[4]);
      intervalSeconds = Number(d[5]);
      totalIntervals = Number(d[6]);
      totalUsdcDeposited = readU256(d[7], d[8]);
      // d[9], d[10] = total_strk_fee_deposited — skip
      const decoded = readByteArray(d, 11);
      btcDestination = decoded.value;
    } else return;
    const order = new DcaOrder(orderId, ctx.indexerName);
    order.owner = owner;
    order.usdc_per_interval = usdcPerInterval;
    order.interval_seconds = intervalSeconds;
    order.total_intervals = totalIntervals;
    order.total_usdc_deposited = totalUsdcDeposited;
    order.btc_destination = btcDestination;
    order.executed_intervals = 0;
    order.is_active = true;
    order.last_execution = block.timestamp ?? 0;
    order.created_at_block = block.block_number;
    order.created_tx_hash = txId;
    await order.save();
  };

  // DCA EXECUTED
  //
  // Creates a DcaExecution record with status=pending. BTC has not been
  // confirmed delivered yet — that happens in DCAIntervalClaimed.
  //
  // rawEvent.data: [order_id.low, order_id.high, owner,
  //   usdc_spent.low, usdc_spent.high, btc_received.low, btc_received.high,
  //   executed_intervals, keeper, keeper_fee_paid.low, keeper_fee_paid.high]
  const handleDCAExecuted: starknet.Writer = async ({
    event,
    rawEvent,
    block,
    txId,
  }) => {
    if (!block) return;
    let orderId: string, usdcSpent: string, btcReceived: string, keeper: string;
    let executedIntervals: number;
    if (event) {
      orderId = toDecimal(event.order_id);
      usdcSpent = toDecimal(event.usdc_spent);
      btcReceived = toDecimal(event.btc_received);
      executedIntervals = Number(event.executed_intervals);
      keeper = toHexAddress(event.keeper);
    } else if (rawEvent) {
      const d = rawEvent.data;
      orderId = readU256(d[0], d[1]);
      usdcSpent = readU256(d[3], d[4]);
      btcReceived = readU256(d[5], d[6]);
      executedIntervals = Number(d[7]);
      keeper = toHexAddress(d[8]);
    } else return;

    const order = await DcaOrder.loadEntity(orderId, ctx.indexerName);
    if (order) {
      order.executed_intervals = executedIntervals;
      order.last_execution = block.timestamp ?? 0;
      order.last_executed_at_block = block.block_number;
      if (executedIntervals >= order.total_intervals) order.is_active = false;
      await order.save();
    }

    const exec = new DcaExecution(
      `${orderId}-${executedIntervals}`,
      ctx.indexerName,
    );
    exec.order_id = orderId;
    exec.executed_intervals = executedIntervals;
    exec.usdc_spent = usdcSpent;
    exec.btc_received = btcReceived;
    exec.keeper = keeper;
    exec.status = STATUS_PENDING;
    exec.executed_at_block = block.block_number;
    exec.executed_tx_hash = txId;
    exec.executed_timestamp = block.timestamp ?? 0;
    await exec.save();
  };

  // DCA INTERVAL CLAIMED
  //
  // LP successfully delivered BTC. Updates the DcaExecution status to
  // claimed. The DcaOrder counter is already correct from DCAExecuted —
  // no rollback needed.
  //
  // rawEvent.data: [order_id.low, order_id.high, interval_index]
  const handleDCAIntervalClaimed: starknet.Writer = async ({
    event,
    rawEvent,
    block,
  }) => {
    if (!block) return;
    let orderId: string;
    let intervalIndex: number;
    if (event) {
      orderId = toDecimal(event.order_id);
      intervalIndex = Number(event.interval_index);
    } else if (rawEvent) {
      const d = rawEvent.data;
      orderId = readU256(d[0], d[1]);
      intervalIndex = Number(d[2]);
    } else return;

    const exec = await DcaExecution.loadEntity(
      `${orderId}-${intervalIndex}`,
      ctx.indexerName,
    );
    if (exec) {
      exec.status = STATUS_CLAIMED;
      exec.claimed_at_block = block.block_number;
      await exec.save();
    }
  };

  // DCA INTERVAL REFUNDED
  //
  // LP failed to deliver BTC. The on-chain contract rolled back
  // executed_intervals and last_execution. We mirror that here and mark the
  // execution record as refunded rather than deleting it so the UI can show
  // the full retry history.
  //
  // rawEvent.data: [order_id.low, order_id.high, interval_index,
  //   strk_returned.low, strk_returned.high]
  const handleDCAIntervalRefunded: starknet.Writer = async ({
    event,
    rawEvent,
    block,
  }) => {
    if (!block) return;
    let orderId: string;
    let intervalIndex: number;
    if (event) {
      orderId = toDecimal(event.order_id);
      intervalIndex = Number(event.interval_index);
    } else if (rawEvent) {
      const d = rawEvent.data;
      orderId = readU256(d[0], d[1]);
      intervalIndex = Number(d[2]);
    } else return;

    const exec = await DcaExecution.loadEntity(
      `${orderId}-${intervalIndex}`,
      ctx.indexerName,
    );
    if (exec) {
      exec.status = STATUS_REFUNDED;
      exec.refunded_at_block = block.block_number;
      await exec.save();
    }

    const order = await DcaOrder.loadEntity(orderId, ctx.indexerName);
    if (order) {
      order.executed_intervals = Math.max(0, order.executed_intervals - 1);
      order.last_execution = order.last_execution - order.interval_seconds;
      if (!order.is_active && order.executed_intervals < order.total_intervals)
        order.is_active = true;
      if (order.executed_intervals === 0) order.last_executed_at_block = null;
      await order.save();
    }
  };

  // DCA CANCELLED
  // rawEvent.data: [order_id.low, order_id.high, owner,
  //   usdc_refunded.low, usdc_refunded.high,
  //   strk_fee_refunded.low, strk_fee_refunded.high]
  const handleDCACancelled: starknet.Writer = async ({
    event,
    rawEvent,
    block,
  }) => {
    if (!block) return;
    let orderId: string;
    let usdcRefunded: string;
    if (event) {
      orderId = toDecimal(event.order_id);
      usdcRefunded = toDecimal(event.usdc_refunded);
    } else if (rawEvent) {
      const d = rawEvent.data;
      orderId = readU256(d[0], d[1]);
      usdcRefunded = readU256(d[3], d[4]);
    } else return;
    const order = await DcaOrder.loadEntity(orderId, ctx.indexerName);
    if (order) {
      order.is_active = false;
      order.usdc_refunded = usdcRefunded;
      order.cancelled_at_block = block.block_number;
      await order.save();
    }
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
    handleDCAOrderCreated,
    handleDCAExecuted,
    handleDCAIntervalClaimed,
    handleDCAIntervalRefunded,
    handleDCACancelled,
  };
}
