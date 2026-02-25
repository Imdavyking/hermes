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

#[derive(Drop, Serde)]
struct Round {
    round_id: felt252,
    answer: u128,
    block_num: u64,
    started_at: u64,
    updated_at: u64,
}

#[starknet::interface]
trait IAggregatorProxy<TContractState> {
    fn latest_round_data(self: @TContractState) -> Round;
    fn decimals(self: @TContractState) -> u8;
}

#[derive(Drop, Serde, Copy, starknet::Store)]
struct Swap {
    token: ContractAddress,
    sender: ContractAddress,          // refund address
    recipient: ContractAddress,       // who receives this token (zero = open order)
    strk_recipient: ContractAddress,  // where Alice wants her STRK sent (wBTC swap only)
    hashlock: felt252,
    amount: u256,
    timelock: u64,
    filled: bool,    // true once someone calls fill_swap
    withdrawn: bool,
    refunded: bool,
}

#[starknet::interface]
trait IPrivateSwap<TContractState> {
    fn deposit(ref self: TContractState, commitment: u256);
    // strk_recipient = where Alice wants her STRK
    // recipient = zero for open order, or Bob's address for private swap
    fn create_swap_wbtc(
        ref self: TContractState,
        proof: Span<felt252>,
        strk_recipient: ContractAddress,
        hashlock: felt252,
        timelock: u64,
    );
    fn create_swap_strk(
        ref self: TContractState,
        recipient: ContractAddress,
        amount: u256,
        hashlock: felt252,
        timelock: u64,
    );
    // Bob calls this to fill an open wBTC order
    // atomically: sets himself as recipient + locks his STRK
    fn fill_swap(
        ref self: TContractState,
        wbtc_swap_id: felt252,
        timelock: u64,
    );
    fn withdraw(ref self: TContractState, swap_id: felt252, secret: felt252);
    fn refund(ref self: TContractState, swap_id: felt252);
    fn get_swap(self: @TContractState, swap_id: felt252) -> Swap;
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
    use core::pedersen::pedersen;
    use starknet::contract_address::contract_address_const;
    use crate::incremental_merkle_tree::IncrementalMerkleTreeComponent;
    use crate::incremental_merkle_tree::IncrementalMerkleTreeComponent::InternalTrait;
    use super::{
        ContractAddress, IAggregatorProxyDispatcher, IAggregatorProxyDispatcherTrait,
        IVerifierDispatcher, IVerifierDispatcherTrait, get_block_timestamp, get_caller_address,
        get_contract_address, Swap,
    };
    component!(path: IncrementalMerkleTreeComponent, storage: imt, event: ImtEvent);

    const BTC_DENOMINATION: u256 = 1_000;
    const STRK_PRECISION: u256 = 1_000_000_000_000_000_000;
    const TREE_DEPTH: u32 = 10;

    const BTC_USD_FEED: felt252 = 0x0258b8f498b767c200577227e3e9f009c9b0fe7f6a3c8c2c24efd588c54747a;
    const STRK_USD_FEED: felt252 = 0x0a5db422ee7c28beead49303646e44ef9cbb8364eeba4d8af9ac06a3b556937;
    const MAX_PRICE_AGE: u64 = 86400;

    pub mod Errors {
        pub const COMMITMENT_USED: felt252 = 'commitment already used';
        pub const WBTC_TRANSFER_FAILED: felt252 = 'wBTC transfer failed';
        pub const STRK_TRANSFER_FAILED: felt252 = 'STRK transfer failed';
        pub const INVALID_PROOF: felt252 = 'invalid proof';
        pub const UNKNOWN_ROOT: felt252 = 'unknown root';
        pub const NULLIFIER_USED: felt252 = 'nullifier used';
        pub const TIMELOCK_IN_PAST: felt252 = 'timelock must be in future';
        pub const ALREADY_WITHDRAWN: felt252 = 'already withdrawn';
        pub const ALREADY_REFUNDED: felt252 = 'already refunded';
        pub const NOT_RECIPIENT: felt252 = 'not the recipient';
        pub const TIMELOCK_EXPIRED: felt252 = 'timelock expired';
        pub const INVALID_SECRET: felt252 = 'invalid secret';
        pub const TIMELOCK_NOT_EXPIRED: felt252 = 'timelock not expired yet';
        pub const INSUFFICIENT_ALLOWANCE: felt252 = 'insufficient allowance';
        pub const ZERO_AMOUNT: felt252 = 'amount must be non-zero';
        pub const TRANSFER_FAILED: felt252 = 'transfer failed';
        pub const ALREADY_FILLED: felt252 = 'swap already filled';
        pub const NOT_WBTC_SWAP: felt252 = 'not a wBTC swap';
        pub const BOB_TIMELOCK_TOO_LONG: felt252 = 'timelock must be shorter';
        pub const SWAP_EXPIRED: felt252 = 'swap already expired';
    }

    // -------------------------------------------------------
    // Storage
    // -------------------------------------------------------
    #[storage]
    struct Storage {
        #[substorage(v0)]
        imt: IncrementalMerkleTreeComponent::Storage,
        commitments: Map<u256, bool>,
        nullifier_hashes: Map<u256, bool>,
        swaps: Map<felt252, Swap>,
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
        SwapCreated: SwapCreated,
        SwapFilled: SwapFilled,
        SwapWithdrawn: SwapWithdrawn,
        SwapRefunded: SwapRefunded,
    }

    #[derive(Drop, starknet::Event)]
    struct Deposit {
        #[key]
        commitment: u256,
        leaf_index: u32,
        timestamp: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct SwapCreated {
        #[key]
        swap_id: felt252,
        token: ContractAddress,
        sender: ContractAddress,
        strk_recipient: ContractAddress, // non-zero for wBTC swaps
        amount: u256,
        hashlock: felt252,
        timelock: u64,
    }

    // Fired when Bob fills an open wBTC order
    #[derive(Drop, starknet::Event)]
    struct SwapFilled {
        #[key]
        wbtc_swap_id: felt252,  // Alice's swap
        #[key]
        strk_swap_id: felt252,  // Bob's swap (= hashlock)
        filler: ContractAddress,
        strk_amount: u256,
        timelock: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct SwapWithdrawn {
        #[key]
        swap_id: felt252,
        recipient: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    struct SwapRefunded {
        #[key]
        swap_id: felt252,
        sender: ContractAddress,
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
        // ---------------------------------------------------
        fn deposit(ref self: ContractState, commitment: u256) {
            assert(!self.commitments.read(commitment), Errors::COMMITMENT_USED);

            let wBTC = IERC20Dispatcher { contract_address: self.wBTC.read() };
            let success = wBTC
                .transfer_from(get_caller_address(), get_contract_address(), BTC_DENOMINATION);
            assert(success, Errors::WBTC_TRANSFER_FAILED);

            let leaf_index = self.imt._insert(commitment);
            self.commitments.write(commitment, true);
            self.emit(Deposit { commitment, leaf_index, timestamp: get_block_timestamp() });
        }

        // ---------------------------------------------------
        // CREATE SWAP — wBTC side (open order)
        // recipient is zero — anyone can fill via fill_swap()
        // strk_recipient = where Alice wants her STRK delivered
        // ---------------------------------------------------
        fn create_swap_wbtc(
            ref self: ContractState,
            proof: Span<felt252>,
            strk_recipient: ContractAddress,
            refund_address: ContractAddress, // where alice 
            hashlock: felt252,
            timelock: u64,
        ) {
            let verifier = IVerifierDispatcher { contract_address: self.verifier.read() };
            let verified_proof = verifier.verify_ultra_keccak_zk_honk_proof(proof);
            assert(verified_proof.is_ok(), Errors::INVALID_PROOF);

            let result = verified_proof.unwrap();
            let root = *result.at(0);
            let nullifier_hash = *result.at(1);

            assert(self.imt.is_known_root(root), Errors::UNKNOWN_ROOT);
            assert(!self.nullifier_hashes.read(nullifier_hash), Errors::NULLIFIER_USED);
            self.nullifier_hashes.write(nullifier_hash, true);

            assert(timelock > get_block_timestamp(), Errors::TIMELOCK_IN_PAST);

            let strk_amount = self.get_btc_strk_rate() * BTC_DENOMINATION / STRK_PRECISION;
            let caller = get_caller_address();
            let swap_id: felt252 = nullifier_hash.try_into().unwrap();

            self.swaps.write(swap_id, Swap {
                token: self.wBTC.read(),
                sender: caller,                          // refund address
                recipient: contract_address_const::<0>(), // zero = open order
                strk_recipient,                          // where Alice gets her STRK
                hashlock,
                amount: strk_amount,
                timelock,
                filled: false,
                withdrawn: false,
                refunded: false,
            });

            self.emit(SwapCreated {
                swap_id,
                token: self.wBTC.read(),
                sender: caller,
                strk_recipient,
                amount: strk_amount,
                hashlock,
                timelock,
            });
        }

        // ---------------------------------------------------
        // CREATE SWAP — STRK side (private, used internally by fill_swap
        // or directly if Alice and Bob already coordinated off-chain)
        // ---------------------------------------------------
        fn create_swap_strk(
            ref self: ContractState,
            recipient: ContractAddress,
            amount: u256,
            hashlock: felt252,
            timelock: u64,
        ) {
            assert(amount > 0, Errors::ZERO_AMOUNT);
            assert(timelock > get_block_timestamp(), Errors::TIMELOCK_IN_PAST);

            let caller = get_caller_address();
            let this = get_contract_address();

            let strk = IERC20Dispatcher { contract_address: self.strk.read() };
            let allowance = strk.allowance(caller, this);
            assert(allowance >= amount, Errors::INSUFFICIENT_ALLOWANCE);

            let success = strk.transfer_from(caller, this, amount);
            assert(success, Errors::STRK_TRANSFER_FAILED);

            let swap_id: felt252 = hashlock;

            self.swaps.write(swap_id, Swap {
                token: self.strk.read(),
                sender: caller,
                recipient,
                strk_recipient: contract_address_const::<0>(), // unused for STRK swaps
                hashlock,
                amount,
                timelock,
                filled: true, // STRK swaps are always immediately filled
                withdrawn: false,
                refunded: false,
            });

            self.emit(SwapCreated {
                swap_id,
                token: self.strk.read(),
                sender: caller,
                strk_recipient: contract_address_const::<0>(),
                amount,
                hashlock,
                timelock,
            });
        }

        // ---------------------------------------------------
        // FILL SWAP — Bob fills Alice's open wBTC order
        // 1. Sets Bob as recipient of Alice's wBTC swap
        // 2. Atomically locks Bob's STRK with the same hashlock
        // Bob's timelock MUST be shorter than Alice's
        // ---------------------------------------------------
        fn fill_swap(
            ref self: ContractState,
            wbtc_swap_id: felt252,
            timelock: u64,
        ) {
            let mut alice_swap = self.swaps.read(wbtc_swap_id);

            // Validate Alice's swap is open and still valid
            assert(!alice_swap.filled, Errors::ALREADY_FILLED);
            assert(!alice_swap.refunded, Errors::ALREADY_REFUNDED);
            assert(!alice_swap.withdrawn, Errors::ALREADY_WITHDRAWN);
            assert(alice_swap.token == self.wBTC.read(), Errors::NOT_WBTC_SWAP);
            assert(get_block_timestamp() < alice_swap.timelock, Errors::SWAP_EXPIRED);

            // Bob's timelock must be strictly shorter than Alice's
            assert(timelock < alice_swap.timelock, Errors::BOB_TIMELOCK_TOO_LONG);
            assert(timelock > get_block_timestamp(), Errors::TIMELOCK_IN_PAST);

            let bob = get_caller_address();
            let this = get_contract_address();
            let strk_amount = alice_swap.amount;

            // Pull Bob's STRK into the contract
            let strk = IERC20Dispatcher { contract_address: self.strk.read() };
            let allowance = strk.allowance(bob, this);
            assert(allowance >= strk_amount, Errors::INSUFFICIENT_ALLOWANCE);
            let success = strk.transfer_from(bob, this, strk_amount);
            assert(success, Errors::STRK_TRANSFER_FAILED);

            // 1. Update Alice's swap — Bob is now the recipient of wBTC
            alice_swap.recipient = bob;
            alice_swap.filled = true;
            self.swaps.write(wbtc_swap_id, alice_swap);

            // 2. Create Bob's STRK swap — Alice's strk_recipient receives STRK
            let strk_swap_id: felt252 = alice_swap.hashlock;
            self.swaps.write(strk_swap_id, Swap {
                token: self.strk.read(),
                sender: bob,                             // Bob gets STRK back on refund
                recipient: alice_swap.strk_recipient,    // Alice receives STRK
                strk_recipient: contract_address_const::<0>(),
                hashlock: alice_swap.hashlock,
                amount: strk_amount,
                timelock,
                filled: true,
                withdrawn: false,
                refunded: false,
            });

            self.emit(SwapFilled {
                wbtc_swap_id,
                strk_swap_id,
                filler: bob,
                strk_amount,
                timelock,
            });
        }

        // ---------------------------------------------------
        // WITHDRAW — recipient reveals secret, gets tokens
        // Works for both sides
        // ---------------------------------------------------
        fn withdraw(ref self: ContractState, swap_id: felt252, secret: felt252) {
            let mut swap = self.swaps.read(swap_id);
            let caller = get_caller_address();

            assert(!swap.withdrawn, Errors::ALREADY_WITHDRAWN);
            assert(!swap.refunded, Errors::ALREADY_REFUNDED);
            assert(swap.recipient == caller, Errors::NOT_RECIPIENT);
            assert(get_block_timestamp() < swap.timelock, Errors::TIMELOCK_EXPIRED);

            let hash = pedersen(0, secret);
            assert(hash == swap.hashlock, Errors::INVALID_SECRET);

            swap.withdrawn = true;
            self.swaps.write(swap_id, swap);

            let token = IERC20Dispatcher { contract_address: swap.token };
            let success = token.transfer(caller, swap.amount);
            assert(success, Errors::TRANSFER_FAILED);

            self.emit(SwapWithdrawn { swap_id, recipient: caller });
        }

        // ---------------------------------------------------
        // REFUND — sender gets tokens back after timelock expires
        // Works for both sides
        // ---------------------------------------------------
        fn refund(ref self: ContractState, swap_id: felt252) {
            let mut swap = self.swaps.read(swap_id);

            assert(!swap.withdrawn, Errors::ALREADY_WITHDRAWN);
            assert(!swap.refunded, Errors::ALREADY_REFUNDED);
            assert(get_block_timestamp() >= swap.timelock, Errors::TIMELOCK_NOT_EXPIRED);

            swap.refunded = true;
            self.swaps.write(swap_id, swap);

            let token = IERC20Dispatcher { contract_address: swap.token };
            let success = token.transfer(swap.sender, swap.amount);
            assert(success, Errors::TRANSFER_FAILED);

            self.emit(SwapRefunded { swap_id, sender: swap.sender });
        }

        // ---------------------------------------------------
        // Views
        // ---------------------------------------------------
        fn get_swap(self: @ContractState, swap_id: felt252) -> Swap {
            self.swaps.read(swap_id)
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
        fn get_chainlink_price(self: @ContractState, feed_address: felt252) -> (u128, u32) {
            let feed = IAggregatorProxyDispatcher {
                contract_address: feed_address.try_into().unwrap(),
            };
            let round = feed.latest_round_data();
            let block_time = get_block_timestamp();
            assert(block_time - round.updated_at < MAX_PRICE_AGE, 'stale price');
            assert(round.answer > 0, 'invalid price');
            let decimals: u32 = feed.decimals().into();
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