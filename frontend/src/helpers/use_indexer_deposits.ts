import { useApolloClient } from "@apollo/client";
import { useCallback } from "react";
import { GET_ALL_DEPOSITS } from "../graphql/queries";

const PAGE_SIZE = 500;

/**
 * Returns a function that fetches ALL deposit commitments from the indexer,
 * ordered by leaf_index, paginating automatically.
 *
 * Replaces the `provider.getEvents` loop that was used in PostOrderPanel
 * and WithdrawTab to reconstruct the Merkle tree.
 */
export function useIndexerDeposits() {
  const client = useApolloClient();

  const fetchAllCommitments = useCallback(async (): Promise<string[]> => {
    const commitments: string[] = [];
    let skip = 0;

    while (true) {
      const { data } = await client.query({
        query: GET_ALL_DEPOSITS,
        variables: { first: PAGE_SIZE, skip },
        fetchPolicy: "network-only",
      });

      const page: { commitment: string; leaf_index: number }[] =
        data?.deposits ?? [];

      // The indexer already orders by leaf_index asc, but let's be safe
      page
        .slice()
        .sort((a, b) => a.leaf_index - b.leaf_index)
        .forEach((d) => commitments.push(d.commitment));

      if (page.length < PAGE_SIZE) break; // last page
      skip += PAGE_SIZE;
    }

    return commitments;
  }, [client]);

  return { fetchAllCommitments };
}
