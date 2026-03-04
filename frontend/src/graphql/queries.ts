import { gql } from "@apollo/client";

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

export const GET_ACTIVE_DCA_ORDERS = gql`
  query GetActiveDcaOrders($owner: String!) {
    dcaorders(
      where: { owner: $owner, is_active: true }
      orderBy: created_at_block
      orderDirection: desc
    ) {
      id
      owner
      usdc_per_interval
      interval_seconds
      total_intervals
      total_usdc_deposited
      btc_destination
      executed_intervals
      is_active
      last_execution
      created_at_block
      created_tx_hash
      last_executed_at_block
    }
  }
`;

export const GET_ALL_DCA_ORDERS = gql`
  query GetAllDcaOrders($owner: String!) {
    dcaorders(
      where: { owner: $owner }
      orderBy: created_at_block
      orderDirection: desc
    ) {
      id
      owner
      usdc_per_interval
      interval_seconds
      total_intervals
      btc_destination
      executed_intervals
      is_active
      last_execution
      usdc_refunded
      created_at_block
      created_tx_hash
      last_executed_at_block
      cancelled_at_block
    }
  }
`;

export const GET_DCA_EXECUTIONS = gql`
  query GetDcaExecutions($orderId: String!) {
    dcaexecutions(
      where: { order_id: $orderId }
      orderBy: executed_intervals
      orderDirection: asc
    ) {
      id
      order_id
      executed_intervals
      usdc_spent
      btc_received
      keeper
      status
      executed_at_block
      executed_tx_hash
      executed_timestamp
      claimed_at_block
      refunded_at_block
    }
  }
`;

export const GET_DCA_ORDER = gql`
  query GetDcaOrder($orderId: String!) {
    dcaorder(id: $orderId) {
      id
      owner
      usdc_per_interval
      interval_seconds
      total_intervals
      btc_destination
      executed_intervals
      is_active
      last_execution
      usdc_refunded
      created_at_block
      created_tx_hash
      last_executed_at_block
      cancelled_at_block
    }
  }
`;
