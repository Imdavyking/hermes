# Umbra — Private BTC Swap on Starknet

> Deposit Bitcoin anonymously. Swap privately for STRK. No on-chain link between buyer and seller.

Umbra is a privacy-preserving BTC↔STRK atomic swap protocol built on Starknet. Users deposit wBTC into a shielded pool backed by a ZK-verified incremental Merkle tree, then either withdraw wBTC directly to a fresh address or post an open order for Bob to fill with STRK — with zero on-chain link between depositor and withdrawer.

Proofs are generated with **Noir** and verified on-chain via **Garaga**. Prices are sourced from the **Chainlink oracle** (BTC/USD and STRK/USD cross rate). The Merkle tree uses **Poseidon2 over BN254** to stay compatible with Noir's native hash. Swaps are settled via **Hash Time-Lock Contracts (HTLCs)** — trustless and atomic.

---

## How It Works

### Deposit

Each deposit is a fixed lot of **1,000 satoshis (0.00001 BTC)** — the value of `BTC_DENOMINATION` in the contract.

1. Approve PrivateSwap to spend `1,000` wBTC base units (satoshis)
2. Generate a random `nullifier` and `secret` offchain
3. Compute `commitment = Poseidon2(nullifier, secret)`
4. Save your note `{ nullifier, secret, commitment }` — you need this to withdraw
5. Call `deposit(commitment)` — your commitment is inserted into the Merkle tree

### ZK Withdraw (direct)

1. Load your saved note
2. Frontend fetches all deposit commitments from the indexer and reconstructs the Merkle tree
3. Noir circuit generates a ZK proof of Merkle membership without revealing your leaf
4. Call `zk_withdraw_wbtc(proof, recipient)` — contract verifies the proof, checks the nullifier, transfers wBTC to `recipient`

> Note: `recipient` is a plain function parameter — it is not bound to or verified by the proof. Anyone who obtains a valid proof can specify any recipient address.

### Private HTLC Swap (wBTC → STRK)

Alice wants STRK. Bob wants wBTC. Neither needs to trust the other.

**Alice (seller):**

1. Generate a `secret` and compute `hashlock = pedersen(0, secret)`
2. Call `post_wbtc_order(proof, alice_strk_destination, hashlock, expiry, slippage_bps)` — proves Merkle membership, locks wBTC, quotes live BTC/STRK rate
3. The `wbtc_order_id` is Alice's nullifier hash (guaranteed unique, already stored on-chain)
4. Once Bob fills, call `withdraw_strk(strk_order_id, secret)` — claims STRK, publishes secret on-chain

**Bob (buyer):**

1. Browse open orders from the indexer or receive Alice's `wbtc_order_id` directly
2. Approve STRK, call `fill_wbtc_order(wbtc_order_id, bob_expiry)` — locks STRK at the live oracle rate, becomes the wBTC buyer
3. The `strk_order_id` is `pedersen(hashlock, 'fill')` — Bob can derive it from the fill event
4. Watch for Alice's `withdraw_strk` — the secret is then stored on the wBTC order
5. Call `withdraw_wbtc(wbtc_order_id)` — contract reads the revealed secret and transfers wBTC

**Safety guarantees:**

- Bob's expiry must be strictly less than Alice's — he can always refund STRK before Alice's window opens
- Alice cannot refund wBTC after she has already revealed the secret (`swap_initiated` guard prevents double-spend)
- A quoted rate older than 1 hour blocks fills — prevents filling a stale order after a large price move
- Slippage tolerance (0.1%–10%) is set per order by Alice; fills are rejected if the live rate falls below her floor

---

## Architecture

```
contracts/
├── lib.cairo                      # Entry point, module declarations
├── field.cairo                    # BN254 field arithmetic
├── poseidon2.cairo                # Poseidon2 permutation (BN254)
├── poseidon2lib.cairo             # Public Poseidon2 API
├── incremental_merkle_tree.cairo  # On-chain IMT component (depth 10)
└── wBTC.cairo                     # Mock wBTC for local testing (8 decimals)

noir/
└── src/
    └── main.nr                    # ZK circuit: proves Merkle membership without revealing leaf

indexer/
├── config.ts                      # Checkpoint config: contract address, event handlers
├── schema.gql                     # GraphQL schema (Deposit, WbtcOrder, StrkOrder, …)
└── src/
    ├── index.ts                   # Writer registration
    └── writers.ts                 # Event handlers that persist indexed data
```

### Key Design Decisions

| Decision                                   | Reason                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------- |
| Poseidon2 over BN254 (not Stark field)     | Matches Noir's native hash — proofs are compatible                              |
| Incremental Merkle tree depth 10           | Supports ~1,024 deposits (testnet scope)                                        |
| Root history (last 30 roots)               | Users can withdraw even if new deposits happened after theirs                   |
| Nullifier hash as order ID                 | Guaranteed unique; already recorded on-chain when the order is posted           |
| HTLC with `hashlock = pedersen(0, secret)` | Trustless atomic swap — no escrow, no counterparty risk                         |
| Slippage tolerance per order               | Alice controls her price risk; Bob fills at live rate                           |
| Rate expiry (1h)                           | Prevents filling stale orders after large price moves                           |
| `MIN_STRK_AMOUNT = 1 STRK`                 | Guards against degenerate oracle responses producing dust fills                 |
| Real STRK as swap currency                 | No mock token needed — uses native Starknet STRK                                |
| Checkpoint indexer                         | Replaces per-event RPC loops with a single GraphQL query; scales as chain grows |

---

## Contracts

### PrivateSwap

The main contract. Deploys the Garaga verifier internally from its class hash. Defaults to real wBTC and real STRK on Sepolia — no mock tokens required.

```
wBTC (Starknet Sepolia): 0x00452bd5c0512a61df7c7be8cfea5e4f893cb40e126bdc40aee6054db955129e
STRK (Starknet Sepolia): 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d
```

| Function                                                            | Description                                                                      |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `deposit(commitment)`                                               | Lock `BTC_DENOMINATION` (1,000 sat) wBTC, insert commitment into Merkle tree     |
| `zk_withdraw_wbtc(proof, recipient)`                                | Verify ZK proof and withdraw wBTC directly to any address                        |
| `post_wbtc_order(proof, strk_dest, hashlock, expiry, slippage_bps)` | Post an open HTLC swap order using a ZK proof                                    |
| `fill_wbtc_order(wbtc_order_id, bob_expiry)`                        | Bob locks STRK at live rate and becomes the wBTC buyer                           |
| `withdraw_strk(strk_order_id, secret)`                              | Alice reveals secret to claim STRK; secret is published on the paired wBTC order |
| `withdraw_wbtc(wbtc_order_id)`                                      | Bob claims wBTC after Alice has revealed the secret on-chain                     |
| `refund_wbtc(wbtc_order_id)`                                        | Alice reclaims wBTC after expiry, provided she never revealed the secret         |
| `refund_strk(strk_order_id)`                                        | Bob reclaims STRK after his expiry, if Alice never revealed the secret           |
| `get_wbtc_order(order_id)`                                          | Read a `WbtcOrder` by ID                                                         |
| `get_strk_order(order_id)`                                          | Read a `StrkOrder` by ID                                                         |
| `get_btc_strk_rate()`                                               | Live BTC/STRK rate (STRK units per whole BTC) from Chainlink cross rate          |
| `get_quoted_strk_amount()`                                          | STRK owed for one `BTC_DENOMINATION` lot at the current price                    |
| `get_btc_usd_price()`                                               | Raw BTC/USD price and decimals from Chainlink                                    |
| `get_strk_usd_price()`                                              | Raw STRK/USD price and decimals from Chainlink                                   |
| `current_root()`                                                    | Latest Merkle root                                                               |
| `next_leaf_index()`                                                 | Number of deposits so far                                                        |
| `is_known_root(root)`                                               | Check whether a root is in the last 30 roots                                     |
| `wBTC_address()`                                                    | Active wBTC contract address                                                     |
| `strk_address()`                                                    | Active STRK contract address                                                     |
| `wBTC_denomination()`                                               | The fixed lot size in wBTC base units (1,000)                                    |
| `owner()`                                                           | Current contract owner                                                           |
| `set_mock_wbtc(addr)`                                               | Owner-only: replace wBTC address for local testing                               |
| `reset_wbtc_real()`                                                 | Owner-only: restore wBTC address to the canonical Starknet value                 |
| `transfer_ownership(new_owner)`                                     | Owner-only: transfer contract ownership                                          |

### Mock wBTC

Used in local tests and development. 8 decimals. Minted by an authorised minter address set at deploy time.

---

## Indexer (Checkpoint)

The frontend uses a [Checkpoint](https://www.npmjs.com/package/@snapshot-labs/checkpoint) indexer to query on-chain state without scanning raw RPC events at runtime.

### What it indexes

| Event                  | Stored as                 | Used for                                     |
| ---------------------- | ------------------------- | -------------------------------------------- |
| `Deposit`              | `Deposit`                 | Reconstructing the Merkle tree for ZK proofs |
| `WbtcOrderPosted`      | `WbtcOrder`               | Browsing open orders (Fill Order panel)      |
| `WbtcOrderFilled`      | `WbtcOrder` + `StrkOrder` | Tracking filled orders, claimable STRK       |
| `WbtcWithdrawn`        | `WbtcOrder`               | Marking orders as claimed                    |
| `StrkWithdrawn`        | `StrkOrder`               | Marking STRK orders as claimed               |
| `WbtcRefunded`         | `WbtcOrder`               | Marking orders as refunded                   |
| `StrkRefunded`         | `StrkOrder`               | Marking STRK orders as refunded              |
| `OwnershipTransferred` | `OwnershipTransfer`       | Audit trail                                  |

### Why not just use `provider.getEvents`?

`provider.getEvents` makes one RPC call per page of events, then a separate contract call for each result to fetch current state — O(n) RPC calls that get slower as the chain grows. The indexer pre-processes all events into a Postgres database, so the frontend gets everything in a single GraphQL query.

One exception: checking whether Alice has revealed her secret (`secret` field on a `WbtcOrder`) still requires a direct contract call, because the secret is not included in any event log and therefore cannot be indexed.

### Running the indexer locally

```bash
cd indexer
cp .env.example .env
# Set STARKNET_RPC, CONTRACT_ADDRESS, START_BLOCK

yarn install
yarn checkpoint
```

The GraphQL playground will be available at `http://localhost:5100/graphql`.

### Schema overview

```graphql
type Deposit       { id, commitment, leaf_index, timestamp, block_number, tx_hash }
type WbtcOrder     { id, wbtc_seller, wbtc_amount, quoted_strk_amount, hashlock,
                     expiry, is_filled, is_withdrawn, is_refunded, … }
type StrkOrder     { id, strk_seller, strk_buyer, strk_amount, hashlock,
                     expiry, is_withdrawn, is_refunded, … }
type OwnershipTransfer { id, previous_owner, new_owner, block_number, tx_hash }
```

See `indexer/schema.gql` for the full schema.

---

## Oracle Integration

Prices are fetched directly from individual Chainlink feed contracts on Starknet Sepolia:

```
BTC/USD feed: 0x0258b8f498b767c200577227e3e9f009c9b0fe7f6a3c8c2c24efd588c54747a
STRK/USD feed: 0x0a5db422ee7c28beead49303646e44ef9cbb8364eeba4d8af9ac06a3b556937
Max oracle age: 6 hours (relaxed for Sepolia; tighten for mainnet)
```

The BTC/STRK rate is computed as a cross rate:

```
rate (STRK per BTC) = (btc_usd × 10^strk_decimals × STRK_PRECISION)
                      / (strk_usd × 10^btc_decimals)

quoted_strk_amount  = rate × BTC_DENOMINATION / WBTC_PRECISION
```

---

## ZK Circuit (Noir)

```noir
use dep::poseidon::poseidon2;

fn compute_merkle_root(
    leaf: Field,
    merkle_proof: [Field; 10],
    is_even: [bool; 10]
) -> Field {
    let mut hash = leaf;
    for i in 0..10 {
        let (left, right) = if is_even[i] {
            (hash, merkle_proof[i])
        } else {
            (merkle_proof[i], hash)
        };
        hash = poseidon2::Poseidon2::hash([left, right], 2);
    }
    hash
}
```

Public outputs (read by the contract from the verified proof): `root`, `nullifier_hash`  
Private inputs: `nullifier`, `secret`, `merkle_proof`, `is_even`

The circuit proves:

- `commitment = Poseidon2(nullifier, secret)` exists in the tree at the claimed `root`
- `nullifier_hash = Poseidon2(nullifier)` — prevents double withdrawal without revealing the nullifier

The `recipient` parameter in `zk_withdraw_wbtc` and `post_wbtc_order` is **not** part of the proof — it is a plain calldata argument.

---

## Getting Started

### Prerequisites

- Scarb 2.14.0
- Cairo 2.14.0
- snforge 0.53.0
- Node.js + Yarn (for deploy scripts and indexer)
- Noir + Barretenberg (for proof generation)

### Build contracts

```bash
cd contracts
scarb build
```

### Test

```bash
snforge test
```

### Deploy

```bash
cp .env.example .env
# fill in RPC_ENDPOINT, DEPLOYER_ADDRESS, DEPLOYER_PRIVATE_KEY

yarn deploy
```

The deploy script:

1. Declares the Garaga verifier class
2. Deploys PrivateSwap (verifier deployed internally; wBTC and STRK default to real Sepolia addresses)
3. Optionally deploys MockWBTC with the deployer as minter
4. Calls `set_mock_wbtc` to register the mock for local testing

To use real wBTC on Sepolia, skip steps 3–4. The contract defaults to the real address automatically.

### Run the indexer

```bash
cd indexer
cp .env.example .env
# fill in STARKNET_RPC, CONTRACT_ADDRESS, START_BLOCK

yarn install
yarn checkpoint
```

The indexer must be running before the frontend will display orders or deposits. Keep it running alongside the frontend in development.

### Run the frontend

```bash
cd frontend
yarn install
yarn dev
```

---

## Environment Variables

**contracts / deploy:**

```env
RPC_ENDPOINT=https://starknet-sepolia.infura.io/v3/YOUR_KEY
DEPLOYER_ADDRESS=0x...
DEPLOYER_PRIVATE_KEY=0x...
```

**indexer:**

```env
STARKNET_RPC=https://starknet-sepolia.infura.io/v3/YOUR_KEY
CONTRACT_ADDRESS=0x...
START_BLOCK=0          # block number of your deployment
```

**frontend:**

```env
VITE_CONTRACT_ADDRESS=0x...
VITE_DEPLOY_BLOCK=0
VITE_GRAPH_QL_ENDPOINT=http://localhost:3000/graphql
```

---

## Security Notes

- Nullifiers are marked spent **before** token transfers (reentrancy guard)
- Root history of 30 prevents griefing via fast root rotation
- `set_mock_wbtc`, `reset_wbtc_real`, and `transfer_ownership` are owner-only — guarded by `assert_only_owner()`
- Bob's HTLC expiry is enforced to be strictly less than Alice's — Bob can always refund STRK before Alice's window opens
- Alice cannot refund wBTC after she has revealed the secret (`!swap_initiated` guard prevents double-spend)
- The 1-hour rate expiry (`RATE_VALID_FOR_SECS`) prevents fills against stale price quotes
- Fills are rejected if the live STRK amount falls below `1 STRK` (`MIN_STRK_AMOUNT`), guarding against degenerate oracle responses
- Proof verification is handled by Garaga's `verify_ultra_keccak_zk_honk_proof`
- The `recipient` in `zk_withdraw_wbtc` is not bound to the proof — a leaked proof could be front-run with a different recipient
- **This is an unaudited testnet demo — do not use with real funds**

---

## License

MIT
