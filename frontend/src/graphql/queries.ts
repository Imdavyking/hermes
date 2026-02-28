import { gql } from "@apollo/client";

// ── Deposits (for Merkle tree reconstruction) ────────────────────────────────

export const GET_ALL_DEPOSITS = gql`
  query GetAllDeposits($first: Int!, $skip: Int!) {
    deposits(
      orderBy: leaf_index
      orderDirection: asc
      first: $first
      skip: $skip
    ) {
      id
      commitment
      leaf_index
    }
  }
`;

// ── Open wBTC orders (for FillOrderPanel) ────────────────────────────────────

export const GET_OPEN_WBTC_ORDERS = gql`
  query GetOpenWbtcOrders {
    wbtcorders(
      where: { is_filled: false, is_refunded: false, is_withdrawn: false }
    ) {
      id
      wbtc_seller
      alice_strk_destination
      wbtc_amount
      quoted_strk_amount
      hashlock
      expiry
      rate_expiry
    }
  }
`;

// ── Claimable STRK orders (Alice filled → Bob calls withdraw_strk) ───────────
// strk_buyer = myAddr, not withdrawn, not refunded, not expired

export const GET_CLAIMABLE_STRK_ORDERS = gql`
  query GetClaimableStrkOrders($buyer: String!, $now: Int!) {
    strkorders(
      where: {
        strk_buyer: $buyer
        is_withdrawn: false
        is_refunded: false
        expiry_gt: $now
      }
    ) {
      id
      wbtc_order_id
      strk_amount
      expiry
      hashlock
    }
  }
`;

// ── Claimable wBTC orders (secret revealed → Bob calls withdraw_wbtc) ────────
// wbtc_buyer = myAddr, is_filled=true, not withdrawn
// NOTE: secret-revealed check still requires a contract call because the
//       `secret` field is not indexed. We fetch candidates here and filter
//       on-chain in the hook.

export const GET_FILLED_WBTC_ORDERS_FOR_BUYER = gql`
  query GetFilledWbtcOrdersForBuyer($buyer: String!) {
    wbtcorders(
      where: {
        wbtc_buyer: $buyer
        is_filled: true
        is_withdrawn: false
        is_refunded: false
      }
    ) {
      id
      wbtc_amount
      expiry
      hashlock
    }
  }
`;

// ── Refundable wBTC orders (Alice, expired + never filled) ───────────────────

export const GET_REFUNDABLE_WBTC_ORDERS = gql`
  query GetRefundableWbtcOrders($seller: String!, $now: Int!) {
    wbtcorders(
      where: {
        wbtc_seller: $seller
        is_filled: false
        is_withdrawn: false
        is_refunded: false
        expiry_lte: $now
      }
    ) {
      id
      wbtc_amount
      expiry
    }
  }
`;

// ── Refundable STRK orders (Bob, expired + Alice never revealed) ─────────────

export const GET_REFUNDABLE_STRK_ORDERS = gql`
  query GetRefundableStrkOrders($seller: String!, $now: Int!) {
    strkorders(
      where: {
        strk_seller: $seller
        is_withdrawn: false
        is_refunded: false
        expiry_lte: $now
      }
    ) {
      id
      strk_amount
      expiry
    }
  }
`;

// ── All active DCA orders for an owner ───────────────────────────────────────
// "Active" = not cancelled + executions_left > 0
// Used in DcaTab to show live orders.

export const GET_ACTIVE_DCA_ORDERS = gql`
  query GetActiveDcaOrders($owner: String!) {
    dcaorders(
      where: { owner: $owner, is_cancelled: false, executions_left_gt: "0" }
      orderBy: created_at_block
      orderDirection: desc
    ) {
      id
      order_id
      usdc_recipient
      usdc_per_interval
      interval_seconds
      executions_total
      executions_left
      next_execution
      is_cancelled
      created_at_block
      created_tx_hash
    }
  }
`;

// ── All DCA orders (incl. completed + cancelled) for history view ─────────────

export const GET_ALL_DCA_ORDERS = gql`
  query GetAllDcaOrders($owner: String!) {
    dcaorders(
      where: { owner: $owner }
      orderBy: created_at_block
      orderDirection: desc
    ) {
      id
      order_id
      usdc_recipient
      usdc_per_interval
      interval_seconds
      executions_total
      executions_left
      next_execution
      is_cancelled
      created_at_block
      last_executed_at_block
      cancelled_at_block
    }
  }
`;

// ── Execution history for a single DCA order ─────────────────────────────────
// Used to render the cost-basis chart / execution log.

export const GET_DCA_EXECUTIONS = gql`
  query GetDcaExecutions($orderId: String!) {
    dcaexecutions(
      where: { order_id: $orderId }
      orderBy: execution_number
      orderDirection: asc
    ) {
      id
      execution_number
      usdc_spent
      wbtc_received
      btc_price_usd
      executed_at_block
      executed_tx_hash
      executed_timestamp
    }
  }
`;

// ── Single DCA order (for detail panel / cancel confirmation) ─────────────────

export const GET_DCA_ORDER = gql`
  query GetDcaOrder($orderId: String!) {
    dcaorder(id: $orderId) {
      id
      order_id
      owner
      usdc_recipient
      usdc_per_interval
      interval_seconds
      executions_total
      executions_left
      next_execution
      is_cancelled
      created_at_block
      created_tx_hash
      last_executed_at_block
      cancelled_at_block
    }
  }
`;
