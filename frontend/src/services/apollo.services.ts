import { ApolloClient, InMemoryCache } from "@apollo/client";
import { GRAPH_QL_ENDPOINT } from "../utils/constants";

const client = new ApolloClient({
  uri: GRAPH_QL_ENDPOINT,
  cache: new InMemoryCache(),
});

export default client;
