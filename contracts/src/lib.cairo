use starknet::{ContractAddress, get_block_timestamp, get_caller_address, get_contract_address};
mod field;
mod incremental_merkle_tree;
mod poseidon2;
mod poseidon2lib;

// -------------------------------------------------------
// Interfaces
// -------------------------------------------------------

#[starknet::interface]
trait IVerifier<TContractState> {
    fn verify_ultra_keccak_zk_honk_proof(
        self: @TContractState, full_proof_with_hints: Span<felt252>,
    ) -> Result<Span<u256>, felt252>;
}

/// Chainlink round response struct — must match the ABI exactly.
/// round_id is felt252 because Chainlink uses phase-prefixed IDs that overflow u128.
#[derive(Drop, Serde)]
struct Round {
    round_id: felt252,
    answer: u128,
    block_num: u64,
    started_at: u64,
    updated_at: u64,
}

/// Chainlink AggregatorProxy interface
#[starknet::interface]
trait IAggregatorProxy<TContractState> {
    fn latest_round_data(self: @TContractState) -> Round;
    fn decimals(self: @TContractState) -> u8;
}

#[starknet::interface]
trait IPrivateSwap<TContractState> {
    fn deposit(ref self: TContractState, commitment: u256);
    fn initate_lock(
        ref self: TContractState,
        proof: Span<felt252>,
        recipient: ContractAddress,
        hashlock: felt252,
        timelock: u64,
    );
    fn current_root(self: @TContractState) -> u256;
    fn next_leaf_index(self: @TContractState) -> u32;
    fn is_known_root(self: @TContractState, root: u256) -> bool;
    fn wBTC_address(self: @TContractState) -> ContractAddress;
    fn strk_address(self: @TContractState) -> ContractAddress;
    fn wBTC_denomination(self: @TContractState) -> u256;
    fn get_btc_usd_price(self: @TContractState) -> (u128, u32);
    fn get_strk_usd_price(self: @TContractState) -> (u128, u32);
    fn get_btc_strk_rate(self: @TContractState) -> u256;
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
    use super::{
        ContractAddress, IAggregatorProxyDispatcher, IAggregatorProxyDispatcherTrait,
        IVerifierDispatcher, IVerifierDispatcherTrait, get_block_timestamp, get_caller_address,
        get_contract_address,
    };
    component!(path: IncrementalMerkleTreeComponent, storage: imt, event: ImtEvent);

    const BTC_DENOMINATION: u256 = 1_000;
    const STRK_PRECISION: u256 = 1_000_000_000_000_000_000; // 10^18
    const TREE_DEPTH: u32 = 10;

    // Chainlink Sepolia feed addresses
    // BTC/USD — 8 decimals
    const BTC_USD_FEED: felt252 = 0x0258b8f498b767c200577227e3e9f009c9b0fe7f6a3c8c2c24efd588c54747a;
    // STRK/USD — 8 decimals
    const STRK_USD_FEED: felt252 =
        0x0a5db422ee7c28beead49303646e44ef9cbb8364eeba4d8af9ac06a3b556937;

    // 24 hours — testnet feeds update infrequently
    const MAX_PRICE_AGE: u64 = 86400;

    // -------------------------------------------------------
    // Storage
    // -------------------------------------------------------
    #[storage]
    struct Storage {
        #[substorage(v0)]
        imt: IncrementalMerkleTreeComponent::Storage,
        commitments: Map<u256, bool>,
        nullifier_hashes: Map<u256, bool>,
        wBTC: ContractAddress,
        strk: ContractAddress,
        verifier: ContractAddress,
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
    }

    // -------------------------------------------------------
    // Constructor
    // -------------------------------------------------------
    #[constructor]
    fn constructor(
        ref self: ContractState, pstrk_class_hash: ClassHash, verifier_class_hash: ClassHash,
    ) {
        self
            .wBTC
            .write(
                0x00452bd5c0512a61df7c7be8cfea5e4f893cb40e126bdc40aee6054db955129e
                    .try_into()
                    .unwrap(),
            );

        let contract_address = get_contract_address();

        self
            .strk
            .write(
                0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d
                    .try_into()
                    .unwrap(),
            );

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
        // DEPOSIT
        // User generates commitment = Poseidon2(nullifier, secret) offchain
        // ---------------------------------------------------
        fn deposit(ref self: ContractState, commitment: u256) {
            assert(!self.commitments.read(commitment), 'commitment already used');

            let wBTC = IERC20Dispatcher { contract_address: self.wBTC.read() };
            let success = wBTC
                .transfer_from(get_caller_address(), get_contract_address(), BTC_DENOMINATION);
            assert(success, 'wBTC transfer failed');

            let leaf_index = self.imt._insert(commitment);
            self.commitments.write(commitment, true);
            self.emit(Deposit { commitment, leaf_index, timestamp: get_block_timestamp() });
        }

        // ---------------------------------------------------

        // ---------------------------------------------------
        fn initate_lock(
            ref self: ContractState,
            proof: Span<felt252>,
            recipient: ContractAddress,
            hashlock: felt252,
            timelock: u64,
        ) {
            let verifier = IVerifierDispatcher { contract_address: self.verifier.read() };
            let verified_proof = verifier.verify_ultra_keccak_zk_honk_proof(proof);
            assert(verified_proof.is_ok(), 'invalid proof');

            let result = verified_proof.unwrap();
            let root = *result.at(0);
            let nullifier_hash = *result.at(1);

            // 1. root must be a root we've seen (last 30)
            assert(self.imt.is_known_root(root), 'unknown root');

            // 2. nullifier must not be spent
            assert(!self.nullifier_hashes.read(nullifier_hash), 'nullifier used');

            // 3. mark nullifier spent before external calls — reentrancy guard
            self.nullifier_hashes.write(nullifier_hash, true);
        }

        fn get_btc_usd_price(self: @ContractState) -> (u128, u32) {
            self.get_chainlink_price(BTC_USD_FEED)
        }

        fn get_strk_usd_price(self: @ContractState) -> (u128, u32) {
            self.get_chainlink_price(STRK_USD_FEED)
        }

        fn get_btc_strk_rate(self: @ContractState) -> u256 {
            let (btc_usd, btc_dec) = self.get_chainlink_price(BTC_USD_FEED);
            let (strk_usd, strk_dec) = self.get_chainlink_price(STRK_USD_FEED);

            assert(btc_usd > 0, 'invalid BTC price');
            assert(strk_usd > 0, 'invalid STRK price');

            (btc_usd.into() * self.pow10(strk_dec.into()) * STRK_PRECISION)
                / (strk_usd.into() * self.pow10(btc_dec.into()))
        }

        // ---------------------------------------------------
        // Views
        // ---------------------------------------------------
        fn current_root(self: @ContractState) -> u256 {
            self.imt.current_root()
        }

        fn next_leaf_index(self: @ContractState) -> u32 {
            self.imt.next_leaf_index()
        }

        fn is_known_root(self: @ContractState, root: u256) -> bool {
            self.imt.is_known_root(root)
        }

        fn strk_address(self: @ContractState) -> ContractAddress {
            self.strk.read()
        }

        fn wBTC_address(self: @ContractState) -> ContractAddress {
            self.wBTC.read()
        }

        fn wBTC_denomination(self: @ContractState) -> u256 {
            BTC_DENOMINATION
        }
    }

    // -------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------

    #[generate_trait]
    impl Private of PrivateTrait {
        /// Reads latest price from a Chainlink feed.
        /// Returns (price, decimals) — same signature as the old Pragma helper
        /// so all the cross-rate math above is unchanged.
        fn get_chainlink_price(self: @ContractState, feed_address: felt252) -> (u128, u32) {
            let feed = IAggregatorProxyDispatcher {
                contract_address: feed_address.try_into().unwrap(),
            };

            let round = feed.latest_round_data();

            // Staleness check — revert if price is older than MAX_PRICE_AGE
            let block_time = get_block_timestamp();
            assert(block_time - round.updated_at < MAX_PRICE_AGE, 'stale price');
            assert(round.answer > 0, 'invalid price');

            let decimals: u32 = feed.decimals().into(); // Chainlink feeds use 8 decimals
            (round.answer, decimals)
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
