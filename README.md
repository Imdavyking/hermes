# Umbra — Private BTC Swap on Starknet

> Deposit Bitcoin anonymously. Withdraw Starknet tokens. No one knows who you are.

Umbra is a privacy-preserving BTC swap protocol built on Starknet. Users deposit pBTC into a shielded pool backed by a ZK-verified incremental Merkle tree, then withdraw an equivalent value in pSTRK — with zero on-chain link between depositor and withdrawer.

Proofs are generated with **Noir** and verified on-chain via **Garaga**. Prices are sourced from the **Pragma oracle** (BTC/USD and STRK/USD cross rate). The Merkle tree uses **Poseidon2 over BN254** to stay compatible with Noir's native hash.

---

## How It Works

### Deposit

1. Call `mock_btc_mint` to receive test pBTC (demo only)
2. Approve PrivateSwap to spend `100,000,000` (1 pBTC, 8 decimals)
3. Generate a random `nullifier` and `secret` offchain
4. Compute `commitment = Poseidon2(nullifier, secret)`
5. Save your note — `{ nullifier, secret }` — you will need it to withdraw
6. Call `deposit(commitment)` — your commitment is inserted into the Merkle tree

### Withdraw

1. Load your saved `nullifier` and `secret`
2. Frontend fetches the current Merkle root and computes your inclusion proof
3. Noir circuit generates a ZK proof that you know a valid `(nullifier, secret)` for a commitment in the tree — without revealing which one
4. Call `withdraw(proof, root, nullifier_hash, recipient)`
5. Contract verifies the proof, checks the root, marks the nullifier spent, and mints pSTRK to your recipient address at the live BTC/STRK market rate

---

## Architecture

```
contracts/
├── lib.cairo                      # Entry point, module declarations
├── field.cairo                    # BN254 field arithmetic
├── poseidon2.cairo                # Poseidon2 permutation (BN254)
├── poseidon2lib.cairo             # Public Poseidon2 API
├── incremental_merkle_tree.cairo  # On-chain IMT component (depth 20)
├── pragma_oracle.cairo            # Manual Pragma ABI (no lib dependency)
├── pBTC.cairo                     # Mock wrapped Bitcoin (8 decimals)
└── pSTRK.cairo                    # Mock Starknet token (18 decimals, minted on withdraw)

noir/
└── src/
    └── main.nr                    # ZK circuit: proves Merkle membership without revealing leaf
```

### Key Design Decisions

| Decision                               | Reason                                                        |
| -------------------------------------- | ------------------------------------------------------------- |
| Poseidon2 over BN254 (not Stark field) | Matches Noir's native hash — proofs are compatible            |
| Incremental Merkle tree depth 20       | Supports ~1M deposits                                         |
| Root history of 30                     | Users can withdraw even if new deposits happened after theirs |
| Nullifier hash on-chain                | Prevents double withdrawal without revealing the note         |
| pSTRK minted on withdraw               | No pre-funded liquidity needed for demo                       |
| BTC/STRK cross rate via Pragma         | Real on-chain price feed — BTC/USD ÷ STRK/USD                 |

---

## Contracts

### PrivateSwap

The main contract. Deploys pBTC, pSTRK, and the Garaga verifier internally from their class hashes.

| Function                                           | Description                                 |
| -------------------------------------------------- | ------------------------------------------- |
| `mock_btc_mint(recipient, amount)`                 | Mint test pBTC for demo purposes            |
| `deposit(commitment)`                              | Deposit 1 pBTC, insert commitment into tree |
| `withdraw(proof, root, nullifier_hash, recipient)` | Verify ZK proof, mint pSTRK at market rate  |
| `current_root()`                                   | Latest Merkle root                          |
| `next_leaf_index()`                                | Number of deposits so far                   |
| `is_known_root(root)`                              | Check if root is in last 30 roots           |
| `pbtc_address()`                                   | Deployed pBTC contract address              |
| `pstrk_address()`                                  | Deployed pSTRK contract address             |
| `get_btc_usd_price()`                              | Live BTC/USD from Pragma                    |
| `get_strk_usd_price()`                             | Live STRK/USD from Pragma                   |
| `get_btc_strk_rate()`                              | Computed pSTRK payout for 1 pBTC            |

### pBTC (Private Bitcoin)

Mock ERC20 with 8 decimals. Freely mintable via PrivateSwap's `mock_btc_mint` for testing.

### pSTRK (Private Starknet)

Mock ERC20 with 18 decimals. Only PrivateSwap can mint — minted on each valid withdrawal.

---

## Oracle Integration

Prices are fetched from the **Pragma oracle** on Starknet Sepolia:

```
Oracle address: 0x036031daa264c24520b11d93af622c848b2499b66b41d611bac95e13cfca131a
BTC/USD key:  18669995996566340
STRK/USD key: 6004514686061859652
```

The BTC/STRK rate is computed as a cross rate:

```
pSTRK amount = (1 pBTC × BTC/USD price) / STRK/USD price
```

Both prices are returned with 8 decimals from Pragma, which are normalised before the division.

---

## ZK Circuit (Noir)

```noir
use dep::poseidon::poseidon2;

pub fn compute_merkle_root(
    leaf: Field,
    merkle_proof: [Field; 20],
    is_even: [bool; 20]
) -> Field {
    let mut hash = leaf;
    for i in 0..20 {
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

Public inputs: `root`, `nullifier_hash`, `recipient`  
Private inputs: `nullifier`, `secret`, `merkle_proof`, `is_even`

The circuit proves:

- `commitment = Poseidon2(nullifier, secret)` exists in the tree
- `nullifier_hash = hash(nullifier)` (prevents double spend without revealing nullifier)
- The claimed `root` is the correct root for the given proof path

---

## Getting Started

### Prerequisites

- Scarb 2.14.0
- Cairo 2.14.0
- snforge 0.53.0
- Node.js + Yarn (for deploy scripts)
- Noir + Barretenberg (for proof generation)

### Build

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
# set up .env
cp .env.example .env
# fill in RPC_ENDPOINT, DEPLOYER_ADDRESS, DEPLOYER_PRIVATE_KEY

yarn deploy
```

The deploy script:

1. Declares the Garaga verifier class
2. Declares pBTC class
3. Declares pSTRK class
4. Deploys PrivateSwap with all three class hashes — pBTC, pSTRK, and verifier are deployed internally

---

## Environment Variables

```env
RPC_ENDPOINT=https://starknet-sepolia.infura.io/v3/YOUR_KEY
DEPLOYER_ADDRESS=0x...
DEPLOYER_PRIVATE_KEY=0x...
```

---

## Bitcoin Track

Umbra qualifies for the **Bitcoin track** through:

- **BTC wrapper** — pBTC mirrors real wBTC (8 decimals, same denomination)
- **BTCFi** — BTC is the deposit asset; the entire protocol is priced in BTC terms
- **Live BTC price feed** — Pragma BTC/USD oracle drives every withdrawal payout
- **Mainnet ready** — swap `pbtc_class_hash` for real wBTC (`0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac`) to go live

---

## Security Notes

- Nullifiers are marked spent **before** external mint calls (reentrancy guard)
- Root history of 30 prevents griefing via fast root rotation
- `mock_btc_mint` is open to anyone — **remove or restrict before mainnet**
- Proof verification is handled by Garaga's `verify_ultra_keccak_zk_honk_proof`
- This is an unaudited demo — do not use with real funds

---

## License

MIT
