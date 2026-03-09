import { starknet } from "@snapshot-labs/checkpoint";
import {
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
    const existing = await DcaOrder.loadEntity(orderId, ctx.indexerName);
    if (existing) return;
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
  //   usdc_spent.low, usdc_spent.high,
  //   executed_intervals, keeper, keeper_fee_paid.low, keeper_fee_paid.high]
  const handleDCAExecuted: starknet.Writer = async ({
    event,
    rawEvent,
    block,
    txId,
  }) => {
    if (!block) return;
    let orderId: string, usdcSpent: string, keeper: string;
    let executedIntervals: number;
    if (event) {
      orderId = toDecimal(event.order_id);
      usdcSpent = toDecimal(event.usdc_spent);
      executedIntervals = Number(event.executed_intervals);
      keeper = toHexAddress(event.keeper);
    } else if (rawEvent) {
      const d = rawEvent.data;
      // [0,1]=order_id [2]=owner [3,4]=usdc_spent [5]=executed_intervals [6]=keeper [7,8]=keeper_fee_paid
      orderId = readU256(d[0], d[1]);
      usdcSpent = readU256(d[3], d[4]);
      executedIntervals = Number(d[5]);
      keeper = toHexAddress(d[6]);
    } else return;

    const order = await DcaOrder.loadEntity(orderId, ctx.indexerName);
    if (order) {
      order.executed_intervals = executedIntervals;
      order.last_execution = block.timestamp ?? 0;
      order.last_executed_at_block = block.block_number;
      if (executedIntervals >= order.total_intervals) order.is_active = false;
      await order.save();
    }

    const existing = await DcaExecution.loadEntity(
      `${orderId}-${executedIntervals}`,
      ctx.indexerName,
    );
    if (existing) return;
    const exec = new DcaExecution(
      `${orderId}-${executedIntervals}`,
      ctx.indexerName,
    );
    exec.order_id = orderId;
    exec.executed_intervals = executedIntervals;
    exec.usdc_spent = usdcSpent;
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
    handleOwnershipTransferred,
    handleDCAOrderCreated,
    handleDCAExecuted,
    handleDCAIntervalClaimed,
    handleDCAIntervalRefunded,
    handleDCACancelled,
  };
}
