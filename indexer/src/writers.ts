import { starknet } from "@snapshot-labs/checkpoint";
import {
  Deposit,
  Withdrawal,
  WbtcOrder,
  StrkOrder,
  OwnershipTransfer,
} from "../.checkpoint/models";
import { toHexAddress, u256ToString } from "./shared";
import { Context } from "./index";

// -------------------------------------------------------
// Factory — same pattern as the reference example
// -------------------------------------------------------
export function createWriters(ctx: Context) {
  // -------------------------------------------------------
  // DEPOSIT
  // event fields: commitment (u256), leaf_index (u32), timestamp (u64)
  // -------------------------------------------------------
  const handleDeposit: starknet.Writer = async ({ event, block, tx }) => {
    const id = toHexAddress(event.commitment);

    const deposit = new Deposit(id, ctx.indexerName);
    deposit.commitment = id;
    deposit.leaf_index = Number(event.leaf_index);
    deposit.timestamp = Number(event.timestamp);
    deposit.block_number = block.block_number;
    deposit.tx_hash = tx.transaction_hash;

    await deposit.save();
  };

  // -------------------------------------------------------
  // WITHDRAWAL (ZK direct withdrawal)
  // event fields: recipient (ContractAddress), nullifier_hash (u256)
  // -------------------------------------------------------
  const handleWithdrawal: starknet.Writer = async ({ event, block, tx }) => {
    const id = toHexAddress(event.nullifier_hash);

    const withdrawal = new Withdrawal(id, ctx.indexerName);
    withdrawal.recipient = toHexAddress(event.recipient);
    withdrawal.nullifier_hash = id;
    withdrawal.block_number = block.block_number;
    withdrawal.tx_hash = tx.transaction_hash;

    await withdrawal.save();
  };

  // -------------------------------------------------------
  // WBTC ORDER POSTED
  // event fields: order_id, wbtc_seller, alice_strk_destination,
  //               wbtc_amount, quoted_strk_amount, hashlock, expiry, rate_expiry
  // -------------------------------------------------------
  const handleWbtcOrderPosted: starknet.Writer = async ({
    event,
    block,
    tx,
  }) => {
    const id = toHexAddress(event.order_id);

    const order = new WbtcOrder(id, ctx.indexerName);
    order.wbtc_seller = toHexAddress(event.wbtc_seller);
    order.alice_strk_destination = toHexAddress(event.alice_strk_destination);
    order.wbtc_amount = u256ToString(event.wbtc_amount);
    order.quoted_strk_amount = u256ToString(event.quoted_strk_amount);
    order.hashlock = toHexAddress(event.hashlock);
    order.expiry = Number(event.expiry);
    order.rate_expiry = Number(event.rate_expiry);
    order.is_filled = false;
    order.is_withdrawn = false;
    order.is_refunded = false;
    order.posted_at_block = block.block_number;
    order.posted_tx_hash = tx.transaction_hash;

    await order.save();
  };

  // -------------------------------------------------------
  // WBTC ORDER FILLED
  // event fields: wbtc_order_id, strk_order_id, bob,
  //               strk_amount_locked, bob_expiry
  // -------------------------------------------------------
  const handleWbtcOrderFilled: starknet.Writer = async ({
    event,
    block,
    tx,
  }) => {
    const wbtcOrderId = toHexAddress(event.wbtc_order_id);
    const strkOrderId = toHexAddress(event.strk_order_id);
    const bob = toHexAddress(event.bob);
    const strkAmount = u256ToString(event.strk_amount_locked);
    const bobExpiry = Number(event.bob_expiry);

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
    strkOrder.posted_tx_hash = tx.transaction_hash;

    await strkOrder.save();
  };

  // -------------------------------------------------------
  // WBTC WITHDRAWN (Bob claims wBTC after secret is revealed)
  // event fields: order_id, wbtc_buyer
  // -------------------------------------------------------
  const handleWbtcWithdrawn: starknet.Writer = async ({ event, block }) => {
    const order = await WbtcOrder.loadEntity(
      toHexAddress(event.order_id),
      ctx.indexerName,
    );
    if (order) {
      order.is_withdrawn = true;
      order.withdrawn_at_block = block.block_number;
      await order.save();
    }
  };

  // -------------------------------------------------------
  // STRK WITHDRAWN (Alice claims STRK by revealing secret)
  // event fields: order_id, strk_buyer
  // -------------------------------------------------------
  const handleStrkWithdrawn: starknet.Writer = async ({ event, block }) => {
    const order = await StrkOrder.loadEntity(
      toHexAddress(event.order_id),
      ctx.indexerName,
    );
    if (order) {
      order.is_withdrawn = true;
      order.withdrawn_at_block = block.block_number;
      await order.save();
    }
  };

  // -------------------------------------------------------
  // WBTC REFUNDED (Alice reclaims wBTC after expiry)
  // event fields: order_id, wbtc_seller
  // -------------------------------------------------------
  const handleWbtcRefunded: starknet.Writer = async ({ event, block }) => {
    const order = await WbtcOrder.loadEntity(
      toHexAddress(event.order_id),
      ctx.indexerName,
    );
    if (order) {
      order.is_refunded = true;
      order.refunded_at_block = block.block_number;
      await order.save();
    }
  };

  // -------------------------------------------------------
  // STRK REFUNDED (Bob reclaims STRK after expiry)
  // event fields: order_id, strk_seller
  // -------------------------------------------------------
  const handleStrkRefunded: starknet.Writer = async ({ event, block }) => {
    const order = await StrkOrder.loadEntity(
      toHexAddress(event.order_id),
      ctx.indexerName,
    );
    if (order) {
      order.is_refunded = true;
      order.refunded_at_block = block.block_number;
      await order.save();
    }
  };

  // -------------------------------------------------------
  // STRK ORDER POSTED (direct off-chain coordinated order)
  // event fields: order_id, strk_seller, strk_buyer,
  //               strk_amount, hashlock, expiry
  // -------------------------------------------------------
  const handleStrkOrderPosted: starknet.Writer = async ({
    event,
    block,
    tx,
  }) => {
    const id = toHexAddress(event.order_id);

    const order = new StrkOrder(id, ctx.indexerName);
    order.strk_seller = toHexAddress(event.strk_seller);
    order.strk_buyer = toHexAddress(event.strk_buyer);
    order.strk_amount = u256ToString(event.strk_amount);
    order.hashlock = toHexAddress(event.hashlock);
    order.expiry = Number(event.expiry);
    order.wbtc_order_id = null;
    order.is_withdrawn = false;
    order.is_refunded = false;
    order.posted_at_block = block.block_number;
    order.posted_tx_hash = tx.transaction_hash;

    await order.save();
  };

  // -------------------------------------------------------
  // OWNERSHIP TRANSFERRED
  // event fields: previous_owner, new_owner
  // -------------------------------------------------------
  const handleOwnershipTransferred: starknet.Writer = async ({
    event,
    block,
    tx,
  }) => {
    const transfer = new OwnershipTransfer(
      tx.transaction_hash,
      ctx.indexerName,
    );
    transfer.previous_owner = toHexAddress(event.previous_owner);
    transfer.new_owner = toHexAddress(event.new_owner);
    transfer.block_number = block.block_number;
    transfer.tx_hash = tx.transaction_hash;

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
