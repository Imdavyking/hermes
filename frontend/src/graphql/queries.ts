import { gql } from "@apollo/client";

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
      keeper
      status
      executed_tx_hash
      executed_timestamp
      claimed_at_block
      refunded_at_block
    }
  }
`;
