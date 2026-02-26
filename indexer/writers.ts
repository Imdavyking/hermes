import { CheckpointWriters } from "@snapshot-labs/checkpoint";

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

function toHex(value: string): string {
  if (!value) return "0x0";
  return "0x" + BigInt(value).toString(16);
}

// Starknet encodes u256 as [low, high] — two consecutive 128-bit felts.
function readU256(low: string, high: string): string {
  const lo = BigInt(low || "0");
  const hi = BigInt(high || "0");
  return ((hi << 128n) | lo).toString();
}

// -------------------------------------------------------
// Writers
// -------------------------------------------------------

export const writers: CheckpointWriters = {
  handleDeploy: async () => {
    // Nothing to do on deploy
  },

  // -------------------------------------------------------
  // DEPOSIT
  // events: [commitment.low, commitment.high, leaf_index, timestamp]
  // -------------------------------------------------------
  handleDeposit: async ({ receipt, mysql }) => {
    const events = receipt.events;
    const commitment = toHex(readU256(events[0], events[1]));
    const leafIndex = Number(events[2]);
    const timestamp = events[3];
    const blockNumber = receipt.transaction_hash
      ? ((receipt as any).block_number ?? 0)
      : 0;

    await mysql.queryAsync(`INSERT IGNORE INTO deposits SET ?`, [
      {
        id: commitment,
        commitment: commitment,
        leaf_index: leafIndex,
        timestamp: timestamp,
        block_number: (receipt as any).block_number ?? 0,
        tx_hash: receipt.transaction_hash,
      },
    ]);
  },

  // -------------------------------------------------------
  // WITHDRAWAL (ZK direct withdrawal)
  // events: [recipient, nullifier_hash.low, nullifier_hash.high]
  // -------------------------------------------------------
  handleWithdrawal: async ({ receipt, mysql }) => {
    const events = receipt.events;
    const nullifierHash = toHex(readU256(events[1], events[2]));

    await mysql.queryAsync(`INSERT IGNORE INTO withdrawals SET ?`, [
      {
        id: nullifierHash,
        recipient: toHex(events[0]),
        nullifier_hash: nullifierHash,
        block_number: (receipt as any).block_number ?? 0,
        tx_hash: receipt.transaction_hash,
      },
    ]);
  },

  // -------------------------------------------------------
  // WBTC ORDER POSTED
  // events: [order_id.low, order_id.high, wbtc_seller,
  //          alice_strk_destination, wbtc_amount.low, wbtc_amount.high,
  //          quoted_strk_amount.low, quoted_strk_amount.high,
  //          hashlock, expiry, rate_expiry]
  // -------------------------------------------------------
  handleWbtcOrderPosted: async ({ receipt, mysql }) => {
    const e = receipt.events;
    const orderId = toHex(readU256(e[0], e[1]));

    await mysql.queryAsync(`INSERT IGNORE INTO wbtc_orders SET ?`, [
      {
        id: orderId,
        wbtc_seller: toHex(e[2]),
        alice_strk_destination: toHex(e[3]),
        wbtc_amount: readU256(e[4], e[5]),
        quoted_strk_amount: readU256(e[6], e[7]),
        hashlock: toHex(e[8]),
        expiry: e[9],
        rate_expiry: e[10],
        is_filled: 0,
        is_withdrawn: 0,
        is_refunded: 0,
        posted_at_block: (receipt as any).block_number ?? 0,
        posted_tx_hash: receipt.transaction_hash,
      },
    ]);
  },

  // -------------------------------------------------------
  // WBTC ORDER FILLED
  // events: [wbtc_order_id.low, wbtc_order_id.high,
  //          strk_order_id.low, strk_order_id.high,
  //          bob, strk_amount_locked.low, strk_amount_locked.high,
  //          bob_expiry]
  // -------------------------------------------------------
  handleWbtcOrderFilled: async ({ receipt, mysql }) => {
    const e = receipt.events;
    const wbtcOrderId = toHex(readU256(e[0], e[1]));
    const strkOrderId = toHex(readU256(e[2], e[3]));
    const bob = toHex(e[4]);
    const strkAmountLocked = readU256(e[5], e[6]);
    const bobExpiry = e[7];
    const blockNumber = (receipt as any).block_number ?? 0;

    // Update the WbtcOrder
    await mysql.queryAsync(
      `UPDATE wbtc_orders
       SET wbtc_buyer = ?, strk_order_id = ?, strk_amount_locked = ?,
           bob_expiry = ?, is_filled = 1, filled_at_block = ?
       WHERE id = ?`,
      [bob, strkOrderId, strkAmountLocked, bobExpiry, blockNumber, wbtcOrderId],
    );

    // Fetch alice_strk_destination and hashlock from the WbtcOrder
    const [wbtcOrder] = await mysql.queryAsync(
      `SELECT alice_strk_destination, hashlock FROM wbtc_orders WHERE id = ?`,
      [wbtcOrderId],
    );

    await mysql.queryAsync(`INSERT IGNORE INTO strk_orders SET ?`, [
      {
        id: strkOrderId,
        strk_seller: bob,
        strk_buyer: wbtcOrder?.alice_strk_destination ?? "0x0",
        strk_amount: strkAmountLocked,
        hashlock: wbtcOrder?.hashlock ?? "0x0",
        expiry: bobExpiry,
        wbtc_order_id: wbtcOrderId,
        is_withdrawn: 0,
        is_refunded: 0,
        posted_at_block: blockNumber,
        posted_tx_hash: receipt.transaction_hash,
      },
    ]);
  },

  // -------------------------------------------------------
  // WBTC WITHDRAWN (Bob claims wBTC after secret is revealed)
  // events: [order_id.low, order_id.high, wbtc_buyer]
  // -------------------------------------------------------
  handleWbtcWithdrawn: async ({ receipt, mysql }) => {
    const e = receipt.events;
    const orderId = toHex(readU256(e[0], e[1]));

    await mysql.queryAsync(
      `UPDATE wbtc_orders SET is_withdrawn = 1, withdrawn_at_block = ? WHERE id = ?`,
      [(receipt as any).block_number ?? 0, orderId],
    );
  },

  // -------------------------------------------------------
  // STRK WITHDRAWN (Alice claims STRK by revealing secret)
  // events: [order_id.low, order_id.high, strk_buyer]
  // -------------------------------------------------------
  handleStrkWithdrawn: async ({ receipt, mysql }) => {
    const e = receipt.events;
    const orderId = toHex(readU256(e[0], e[1]));

    await mysql.queryAsync(
      `UPDATE strk_orders SET is_withdrawn = 1, withdrawn_at_block = ? WHERE id = ?`,
      [(receipt as any).block_number ?? 0, orderId],
    );
  },

  // -------------------------------------------------------
  // WBTC REFUNDED (Alice reclaims wBTC after expiry)
  // events: [order_id.low, order_id.high, wbtc_seller]
  // -------------------------------------------------------
  handleWbtcRefunded: async ({ receipt, mysql }) => {
    const e = receipt.events;
    const orderId = toHex(readU256(e[0], e[1]));

    await mysql.queryAsync(
      `UPDATE wbtc_orders SET is_refunded = 1, refunded_at_block = ? WHERE id = ?`,
      [(receipt as any).block_number ?? 0, orderId],
    );
  },

  // -------------------------------------------------------
  // STRK REFUNDED (Bob reclaims STRK after expiry)
  // events: [order_id.low, order_id.high, strk_seller]
  // -------------------------------------------------------
  handleStrkRefunded: async ({ receipt, mysql }) => {
    const e = receipt.events;
    const orderId = toHex(readU256(e[0], e[1]));

    await mysql.queryAsync(
      `UPDATE strk_orders SET is_refunded = 1, refunded_at_block = ? WHERE id = ?`,
      [(receipt as any).block_number ?? 0, orderId],
    );
  },

  // -------------------------------------------------------
  // STRK ORDER POSTED (direct/off-chain coordinated order)
  // events: [order_id (felt252), strk_seller, strk_buyer,
  //          strk_amount.low, strk_amount.high, hashlock, expiry]
  // -------------------------------------------------------
  handleStrkOrderPosted: async ({ receipt, mysql }) => {
    const e = receipt.events;
    const orderId = toHex(e[0]);

    await mysql.queryAsync(`INSERT IGNORE INTO strk_orders SET ?`, [
      {
        id: orderId,
        strk_seller: toHex(e[1]),
        strk_buyer: toHex(e[2]),
        strk_amount: readU256(e[3], e[4]),
        hashlock: toHex(e[5]),
        expiry: e[6],
        wbtc_order_id: null,
        is_withdrawn: 0,
        is_refunded: 0,
        posted_at_block: (receipt as any).block_number ?? 0,
        posted_tx_hash: receipt.transaction_hash,
      },
    ]);
  },

  // -------------------------------------------------------
  // OWNERSHIP TRANSFERRED
  // events: [previous_owner, new_owner]
  // -------------------------------------------------------
  handleOwnershipTransferred: async ({ receipt, mysql }) => {
    const e = receipt.events;

    await mysql.queryAsync(`INSERT IGNORE INTO ownership_transfers SET ?`, [
      {
        id: receipt.transaction_hash,
        previous_owner: toHex(e[0]),
        new_owner: toHex(e[1]),
        block_number: (receipt as any).block_number ?? 0,
        tx_hash: receipt.transaction_hash,
      },
    ]);
  },
};
