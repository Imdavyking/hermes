use starknet::{ContractAddress, get_block_timestamp, get_caller_address, get_contract_address};
mod field;
mod incremental_merkle_tree;
use crate::poseidon2lib::Poseidon2Trait;
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

// ERC-4626 vToken interface (Vesu)
// deposit()  → mints shares, returns shares received
// redeem()   → burns shares, returns assets (wBTC + accrued yield)
// convert_to_assets() → converts shares to current wBTC value (read-only)
#[starknet::interface]
trait IVToken<TContractState> {
    fn deposit(ref self: TContractState, assets: u256, receiver: ContractAddress) -> u256;
    fn redeem(
        ref self: TContractState, shares: u256, receiver: ContractAddress, owner: ContractAddress,
    ) -> u256;
    fn convert_to_assets(self: @TContractState, shares: u256) -> u256;
}

// -------------------------------------------------------
// Structs
// -------------------------------------------------------

#[derive(Drop, Serde, Copy, starknet::Store)]
struct WbtcOrder {
    wbtc_seller: ContractAddress,
    wbtc_buyer: ContractAddress,
    alice_strk_destination: ContractAddress,
    hashlock: felt252,
    wbtc_amount: u256,
    quoted_strk_amount: u256,
    slippage_tolerance_bps: u256,
    expiry: u64,
    rate_expiry: u64,
    is_filled: bool,
    is_withdrawn: bool,
    is_refunded: bool,
    swap_initiated: bool,
    secret: felt252,
}

#[derive(Drop, Serde, Copy, starknet::Store)]
struct StrkOrder {
    strk_seller: ContractAddress,
    strk_buyer: ContractAddress,
    hashlock: felt252,
    strk_amount: u256,
    expiry: u64,
    is_withdrawn: bool,
    is_refunded: bool,
    wbtc_order_id: u256,
}

// -------------------------------------------------------
// Interface
// -------------------------------------------------------

#[starknet::interface]
trait IPrivateSwap<TContractState> {
    // Core pool
    fn deposit(ref self: TContractState, commitment: u256);
    fn zk_withdraw_wbtc(ref self: TContractState, proof: Span<felt252>, recipient: ContractAddress);

    // Yield
    // start_earning() locks the recipient address on-chain and marks the nullifier
    // as spent. The note cannot be used in zk_withdraw_wbtc or post_wbtc_order after this.
    // stop_earning() can only be called by the committed recipient — no ZK proof needed.
    fn start_earning(ref self: TContractState, proof: Span<felt252>, recipient: ContractAddress);
    fn stop_earning(ref self: TContractState, nullifier_hash: u256);
    fn get_yield_balance(self: @TContractState, nullifier_hash: u256) -> u256;
    fn is_earning(self: @TContractState, nullifier_hash: u256) -> bool;

    // HTLC swap
    fn post_wbtc_order(
        ref self: TContractState,
        proof: Span<felt252>,
        alice_strk_destination: ContractAddress,
        hashlock: felt252,
        expiry: u64,
        slippage_tolerance_bps: u256,
    );
    fn fill_wbtc_order(ref self: TContractState, wbtc_order_id: u256, bob_expiry: u64);
    fn withdraw_wbtc(ref self: TContractState, wbtc_order_id: u256);
    fn withdraw_strk(ref self: TContractState, strk_order_id: u256, secret: felt252);
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
    fn vesu_vtoken_address(self: @TContractState) -> ContractAddress;
    fn wBTC_denomination(self: @TContractState) -> u256;
    fn get_btc_usd_price(self: @TContractState) -> (u128, u32);
    fn get_strk_usd_price(self: @TContractState) -> (u128, u32);
    fn get_btc_strk_rate(self: @TContractState) -> u256;
    fn owner(self: @TContractState) -> ContractAddress;
    fn get_quoted_strk_amount(self: @TContractState) -> u256;
    fn get_yield_recipient(self: @TContractState, nullifier_hash: u256) -> ContractAddress;

    // Admin
    fn set_mock_wbtc(ref self: TContractState, wbtc: ContractAddress);
    fn set_vesu_vtoken(ref self: TContractState, vtoken: ContractAddress);
    fn transfer_ownership(ref self: TContractState, new_owner: ContractAddress);
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
    use starknet::class_hash::ClassHash;
    use starknet::contract_address::contract_address_const;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::syscalls::deploy_syscall;
    use starknet::{SyscallResultTrait, get_tx_info};
    use crate::incremental_merkle_tree::IncrementalMerkleTreeComponent;
    use crate::incremental_merkle_tree::IncrementalMerkleTreeComponent::InternalTrait;
    use super::{
        ContractAddress, FieldTrait, IAggregatorProxyDispatcher, IAggregatorProxyDispatcherTrait,
        IVTokenDispatcher, IVTokenDispatcherTrait, IVerifierDispatcher, IVerifierDispatcherTrait,
        Poseidon2Trait, StrkOrder, WbtcOrder, get_block_timestamp, get_caller_address,
        get_contract_address,
    };
    component!(path: IncrementalMerkleTreeComponent, storage: imt, event: ImtEvent);

    const BTC_DENOMINATION: u256 = 1_000;
    const WBTC_PRECISION: u256 = 100_000_000;
    const STRK_PRECISION: u256 = 1_000_000_000_000_000_000;
    const TREE_DEPTH: u32 = 10;

    const BTC_USD_FEED: felt252 = 0x0258b8f498b767c200577227e3e9f009c9b0fe7f6a3c8c2c24efd588c54747a;
    const STRK_USD_FEED: felt252 =
        0x0a5db422ee7c28beead49303646e44ef9cbb8364eeba4d8af9ac06a3b556937;

    const MAX_ORACLE_AGE_SECS: u64 = 86400;
    const MIN_EXPIRY_DURATION_SECS: u64 = 3600;
    const RATE_VALID_FOR_SECS: u64 = 3600;
    const MIN_SLIPPAGE_BPS: u256 = 10;
    const MAX_SLIPPAGE_BPS: u256 = 1000;
    const BPS_DENOMINATOR: u256 = 10000;
    const MIN_STRK_AMOUNT: u256 = 1_000_000_000_000_000_000;

    // Vesu wBTC on Starknet Sepolia (publicly mintable — used for testnet)
    // Switch to real wBTC address on mainnet.
    const VESU_WBTC_ADDRESS: felt252 =
        0x063d32a3fa6074e72e7a1e06fe78c46a0c8473217773e19f11d8c8cbfc4ff8ca;

    // Vesu wBTC vToken on Starknet Sepolia (ERC-4626 — deposit wBTC, receive yield-bearing
    // shares)
    const VESU_VTOKEN_ADDRESS: felt252 =
        0x05868ed6b7c57ac071bf6bfe762174a2522858b700ba9fb062709e63b65bf186;

    const REAL_STRK_ADDRESS: felt252 =
        0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d;

    pub mod Errors {
        pub const COMMITMENT_USED: felt252 = 'commitment already used';
        pub const WBTC_TRANSFER_FAILED: felt252 = 'wBTC transfer failed';
        pub const STRK_TRANSFER_FAILED: felt252 = 'STRK transfer failed';
        pub const INVALID_PROOF: felt252 = 'invalid proof';
        pub const UNKNOWN_ROOT: felt252 = 'unknown root';
        pub const NOT_INTENDED_RECIPIENT: felt252 = 'not intended recipient';
        pub const NULLIFIER_USED: felt252 = 'nullifier already used';
        pub const EXPIRY_TOO_SOON: felt252 = 'expiry is too soon';
        pub const ALREADY_WITHDRAWN: felt252 = 'already withdrawn';
        pub const NOT_A_STRK_ORDER: felt252 = 'order is not a STRK order';
        pub const ALREADY_REFUNDED: felt252 = 'already refunded';
        pub const SECRET_CANNOT_BE_ZERO: felt252 = 'secret cannot be zero';
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
        pub const SECRET_UNKNOWN: felt252 = 'secret not yet revealed';
        pub const ORDER_STILL_FILLED: felt252 = 'order is filled, cannot refund';
        pub const NOT_OWNER: felt252 = 'caller is not the owner';
        pub const ZERO_ADDRESS: felt252 = 'new owner cannot be zero';
        pub const ALREADY_EARNING: felt252 = 'nullifier already earning';
        pub const NOT_EARNING: felt252 = 'nullifier is not earning';
        pub const NOT_RECIPIENT: felt252 = 'caller is not the recipient';
        pub const INVALID_RECIPIENT: felt252 = 'recipient cannot be zero';
        pub const VESU_NOT_CONFIGURED: felt252 = 'vesu vtoken not configured';
        pub const VESU_DEPOSIT_FAILED: felt252 = 'vesu deposit failed';
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
        owner: ContractAddress,
        // Vesu vToken — ERC-4626 contract that accepts wBTC and returns yield-bearing shares.
        // Zero address = Vesu disabled (wBTC sits idle in this contract).
        vesu_vtoken: ContractAddress,
        // Per-nullifier yield tracking.
        // earning[nullifier_hash]   = true  → wBTC is inside Vesu for this nullifier.
        // shares[nullifier_hash]    = vToken shares held on behalf of this nullifier.
        // recipient[nullifier_hash] = the address locked in at start_earning time.
        //                             Only this address can call stop_earning.
        //
        // The nullifier IS marked spent in nullifier_hashes inside start_earning.
        // stop_earning is the sole withdrawal path for an earning position.
        nullifier_earning: Map<u256, bool>,
        nullifier_shares: Map<u256, u256>,
        nullifier_recipient: Map<u256, ContractAddress>,
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
        YieldStarted: YieldStarted,
        YieldStopped: YieldStopped,
        YieldRedeemed: YieldRedeemed,
        WbtcOrderPosted: WbtcOrderPosted,
        WbtcOrderFilled: WbtcOrderFilled,
        WbtcWithdrawn: WbtcWithdrawn,
        StrkWithdrawn: StrkWithdrawn,
        WbtcRefunded: WbtcRefunded,
        StrkRefunded: StrkRefunded,
        OwnershipTransferred: OwnershipTransferred,
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
        // Amount may be > BTC_DENOMINATION if yield was accrued
        amount: u256,
    }

    // Emitted when a user opts their deposit into Vesu yield earning.
    #[derive(Drop, starknet::Event)]
    struct YieldStarted {
        #[key]
        nullifier_hash: u256,
        recipient: ContractAddress,
        // vToken shares received from Vesu for BTC_DENOMINATION wBTC
        shares: u256,
    }

    // Emitted when a user calls stop_earning and receives wBTC + yield.
    #[derive(Drop, starknet::Event)]
    struct YieldStopped {
        #[key]
        nullifier_hash: u256,
        recipient: ContractAddress,
        // wBTC returned (principal + yield)
        amount: u256,
    }

    // Emitted internally when Vesu shares are redeemed back to wBTC.
    #[derive(Drop, starknet::Event)]
    struct YieldRedeemed {
        #[key]
        nullifier_hash: u256,
        shares: u256,
        wbtc_returned: u256,
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

    #[derive(Drop, starknet::Event)]
    struct OwnershipTransferred {
        previous_owner: ContractAddress,
        new_owner: ContractAddress,
    }

    // -------------------------------------------------------
    // Constructor
    // -------------------------------------------------------
    #[constructor]
    fn constructor(ref self: ContractState, verifier_class_hash: ClassHash) {
        let tx_info = get_tx_info();

        // Use Vesu's wBTC on Sepolia — publicly mintable and compatible with the vToken.
        // Switch to real wBTC address for mainnet deployment.
        self.wBTC.write(VESU_WBTC_ADDRESS.try_into().unwrap());
        self.strk.write(REAL_STRK_ADDRESS.try_into().unwrap());

        // Configure Vesu vToken — accepts Vesu wBTC and earns lending yield.
        // Set to zero address to disable yield earning (idle pool mode).
        self.vesu_vtoken.write(VESU_VTOKEN_ADDRESS.try_into().unwrap());

        let verifier_calldata: Array<felt252> = array![];
        let (verifier_address, _) = deploy_syscall(
            verifier_class_hash, 0, verifier_calldata.span(), false,
        )
            .unwrap_syscall();
        self.verifier.write(verifier_address);

        self.imt.initializer(TREE_DEPTH);

        let owner = tx_info.account_contract_address;
        self.owner.write(owner);
        self
            .emit(
                OwnershipTransferred {
                    previous_owner: contract_address_const::<0>(), new_owner: owner,
                },
            );
    }

    // -------------------------------------------------------
    // Implementation
    // -------------------------------------------------------
    #[abi(embed_v0)]
    impl PrivateSwapImpl of super::IPrivateSwap<ContractState> {
        // ---------------------------------------------------
        // DEPOSIT
        // Alice locks BTC_DENOMINATION wBTC into the anonymous pool.
        // At this point the wBTC is idle — Alice can later:
        //   a) zk_withdraw_wbtc() to withdraw directly, or
        //   b) post_wbtc_order()  to swap for STRK, or
        //   c) start_earning()    to earn Vesu yield (then stop_earning() to exit).
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
        // START EARNING
        // Alice uses her ZK proof to opt her deposit into Vesu yield.
        //
        // SECURITY:
        // - The nullifier is marked spent immediately so the same proof
        //   cannot be replayed in zk_withdraw_wbtc or post_wbtc_order.
        // - The recipient address is locked on-chain. Only that address
        //   can call stop_earning — no ZK proof required at that point.
        // - The recipient must be non-zero (zero would lock funds forever).
        //
        // After this call the note is consumed. The ONLY way to withdraw
        // the wBTC + yield is via stop_earning(nullifier_hash).
        // ---------------------------------------------------
        fn start_earning(
            ref self: ContractState, proof: Span<felt252>, recipient: ContractAddress,
        ) {
            assert(recipient != contract_address_const::<0>(), Errors::INVALID_RECIPIENT);

            let verifier = IVerifierDispatcher { contract_address: self.verifier.read() };
            let verified = verifier.verify_ultra_keccak_zk_honk_proof(proof);
            assert(verified.is_ok(), Errors::INVALID_PROOF);

            let result = verified.unwrap();
            let root = *result.at(0);
            let nullifier_hash = *result.at(1);
            let recipient_hash = *result.at(2);

            let computed_recipient_hash = Poseidon2Trait::hash_1(
                FieldTrait::from_address(alice_strk_destination),
            );

            assert(computed_recipient_hash == recipient_hash, Errors::NOT_INTENDED_RECIPIENT);

            assert(self.imt.is_known_root(root), Errors::UNKNOWN_ROOT);
            // Nullifier must not be spent already
            assert(!self.nullifier_hashes.read(nullifier_hash), Errors::NULLIFIER_USED);
            // Cannot opt in twice (belt-and-suspenders given the nullifier check above)
            assert(!self.nullifier_earning.read(nullifier_hash), Errors::ALREADY_EARNING);

            // Mark nullifier as spent. The proof can no longer be used in
            // zk_withdraw_wbtc or post_wbtc_order — stop_earning is the only exit.
            self.nullifier_hashes.write(nullifier_hash, true);

            let vtoken_addr = self.vesu_vtoken.read();
            assert(vtoken_addr != contract_address_const::<0>(), Errors::VESU_NOT_CONFIGURED);

            let wbtc_addr = self.wBTC.read();
            let this = get_contract_address();

            // Approve Vesu vToken to pull BTC_DENOMINATION from this contract
            let wbtc = IERC20Dispatcher { contract_address: wbtc_addr };
            wbtc.approve(vtoken_addr, BTC_DENOMINATION);

            // Deposit into Vesu — returns vToken shares representing the position.
            // Shares appreciate over time as borrowers pay interest.
            let vtoken = IVTokenDispatcher { contract_address: vtoken_addr };
            let shares = vtoken.deposit(BTC_DENOMINATION, this);
            assert(shares > 0, Errors::VESU_DEPOSIT_FAILED);

            // Record the earning position and lock the recipient.
            self.nullifier_earning.write(nullifier_hash, true);
            self.nullifier_shares.write(nullifier_hash, shares);
            self.nullifier_recipient.write(nullifier_hash, recipient);

            self.emit(YieldStarted { nullifier_hash, recipient, shares });
        }

        // ---------------------------------------------------
        // STOP EARNING
        // Redeems the Vesu position and sends wBTC + yield to the recipient.
        //
        // No ZK proof required — the recipient address committed during
        // start_earning is the sole credential. Only that address can call
        // this function. Anyone can call it on behalf of the recipient but
        // funds always go to the pre-committed recipient address.
        // ---------------------------------------------------
        fn stop_earning(ref self: ContractState, nullifier_hash: u256) {
            let recipient = self.nullifier_recipient.read(nullifier_hash);

            // Recipient must have been set (i.e. start_earning was called)
            assert(recipient != contract_address_const::<0>(), Errors::NOT_EARNING);
            // Only the committed recipient can trigger withdrawal
            assert(get_caller_address() == recipient, Errors::NOT_RECIPIENT);
            // Must still be in the earning state (not already redeemed)
            assert(self.nullifier_earning.read(nullifier_hash), Errors::NOT_EARNING);

            // Redeem Vesu shares → wBTC + yield lands in this contract
            let amount = self.redeem_vesu_position(nullifier_hash);

            // Clear the recipient slot
            self.nullifier_recipient.write(nullifier_hash, contract_address_const::<0>());

            // Transfer to recipient
            let wbtc = IERC20Dispatcher { contract_address: self.wBTC.read() };
            let success = wbtc.transfer(recipient, amount);
            assert(success, Errors::TRANSFER_FAILED);

            self.emit(YieldStopped { nullifier_hash, recipient, amount });
        }

        // ---------------------------------------------------
        // ZK WITHDRAW wBTC
        // Alice proves she owns a deposit and withdraws directly.
        // Cannot be used if start_earning() was already called for this note
        // (the nullifier would already be spent).
        // ---------------------------------------------------
        fn zk_withdraw_wbtc(
            ref self: ContractState, proof: Span<felt252>, recipient: ContractAddress,
        ) {
            let verifier = IVerifierDispatcher { contract_address: self.verifier.read() };
            let verified = verifier.verify_ultra_keccak_zk_honk_proof(proof);
            assert(verified.is_ok(), Errors::INVALID_PROOF);

            let result = verified.unwrap();
            let root = *result.at(0);
            let nullifier_hash = *result.at(1);
            let recipient_hash = *result.at(2);

            let computed_recipient_hash = Poseidon2Trait::hash_1(
                FieldTrait::from_address(alice_strk_destination),
            );

            assert(computed_recipient_hash == recipient_hash, Errors::NOT_INTENDED_RECIPIENT);

            assert(self.imt.is_known_root(root), Errors::UNKNOWN_ROOT);
            assert(!self.nullifier_hashes.read(nullifier_hash), Errors::NULLIFIER_USED);
            self.nullifier_hashes.write(nullifier_hash, true);

            // A non-earning note always holds exactly BTC_DENOMINATION.
            // (Earning notes are exited via stop_earning, not here.)
            let amount = BTC_DENOMINATION;

            let wbtc = IERC20Dispatcher { contract_address: self.wBTC.read() };
            let success = wbtc.transfer(recipient, amount);
            assert(success, Errors::TRANSFER_FAILED);

            self.emit(Withdrawal { recipient, nullifier_hash, amount });
        }

        // ---------------------------------------------------
        // POST WBTC ORDER
        // Alice uses her ZK proof to post a swap order.
        // Cannot be used if start_earning() was already called for this note.
        // ---------------------------------------------------
        fn post_wbtc_order(
            ref self: ContractState,
            proof: Span<felt252>,
            alice_strk_destination: ContractAddress,
            hashlock: felt252,
            expiry: u64,
            slippage_tolerance_bps: u256,
        ) {
            assert(hashlock != pedersen(0, 0), Errors::SECRET_CANNOT_BE_ZERO);

            let verifier = IVerifierDispatcher { contract_address: self.verifier.read() };
            let verified = verifier.verify_ultra_keccak_zk_honk_proof(proof);
            assert(verified.is_ok(), Errors::INVALID_PROOF);

            let result = verified.unwrap();
            let root = *result.at(0);
            let nullifier_hash = *result.at(1);
            let recipient_hash = *result.at(2);

            let computed_recipient_hash = Poseidon2Trait::hash_1(
                FieldTrait::from_address(alice_strk_destination),
            );

            assert(computed_recipient_hash == recipient_hash, Errors::NOT_INTENDED_RECIPIENT);
            assert(self.imt.is_known_root(root), Errors::UNKNOWN_ROOT);
            assert(!self.nullifier_hashes.read(nullifier_hash), Errors::NULLIFIER_USED);
            self.nullifier_hashes.write(nullifier_hash, true);

            let now = get_block_timestamp();
            assert(expiry >= now + MIN_EXPIRY_DURATION_SECS, Errors::EXPIRY_TOO_SOON);
            assert(
                slippage_tolerance_bps >= MIN_SLIPPAGE_BPS
                    && slippage_tolerance_bps <= MAX_SLIPPAGE_BPS,
                Errors::SLIPPAGE_OUT_OF_RANGE,
            );

            let quoted_strk_amount = self.get_btc_strk_rate() * BTC_DENOMINATION / WBTC_PRECISION;
            assert(quoted_strk_amount >= MIN_STRK_AMOUNT, Errors::STRK_AMOUNT_TOO_LOW);

            let alice = get_caller_address();
            let order_id: u256 = nullifier_hash;

            self
                .wbtc_orders
                .write(
                    order_id,
                    WbtcOrder {
                        wbtc_seller: alice,
                        wbtc_buyer: contract_address_const::<0>(),
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
                        secret: 0,
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
        // ---------------------------------------------------
        fn fill_wbtc_order(ref self: ContractState, wbtc_order_id: u256, bob_expiry: u64) {
            let mut order = self.wbtc_orders.read(wbtc_order_id);
            let now = get_block_timestamp();

            assert(!order.is_filled, Errors::ORDER_ALREADY_FILLED);
            assert(!order.is_refunded, Errors::ALREADY_REFUNDED);
            assert(!order.is_withdrawn, Errors::ALREADY_WITHDRAWN);
            assert(order.wbtc_amount > 0, Errors::NOT_A_WBTC_ORDER);
            assert(now < order.expiry, Errors::ORDER_EXPIRED);
            assert(now <= order.rate_expiry, Errors::QUOTED_RATE_EXPIRED);
            assert(bob_expiry < order.expiry, Errors::BOB_EXPIRY_TOO_LONG);
            assert(bob_expiry >= now + MIN_EXPIRY_DURATION_SECS, Errors::EXPIRY_TOO_SOON);

            let live_strk_amount = self.get_btc_strk_rate() * order.wbtc_amount / WBTC_PRECISION;
            assert(live_strk_amount >= MIN_STRK_AMOUNT, Errors::STRK_AMOUNT_TOO_LOW);

            let min_acceptable = order.quoted_strk_amount
                * (BPS_DENOMINATOR - order.slippage_tolerance_bps)
                / BPS_DENOMINATOR;
            assert(live_strk_amount >= min_acceptable, Errors::SLIPPAGE_TOO_HIGH);

            let bob = get_caller_address();
            let this = get_contract_address();

            let strk = IERC20Dispatcher { contract_address: self.strk.read() };
            assert(strk.allowance(bob, this) >= live_strk_amount, Errors::INSUFFICIENT_ALLOWANCE);
            let success = strk.transfer_from(bob, this, live_strk_amount);
            assert(success, Errors::STRK_TRANSFER_FAILED);

            order.wbtc_buyer = bob;
            order.is_filled = true;
            self.wbtc_orders.write(wbtc_order_id, order);

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
        // WITHDRAW wBTC (HTLC — Bob claims after Alice reveals secret)
        // ---------------------------------------------------
        fn withdraw_wbtc(ref self: ContractState, wbtc_order_id: u256) {
            let mut order = self.wbtc_orders.read(wbtc_order_id);
            let caller = get_caller_address();

            assert(!order.is_withdrawn, Errors::ALREADY_WITHDRAWN);
            assert(!order.is_refunded, Errors::ALREADY_REFUNDED);
            assert(order.wbtc_buyer == caller, Errors::NOT_THE_BUYER);
            assert(order.secret != 0, Errors::SECRET_UNKNOWN);
            assert(
                get_block_timestamp() < order.expiry || order.swap_initiated, Errors::ORDER_EXPIRED,
            );

            let hash = pedersen(0, order.secret);
            assert(hash == order.hashlock, Errors::INVALID_SECRET);

            order.is_withdrawn = true;
            self.wbtc_orders.write(wbtc_order_id, order);

            let wbtc = IERC20Dispatcher { contract_address: self.wBTC.read() };
            let success = wbtc.transfer(caller, order.wbtc_amount);
            assert(success, Errors::TRANSFER_FAILED);

            self.emit(WbtcWithdrawn { order_id: wbtc_order_id, wbtc_buyer: caller });
        }

        // ---------------------------------------------------
        // WITHDRAW STRK (Alice reveals secret to claim STRK)
        // ---------------------------------------------------
        fn withdraw_strk(ref self: ContractState, strk_order_id: u256, secret: felt252) {
            let mut order = self.strk_orders.read(strk_order_id);
            let caller = get_caller_address();
            assert(secret != 0, Errors::SECRET_CANNOT_BE_ZERO);
            assert(!order.is_withdrawn, Errors::ALREADY_WITHDRAWN);
            assert(!order.is_refunded, Errors::ALREADY_REFUNDED);
            assert(order.strk_buyer == caller, Errors::NOT_THE_BUYER);
            assert(get_block_timestamp() < order.expiry, Errors::ORDER_EXPIRED);

            let hash = pedersen(0, secret);
            assert(hash == order.hashlock, Errors::INVALID_SECRET);

            let mut wbtc_order = self.wbtc_orders.read(order.wbtc_order_id);
            wbtc_order.swap_initiated = true;
            wbtc_order.secret = secret;
            self.wbtc_orders.write(order.wbtc_order_id, wbtc_order);

            order.is_withdrawn = true;
            self.strk_orders.write(strk_order_id, order);

            let strk = IERC20Dispatcher { contract_address: self.strk.read() };
            let success = strk.transfer(caller, order.strk_amount);
            assert(success, Errors::TRANSFER_FAILED);

            self.emit(StrkWithdrawn { order_id: strk_order_id, strk_buyer: caller });
        }

        // ---------------------------------------------------
        // REFUND wBTC
        // ---------------------------------------------------
        fn refund_wbtc(ref self: ContractState, wbtc_order_id: u256) {
            let mut order = self.wbtc_orders.read(wbtc_order_id);
            assert(order.wbtc_amount > 0, Errors::NOT_A_WBTC_ORDER);
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
        // ---------------------------------------------------
        fn refund_strk(ref self: ContractState, strk_order_id: u256) {
            let mut order = self.strk_orders.read(strk_order_id);
            assert(order.strk_amount > 0, Errors::NOT_A_STRK_ORDER);
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
        // Views
        // ---------------------------------------------------
        fn owner(self: @ContractState) -> ContractAddress {
            self.owner.read()
        }

        fn vesu_vtoken_address(self: @ContractState) -> ContractAddress {
            self.vesu_vtoken.read()
        }

        // Returns the current wBTC value of a yield position.
        // Returns 0 if the nullifier is not earning.
        fn get_yield_balance(self: @ContractState, nullifier_hash: u256) -> u256 {
            if !self.nullifier_earning.read(nullifier_hash) {
                return 0;
            }
            let vtoken_addr = self.vesu_vtoken.read();
            if vtoken_addr == contract_address_const::<0>() {
                return 0;
            }
            let shares = self.nullifier_shares.read(nullifier_hash);
            let vtoken = IVTokenDispatcher { contract_address: vtoken_addr };
            vtoken.convert_to_assets(shares)
        }

        fn is_earning(self: @ContractState, nullifier_hash: u256) -> bool {
            self.nullifier_earning.read(nullifier_hash)
        }

        // Returns the recipient locked in at start_earning time.
        // Returns zero address if this nullifier is not in an earning state.
        fn get_yield_recipient(self: @ContractState, nullifier_hash: u256) -> ContractAddress {
            self.nullifier_recipient.read(nullifier_hash)
        }

        fn get_quoted_strk_amount(self: @ContractState) -> u256 {
            self.get_btc_strk_rate() * BTC_DENOMINATION / WBTC_PRECISION
        }

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

        // ---------------------------------------------------
        // Admin
        // ---------------------------------------------------
        fn set_mock_wbtc(ref self: ContractState, wbtc: ContractAddress) {
            self.assert_only_owner();
            let wBTC = IERC20MetadataDispatcher { contract_address: wbtc };
            assert(wBTC.decimals() == 8, 'mock wBTC must have 8 decimals');
            self.wBTC.write(wbtc);
        }

        // Update the Vesu vToken address — use zero address to disable yield.
        fn set_vesu_vtoken(ref self: ContractState, vtoken: ContractAddress) {
            self.assert_only_owner();
            self.vesu_vtoken.write(vtoken);
        }

        fn transfer_ownership(ref self: ContractState, new_owner: ContractAddress) {
            self.assert_only_owner();
            assert(new_owner != contract_address_const::<0>(), Errors::ZERO_ADDRESS);
            let previous = self.owner.read();
            self.owner.write(new_owner);
            self.emit(OwnershipTransferred { previous_owner: previous, new_owner });
        }
    }

    // -------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------
    #[generate_trait]
    impl Private of PrivateTrait {
        fn assert_only_owner(self: @ContractState) {
            assert(get_caller_address() == self.owner.read(), Errors::NOT_OWNER);
        }

        // Redeems the vToken shares for an earning position.
        // Clears earning state and emits YieldRedeemed.
        // Returns the wBTC amount received (principal + yield).
        fn redeem_vesu_position(ref self: ContractState, nullifier_hash: u256) -> u256 {
            let vtoken_addr = self.vesu_vtoken.read();
            let shares = self.nullifier_shares.read(nullifier_hash);
            let this = get_contract_address();

            let vtoken = IVTokenDispatcher { contract_address: vtoken_addr };
            // redeem(shares, receiver, owner) → burns shares, returns wBTC to `this`
            let wbtc_returned = vtoken.redeem(shares, this, this);

            // Clear the earning position
            self.nullifier_earning.write(nullifier_hash, false);
            self.nullifier_shares.write(nullifier_hash, 0);

            self.emit(YieldRedeemed { nullifier_hash, shares, wbtc_returned });

            wbtc_returned
        }

        fn get_oracle_price(self: @ContractState, feed_address: felt252) -> (u128, u32) {
            let feed = IAggregatorProxyDispatcher {
                contract_address: feed_address.try_into().unwrap(),
            };
            let round = feed.latest_round_data();
            let now = get_block_timestamp();
            assert(round.updated_at + MAX_ORACLE_AGE_SECS >= now, 'stale oracle price');
            assert(round.answer > 0, 'invalid oracle price');
            let decimals: u32 = feed.decimals().into();
            (round.answer, decimals)
        }

        fn pow10(self: @ContractState, n: u256) -> u256 {
            match n {
                0 => 1,
                1 => 10,
                2 => 100,
                3 => 1_000,
                4 => 10_000,
                5 => 100_000,
                6 => 1_000_000,
                7 => 10_000_000,
                8 => 100_000_000,
                9 => 1_000_000_000,
                10 => 10_000_000_000,
                11 => 100_000_000_000,
                12 => 1_000_000_000_000,
                18 => 1_000_000_000_000_000_000,
                _ => {
                    let mut result: u256 = 1;
                    let mut i: u256 = 0;
                    while i < n {
                        result *= 10;
                        i += 1;
                    }
                    result
                },
            }
        }
    }
}
