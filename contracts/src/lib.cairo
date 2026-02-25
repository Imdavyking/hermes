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

// -------------------------------------------------------
// Structs
//
// The swap has two sides. Each side gets its own struct
// with only the fields it actually needs.
//
// Alice's side: she is giving wBTC, and wants STRK back.
// Bob's side:   he is giving STRK, and wants wBTC back.
//
// Both sides share the same hashlock and secret.
// Whoever reveals the secret first unlocks both sides.
// -------------------------------------------------------

// Alice deposits wBTC and posts this order.
// Bob fills it by locking his STRK and becoming `wbtc_buyer`.
#[derive(Drop, Serde, Copy, starknet::Store)]
struct WbtcOrder {
    // Who locked the wBTC (Alice). Gets wBTC back if order expires unfilled.
    wbtc_seller: ContractAddress,
    // Who will receive the wBTC once they reveal the secret.
    // Starts as zero (open order). Set to Bob's address when he fills.
    wbtc_buyer: ContractAddress,
    // Where Alice wants her STRK sent when Bob fills this order.
    // Copied into the paired StrkOrder as `strk_buyer` when Bob calls fill_order().
    alice_strk_destination: ContractAddress,
    // The hash of the secret. Whoever knows the secret can withdraw.
    hashlock: felt252,
    // How much wBTC the buyer receives (always BTC_DENOMINATION).
    wbtc_amount: u256,
    // How much STRK Alice expects in return (quoted at order creation time).
    // Used as a reference for slippage checks when Bob fills.
    quoted_strk_amount: u256,
    // How much price movement Alice is willing to accept between
    // when she posts the order and when Bob fills it.
    // Expressed in basis points: 100 = 1%, 200 = 2%, 500 = 5%.
    // If the live price at fill time is more than this far below
    // the quoted price, the fill is rejected.
    // Must be between MIN_SLIPPAGE_BPS and MAX_SLIPPAGE_BPS.
    slippage_tolerance_bps: u256,
    // Order expires and Alice can refund after this timestamp.
    expiry: u64,
    // Quoted rate expires after this timestamp — order cannot be filled
    // with a stale price. Prevents someone filling a days-old order
    // after a large price move.
    rate_expiry: u64,
    // True once Bob has locked his STRK and been set as wbtc_buyer.
    is_filled: bool,
    // True once Bob revealed the secret and took the wBTC.
    is_withdrawn: bool,
    // True once Alice reclaimed her wBTC after expiry.
    is_refunded: bool,
    swap_initiated: bool,
}

// Created by Bob when he fills a WbtcOrder.
// Also created directly if Alice and Bob coordinate off-chain.
#[derive(Drop, Serde, Copy, starknet::Store)]
struct StrkOrder {
    // Who locked the STRK (Bob). Gets STRK back if order expires.
    strk_seller: ContractAddress,
    // Who receives the STRK once they reveal the secret (Alice).
    strk_buyer: ContractAddress,
    // The hash of the secret. Same secret unlocks both sides of the swap.
    hashlock: felt252,
    // How much STRK the buyer receives.
    strk_amount: u256,
    // Order expires and Bob can refund after this timestamp.
    // Always shorter than the paired WbtcOrder's expiry, so Bob can
    // always reclaim his STRK before Alice can reclaim her wBTC.
    expiry: u64,
    // True once Alice revealed the secret and took the STRK.
    is_withdrawn: bool,
    // True once Bob reclaimed his STRK after expiry.
    is_refunded: bool,
    wbtc_order_id: u256,
}

#[starknet::interface]
trait IPrivateSwap<TContractState> {
    // Alice deposits wBTC into the anonymous pool.
    fn deposit(ref self: TContractState, commitment: u256);
    fn zk_withdraw_wbtc(ref self: TContractState, proof: Span<felt252>, recipient: ContractAddress);

    // Alice posts an open order: "I have wBTC, I want STRK."
    // Uses a ZK proof to prove she has a deposit without revealing which one.
    fn post_wbtc_order(
        ref self: TContractState,
        proof: Span<felt252>,
        alice_strk_destination: ContractAddress,
        hashlock: felt252,
        expiry: u64,
        slippage_tolerance_bps: u256,
    );

    // Bob fills Alice's order: he locks his STRK and gets registered as the wBTC buyer.
    // Both sides are now live — whoever reveals the secret takes both tokens.
    fn fill_wbtc_order(ref self: TContractState, wbtc_order_id: u256, bob_expiry: u64);
    // Reveal the secret to claim tokens from either side.
    fn withdraw_wbtc(ref self: TContractState, wbtc_order_id: u256, secret: felt252);
    fn withdraw_strk(ref self: TContractState, strk_order_id: u256, secret: felt252);

    // Reclaim tokens after expiry.
    fn refund_wbtc(ref self: TContractState, wbtc_order_id: u256);
    fn refund_strk(ref self: TContractState, strk_order_id: u256);

    // Views
    fn get_wbtc_order(self: @TContractState, order_id: u256) -> WbtcOrder;
    fn get_strk_order(self: @TContractState, order_id: u256) -> StrkOrder;
    fn current_root(self: @TContractState) -> u256;
    fn next_leaf_index(self: @TContractState) -> u32;
    fn is_known_root(self: @TContractState, root: u256) -> bool;
    fn wBTC_address(self: @TContractState) -> ContractAddress;
    fn strk_address(self: @TContractState) -> ContractAddress;
    fn wBTC_denomination(self: @TContractState) -> u256;
    fn get_btc_usd_price(self: @TContractState) -> (u128, u32);
    fn get_strk_usd_price(self: @TContractState) -> (u128, u32);
    fn get_btc_strk_rate(self: @TContractState) -> u256;

    // Mock
    fn set_mock_wbtc(ref self: TContractState, wbtc: ContractAddress);
    fn reset_wbtc_real(ref self: TContractState);
}

// -------------------------------------------------------
// Contract
// -------------------------------------------------------

#[starknet::contract]
mod PrivateSwap {
    use core::pedersen::pedersen;
    use openzeppelin::token::erc20::interface::{
        IERC20Dispatcher, IERC20DispatcherTrait, IERC20MetadataDispatcher,
        IERC20MetadataDispatcherTrait,
    };
    use starknet::SyscallResultTrait;
    use starknet::class_hash::ClassHash;
    use starknet::contract_address::contract_address_const;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::syscalls::deploy_syscall;
    use crate::incremental_merkle_tree::IncrementalMerkleTreeComponent;
    use crate::incremental_merkle_tree::IncrementalMerkleTreeComponent::InternalTrait;
    use super::{
        ContractAddress, IAggregatorProxyDispatcher, IAggregatorProxyDispatcherTrait,
        IVerifierDispatcher, IVerifierDispatcherTrait, StrkOrder, WbtcOrder, get_block_timestamp,
        get_caller_address, get_contract_address,
    };
    component!(path: IncrementalMerkleTreeComponent, storage: imt, event: ImtEvent);

    // wBTC lot size. Every deposit and order is exactly this many wBTC units.
    const BTC_DENOMINATION: u256 = 1_000;

    // 1 wBTC expressed in its base units (8 decimals).
    const WBTC_PRECISION: u256 = 100_000_000; // 10^8 — 1 full BTC in sats


    // 1 STRK expressed in its base units (18 decimals).
    const STRK_PRECISION: u256 = 1_000_000_000_000_000_000;

    const TREE_DEPTH: u32 = 10;

    const BTC_USD_FEED: felt252 = 0x0258b8f498b767c200577227e3e9f009c9b0fe7f6a3c8c2c24efd588c54747a;
    const STRK_USD_FEED: felt252 =
        0x0a5db422ee7c28beead49303646e44ef9cbb8364eeba4d8af9ac06a3b556937;

    // Oracle price must be no older than 6 hours (we are on testnet), on mainnet this could be much
    // shorter like 15 mins.
    const MAX_ORACLE_AGE_SECS: u64 = 21600;

    // Both expiry timestamps must be at least 1 hour from now.
    // This gives each party enough time to act before their window closes.
    const MIN_EXPIRY_DURATION_SECS: u64 = 3600;

    // A quoted rate in a WbtcOrder is only valid for 1 hour after posting.
    // After that, the order cannot be filled (use a fresh order instead).
    const RATE_VALID_FOR_SECS: u64 = 3600;

    // If the live oracle price at fill time differs from the quoted price
    // by more than Alice's chosen tolerance, the fill is rejected.
    // Alice sets her own tolerance per order, but it must be within this range.
    const MIN_SLIPPAGE_BPS: u256 = 10; // 0.1% — tightest Alice can set
    const MAX_SLIPPAGE_BPS: u256 = 1000; // 10%  — loosest Alice can set
    const BPS_DENOMINATOR: u256 = 10000;

    // Minimum STRK amount per order — guards against degenerate oracle responses.
    const MIN_STRK_AMOUNT: u256 = 1_000_000_000_000_000_000; // 1 STRK

    pub mod Errors {
        pub const COMMITMENT_USED: felt252 = 'commitment already used';
        pub const WBTC_TRANSFER_FAILED: felt252 = 'wBTC transfer failed';
        pub const STRK_TRANSFER_FAILED: felt252 = 'STRK transfer failed';
        pub const INVALID_PROOF: felt252 = 'invalid proof';
        pub const UNKNOWN_ROOT: felt252 = 'unknown root';
        pub const NULLIFIER_USED: felt252 = 'nullifier already used';
        pub const EXPIRY_TOO_SOON: felt252 = 'expiry is too soon';
        pub const ALREADY_WITHDRAWN: felt252 = 'already withdrawn';
        pub const ALREADY_REFUNDED: felt252 = 'already refunded';
        pub const SWAP_STARTED: felt252 = 'swap started';
        pub const NOT_THE_BUYER: felt252 = 'caller is not the buyer';
        pub const ORDER_EXPIRED: felt252 = 'order has expired';
        pub const INVALID_SECRET: felt252 = 'secret does not match lock';
        pub const NOT_EXPIRED_YET: felt252 = 'order has not expired yet';
        pub const INSUFFICIENT_ALLOWANCE: felt252 = 'insufficient token allowance';
        pub const ZERO_AMOUNT: felt252 = 'amount must be non-zero';
        pub const TRANSFER_FAILED: felt252 = 'token transfer failed';
        pub const ORDER_ALREADY_FILLED: felt252 = 'order already filled';
        pub const NOT_A_WBTC_ORDER: felt252 = 'order_id is not a wBTC order';
        pub const BOB_EXPIRY_TOO_LONG: felt252 = 'bob expiry exceeds alice expiry';
        pub const QUOTED_RATE_EXPIRED: felt252 = 'quoted rate has expired';
        pub const SLIPPAGE_TOO_HIGH: felt252 = 'price moved since quote';
        pub const SLIPPAGE_OUT_OF_RANGE: felt252 = 'slippage tolerance out of range';
        pub const STRK_AMOUNT_TOO_LOW: felt252 = 'strk amount below minimum';
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
        wbtc_orders: Map<u256, WbtcOrder>,
        strk_orders: Map<u256, StrkOrder>,
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
        WbtcOrderPosted: WbtcOrderPosted,
        WbtcOrderFilled: WbtcOrderFilled,
        WbtcWithdrawn: WbtcWithdrawn,
        StrkWithdrawn: StrkWithdrawn,
        WbtcRefunded: WbtcRefunded,
        StrkRefunded: StrkRefunded,
        // FIX #4: Added missing event for direct STRK orders
        StrkOrderPosted: StrkOrderPosted,
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

    #[derive(Drop, starknet::Event)]
    struct WbtcOrderPosted {
        #[key]
        order_id: u256,
        wbtc_seller: ContractAddress,
        alice_strk_destination: ContractAddress,
        wbtc_amount: u256,
        quoted_strk_amount: u256,
        hashlock: felt252,
        expiry: u64,
        rate_expiry: u64,
    }

    // Fired when Bob fills Alice's open wBTC order.
    #[derive(Drop, starknet::Event)]
    struct WbtcOrderFilled {
        #[key]
        wbtc_order_id: u256,
        #[key]
        strk_order_id: u256,
        bob: ContractAddress,
        strk_amount_locked: u256,
        bob_expiry: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct WbtcWithdrawn {
        #[key]
        order_id: u256,
        wbtc_buyer: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    struct StrkWithdrawn {
        #[key]
        order_id: u256,
        strk_buyer: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    struct WbtcRefunded {
        #[key]
        order_id: u256,
        wbtc_seller: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    struct StrkRefunded {
        #[key]
        order_id: u256,
        strk_seller: ContractAddress,
    }

    // FIX #4: New event for post_strk_order so off-chain indexers can discover direct orders.
    #[derive(Drop, starknet::Event)]
    struct StrkOrderPosted {
        #[key]
        order_id: felt252,
        strk_seller: ContractAddress,
        strk_buyer: ContractAddress,
        strk_amount: u256,
        hashlock: felt252,
        expiry: u64,
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
        // Alice locks BTC_DENOMINATION wBTC into the anonymous pool.
        // She gets a leaf in the Merkle tree she can later prove membership of.
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

        fn zk_withdraw_wbtc(
            ref self: ContractState, proof: Span<felt252>, recipient: ContractAddress,
        ) {
            let verifier = IVerifierDispatcher { contract_address: self.verifier.read() };
            let verified = verifier.verify_ultra_keccak_zk_honk_proof(proof);
            assert(verified.is_ok(), Errors::INVALID_PROOF);

            let result = verified.unwrap();
            let root = *result.at(0);
            let nullifier_hash = *result.at(1);

            assert(self.imt.is_known_root(root), Errors::UNKNOWN_ROOT);
            assert(!self.nullifier_hashes.read(nullifier_hash), Errors::NULLIFIER_USED);
            self.nullifier_hashes.write(nullifier_hash, true);

            // withdraw btc to recipient
            let wBTC = IERC20Dispatcher { contract_address: self.wBTC.read() };
            let success = wBTC.transfer(recipient, BTC_DENOMINATION);
            assert(success, 'transfer failed');
            self.emit(Withdrawal { recipient, nullifier_hash });
        }

        // ---------------------------------------------------
        // POST WBTC ORDER
        // Alice says: "I have wBTC and want STRK. Anyone can fill this."
        //
        // - She proves anonymously (via ZK proof) that she owns a deposit.
        // - The contract looks up the current BTC/STRK rate from the oracle
        //   and records it as `quoted_strk_amount`.
        // - `alice_strk_destination` is where her STRK will be sent when
        //   Bob fills the order.
        // - The order stays open (wbtc_buyer = zero) until Bob fills it.
        // ---------------------------------------------------
        fn post_wbtc_order(
            ref self: ContractState,
            proof: Span<felt252>,
            alice_strk_destination: ContractAddress,
            hashlock: felt252,
            expiry: u64,
            slippage_tolerance_bps: u256,
        ) {
            // Verify the ZK proof and extract the Merkle root + nullifier
            let verifier = IVerifierDispatcher { contract_address: self.verifier.read() };
            let verified = verifier.verify_ultra_keccak_zk_honk_proof(proof);
            assert(verified.is_ok(), Errors::INVALID_PROOF);

            let result = verified.unwrap();
            let root = *result.at(0);
            let nullifier_hash = *result.at(1);

            assert(self.imt.is_known_root(root), Errors::UNKNOWN_ROOT);
            assert(!self.nullifier_hashes.read(nullifier_hash), Errors::NULLIFIER_USED);
            self.nullifier_hashes.write(nullifier_hash, true);

            let now = get_block_timestamp();
            assert(expiry >= now + MIN_EXPIRY_DURATION_SECS, Errors::EXPIRY_TOO_SOON);

            // Alice sets her own slippage tolerance — must be within the allowed range.
            // Too tight (< 0.1%) would cause almost every fill to fail due to oracle noise.
            // Too loose (> 10%) would expose Alice to significant price manipulation.
            assert(
                slippage_tolerance_bps >= MIN_SLIPPAGE_BPS
                    && slippage_tolerance_bps <= MAX_SLIPPAGE_BPS,
                Errors::SLIPPAGE_OUT_OF_RANGE,
            );

            // get wbtc decimals

            let quoted_strk_amount = self.get_btc_strk_rate() * BTC_DENOMINATION / WBTC_PRECISION;
            assert(quoted_strk_amount >= MIN_STRK_AMOUNT, Errors::STRK_AMOUNT_TOO_LOW);

            let alice = get_caller_address();
            let order_id: u256 =
                nullifier_hash; // Use the nullifier hash as the order ID since it's guaranteed unique and already in storage

            self
                .wbtc_orders
                .write(
                    order_id,
                    WbtcOrder {
                        wbtc_seller: alice,
                        wbtc_buyer: contract_address_const::<0>(), // zero = open, not yet filled
                        alice_strk_destination,
                        hashlock,
                        wbtc_amount: BTC_DENOMINATION,
                        quoted_strk_amount,
                        slippage_tolerance_bps,
                        expiry,
                        rate_expiry: now + RATE_VALID_FOR_SECS,
                        is_filled: false,
                        is_withdrawn: false,
                        is_refunded: false,
                        swap_initiated: false,
                    },
                );

            self
                .emit(
                    WbtcOrderPosted {
                        order_id,
                        wbtc_seller: alice,
                        alice_strk_destination,
                        wbtc_amount: BTC_DENOMINATION,
                        quoted_strk_amount,
                        hashlock,
                        expiry,
                        rate_expiry: now + RATE_VALID_FOR_SECS,
                    },
                );
        }

        // ---------------------------------------------------
        // FILL WBTC ORDER
        // Bob says: "I'll take Alice's wBTC. Here is my STRK."
        //
        // Two things happen atomically in this call:
        //   1. Bob is registered as the wbtc_buyer on Alice's WbtcOrder.
        //   2. A new StrkOrder is created with Bob's STRK locked inside,
        //      payable to alice_strk_destination using the same hashlock.
        //
        // After this call:
        //   - Alice reveals the secret → takes Bob's STRK, secret goes public
        //   - Bob uses the public secret → takes Alice's wBTC
        //
        // Bob's expiry must be shorter than Alice's so Bob can always
        // reclaim his STRK if Alice disappears without revealing the secret.
        // ---------------------------------------------------
        fn fill_wbtc_order(ref self: ContractState, wbtc_order_id: u256, bob_expiry: u64) {
            let mut order = self.wbtc_orders.read(wbtc_order_id);
            let now = get_block_timestamp();

            assert(!order.is_filled, Errors::ORDER_ALREADY_FILLED);
            assert(!order.is_refunded, Errors::ALREADY_REFUNDED);
            assert(!order.is_withdrawn, Errors::ALREADY_WITHDRAWN);
            assert(order.wbtc_amount > 0, Errors::NOT_A_WBTC_ORDER);
            assert(now < order.expiry, Errors::ORDER_EXPIRED);

            // The quoted rate must still be fresh
            assert(now <= order.rate_expiry, Errors::QUOTED_RATE_EXPIRED);

            // Bob's window must be shorter so he can refund before Alice
            assert(bob_expiry < order.expiry, Errors::BOB_EXPIRY_TOO_LONG);
            assert(bob_expiry >= now + MIN_EXPIRY_DURATION_SECS, Errors::EXPIRY_TOO_SOON);

            // Check live price hasn't moved more than Alice's chosen tolerance since she quoted.
            // Uses Alice's own slippage_tolerance_bps stored in the order, not a global constant.
            let live_strk_amount = self.get_btc_strk_rate() * BTC_DENOMINATION / WBTC_PRECISION;
            assert(live_strk_amount >= MIN_STRK_AMOUNT, Errors::STRK_AMOUNT_TOO_LOW);

            let min_acceptable = order.quoted_strk_amount
                * (BPS_DENOMINATOR - order.slippage_tolerance_bps)
                / BPS_DENOMINATOR;
            assert(live_strk_amount >= min_acceptable, Errors::SLIPPAGE_TOO_HIGH);

            let bob = get_caller_address();
            let this = get_contract_address();

            // Pull Bob's STRK into the contract
            let strk = IERC20Dispatcher { contract_address: self.strk.read() };
            assert(strk.allowance(bob, this) >= live_strk_amount, Errors::INSUFFICIENT_ALLOWANCE);
            let success = strk.transfer_from(bob, this, live_strk_amount);
            assert(success, Errors::STRK_TRANSFER_FAILED);

            // 1. Lock Bob in as the wBTC buyer on Alice's order
            order.wbtc_buyer = bob;
            order.is_filled = true;
            self.wbtc_orders.write(wbtc_order_id, order);

            // 2. Create the paired STRK order.
            //    FIX #3: Use pedersen(hashlock, 'fill') as the strk_order_id instead of the raw
            //    hashlock. This prevents a collision with a direct post_strk_order that uses
            //    pedersen(hashlock, 'direct'), which would otherwise allow an attacker to overwrite
            //    Bob's locked STRK by calling post_strk_order with the same hashlock.
            //    strk_buyer = alice_strk_destination (where Alice wants her STRK)
            //    strk_seller = Bob (gets STRK back if Alice never reveals the secret)
            let strk_order_id: u256 = pedersen(order.hashlock, 'fill').into();
            self
                .strk_orders
                .write(
                    strk_order_id,
                    StrkOrder {
                        strk_seller: bob,
                        strk_buyer: order.alice_strk_destination,
                        hashlock: order.hashlock,
                        strk_amount: live_strk_amount,
                        expiry: bob_expiry,
                        is_withdrawn: false,
                        is_refunded: false,
                        wbtc_order_id,
                    },
                );

            self
                .emit(
                    WbtcOrderFilled {
                        wbtc_order_id,
                        strk_order_id,
                        bob,
                        strk_amount_locked: live_strk_amount,
                        bob_expiry,
                    },
                );
        }

        // ---------------------------------------------------
        // WITHDRAW wBTC
        // Bob reveals the secret to claim his wBTC.
        // The secret was made public when Alice withdrew her STRK.
        // ---------------------------------------------------
        fn withdraw_wbtc(ref self: ContractState, wbtc_order_id: u256, secret: felt252) {
            let mut order = self.wbtc_orders.read(wbtc_order_id);
            let caller = get_caller_address();

            assert(!order.is_withdrawn, Errors::ALREADY_WITHDRAWN);
            assert(!order.is_refunded, Errors::ALREADY_REFUNDED);
            assert(order.wbtc_buyer == caller, Errors::NOT_THE_BUYER);
            assert(
                get_block_timestamp() < order.expiry || order.swap_initiated, Errors::ORDER_EXPIRED,
            );

            let hash = pedersen(0, secret);
            assert(hash == order.hashlock, Errors::INVALID_SECRET);

            order.is_withdrawn = true;
            self.wbtc_orders.write(wbtc_order_id, order);

            let wbtc = IERC20Dispatcher { contract_address: self.wBTC.read() };
            let success = wbtc.transfer(caller, order.wbtc_amount);
            assert(success, Errors::TRANSFER_FAILED);

            self.emit(WbtcWithdrawn { order_id: wbtc_order_id, wbtc_buyer: caller });
        }

        // ---------------------------------------------------
        // WITHDRAW STRK
        // Alice reveals the secret to claim her STRK.
        // This makes the secret public so Bob can then claim his wBTC.
        // ---------------------------------------------------
        fn withdraw_strk(ref self: ContractState, strk_order_id: u256, secret: felt252) {
            let mut order = self.strk_orders.read(strk_order_id);
            let caller = get_caller_address();

            assert(!order.is_withdrawn, Errors::ALREADY_WITHDRAWN);
            assert(!order.is_refunded, Errors::ALREADY_REFUNDED);
            assert(order.strk_buyer == caller, Errors::NOT_THE_BUYER);
            assert(get_block_timestamp() < order.expiry, Errors::ORDER_EXPIRED);

            let mut wbtc_order = self.wbtc_orders.read(order.wbtc_order_id);
            wbtc_order.swap_initiated = true;
            self.wbtc_orders.write(order.wbtc_order_id, wbtc_order);

            let hash = pedersen(0, secret);
            assert(hash == order.hashlock, Errors::INVALID_SECRET);

            order.is_withdrawn = true;
            self.strk_orders.write(strk_order_id, order);

            let strk = IERC20Dispatcher { contract_address: self.strk.read() };
            let success = strk.transfer(caller, order.strk_amount);
            assert(success, Errors::TRANSFER_FAILED);

            self.emit(StrkWithdrawn { order_id: strk_order_id, strk_buyer: caller });
        }

        // ---------------------------------------------------
        // REFUND wBTC
        // Alice reclaims her wBTC if no one filled the order before expiry,
        // or if Bob filled but never revealed the secret.
        // ---------------------------------------------------
        fn refund_wbtc(ref self: ContractState, wbtc_order_id: u256) {
            let mut order = self.wbtc_orders.read(wbtc_order_id);

            assert(!order.is_withdrawn, Errors::ALREADY_WITHDRAWN);
            assert(!order.is_refunded, Errors::ALREADY_REFUNDED);
            assert(!order.swap_initiated, Errors::SWAP_STARTED);
            assert(get_block_timestamp() >= order.expiry, Errors::NOT_EXPIRED_YET);

            order.is_refunded = true;
            self.wbtc_orders.write(wbtc_order_id, order);

            let wbtc = IERC20Dispatcher { contract_address: self.wBTC.read() };
            let success = wbtc.transfer(order.wbtc_seller, order.wbtc_amount);
            assert(success, Errors::TRANSFER_FAILED);

            self.emit(WbtcRefunded { order_id: wbtc_order_id, wbtc_seller: order.wbtc_seller });
        }

        // ---------------------------------------------------
        // REFUND STRK
        // Bob reclaims his STRK if Alice never revealed the secret.
        // Bob's expiry is always shorter than Alice's, so he can always
        // do this before Alice could reclaim her wBTC.
        // ---------------------------------------------------
        fn refund_strk(ref self: ContractState, strk_order_id: u256) {
            let mut order = self.strk_orders.read(strk_order_id);

            assert(!order.is_withdrawn, Errors::ALREADY_WITHDRAWN);
            assert(!order.is_refunded, Errors::ALREADY_REFUNDED);
            assert(get_block_timestamp() >= order.expiry, Errors::NOT_EXPIRED_YET);

            order.is_refunded = true;
            self.strk_orders.write(strk_order_id, order);

            let strk = IERC20Dispatcher { contract_address: self.strk.read() };
            let success = strk.transfer(order.strk_seller, order.strk_amount);
            assert(success, Errors::TRANSFER_FAILED);

            self.emit(StrkRefunded { order_id: strk_order_id, strk_seller: order.strk_seller });
        }

        // ---------------------------------------------------
        // Mock (for testing)
        // ---------------------------------------------------
        fn set_mock_wbtc(ref self: ContractState, wbtc: ContractAddress) {
            // check that decimals is 8 to avoid messing up the price calculations in tests
            let wBTC = IERC20MetadataDispatcher { contract_address: wbtc };
            assert(wBTC.decimals() == 8, 'mock wBTC must have 8 decimals');
            self.wBTC.write(wbtc);
        }

        fn reset_wbtc_real(ref self: ContractState) {
            self
                .wBTC
                .write(
                    0x00452bd5c0512a61df7c7be8cfea5e4f893cb40e126bdc40aee6054db955129e
                        .try_into()
                        .unwrap(),
                );
        }

        // ---------------------------------------------------
        // Views
        // ---------------------------------------------------
        fn get_wbtc_order(self: @ContractState, order_id: u256) -> WbtcOrder {
            self.wbtc_orders.read(order_id)
        }

        fn get_strk_order(self: @ContractState, order_id: u256) -> StrkOrder {
            self.strk_orders.read(order_id)
        }

        fn get_btc_usd_price(self: @ContractState) -> (u128, u32) {
            self.get_oracle_price(BTC_USD_FEED)
        }

        fn get_strk_usd_price(self: @ContractState) -> (u128, u32) {
            self.get_oracle_price(STRK_USD_FEED)
        }

        fn get_btc_strk_rate(self: @ContractState) -> u256 {
            let (btc_usd, btc_dec) = self.get_oracle_price(BTC_USD_FEED);
            let (strk_usd, strk_dec) = self.get_oracle_price(STRK_USD_FEED);
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
        fn get_oracle_price(self: @ContractState, feed_address: felt252) -> (u128, u32) {
            let feed = IAggregatorProxyDispatcher {
                contract_address: feed_address.try_into().unwrap(),
            };
            let round = feed.latest_round_data();
            let now = get_block_timestamp();
            // FIX #2: Avoid u64 underflow if oracle returns a future timestamp.
            // Original: now - round.updated_at < MAX_ORACLE_AGE_SECS (panics if updated_at > now)
            // Fixed:    addition on the known-safe side instead.
            assert(round.updated_at + MAX_ORACLE_AGE_SECS > now, 'stale oracle price');
            assert(round.answer > 0, 'invalid oracle price');
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
