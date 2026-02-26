# PrivateSwap Indexer

Checkpoint indexer for the PrivateSwap contract on Starknet Sepolia.

## Indexed Events

| Event                  | Entity                                    |
| ---------------------- | ----------------------------------------- |
| `Deposit`              | `Deposit`                                 |
| `Withdrawal`           | `Withdrawal`                              |
| `WbtcOrderPosted`      | `WbtcOrder`                               |
| `WbtcOrderFilled`      | Updates `WbtcOrder` + creates `StrkOrder` |
| `WbtcWithdrawn`        | Updates `WbtcOrder.is_withdrawn`          |
| `StrkWithdrawn`        | Updates `StrkOrder.is_withdrawn`          |
| `WbtcRefunded`         | Updates `WbtcOrder.is_refunded`           |
| `StrkRefunded`         | Updates `StrkOrder.is_refunded`           |
| `OwnershipTransferred` | `OwnershipTransfer`                       |

---

## Local Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Set up environment

```bash
cp .env.example .env
# Edit .env with your DATABASE_URL and RPC_URL
```

### 3. Start a local Postgres (if you don't have one)

```bash
docker compose up -d
```

### 4. Generate models & start indexer

```bash
npm run dev
```

GraphQL is now available at: **http://localhost:5100/graphql**

---

## Deploy to Railway (Recommended)

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Add a **PostgreSQL** plugin to your project
4. Set environment variables:
   - `DATABASE_URL` → copy from Railway's Postgres plugin
   - `RPC_URL` → your Starknet Sepolia RPC (e.g. from Blast or Infura)
5. Deploy — Railway gives you a public URL automatically

Your GraphQL endpoint will be: `https://your-app.railway.app/graphql`

---

## Example GraphQL Queries

### Get all open WbtcOrders

```graphql
{
  wbtcOrders(where: { is_filled: false, is_refunded: false }) {
    id
    wbtc_seller
    quoted_strk_amount
    expiry
    hashlock
  }
}
```

### Get all deposits

```graphql
{
  deposits(orderBy: "block_number", orderDirection: "desc") {
    id
    commitment
    leaf_index
    timestamp
    block_number
  }
}
```

### Get a specific order and its paired STRK order

```graphql
{
  wbtcOrder(id: "0x...") {
    id
    wbtc_seller
    wbtc_buyer
    is_filled
    is_withdrawn
    strk_order_id
    strk_amount_locked
  }
}
```

### Track latest indexed block

```graphql
{
  _metadata(id: "last_indexed_block") {
    value
  }
}
```

- Node.js 18+
- Postgres 15+
