import { ApolloClient, InMemoryCache, gql, HttpLink } from "@apollo/client";
import fetch from "cross-fetch";
import { config } from "./config";

export const apolloClient = new ApolloClient({
  link: new HttpLink({ uri: config.graphqlUrl, fetch }),
  cache: new InMemoryCache(),
  defaultOptions: {
    // Always hit the indexer fresh — never return stale cached state.
    query: { fetchPolicy: "network-only" },
  },
});

// ── Query ─────────────────────────────────────────────────────────────────────
// Fetches all active DCA orders regardless of owner.
// The keeper is permissionless — it processes every order that is due.
// We only pull the fields needed to decide whether to execute.

export const GET_ALL_ACTIVE_DCA_ORDERS = gql`
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

export async function fetchActiveOrders(): Promise<ActiveDcaOrder[]> {
  const { data } = await apolloClient.query({
    query: GET_ALL_ACTIVE_DCA_ORDERS,
  });
  return data.dcaorders ?? [];
}
