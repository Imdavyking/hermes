use starknet::{ContractAddress, get_block_timestamp, get_caller_address, get_contract_address};
mod field;
mod incremental_merkle_tree;
mod pSTRK;
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

#[starknet::interface]
trait IPSTRKMint<TContractState> {
    fn mint(ref self: TContractState, recipient: ContractAddress, amount: u256);
}

/// Chainlink AggregatorProxy interface
#[starknet::interface]
trait IAggregatorProxy<TContractState> {
    fn latest_round_data(self: @TContractState) -> (u128, u128, u64, u64, u128);
    // returns: (round_id, answer, started_at, updated_at, answered_in_round)
    fn decimals(self: @TContractState) -> u8;
}

#[starknet::interface]
trait IPrivateSwap<TContractState> {
    fn deposit(ref self: TContractState, commitment: u256);
    fn withdraw(ref self: TContractState, proof: Span<felt252>, recipient: ContractAddress);
    fn current_root(self: @TContractState) -> u256;
    fn next_leaf_index(self: @TContractState) -> u32;
    fn is_known_root(self: @TContractState, root: u256) -> bool;
    fn pstrk_address(self: @TContractState) -> ContractAddress;
    fn wBTC_address(self: @TContractState) -> ContractAddress;
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
        IPSTRKMintDispatcher, IPSTRKMintDispatcherTrait, IVerifierDispatcher,
        IVerifierDispatcherTrait, get_block_timestamp, get_caller_address, get_contract_address,
    };
    component!(path: IncrementalMerkleTreeComponent, storage: imt, event: ImtEvent);

    const BTC_DENOMINATION: u256 = 1_000;
    const PSTRK_PRECISION: u256 = 1_000_000_000_000_000_000; // 10^18
    const TREE_DEPTH: u32 = 10;

    // Chainlink Sepolia feed addresses
    // BTC/USD — 8 decimals
    const BTC_USD_FEED: felt252 = 0x0258b8f498b767c200577227e3e9f009c9b0fe7f6a3c8c2c24efd588c54747a;
    // STRK/USD — 8 decimals
    const STRK_USD_FEED: felt252 =
        0x0a5db422ee7c28beead49303646e44ef9cbb8364eeba4d8af9ac06a3b556937;

    // Max price age: 1 hour. Revert if Chainlink hasn't updated within this window.
    const MAX_PRICE_AGE: u64 = 3600;

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
        pstrk: ContractAddress,
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
        let mut pstrk_calldata: Array<felt252> = array![];
        pstrk_calldata.append(contract_address.into());
        let (pstrk_address, _) = deploy_syscall(pstrk_class_hash, 0, pstrk_calldata.span(), false)
            .unwrap_syscall();
        self.pstrk.write(pstrk_address);

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
        // WITHDRAW
        // User submits a Noir proof that they know a secret
        // corresponding to a commitment in the tree.
        // Contract mints pSTRK at BTC/STRK market rate via Chainlink.
        // ---------------------------------------------------
        fn withdraw(ref self: ContractState, proof: Span<felt252>, recipient: ContractAddress) {
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

            // 4. fetch BTC/USD and STRK/USD from Chainlink, derive BTC/STRK cross rate
            let (btc_usd, btc_dec) = self.get_chainlink_price(BTC_USD_FEED);
            let (strk_usd, strk_dec) = self.get_chainlink_price(STRK_USD_FEED);

            assert(btc_usd > 0, 'invalid BTC price');
            assert(strk_usd > 0, 'invalid STRK price');

            // BTC/STRK cross rate in 18-decimal pSTRK token units:
            //   (btc_usd / strk_usd) gives how many STRK per 1 BTC,
            //   scaled by PSTRK_PRECISION to preserve 18-decimal token wei.
            let onestrk_btc: u256 = (btc_usd.into() * self.pow10(strk_dec.into()) * PSTRK_PRECISION)
                / (strk_usd.into() * self.pow10(btc_dec.into()));

            let pstrk_amount = onestrk_btc / (self.pow10(btc_dec.into()) / BTC_DENOMINATION);

            assert(pstrk_amount > 0, 'pSTRK amount is zero');

            // 5. mint pSTRK to recipient
            let pstrk = IPSTRKMintDispatcher { contract_address: self.pstrk.read() };
            pstrk.mint(recipient, pstrk_amount);

            self.emit(Withdrawal { recipient, nullifier_hash });
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

            (btc_usd.into() * self.pow10(strk_dec.into()) * PSTRK_PRECISION)
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

        fn pstrk_address(self: @ContractState) -> ContractAddress {
            self.pstrk.read()
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
        /// Returns (price, decimals) matching the old Pragma signature
        /// so the rest of the math is unchanged.
        fn get_chainlink_price(self: @ContractState, feed_address: felt252) -> (u128, u32) {
            let feed = IAggregatorProxyDispatcher {
                contract_address: feed_address.try_into().unwrap(),
            };

            let (_, answer, _, updated_at, _) = feed.latest_round_data();
            // round_id, answer, started_at, updated_at, answered_in_round

            // Staleness check — revert if price is older than MAX_PRICE_AGE
            let block_time = get_block_timestamp();
            assert(block_time - updated_at < MAX_PRICE_AGE, 'stale price');
            assert(answer > 0, 'invalid price');

            let decimals: u32 = feed.decimals().into(); // Chainlink feeds use 8 decimals
            (answer, decimals)
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
