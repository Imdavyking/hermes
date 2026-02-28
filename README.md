# Umbra — Private wBTC Protocol on Starknet

> Deposit wBTC anonymously. Withdraw to any address. Swap privately for STRK. Earn yield without revealing your position. DCA recurring USDC → wBTC purchases. No on-chain link between depositor and withdrawer.

**Noir** (ZK proofs) · **Garaga** (on-chain verifier) · **Chainlink** (oracle) · **Vesu** (yield) · **Poseidon2/BN254** (Merkle tree) · **HTLCs** (atomic swaps)

---

## How It Works

### 1. Deposit

1. Generate `nullifier` and `secret` offchain
2. Compute `commitment = Poseidon2(nullifier, secret)`
3. Save your note `{ nullifier, secret, commitment }` — **required for all future actions**
4. Approve and call `deposit(commitment)` — locks `1,000 sat` wBTC, inserts leaf into Merkle tree

### 2. ZK Withdraw

1. Load your note → frontend reconstructs Merkle tree from indexed deposits
2. Noir generates a ZK proof of membership without revealing your leaf
3. Call `zk_withdraw_wbtc(proof, recipient)` → contract verifies proof, checks nullifier, sends wBTC

> `recipient` is bound to the proof via `recipient_hash = Poseidon2(recipient)` — changing it invalidates the proof and prevents frontrunning.

### 3. Yield Earning (Vesu)

1. Load your note → generate ZK proof (same flow as withdraw)
2. Call `start_earning(proof, recipient)` — marks nullifier spent, deposits wBTC into Vesu lending pool
3. Vesu mints yield-bearing shares that appreciate as borrowers pay interest
4. When ready, call `stop_earning(nullifier_hash)` — redeems shares, sends wBTC + all accrued yield to `recipient`

> No ZK proof needed to stop earning — only the `recipient` address committed at start time can call it.  
> Once `start_earning` is called, the note is consumed. The only exit is `stop_earning`.

### 4. HTLC Swap (wBTC → STRK)

**Alice (wBTC seller):**

1. Generate `secret`, compute `hashlock = pedersen(0, secret)`
2. Call `post_wbtc_order(proof, strk_dest, hashlock, expiry, slippage_bps)` — locks wBTC, quotes live rate
3. After Bob fills, call `withdraw_strk(strk_order_id, secret)` — claims STRK, publishes secret on-chain

**Bob (STRK seller):**

1. Find Alice's order via indexer or `wbtc_order_id`
2. Approve STRK, call `fill_wbtc_order(wbtc_order_id, bob_expiry)` — locks STRK at live rate
3. Watch for Alice's `withdraw_strk`, then call `withdraw_wbtc(wbtc_order_id)` — secret is now on-chain

**Safety guarantees:**

- Bob expiry < Alice expiry — Bob can always refund STRK before Alice's window opens
- `swap_initiated` flag — Alice cannot refund wBTC after revealing her secret
- Rate expiry (1h) — stale quotes rejected at fill time
- Slippage guard (0.1–10%) — fills rejected if live rate drops below Alice's floor

### 5. DCA (USDC → wBTC)

Schedule recurring fixed-dollar BTC purchases at the live Chainlink oracle price. USDC is a stable spend — wBTC received varies with price, which is exactly the point of DCA.

**Creating an order:**

1. Approve `usdc_per_interval × total_intervals` USDC to the contract
2. Call `create_dca_order(usdc_per_interval, interval_hours, total_intervals)` — full USDC pulled upfront
3. A keeper calls `execute_dca(order_id)` once per interval — wBTC is delivered directly to your wallet each time

**Cancelling:**

- Call `cancel_dca(order_id)` — marks the order inactive and refunds all remaining unspent USDC
- Already-executed intervals are not reversed

**Keeper integration (Gelato-style):**

- `checker(order_id)` returns `(can_exec, payload)` — keeper polls this view and fires the payload when `can_exec` is true
- Keeper needs zero capital and zero approvals; they never touch funds

**Constraints:**

- `usdc_per_interval` ≥ 1 USDC (ensures non-zero wBTC output at any realistic BTC price)
- `interval_hours`: 1–720 (1 hour to 30 days)
- `total_intervals`: 1–1,000
- wBTC is always delivered to `order.owner` (the address that created the order)

> **Testnet note:** `execute_dca` mints wBTC directly via the mock contract. On mainnet, replace `_acquire_wbtc()` with an Ekubo USDC → wBTC swap.

---

## ZK Circuit

Public inputs: `root`, `nullifier_hash`, `recipient_hash`  
Private inputs: `nullifier`, `secret`, `recipient`, `merkle_proof[10]`, `is_even[10]`

The circuit proves:

- `commitment = Poseidon2(nullifier, secret)` exists in the tree at `root`
- `nullifier_hash = Poseidon2(nullifier)` — double-spend prevention without revealing nullifier
- `recipient_hash = Poseidon2(recipient)` — binds destination address to the proof, blocking frontrunning

The same proof is used for `zk_withdraw_wbtc`, `start_earning`, and `post_wbtc_order` — each binding a different destination address as the recipient.

---

## Contract Reference

| Function | Description |
| --- | --- |
| `deposit(commitment)` | Lock 1,000 sat wBTC, insert leaf |
| `zk_withdraw_wbtc(proof, recipient)` | Verify proof, withdraw wBTC to recipient |
| `start_earning(proof, recipient)` | Opt deposit into Vesu yield, lock recipient |
| `stop_earning(nullifier_hash)` | Redeem Vesu shares, receive wBTC + yield |
| `get_yield_balance(nullifier_hash)` | Current wBTC value of a Vesu position |
| `is_earning(nullifier_hash)` | Check if a nullifier is in an earning position |
| `get_yield_recipient(nullifier_hash)` | Address locked in at start_earning time |
| `post_wbtc_order(proof, dest, hashlock, expiry, slippage)` | Post HTLC swap order |
| `fill_wbtc_order(order_id, bob_expiry)` | Bob locks STRK at live rate |
| `withdraw_strk(order_id, secret)` | Alice claims STRK, reveals secret on-chain |
| `withdraw_wbtc(order_id)` | Bob claims wBTC using revealed secret |
| `refund_wbtc(order_id)` | Alice reclaims wBTC after expiry |
| `refund_strk(order_id)` | Bob reclaims STRK after his expiry |
| `get_btc_strk_rate()` | Live BTC/STRK cross rate from Chainlink |
| `get_quoted_strk_amount()` | STRK owed for one lot at current price |
| `create_dca_order(usdc_per_interval, interval_hours, total_intervals)` | Deposit USDC upfront, schedule recurring wBTC purchases |
| `execute_dca(order_id)` | Keeper: buy wBTC with one interval's USDC at live oracle price |
| `cancel_dca(order_id)` | Cancel active order, refund remaining USDC |
| `checker(order_id)` | Keeper resolver: returns (can_exec, calldata payload) |
| `preview_wbtc_for_usdc(usdc_amount)` | How much wBTC a USDC amount buys at current oracle price |
| `get_dca_order(order_id)` | Fetch a DCA order by ID |
| `current_root()` | Latest Merkle root |
| `next_leaf_index()` | Total deposits so far |
| `is_known_root(root)` | Check if root is in the last 30 roots |

**Token addresses (Sepolia):**

```
wBTC: 0x063d32a3fa6074e72e7a1e06fe78c46a0c8473217773e19f11d8c8cbfc4ff8ca
STRK: 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d
USDC: 0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8
Vesu vToken: 0x05868ed6b7c57ac071bf6bfe762174a2522858b700ba9fb062709e63b65bf186
```

---

## Architecture

```
contracts/   Cairo contracts (PrivateSwap, IMT, Poseidon2, MockWBTC)
noir/        ZK circuit (Merkle membership proof)
indexer/     Checkpoint indexer → GraphQL API
frontend/    React UI (Deposit, Withdraw, Swap, Yield, DCA tabs)
```

**Key decisions:**

| Decision | Reason |
| --- | --- |
| Poseidon2 over BN254 | Matches Noir's native hash |
| IMT depth 10 | ~1,024 deposits (testnet scope) |
| Root history (30) | Withdraw even after new deposits |
| Nullifier hash as order ID | Unique, already on-chain |
| Recipient hash in proof | Prevents frontrunning on all ZK functions |
| Vesu ERC-4626 for yield | Non-custodial, share-based — yield accrues automatically |
| USDC (not STRK) for DCA | STRK's dollar value fluctuates; USDC makes `usdc_per_interval` a genuine fixed dollar budget |
| DCA USDC pulled upfront | Simplifies keeper: no capital, no approvals, no per-execution user interaction |
| Checkpoint indexer | Single GraphQL query vs O(n) RPC calls |

**Oracle (Chainlink, Sepolia):**

```
BTC/USD:  0x0258b8f498b767c200577227e3e9f009c9b0fe7f6a3c8c2c24efd588c54747a
STRK/USD: 0x0a5db422ee7c28beead49303646e44ef9cbb8364eeba4d8af9ac06a3b556937

BTC/STRK rate = (btc_usd × 10^strk_dec × STRK_PRECISION) / (strk_usd × 10^btc_dec)
wBTC for USDC = usdc_amount × WBTC_PRECISION × 10^btc_dec / (btc_usd × USDC_PRECISION)
```

Max oracle age: 7 days (testnet) — tighten to 1h for mainnet.

---

## Quick Start

**Prerequisites:** Scarb 2.14.0 · Cairo 2.14.0 · snforge 0.53.0 · Node.js + Yarn · Noir + Barretenberg · Docker

```bash
# build & test
cd contracts && scarb build
snforge test

# deploy
cp .env.example .env   # fill in RPC_ENDPOINT, DEPLOYER_ADDRESS, DEPLOYER_PRIVATE_KEY
yarn deploy

# run full stack
cp indexer/.env.example indexer/.env
cp frontend/.env.example frontend/.env
docker compose up --build
```

Services: **Postgres** `:5555` · **Indexer + GraphQL** `:5100` · **Frontend** `:3000`

> Always run `docker compose up` from the root. Running it inside `indexer/` first will bind port 5100 and cause a conflict.

---

## Environment Variables

```env
# contracts
RPC_ENDPOINT=https://starknet-sepolia.infura.io/v3/YOUR_KEY
DEPLOYER_ADDRESS=0x...
DEPLOYER_PRIVATE_KEY=0x...

# indexer
DATABASE_URL=postgres://user:default_password@postgres:5432/checkpoint
RPC_URL=https://...
CONTRACT_ADDRESS=0x...
START_BLOCK=0

# frontend
VITE_CONTRACT_ADDRESS=0x...
VITE_GRAPH_QL_ENDPOINT=http://localhost:5100/graphql
```

---

## Security Notes

- Nullifiers marked spent **before** token transfers (CEI pattern — no reentrancy)
- Recipient address cryptographically bound to proof — frontrunning not possible on any ZK function
- Root history of 30 — proof stays valid even if new deposits land before submission
- Yield recipient locked at `start_earning` time — cannot be changed after the fact
- Vesu deposit approved for exact `BTC_DENOMINATION` only — no excess allowance left on vToken
- Bob expiry strictly < Alice expiry — HTLC ordering enforced on-chain
- `swap_initiated` flag — Alice cannot double-spend after secret reveal
- Rate expiry (1h) + slippage guard — protects Alice from price manipulation at fill time
- DCA order marked inactive **before** USDC refund transfer in `cancel_dca` (CEI)
- All admin functions are owner-only (`assert_only_owner`)

> ⚠️ Unaudited testnet demo — do not use with real funds.

---

## License

MIT