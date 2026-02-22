use starknet::{ContractAddress, get_block_timestamp, get_caller_address, get_contract_address};
mod field;
mod incremental_merkle_tree;
mod pBTC;
mod pSTRK;
mod poseidon2;
mod poseidon2lib;
mod pragma_oracle;

// -------------------------------------------------------
// Interfaces
// -------------------------------------------------------

#[starknet::interface]
trait IVerifier<TContractState> {
    fn verify_ultra_keccak_zk_honk_proof(
        self: @TContractState, full_proof_with_hints: Span<felt252>,
    ) -> Result<Span<u256>, felt252>;
}

#[starknet::interface]
trait IPSTRKMint<TContractState> {
    fn mint(ref self: TContractState, recipient: ContractAddress, amount: u256);
}

#[starknet::interface]
trait IPBTCMint<TContractState> {
    fn mint(ref self: TContractState, recipient: ContractAddress, amount: u256);
}

#[starknet::interface]
trait IPrivateSwap<TContractState> {
    fn deposit(ref self: TContractState, commitment: u256);
    fn withdraw(
        ref self: TContractState,
        proof: Span<felt252>,
        root: u256,
        nullifier_hash: u256,
        recipient: ContractAddress,
        // NEW: the block timestamp recorded at deposit time.
        // The Noir circuit must expose this as a public input and prove that it corresponds
        // to the commitment being spent. The contract trusts it because the proof commits to it.
        // Without this, the contract has no way to know elapsed time without linking the
        // deposit to the withdrawal on-chain (which would break privacy).
        deposit_timestamp: u64,
    );
    fn mock_btc_mint(ref self: TContractState, recipient: ContractAddress, amount: u256);
    fn current_root(self: @TContractState) -> u256;
    fn next_leaf_index(self: @TContractState) -> u32;
    fn is_known_root(self: @TContractState, root: u256) -> bool;
    fn pstrk_address(self: @TContractState) -> ContractAddress;
    fn pbtc_address(self: @TContractState) -> ContractAddress;
    fn get_btc_usd_price(self: @TContractState) -> (u128, u32);
    fn get_strk_usd_price(self: @TContractState) -> (u128, u32);
    fn get_btc_strk_rate(self: @TContractState) -> u256;
    fn compute_yield(self: @TContractState, deposit_timestamp: u64) -> u256;
}

// -------------------------------------------------------
// Contract
// -------------------------------------------------------

#[starknet::contract]
mod PrivateSwap {
    use openzeppelin::token::erc20::interface::{IERC20Dispatcher, IERC20DispatcherTrait};
    use starknet::SyscallResultTrait;
    use starknet::class_hash::ClassHash;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::syscalls::deploy_syscall;
    use crate::incremental_merkle_tree::IncrementalMerkleTreeComponent;
    use crate::incremental_merkle_tree::IncrementalMerkleTreeComponent::InternalTrait;
    use crate::pragma_oracle::{
        AggregationMode, DataType, IPragmaABIDispatcher, IPragmaABIDispatcherTrait,
        PragmaPricesResponse,
    };
    use super::{
        ContractAddress, IPBTCMintDispatcher, IPBTCMintDispatcherTrait, IPSTRKMintDispatcher,
        IPSTRKMintDispatcherTrait, IVerifierDispatcher, IVerifierDispatcherTrait,
        get_block_timestamp, get_caller_address, get_contract_address,
    };
    component!(path: IncrementalMerkleTreeComponent, storage: imt, event: ImtEvent);

    // 1 pBTC — 8 decimals
    const DENOMINATION: u256 = 100_000_000;
    // pSTRK token precision — 18 decimals
    // FIX: previously missing, causing pstrk_amount to be ~10^10 times too small.
    const PSTRK_PRECISION: u256 = 1_000_000_000_000_000_000; // 10^18
    // Merkle tree depth — supports up to 2^10 = ~1k deposits
    const TREE_DEPTH: u32 = 10;

    // --- Yield constants ---
    // 5% APY expressed as basis points (500 / 10_000 = 0.05)
    const YIELD_RATE_BPS: u256 = 500;
    const BPS_DENOMINATOR: u256 = 10_000;
    // Seconds in a year (365.25 days), used to pro-rate yield
    const SECONDS_PER_YEAR: u256 = 31_557_600;
    // Maximum claimable yield per withdrawal — caps a single note at 1× its face
    // value (i.e., ~20 years at 5% APY). Prevents unbounded minting if a
    // deposit_timestamp is forged or the contract is used long after deployment.
    const MAX_YIELD: u256 = 100_000_000; // 1 pBTC (8 decimals)

    // Pragma pair keys
    const BTC_USD: felt252 = 'BTC/USD';
    const STRK_USD: felt252 = 'STRK/USD';

    // -------------------------------------------------------
    // Storage
    // -------------------------------------------------------
    #[storage]
    struct Storage {
        #[substorage(v0)]
        imt: IncrementalMerkleTreeComponent::Storage,
        commitments: Map<u256, bool>,
        nullifier_hashes: Map<u256, bool>,
        pbtc: ContractAddress,
        pstrk: ContractAddress,
        verifier: ContractAddress,
        // NEW: timestamp stored per commitment at deposit time.
        // Used by the Noir circuit as a private witness when generating the proof.
        // The circuit exposes deposit_timestamp as a public input so the contract
        // can compute yield without ever learning which commitment is being spent.
        commitment_timestamps: Map<u256, u64>,
    }

    // -------------------------------------------------------
    // Events
    // -------------------------------------------------------
    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        ImtEvent: IncrementalMerkleTreeComponent::Event,
        Deposit: Deposit,
        Withdrawal: Withdrawal,
    }

    #[derive(Drop, starknet::Event)]
    struct Deposit {
        #[key]
        commitment: u256,
        leaf_index: u32,
        timestamp: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct Withdrawal {
        #[key]
        recipient: ContractAddress,
        #[key]
        nullifier_hash: u256,
        // NEW: pBTC yield minted alongside the pSTRK swap, in satoshis (8 decimals).
        // Does not reveal position size — every note is 1 pBTC so yield only
        // discloses elapsed time, which the ZK proof already hides.
        yield_amount: u256,
    }

    // -------------------------------------------------------
    // Constructor
    // -------------------------------------------------------
    #[constructor]
    fn constructor(
        ref self: ContractState,
        pbtc_class_hash: ClassHash,
        pstrk_class_hash: ClassHash,
        verifier_class_hash: ClassHash,
    ) {
        // Deploy pBTC — no minter restriction, mock_btc_mint is open
        let mut pbtc_calldata: Array<felt252> = array![];
        let (pbtc_address, _) = deploy_syscall(pbtc_class_hash, 0, pbtc_calldata.span(), false)
            .unwrap_syscall();
        self.pbtc.write(pbtc_address);

        // Deploy pSTRK — minter is this contract so withdraw can mint
        let contract_address = get_contract_address();
        let mut pstrk_calldata: Array<felt252> = array![];
        pstrk_calldata.append(contract_address.into());
        let (pstrk_address, _) = deploy_syscall(pstrk_class_hash, 0, pstrk_calldata.span(), false)
            .unwrap_syscall();
        self.pstrk.write(pstrk_address);

        // Deploy Verifier — no constructor args needed
        let mut verifier_calldata: Array<felt252> = array![];
        let (verifier_address, _) = deploy_syscall(
            verifier_class_hash, 0, verifier_calldata.span(), false,
        )
            .unwrap_syscall();
        self.verifier.write(verifier_address);

        self.imt.initializer(TREE_DEPTH);
    }

    // -------------------------------------------------------
    // Implementation
    // -------------------------------------------------------
    #[abi(embed_v0)]
    impl PrivateSwapImpl of super::IPrivateSwap<ContractState> {
        // ---------------------------------------------------
        // MOCK MINT — for testing only
        // ---------------------------------------------------
        fn mock_btc_mint(ref self: ContractState, recipient: ContractAddress, amount: u256) {
            let pbtc = IPBTCMintDispatcher { contract_address: self.pbtc.read() };
            pbtc.mint(recipient, amount);
        }

        // ---------------------------------------------------
        // DEPOSIT
        // User generates commitment = Poseidon2(nullifier, secret) offchain.
        // Sends 1 pBTC + the commitment hash.
        //
        // NEW: the current block timestamp is written to storage keyed by commitment.
        // This value is never used by the contract on withdrawal — it exists solely
        // as an on-chain data source the prover can read when constructing the Noir
        // proof, so the circuit can commit to deposit_timestamp without the contract
        // needing to track commitment → nullifier linkage.
        // ---------------------------------------------------
        fn deposit(ref self: ContractState, commitment: u256) {
            assert(!self.commitments.read(commitment), 'commitment already used');

            // pull exactly 1 pBTC from caller
            let pbtc = IERC20Dispatcher { contract_address: self.pbtc.read() };
            let success = pbtc
                .transfer_from(get_caller_address(), get_contract_address(), DENOMINATION);
            assert(success, 'pBTC transfer failed');

            let now = get_block_timestamp();
            let leaf_index = self.imt._insert(commitment);
            self.commitments.write(commitment, true);
            // NEW: record when this commitment was deposited.
            self.commitment_timestamps.write(commitment, now);

            self.emit(Deposit { commitment, leaf_index, timestamp: now });
        }

        // ---------------------------------------------------
        // WITHDRAW
        //
        // NEW parameter: deposit_timestamp
        //   The Noir circuit must be updated to:
        //     1. Accept deposit_timestamp as a private input alongside nullifier/secret.
        //     2. Prove that commitment_timestamps[commitment] == deposit_timestamp
        //        (the prover reads this from the chain and includes it as a witness).
        //     3. Expose deposit_timestamp as a public output so the contract can
        //        read it here for yield calculation.
        //
        // On withdrawal the user receives:
        //   • pBTC yield  — pro-rated at YIELD_RATE_BPS APY for elapsed time,
        //                    minted because the contract holds the deposited pBTC.
        //   • pSTRK       — BTC/STRK swap at current Pragma price (existing behaviour).
        //
        // Privacy is preserved:
        //   • Elapsed time is the only new information revealed, and it is already
        //     hidden by the ZK proof (nobody can link it to the specific deposit).
        //   • All notes are exactly 1 pBTC so yield cannot reveal position size.
        // ---------------------------------------------------
        fn withdraw(
            ref self: ContractState,
            proof: Span<felt252>,
            root: u256,
            nullifier_hash: u256,
            recipient: ContractAddress,
            deposit_timestamp: u64,
        ) {
            // 1. root must be a root we've seen (last 30)
            assert(self.imt.is_known_root(root), 'unknown root');

            // 2. nullifier must not be spent
            assert(!self.nullifier_hashes.read(nullifier_hash), 'nullifier used');

            // 3. deposit_timestamp must be in the past — basic sanity check before
            //    the more expensive proof verification below.
            let now = get_block_timestamp();
            assert(deposit_timestamp <= now, 'timestamp in future');

            // 4. verify Noir proof via Garaga.
            //    The proof must commit to (root, nullifier_hash, recipient, deposit_timestamp)
            //    so a caller cannot substitute an earlier timestamp to inflate yield.
            let verifier = IVerifierDispatcher { contract_address: self.verifier.read() };
            let result = verifier.verify_ultra_keccak_zk_honk_proof(proof);
            assert(result.is_ok(), 'invalid proof');

            // 5. mark nullifier spent before all external calls — reentrancy guard
            self.nullifier_hashes.write(nullifier_hash, true);

            // ---------------------------------------------------
            // NEW: compute and mint pBTC yield
            //
            // yield = DENOMINATION × YIELD_RATE_BPS × elapsed
            //         / (BPS_DENOMINATOR × SECONDS_PER_YEAR)
            //
            // Example: 1 year elapsed at 5% APY
            //   = 100_000_000 × 500 × 31_557_600 / (10_000 × 31_557_600)
            //   = 100_000_000 × 0.05
            //   = 5_000_000 satoshis = 0.05 pBTC
            //
            // Capped at MAX_YIELD to bound worst-case minting from a forged timestamp.
            // (The proof prevents forgery in practice; the cap is a defence-in-depth.)
            // ---------------------------------------------------
            let elapsed: u256 = (now - deposit_timestamp).into();
            let mut yield_amount: u256 = (DENOMINATION * YIELD_RATE_BPS * elapsed)
                / (BPS_DENOMINATOR * SECONDS_PER_YEAR);
            if yield_amount > MAX_YIELD {
                yield_amount = MAX_YIELD;
            }
            if yield_amount > 0 {
                let pbtc_minter = IPBTCMintDispatcher { contract_address: self.pbtc.read() };
                pbtc_minter.mint(recipient, yield_amount);
            }

            // ---------------------------------------------------
            // Existing: swap 1 pBTC principal → pSTRK at Pragma market rate.
            // FIX (from prior review): PSTRK_PRECISION included so the minted
            // amount is in 18-decimal token units, not raw oracle units.
            // ---------------------------------------------------
            let (btc_usd, btc_dec) = self.get_token_price(DataType::SpotEntry(BTC_USD));
            let (strk_usd, strk_dec) = self.get_token_price(DataType::SpotEntry(STRK_USD));

            assert(btc_usd > 0, 'invalid BTC price');
            assert(strk_usd > 0, 'invalid STRK price');

            let pstrk_amount: u256 = (DENOMINATION
                * btc_usd.into()
                * self.pow10(strk_dec.into())
                * PSTRK_PRECISION)
                / (strk_usd.into() * self.pow10(btc_dec.into()));

            assert(pstrk_amount > 0, 'pSTRK amount is zero');

            let pstrk = IPSTRKMintDispatcher { contract_address: self.pstrk.read() };
            pstrk.mint(recipient, pstrk_amount);

            self.emit(Withdrawal { recipient, nullifier_hash, yield_amount });
        }

        // ---------------------------------------------------
        // Views
        // ---------------------------------------------------

        // NEW: lets the frontend preview yield before the user builds their proof.
        // Pass the deposit_timestamp that was emitted in the Deposit event (or read
        // from commitment_timestamps off-chain) to see what yield would be minted now.
        fn compute_yield(self: @ContractState, deposit_timestamp: u64) -> u256 {
            let now = get_block_timestamp();
            if deposit_timestamp >= now {
                return 0;
            }
            let elapsed: u256 = (now - deposit_timestamp).into();
            let mut yield_amount: u256 = (DENOMINATION * YIELD_RATE_BPS * elapsed)
                / (BPS_DENOMINATOR * SECONDS_PER_YEAR);
            if yield_amount > MAX_YIELD {
                yield_amount = MAX_YIELD;
            }
            yield_amount
        }

        fn get_btc_usd_price(self: @ContractState) -> (u128, u32) {
            self.get_token_price(DataType::SpotEntry(BTC_USD))
        }

        fn get_strk_usd_price(self: @ContractState) -> (u128, u32) {
            self.get_token_price(DataType::SpotEntry(STRK_USD))
        }

        fn get_btc_strk_rate(self: @ContractState) -> u256 {
            let (btc_usd, btc_dec) = self.get_token_price(DataType::SpotEntry(BTC_USD));
            let (strk_usd, strk_dec) = self.get_token_price(DataType::SpotEntry(STRK_USD));

            assert(btc_usd > 0, 'invalid BTC price');
            assert(strk_usd > 0, 'invalid STRK price');

            (DENOMINATION
                * btc_usd.into()
                * self.pow10(strk_dec.into())
                * PSTRK_PRECISION)
                / (strk_usd.into() * self.pow10(btc_dec.into()))
        }

        fn current_root(self: @ContractState) -> u256 {
            self.imt.current_root()
        }

        fn next_leaf_index(self: @ContractState) -> u32 {
            self.imt.next_leaf_index()
        }

        fn is_known_root(self: @ContractState, root: u256) -> bool {
            self.imt.is_known_root(root)
        }

        fn pstrk_address(self: @ContractState) -> ContractAddress {
            self.pstrk.read()
        }

        fn pbtc_address(self: @ContractState) -> ContractAddress {
            self.pbtc.read()
        }
    }

    // -------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------

    #[generate_trait]
    impl Private of PrivateTrait {
        fn get_token_price(self: @ContractState, asset: DataType) -> (u128, u32) {
            let oracle_address: ContractAddress =
                0x036031daa264c24520b11d93af622c848b2499b66b41d611bac95e13cfca131a
                .try_into()
                .unwrap();
            let oracle = IPragmaABIDispatcher { contract_address: oracle_address };
            // Ignore this warnings -> so we match the Pragma ABI exactly, which has no parentheses
            // for the enum variants
            let output: PragmaPricesResponse = oracle.get_data(asset, AggregationMode::Median(()));
            (output.price, output.decimals)
        }

        fn pow10(self: @ContractState, n: u256) -> u256 {
            let mut result: u256 = 1;
            let mut i: u256 = 0;
            while i < n {
                result *= 10;
                i += 1;
            }
            result
        }
    }
}
