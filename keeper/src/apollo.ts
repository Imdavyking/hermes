import { GraphQLClient, gql } from "graphql-request";
import { config } from "./config";

const client = new GraphQLClient(config.graphqlUrl);

const GET_ALL_ACTIVE_DCA_ORDERS = gql`
  query GetAllActiveDcaOrders {
    dcaorders(
      where: { is_active: true }
      orderBy: last_execution
      orderDirection: asc
    ) {
      id
      owner
      last_execution
      interval_seconds
      executed_intervals
      total_intervals
    }
  }
`;

export interface ActiveDcaOrder {
  id: string;
  owner: string;
  last_execution: string;
  interval_seconds: string;
  executed_intervals: string;
  total_intervals: string;
}

interface QueryResult {
  dcaorders: ActiveDcaOrder[];
}

export async function fetchActiveOrders(): Promise<ActiveDcaOrder[]> {
  const data = await client.request<QueryResult>(GET_ALL_ACTIVE_DCA_ORDERS);
  return data.dcaorders ?? [];
}
