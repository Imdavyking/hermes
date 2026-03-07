# Hermes — BTC DCA on Starknet

> Automatically buy real Bitcoin with USDC on a schedule. Set it, forget it. Native BTC delivered to your Bitcoin wallet — no bridging, no wrapping.

**Pragma/Chainlink** (oracle) · **Atomiq** (cross-chain LP network) · **Gelato-style keeper** (automation)

---

## How It Works

Schedule recurring fixed-dollar BTC purchases at the live oracle price. USDC is a stable spend — BTC received varies with price, which is exactly the point of DCA. Unlike simple wBTC-minting tools, Hermes delivers **native BTC to your Bitcoin wallet** via the Atomiq cross-chain LP network.

**Creating an order:**

1. Connect your Bitcoin wallet (Xverse) or paste a Bitcoin address directly
2. Approve `usdc_per_interval × total_intervals` USDC + a STRK keeper fee reserve
3. Call `create_dca_order(btc_destination, usdc_per_interval, interval_hours, total_intervals)` — full USDC + STRK fee pulled upfront
4. A keeper calls `execute_dca(order_id, escrow, ...)` once per interval — commits STRK to Atomiq, which routes BTC to your Bitcoin address

**Execution lifecycle:**

- `DCAExecuted` — STRK committed to Atomiq escrow, interval marked pending
- `DCAIntervalClaimed` — LP confirmed BTC delivery, interval unlocked for next execution
- `DCAIntervalRefunded` — LP failed, STRK reclaimed from Atomiq, interval counter rolled back and retried automatically

**Cancelling:**

- Call `cancel_dca(order_id)` — marks order inactive and refunds all remaining unspent USDC + unused STRK keeper fee reserve
- Already-executed and confirmed intervals are not reversed

**Keeper integration (Gelato-style):**

- `checker(order_id)` returns `(can_exec, payload)` — keeper polls this view and fires when `can_exec` is true
- `payload.strk_amount` is the live oracle-priced STRK equivalent of `usdc_per_interval` — no keeper-side oracle math needed
- Keeper needs zero capital and zero approvals; they never touch funds

**Constraints:**

- `usdc_per_interval` ≥ 1 USDC
- `interval_hours`: 1–720 (1 hour to 30 days)
- `total_intervals`: 1–1,000
- `strk_amount` validated within 5% of live oracle price to prevent keeper manipulation

---

## Contract Reference

| Function                                                                                | Description                                                                         |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `create_dca_order(btc_destination, usdc_per_interval, interval_hours, total_intervals)` | Deposit USDC + STRK fee upfront, schedule recurring BTC purchases                   |
| `execute_dca(order_id, escrow, signature, timeout, extra_data)`                         | Keeper: commit STRK to Atomiq escrow for one interval's BTC delivery                |
| `claim_dca_interval(order_id)`                                                          | Settle a pending Atomiq escrow — claim (BTC delivered) or refund (LP failed, retry) |
| `cancel_dca(order_id)`                                                                  | Cancel active order, refund remaining USDC + STRK fee reserve                       |
| `checker(order_id)`                                                                     | Keeper resolver: returns `(can_exec, payload)` with live `strk_amount`              |
| `get_dca_order(order_id)`                                                               | Fetch a DCA order by ID                                                             |
| `get_dca_pending_escrow(order_id)`                                                      | Fetch the pending Atomiq escrow for an order                                        |
| `dca_interval_needs_refund(order_id)`                                                   | Whether an interval is awaiting escrow settlement                                   |
| `get_dca_pending_interval_index(order_id)`                                              | Index of the currently pending interval                                             |
| `get_btc_usd_price()`                                                                   | Live BTC/USD price from Chainlink/Pragma                                            |
| `get_strk_usd_price()`                                                                  | Live STRK/USD price from Chainlink/Pragma                                           |
| `get_dca_strk_reserved(order_id)`                                                       | Remaining STRK keeper fee reserve for an order                                      |
| `get_dca_btc_destination(order_id)`                                                     | Bitcoin address for an order                                                        |
| `keeper_fee_strk()`                                                                     | STRK fee paid to keeper per interval (0.5 STRK)                                     |

**Token addresses (Sepolia):**

```
STRK: 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d
USDC: 0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8
```

---

## Architecture

```
contracts/   Cairo contract (Hermes)
indexer/     Checkpoint indexer → GraphQL API
frontend/    React UI
keeper/      Automated keeper — polls checker(), builds Atomiq escrow, calls execute_dca
```

**Key decisions:**

| Decision                         | Reason                                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| USDC (not STRK) for DCA spend    | STRK's dollar value fluctuates; USDC makes `usdc_per_interval` a genuine fixed dollar budget |
| STRK for keeper fee reserve      | Atomiq escrows are denominated in STRK; contract converts via oracle internally              |
| USDC pulled upfront              | Simplifies keeper: no capital, no approvals, no per-execution user interaction               |
| Atomiq for BTC delivery          | Native BTC to a real Bitcoin address — not a wrapped token on Starknet                       |
| `dca_interval_needs_refund` flag | Prevents double-execution while an Atomiq escrow is in flight                                |
| 5% STRK tolerance window         | Prevents keeper from committing a stale or manipulated STRK amount to Atomiq                 |
| Checkpoint indexer               | Single GraphQL query vs O(n) RPC calls for order and execution history                       |
| Mock USDC with public mint       | Judges can fund themselves instantly without external faucets                                |

**Oracle (Chainlink primary, Pragma fallback — Sepolia):**

```
// Chainlink (Sepolia)
BTC/USD:  0x0258b8f498b767c200577227e3e9f009c9b0fe7f6a3c8c2c24efd588c54747a
STRK/USD: 0x0a5db422ee7c28beead49303646e44ef9cbb8364eeba4d8af9ac06a3b556937

// Pragma oracle (Sepolia)
const PRAGMA_ORACLE_ADDRESS: felt252 =
 0x036031daa264c24520b11d93af622c848b2499b66b41d611bac95e13cfca131a;

STRK for USDC = usdc_amount × STRK_PRECISION × 10^strk_dec / (strk_usd × USDC_PRECISION)
```

Max oracle age: 14 days (testnet) — tighten to 1h for mainnet.

---

## Quick Start

### 1. Install dependencies

```bash
make install-bun
make install-starknet          # starkup (Cairo toolchain)
make install-scarb             # Scarb 2.14.0 via asdf
make install-app-deps          # frontend + keeper + indexer JS deps
```

### 2. Build & deploy contract

```bash
make build-contract            # scarb build
cp .env.example .env           # fill in RPC_ENDPOINT, DEPLOYER_ADDRESS, DEPLOYER_PRIVATE_KEY
make deploy-contract           # yarn deploy
```

### 3. Copy build artifacts

```bash
make artifacts
# copies ABI → indexer/src/abis/ and keeper/src/abis/
# generates typed ABI → frontend/src/assets/json/abi.ts
```

### 4. Run the full stack

```bash
cp indexer/.env.example indexer/.env
cp frontend/.env.example frontend/.env
make start                        # docker compose up --build
```

Services: **Postgres** `:5555` · **Indexer + GraphQL** `:5100` · **Frontend** `:3000`

> Always run `make up` from the root. Running `make up-indexer` first will bind port 5100 and cause a conflict.

### Local dev (no Docker)

```bash
make run-indexer               # indexer only (yarn dev)
make run-frontend              # frontend only (yarn dev)
```

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

- DCA order marked inactive **before** USDC refund transfer in `cancel_dca` (CEI — no reentrancy)
- `dca_interval_needs_refund` flag — prevents double-execution while Atomiq escrow is in flight
- Keeper `strk_amount` validated within 5% of live oracle — prevents manipulation of escrow amount
- Keeper fee only paid to registered keepers — unregistered callers can execute but receive no fee
- All admin functions are owner-only (`assert_only_owner`)

> ⚠️ Unaudited testnet demo — do not use with real funds.

---

## License

MIT
