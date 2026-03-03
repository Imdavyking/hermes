use starknet::{ContractAddress, get_block_timestamp, get_caller_address, get_contract_address};

mod field;
mod incremental_merkle_tree;
mod mockUSDC;
mod poseidon2;
mod poseidon2lib;
use crate::field::FieldTrait;
use crate::poseidon2lib::Poseidon2Trait;

// -------------------------------------------------------
// External Interfaces
// -------------------------------------------------------

#[starknet::interface]
trait IVerifier<TContractState> {
    fn verify_ultra_keccak_zk_honk_proof(
        self: @TContractState, full_proof_with_hints: Span<felt252>,
    ) -> Result<Span<u256>, felt252>;
}

#[starknet::interface]
trait IAggregatorProxy<TContractState> {
    fn latest_round_data(self: @TContractState) -> Round;
    fn decimals(self: @TContractState) -> u8;
}

#[starknet::interface]
trait IResolver<TContractState> {
    fn checker(self: @TContractState, order_id: u256) -> (bool, ExecPayload);
}

#[starknet::interface]
trait IVToken<TContractState> {
    fn deposit(ref self: TContractState, assets: u256, receiver: ContractAddress) -> u256;
    fn redeem(
        ref self: TContractState, shares: u256, receiver: ContractAddress, owner: ContractAddress,
    ) -> u256;
    fn convert_to_assets(self: @TContractState, shares: u256) -> u256;
}

#[starknet::interface]
trait IMockWBTC<TContractState> {
    fn mint(ref self: TContractState, recipient: ContractAddress, amount: u256);
}

// EscrowExecution is needed for the success_action field in EscrowDataFull
// which is passed to IAtomiqEscrowStorage::get_state.
#[derive(Drop, Serde)]
struct EscrowExecution {
    hash: felt252,
    expiry: u64,
    fee: u256,
}

// EscrowData is the stripped struct stored on-chain (no success_action).
// success_action is always None when we initialize an escrow, so we omit it
// from storage to keep Store derivation simple.
#[derive(Drop, Serde, Copy, starknet::Store)]
struct EscrowData {
    offerer: ContractAddress,
    claimer: ContractAddress,
    token: ContractAddress,
    refund_handler: ContractAddress,
    claim_handler: ContractAddress,
    flags: u128,
    claim_data: felt252,
    refund_data: felt252,
    amount: u256,
    fee_token: ContractAddress,
    security_deposit: u256,
    claimer_bounty: u256,
}

// EscrowDataFull matches the Atomiq escrow manager ABI exactly.
// Used only when calling get_state — we always pass success_action = None.
#[derive(Drop, Serde)]
struct EscrowDataFull {
    offerer: ContractAddress,
    claimer: ContractAddress,
    token: ContractAddress,
    refund_handler: ContractAddress,
    claim_handler: ContractAddress,
    flags: u128,
    claim_data: felt252,
    refund_data: felt252,
    amount: u256,
    fee_token: ContractAddress,
    security_deposit: u256,
    claimer_bounty: u256,
    success_action: Option<EscrowExecution>,
}

// EscrowState is returned by IAtomiqEscrowStorage::get_state.
// state values (from Atomiq SDK):
//   1 = COMMITED    — in flight, not yet claimed or refunded
//   2 = SOFT_CLAIMED — payment seen off-chain, not yet claimed on-chain
//   3 = CLAIMED     — LP claimed, BTC was delivered
//   4 = REFUNDABLE  — LP failed to process, user can refund
#[derive(Drop, Serde)]
struct EscrowState {
    init_blockheight: u64,
    finish_blockheight: u64,
    state: u8,
}

#[starknet::interface]
trait IAtomiqEscrow<TContractState> {
    fn initialize(
        ref self: TContractState,
        escrow: EscrowDataFull,
        signature: Array<felt252>,
        timeout: u64,
        extra_data: Span<felt252>,
    );
    fn refund(ref self: TContractState, escrow: EscrowDataFull, witness: Array<felt252>);
}

#[starknet::interface]
trait IAtomiqEscrowStorage<TContractState> {
    fn get_state(self: @TContractState, escrow: EscrowDataFull) -> EscrowState;
}

// -------------------------------------------------------
// Shared Data Types
// -------------------------------------------------------

#[derive(Drop, Serde)]
struct Round {
    round_id: felt252,
    answer: u128,
    block_num: u64,
    started_at: u64,
    updated_at: u64,
}

// ExecPayload is returned by checker() alongside the can_exec boolean.
//
// strk_amount is the live oracle-derived STRK equivalent of the order's
// usdc_per_interval, computed at checker() call time. The keeper reads this
// field directly and passes it to the Atomiq SDK as the exactIn amount,
// eliminating any need for the keeper to replicate oracle arithmetic or hold
// a hardcoded config value.
//
// Derivation (BTC oracle cancels out — only STRK/USD feed needed):
//   strk_amount = usdc_per_interval * STRK_PRECISION * 10^strk_dec
//                 / (strk_usd * USDC_PRECISION)
//
// strk_amount is 0 when can_exec is false.
#[derive(Drop, Serde)]
struct ExecPayload {
    target: ContractAddress,
    selector: ByteArray,
    calldata: Array<felt252>,
    strk_amount: u256,
}

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

#[derive(Drop, Serde, Copy, starknet::Store)]
struct DCAOrder {
    owner: ContractAddress,
    usdc_per_interval: u256,
    interval_seconds: u64,
    last_execution: u64,
    total_intervals: u32,
    executed_intervals: u32,
    is_active: bool,
}

// -------------------------------------------------------
// Public Interface
// -------------------------------------------------------

#[starknet::interface]
trait IPrivateSwap<TContractState> {
    // --- Core pool ---
    fn deposit(ref self: TContractState, commitment: u256);
    fn zk_withdraw_wbtc(ref self: TContractState, proof: Span<felt252>, recipient: ContractAddress);

    // --- Yield (Vesu) ---
    fn start_earning(ref self: TContractState, proof: Span<felt252>, recipient: ContractAddress);
    fn stop_earning(ref self: TContractState, nullifier_hash: u256);
    fn get_yield_balance(self: @TContractState, nullifier_hash: u256) -> u256;
    fn is_earning(self: @TContractState, nullifier_hash: u256) -> bool;
    fn get_yield_recipient(self: @TContractState, nullifier_hash: u256) -> ContractAddress;

    // --- HTLC swap (wBTC → STRK) ---
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

    // --- DCA (USDC → wBTC via Atomiq) ---
    fn create_dca_order(
        ref self: TContractState,
        btc_destination: ByteArray,
        usdc_per_interval: u256,
        interval_hours: u64,
        total_intervals: u32,
    ) -> u256;
    fn execute_dca(
        ref self: TContractState,
        order_id: u256,
        strk_amount: u256,
        payment_hash: felt252,
        expiry: u64,
        flags: u128,
        signature: Array<felt252>,
    );
    // Called by anyone after an Atomiq escrow has settled.
    // If the LP claimed (state=3): clears the pending flag so the next
    // interval can be executed — no rollback.
    // If refundable (state=4): rolls back the interval counter so the keeper
    // retries automatically and reclaims STRK from Atomiq.
    fn refund_dca_interval(ref self: TContractState, order_id: u256);
    fn cancel_dca(ref self: TContractState, order_id: u256);
    // checker() returns (can_exec, payload) where payload.strk_amount is the
    // live oracle-priced STRK equivalent of usdc_per_interval.
    fn checker(self: @TContractState, order_id: u256) -> (bool, ExecPayload);

    // --- Views ---
    fn get_wbtc_order(self: @TContractState, order_id: u256) -> WbtcOrder;
    fn get_strk_order(self: @TContractState, order_id: u256) -> StrkOrder;
    fn get_dca_order(self: @TContractState, order_id: u256) -> DCAOrder;
    fn get_btc_usd_price(self: @TContractState) -> (u128, u32);
    fn get_strk_usd_price(self: @TContractState) -> (u128, u32);
    fn get_btc_strk_rate(self: @TContractState) -> u256;
    fn get_quoted_strk_amount(self: @TContractState) -> u256;
    fn preview_wbtc_for_usdc(self: @TContractState, usdc_amount: u256) -> u256;
    fn get_dca_strk_reserved(self: @TContractState, order_id: u256) -> u256;
    fn get_dca_btc_destination(self: @TContractState, order_id: u256) -> ByteArray;
    fn keeper_fee_strk(self: @TContractState) -> u256;
    fn current_root(self: @TContractState) -> u256;
    fn next_leaf_index(self: @TContractState) -> u32;
    fn is_known_root(self: @TContractState, root: u256) -> bool;
    fn wBTC_address(self: @TContractState) -> ContractAddress;
    fn strk_address(self: @TContractState) -> ContractAddress;
    fn usdc_address(self: @TContractState) -> ContractAddress;
    fn vesu_vtoken_address(self: @TContractState) -> ContractAddress;
    fn wBTC_denomination(self: @TContractState) -> u256;
    fn owner(self: @TContractState) -> ContractAddress;
    fn get_dca_pending_escrow(self: @TContractState, order_id: u256) -> EscrowData;
    fn dca_interval_needs_refund(self: @TContractState, order_id: u256) -> bool;
    fn get_dca_pending_interval_index(self: @TContractState, order_id: u256) -> u32;

    // --- Admin ---
    fn set_wbtc(ref self: TContractState, wbtc: ContractAddress);
    fn set_vesu_vtoken(ref self: TContractState, vtoken: ContractAddress);
    fn set_usdc(ref self: TContractState, usdc: ContractAddress);
    fn transfer_ownership(ref self: TContractState, new_owner: ContractAddress);
    fn add_keeper(ref self: TContractState, keeper: ContractAddress);
    fn remove_keeper(ref self: TContractState, keeper: ContractAddress);
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
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::syscalls::deploy_syscall;
    use starknet::{SyscallResultTrait, get_tx_info};
    use crate::incremental_merkle_tree::IncrementalMerkleTreeComponent;
    use crate::incremental_merkle_tree::IncrementalMerkleTreeComponent::InternalTrait;
    use super::{ContractAddress, DCAOrder, EscrowData, EscrowDataFull, ExecPayload, FieldTrait, IAggregatorProxyDispatcher, IAggregatorProxyDispatcherTrait, IAtomiqEscrowDispatcher, IAtomiqEscrowDispatcherTrait, IAtomiqEscrowStorageDispatcher, IAtomiqEscrowStorageDispatcherTrait, IMockWBTCDispatcherTrait, IVTokenDispatcher, IVTokenDispatcherTrait, IVerifierDispatcher, IVerifierDispatcherTrait, Poseidon2Trait, StrkOrder, WbtcOrder, get_block_timestamp, get_caller_address, get_contract_address};

    component!(path: IncrementalMerkleTreeComponent, storage: imt, event: ImtEvent);

    // -------------------------------------------------------
    // Constants
    // -------------------------------------------------------

    const BTC_DENOMINATION: u256 = 1_000;

    const WBTC_PRECISION: u256 = 100_000_000;
    const STRK_PRECISION: u256 = 1_000_000_000_000_000_000;
    const USDC_PRECISION: u256 = 1_000_000;

    const TREE_DEPTH: u32 = 10;

    const BTC_USD_FEED: felt252 = 0x0258b8f498b767c200577227e3e9f009c9b0fe7f6a3c8c2c24efd588c54747a;
    const STRK_USD_FEED: felt252 =
        0x0a5db422ee7c28beead49303646e44ef9cbb8364eeba4d8af9ac06a3b556937;

    const ZERO_ADDRESS: ContractAddress = 0.try_into().unwrap();

    const MAX_ORACLE_AGE_SECS: u64 = 604_800;

    const MIN_EXPIRY_DURATION_SECS: u64 = 3_600;
    const RATE_VALID_FOR_SECS: u64 = 3_600;

    const MIN_SLIPPAGE_BPS: u256 = 10;
    const MAX_SLIPPAGE_BPS: u256 = 1_000;
    const BPS_DENOMINATOR: u256 = 10_000;

    const MIN_STRK_AMOUNT: u256 = 1_000_000_000_000_000_000;

    const MIN_USDC_PER_INTERVAL: u256 = 1_000_000;

    const DCA_MAX_INTERVALS: u32 = 1_000;
    const DCA_MAX_INTERVAL_HOURS: u64 = 720;

    const KEEPER_FEE_STRK: u256 = 500_000_000_000_000_000;

    const VESU_WBTC_ADDRESS: felt252 =
        0x063d32a3fa6074e72e7a1e06fe78c46a0c8473217773e19f11d8c8cbfc4ff8ca;
    const VESU_VTOKEN_ADDRESS: felt252 =
        0x05868ed6b7c57ac071bf6bfe762174a2522858b700ba9fb062709e63b65bf186;
    const REAL_STRK_ADDRESS: felt252 =
        0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d;
    const USDC_ADDRESS: felt252 =
        0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8;

    const ATOMIQ_ESCROW: felt252 =
        0x017bf50dd28b6d823a231355bb25813d4396c8e19d2df03026038714a22f0413;
    const ATOMIQ_LP: felt252 = 0x07616a5e3dc18e97b3310d8aba0bacb14ab389a4078442d9658be9616feeff3f;
    const ATOMIQ_REFUND_HANDLER: felt252 =
        0x034b8f28b3ca979036cb2849cfa3af7f67207459224b6ca5ce2474aa398ec3e7;
    const ATOMIQ_CLAIM_HANDLER: felt252 =
        0x050e50eacd16da414f2c3a7c3570fd5e248974c6fe757d41acbf72d2836fa0a1;

    const ESCROW_KEY_MULTIPLIER: u256 = 1_000_000;

    // 5% tolerance window for the keeper-supplied strk_amount in execute_dca.
    const STRK_TOLERANCE_BPS: u256 = 500;

    // Atomiq escrow state values (from SDK):
    //   1 = COMMITED     — in flight
    //   2 = SOFT_CLAIMED — payment seen off-chain, not yet claimed on-chain
    //   3 = CLAIMED      — LP claimed, BTC delivered
    //   4 = REFUNDABLE   — LP failed, offerer can refund
    const ESCROW_STATE_CLAIMED: u8 = 3;
    const ESCROW_STATE_REFUNDABLE: u8 = 4;

    // -------------------------------------------------------
    // Errors
    // -------------------------------------------------------

    pub mod Errors {
        pub const INVALID_PROOF: felt252 = 'invalid proof';
        pub const UNKNOWN_ROOT: felt252 = 'unknown root';
        pub const NULLIFIER_USED: felt252 = 'nullifier already used';
        pub const COMMITMENT_USED: felt252 = 'commitment already used';
        pub const NOT_INTENDED_RECIPIENT: felt252 = 'not intended recipient';
        pub const INVALID_RECIPIENT: felt252 = 'recipient cannot be zero';
        pub const WBTC_TRANSFER_FAILED: felt252 = 'wBTC transfer failed';
        pub const STRK_TRANSFER_FAILED: felt252 = 'STRK transfer failed';
        pub const USDC_TRANSFER_FAILED: felt252 = 'USDC transfer failed';
        pub const TRANSFER_FAILED: felt252 = 'token transfer failed';
        pub const INSUFFICIENT_ALLOWANCE: felt252 = 'insufficient token allowance';
        pub const NOT_A_WBTC_ORDER: felt252 = 'order_id is not a wBTC order';
        pub const NOT_A_STRK_ORDER: felt252 = 'order is not a STRK order';
        pub const ORDER_ALREADY_FILLED: felt252 = 'order already filled';
        pub const ORDER_EXPIRED: felt252 = 'order has expired';
        pub const NOT_EXPIRED_YET: felt252 = 'order has not expired yet';
        pub const ALREADY_WITHDRAWN: felt252 = 'already withdrawn';
        pub const ALREADY_REFUNDED: felt252 = 'already refunded';
        pub const SWAP_STARTED: felt252 = 'swap started';
        pub const EXPIRY_TOO_SOON: felt252 = 'expiry is too soon';
        pub const BOB_EXPIRY_TOO_LONG: felt252 = 'bob expiry exceeds alice expiry';
        pub const QUOTED_RATE_EXPIRED: felt252 = 'quoted rate has expired';
        pub const SLIPPAGE_TOO_HIGH: felt252 = 'price moved since quote';
        pub const SLIPPAGE_OUT_OF_RANGE: felt252 = 'slippage tolerance out of range';
        pub const STRK_AMOUNT_TOO_LOW: felt252 = 'strk amount below minimum';
        pub const SECRET_CANNOT_BE_ZERO: felt252 = 'secret cannot be zero';
        pub const SECRET_UNKNOWN: felt252 = 'secret not yet revealed';
        pub const INVALID_SECRET: felt252 = 'secret does not match lock';
        pub const NOT_THE_BUYER: felt252 = 'caller is not the buyer';
        pub const ALREADY_EARNING: felt252 = 'nullifier already earning';
        pub const NOT_EARNING: felt252 = 'nullifier is not earning';
        pub const NOT_RECIPIENT: felt252 = 'caller is not the recipient';
        pub const VESU_NOT_CONFIGURED: felt252 = 'vesu vtoken not configured';
        pub const VESU_DEPOSIT_FAILED: felt252 = 'vesu deposit failed';
        pub const DCA_NOT_ACTIVE: felt252 = 'dca order not active';
        pub const DCA_NOT_DUE: felt252 = 'interval not elapsed yet';
        pub const DCA_NOT_OWNER: felt252 = 'caller is not dca owner';
        pub const DCA_COMPLETED: felt252 = 'dca order completed';
        pub const DCA_INVALID_INTERVALS: felt252 = 'total intervals must be > 0';
        pub const DCA_TOO_MANY_INTERVALS: felt252 = 'exceeds max intervals';
        pub const DCA_INVALID_INTERVAL_HOURS: felt252 = 'interval hours must be > 0';
        pub const DCA_INTERVAL_TOO_LONG: felt252 = 'interval exceeds 30 days';
        pub const DCA_USDC_TOO_LOW: felt252 = 'usdc_per_interval below min';
        pub const DCA_WBTC_ZERO: felt252 = 'wbtc amount would be zero';
        pub const DCA_STRK_FEE_ALLOWANCE: felt252 = 'insufficient STRK fee allowance';
        pub const DCA_INTERVAL_PENDING: felt252 = 'prior escrow still pending';
        pub const DCA_NO_PENDING_ESCROW: felt252 = 'no pending escrow for order';
        pub const DCA_ESCROW_NOT_SETTLED: felt252 = 'escrow not yet settled';
        pub const DCA_STRK_AMOUNT_OUT_OF_RANGE: felt252 = 'strk amount out of 5% tolerance';
        pub const NOT_OWNER: felt252 = 'caller is not the owner';
        pub const ZERO_ADDRESS: felt252 = 'new owner cannot be zero';
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
        registered_keepers: Map<ContractAddress, bool>,
        wbtc_orders: Map<u256, WbtcOrder>,
        strk_orders: Map<u256, StrkOrder>,
        nullifier_earning: Map<u256, bool>,
        nullifier_shares: Map<u256, u256>,
        nullifier_recipient: Map<u256, ContractAddress>,
        dca_orders: Map<u256, DCAOrder>,
        dca_order_count: u256,
        dca_btc_destinations: Map<u256, ByteArray>,
        dca_strk_reserved: Map<u256, u256>,
        dca_pending_escrows: Map<u256, EscrowData>,
        dca_pending_interval_index: Map<u256, u32>,
        dca_interval_needs_refund: Map<u256, bool>,
        wBTC: ContractAddress,
        strk: ContractAddress,
        usdc: ContractAddress,
        vesu_vtoken: ContractAddress,
        verifier: ContractAddress,
        owner: ContractAddress,
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
        DCAOrderCreated: DCAOrderCreated,
        DCAExecuted: DCAExecuted,
        DCACancelled: DCACancelled,
        DCAIntervalRefunded: DCAIntervalRefunded,
        DCAIntervalClaimed: DCAIntervalClaimed,
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
        amount: u256,
    }

    #[derive(Drop, starknet::Event)]
    struct YieldStarted {
        #[key]
        nullifier_hash: u256,
        recipient: ContractAddress,
        shares: u256,
    }

    #[derive(Drop, starknet::Event)]
    struct YieldStopped {
        #[key]
        nullifier_hash: u256,
        recipient: ContractAddress,
        amount: u256,
    }

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

    #[derive(Drop, starknet::Event)]
    struct DCAOrderCreated {
        #[key]
        order_id: u256,
        owner: ContractAddress,
        usdc_per_interval: u256,
        interval_seconds: u64,
        total_intervals: u32,
        total_usdc_deposited: u256,
        total_strk_fee_deposited: u256,
    }

    #[derive(Drop, starknet::Event)]
    struct DCAExecuted {
        #[key]
        order_id: u256,
        owner: ContractAddress,
        usdc_spent: u256,
        wbtc_received: u256,
        executed_intervals: u32,
        keeper: ContractAddress,
        keeper_fee_paid: u256,
    }

    #[derive(Drop, starknet::Event)]
    struct DCACancelled {
        #[key]
        order_id: u256,
        owner: ContractAddress,
        usdc_refunded: u256,
        strk_fee_refunded: u256,
    }

    // Emitted when the LP failed to deliver BTC and STRK was refunded.
    // The interval counter is rolled back so the keeper retries.
    #[derive(Drop, starknet::Event)]
    struct DCAIntervalRefunded {
        #[key]
        order_id: u256,
        interval_index: u32,
        strk_returned: u256,
    }

    // Emitted when the LP successfully claimed (BTC was delivered).
    // The interval counter is kept and the next interval is unlocked.
    #[derive(Drop, starknet::Event)]
    struct DCAIntervalClaimed {
        #[key]
        order_id: u256,
        interval_index: u32,
    }

    // -------------------------------------------------------
    // Constructor
    // -------------------------------------------------------

    #[constructor]
    fn constructor(ref self: ContractState, verifier_class_hash: ClassHash) {
        let tx_info = get_tx_info();

        self.wBTC.write(VESU_WBTC_ADDRESS.try_into().unwrap());
        self.strk.write(REAL_STRK_ADDRESS.try_into().unwrap());
        self.usdc.write(USDC_ADDRESS.try_into().unwrap());
        self.vesu_vtoken.write(VESU_VTOKEN_ADDRESS.try_into().unwrap());

        let (verifier_address, _) = deploy_syscall(verifier_class_hash, 0, array![].span(), false)
            .unwrap_syscall();
        self.verifier.write(verifier_address);

        self.imt.initializer(TREE_DEPTH);
        self.dca_order_count.write(0);

        let owner = tx_info.account_contract_address;
        self.owner.write(owner);
        self.emit(OwnershipTransferred { previous_owner: ZERO_ADDRESS, new_owner: owner });
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

            let wbtc = IERC20Dispatcher { contract_address: self.wBTC.read() };
            let ok = wbtc
                .transfer_from(get_caller_address(), get_contract_address(), BTC_DENOMINATION);
            assert(ok, Errors::WBTC_TRANSFER_FAILED);

            let leaf_index = self.imt._insert(commitment);
            self.commitments.write(commitment, true);
            self.emit(Deposit { commitment, leaf_index, timestamp: get_block_timestamp() });
        }

        // ---------------------------------------------------
        // START EARNING
        // ---------------------------------------------------
        fn start_earning(
            ref self: ContractState, proof: Span<felt252>, recipient: ContractAddress,
        ) {
            assert(recipient != ZERO_ADDRESS, Errors::INVALID_RECIPIENT);

            let nullifier_hash = self.verify_proof_and_consume(proof, recipient);
            assert(!self.nullifier_earning.read(nullifier_hash), Errors::ALREADY_EARNING);

            let vtoken_addr = self.vesu_vtoken.read();
            assert(vtoken_addr != ZERO_ADDRESS, Errors::VESU_NOT_CONFIGURED);

            let this = get_contract_address();
            IERC20Dispatcher { contract_address: self.wBTC.read() }
                .approve(vtoken_addr, BTC_DENOMINATION);

            let shares = IVTokenDispatcher { contract_address: vtoken_addr }
                .deposit(BTC_DENOMINATION, this);
            assert(shares > 0, Errors::VESU_DEPOSIT_FAILED);

            self.nullifier_earning.write(nullifier_hash, true);
            self.nullifier_shares.write(nullifier_hash, shares);
            self.nullifier_recipient.write(nullifier_hash, recipient);

            self.emit(YieldStarted { nullifier_hash, recipient, shares });
        }

        // ---------------------------------------------------
        // STOP EARNING
        // ---------------------------------------------------
        fn stop_earning(ref self: ContractState, nullifier_hash: u256) {
            let recipient = self.nullifier_recipient.read(nullifier_hash);
            assert(recipient != ZERO_ADDRESS, Errors::NOT_EARNING);
            assert(get_caller_address() == recipient, Errors::NOT_RECIPIENT);
            assert(self.nullifier_earning.read(nullifier_hash), Errors::NOT_EARNING);

            let amount = self.redeem_vesu_position(nullifier_hash);
            self.nullifier_recipient.write(nullifier_hash, ZERO_ADDRESS);

            let ok = IERC20Dispatcher { contract_address: self.wBTC.read() }
                .transfer(recipient, amount);
            assert(ok, Errors::TRANSFER_FAILED);

            self.emit(YieldStopped { nullifier_hash, recipient, amount });
        }

        // ---------------------------------------------------
        // ZK WITHDRAW wBTC
        // ---------------------------------------------------
        fn zk_withdraw_wbtc(
            ref self: ContractState, proof: Span<felt252>, recipient: ContractAddress,
        ) {
            let nullifier_hash = self.verify_proof_and_consume(proof, recipient);

            let ok = IERC20Dispatcher { contract_address: self.wBTC.read() }
                .transfer(recipient, BTC_DENOMINATION);
            assert(ok, Errors::TRANSFER_FAILED);

            self.emit(Withdrawal { recipient, nullifier_hash, amount: BTC_DENOMINATION });
        }

        // ---------------------------------------------------
        // POST WBTC ORDER
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

            let nullifier_hash = self.verify_proof_and_consume(proof, alice_strk_destination);

            let now = get_block_timestamp();
            assert(expiry >= now + MIN_EXPIRY_DURATION_SECS, Errors::EXPIRY_TOO_SOON);
            assert(
                slippage_tolerance_bps >= MIN_SLIPPAGE_BPS
                    && slippage_tolerance_bps <= MAX_SLIPPAGE_BPS,
                Errors::SLIPPAGE_OUT_OF_RANGE,
            );

            let quoted_strk_amount = self.get_btc_strk_rate() * BTC_DENOMINATION / WBTC_PRECISION;
            assert(quoted_strk_amount >= MIN_STRK_AMOUNT, Errors::STRK_AMOUNT_TOO_LOW);

            let rate_expiry = now + RATE_VALID_FOR_SECS;

            self
                .wbtc_orders
                .write(
                    nullifier_hash,
                    WbtcOrder {
                        wbtc_seller: get_caller_address(),
                        wbtc_buyer: ZERO_ADDRESS,
                        alice_strk_destination,
                        hashlock,
                        wbtc_amount: BTC_DENOMINATION,
                        quoted_strk_amount,
                        slippage_tolerance_bps,
                        expiry,
                        rate_expiry,
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
                        order_id: nullifier_hash,
                        wbtc_seller: get_caller_address(),
                        alice_strk_destination,
                        wbtc_amount: BTC_DENOMINATION,
                        quoted_strk_amount,
                        hashlock,
                        expiry,
                        rate_expiry,
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
            let ok = strk.transfer_from(bob, this, live_strk_amount);
            assert(ok, Errors::STRK_TRANSFER_FAILED);

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
        // WITHDRAW wBTC
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
            assert(pedersen(0, order.secret) == order.hashlock, Errors::INVALID_SECRET);

            order.is_withdrawn = true;
            self.wbtc_orders.write(wbtc_order_id, order);

            let ok = IERC20Dispatcher { contract_address: self.wBTC.read() }
                .transfer(caller, order.wbtc_amount);
            assert(ok, Errors::TRANSFER_FAILED);

            self.emit(WbtcWithdrawn { order_id: wbtc_order_id, wbtc_buyer: caller });
        }

        // ---------------------------------------------------
        // WITHDRAW STRK
        // ---------------------------------------------------
        fn withdraw_strk(ref self: ContractState, strk_order_id: u256, secret: felt252) {
            let mut order = self.strk_orders.read(strk_order_id);
            let caller = get_caller_address();

            assert(secret != 0, Errors::SECRET_CANNOT_BE_ZERO);
            assert(!order.is_withdrawn, Errors::ALREADY_WITHDRAWN);
            assert(!order.is_refunded, Errors::ALREADY_REFUNDED);
            assert(order.strk_buyer == caller, Errors::NOT_THE_BUYER);
            assert(get_block_timestamp() < order.expiry, Errors::ORDER_EXPIRED);
            assert(pedersen(0, secret) == order.hashlock, Errors::INVALID_SECRET);

            let mut wbtc_order = self.wbtc_orders.read(order.wbtc_order_id);
            wbtc_order.swap_initiated = true;
            wbtc_order.secret = secret;
            self.wbtc_orders.write(order.wbtc_order_id, wbtc_order);

            order.is_withdrawn = true;
            self.strk_orders.write(strk_order_id, order);

            let ok = IERC20Dispatcher { contract_address: self.strk.read() }
                .transfer(caller, order.strk_amount);
            assert(ok, Errors::TRANSFER_FAILED);

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

            let ok = IERC20Dispatcher { contract_address: self.wBTC.read() }
                .transfer(order.wbtc_seller, order.wbtc_amount);
            assert(ok, Errors::TRANSFER_FAILED);

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

            let ok = IERC20Dispatcher { contract_address: self.strk.read() }
                .transfer(order.strk_seller, order.strk_amount);
            assert(ok, Errors::TRANSFER_FAILED);

            self.emit(StrkRefunded { order_id: strk_order_id, strk_seller: order.strk_seller });
        }

        // ---------------------------------------------------
        // CREATE DCA ORDER
        // ---------------------------------------------------
        fn create_dca_order(
            ref self: ContractState,
            btc_destination: ByteArray,
            usdc_per_interval: u256,
            interval_hours: u64,
            total_intervals: u32,
        ) -> u256 {
            assert(total_intervals > 0, Errors::DCA_INVALID_INTERVALS);
            assert(total_intervals <= DCA_MAX_INTERVALS, Errors::DCA_TOO_MANY_INTERVALS);
            assert(interval_hours > 0, Errors::DCA_INVALID_INTERVAL_HOURS);
            assert(interval_hours <= DCA_MAX_INTERVAL_HOURS, Errors::DCA_INTERVAL_TOO_LONG);
            assert(usdc_per_interval >= MIN_USDC_PER_INTERVAL, Errors::DCA_USDC_TOO_LOW);

            let caller = get_caller_address();
            let this = get_contract_address();

            let total_usdc: u256 = usdc_per_interval * total_intervals.into();
            let usdc = IERC20Dispatcher { contract_address: self.usdc.read() };
            assert(usdc.allowance(caller, this) >= total_usdc, Errors::INSUFFICIENT_ALLOWANCE);
            let ok = usdc.transfer_from(caller, this, total_usdc);
            assert(ok, Errors::USDC_TRANSFER_FAILED);

            let total_strk_fee: u256 = KEEPER_FEE_STRK * total_intervals.into();
            let strk = IERC20Dispatcher { contract_address: self.strk.read() };
            assert(strk.allowance(caller, this) >= total_strk_fee, Errors::DCA_STRK_FEE_ALLOWANCE);
            let ok2 = strk.transfer_from(caller, this, total_strk_fee);
            assert(ok2, Errors::STRK_TRANSFER_FAILED);

            let order_id = self.dca_order_count.read() + 1;
            self.dca_order_count.write(order_id);
            self.dca_btc_destinations.write(order_id, btc_destination);

            let interval_seconds: u64 = interval_hours * 3_600;

            self
                .dca_orders
                .write(
                    order_id,
                    DCAOrder {
                        owner: caller,
                        usdc_per_interval,
                        interval_seconds,
                        last_execution: get_block_timestamp(),
                        total_intervals,
                        executed_intervals: 0,
                        is_active: true,
                    },
                );

            self.dca_strk_reserved.write(order_id, total_strk_fee);
            self.dca_interval_needs_refund.write(order_id, false);
            self.dca_pending_interval_index.write(order_id, 0);

            self
                .emit(
                    DCAOrderCreated {
                        order_id,
                        owner: caller,
                        usdc_per_interval,
                        interval_seconds,
                        total_intervals,
                        total_usdc_deposited: total_usdc,
                        total_strk_fee_deposited: total_strk_fee,
                    },
                );

            order_id
        }

        // ---------------------------------------------------
        // EXECUTE DCA
        // ---------------------------------------------------
        fn execute_dca(
            ref self: ContractState,
            order_id: u256,
            strk_amount: u256,
            payment_hash: felt252,
            expiry: u64,
            flags: u128,
            signature: Array<felt252>,
        ) {
            let mut order = self.dca_orders.read(order_id);
            let now = get_block_timestamp();
            let keeper = get_caller_address();

            assert(order.is_active, Errors::DCA_NOT_ACTIVE);
            assert(order.executed_intervals < order.total_intervals, Errors::DCA_COMPLETED);
            assert(now >= order.last_execution + order.interval_seconds, Errors::DCA_NOT_DUE);
            assert(!self.dca_interval_needs_refund.read(order_id), Errors::DCA_INTERVAL_PENDING);

            // Validate strk_amount is within 5% of the live oracle value for
            // usdc_per_interval. This prevents the keeper from committing a
            // wildly wrong STRK amount to Atomiq.
            //
            // expected = usdc_per_interval * STRK_PRECISION * 10^strk_dec
            //            / (strk_usd * USDC_PRECISION)
            let (strk_usd, strk_dec) = self.fetch_oracle_price(STRK_USD_FEED);
            let expected_strk: u256 = order.usdc_per_interval
                * STRK_PRECISION
                * self.pow10(strk_dec.into())
                / (strk_usd.into() * USDC_PRECISION);
            let lower_bound = expected_strk
                * (BPS_DENOMINATOR - STRK_TOLERANCE_BPS)
                / BPS_DENOMINATOR;
            let upper_bound = expected_strk
                * (BPS_DENOMINATOR + STRK_TOLERANCE_BPS)
                / BPS_DENOMINATOR;
            assert(
                strk_amount >= lower_bound && strk_amount <= upper_bound,
                Errors::DCA_STRK_AMOUNT_OUT_OF_RANGE,
            );

            let interval_index = order.executed_intervals + 1;
            order.last_execution = order.last_execution + order.interval_seconds;
            order.executed_intervals = interval_index;
            if order.executed_intervals == order.total_intervals {
                order.is_active = false;
            }
            self.dca_orders.write(order_id, order);

            let this = get_contract_address();
            let pending_escrow = EscrowData {
                offerer: this,
                claimer: ATOMIQ_LP.try_into().unwrap(),
                token: REAL_STRK_ADDRESS.try_into().unwrap(),
                refund_handler: ATOMIQ_REFUND_HANDLER.try_into().unwrap(),
                claim_handler: ATOMIQ_CLAIM_HANDLER.try_into().unwrap(),
                flags,
                claim_data: payment_hash,
                refund_data: expiry.into(),
                amount: strk_amount,
                fee_token: REAL_STRK_ADDRESS.try_into().unwrap(),
                security_deposit: 0,
                claimer_bounty: 0,
            };

            let escrow_key: u256 = order_id * ESCROW_KEY_MULTIPLIER + interval_index.into();
            self.dca_pending_escrows.write(escrow_key, pending_escrow);
            self.dca_pending_interval_index.write(order_id, interval_index);
            self.dca_interval_needs_refund.write(order_id, true);

            self._commit_strk_to_atomiq(strk_amount, payment_hash, expiry, flags, signature);

            if self.registered_keepers.read(keeper) {
                let reserved = self.dca_strk_reserved.read(order_id);
                self.dca_strk_reserved.write(order_id, reserved - KEEPER_FEE_STRK);
                IERC20Dispatcher { contract_address: self.strk.read() }
                    .transfer(keeper, KEEPER_FEE_STRK);
            }

            self
                .emit(
                    DCAExecuted {
                        order_id,
                        owner: order.owner,
                        usdc_spent: order.usdc_per_interval,
                        wbtc_received: 0,
                        executed_intervals: interval_index,
                        keeper,
                        keeper_fee_paid: if self.registered_keepers.read(keeper) {
                            KEEPER_FEE_STRK
                        } else {
                            0
                        },
                    },
                );
        }

        // ---------------------------------------------------
        // REFUND DCA INTERVAL
        //
        // Callable by anyone once an Atomiq escrow has settled.
        //
        // Queries IAtomiqEscrowStorage::get_state to determine the outcome:
        //
        //   state == 3 (CLAIMED):
        //     The LP claimed STRK — BTC was delivered to the user.
        //     Clear the pending flag so the next interval can execute.
        //     No rollback of executed_intervals.
        //
        //   state == 4 (REFUNDABLE):
        //     The LP failed to deliver BTC.
        //     Roll back executed_intervals and last_execution so the keeper
        //     retries this interval automatically. Then call Atomiq refund
        //     to reclaim the STRK back to this contract.
        //
        //   state == 1 (COMMITED) or 2 (SOFT_CLAIMED):
        //     Still in flight — reverts with DCA_ESCROW_NOT_SETTLED.
        // ---------------------------------------------------
        fn refund_dca_interval(ref self: ContractState, order_id: u256) {
            assert(self.dca_interval_needs_refund.read(order_id), Errors::DCA_NO_PENDING_ESCROW);

            let interval_index = self.dca_pending_interval_index.read(order_id);
            let escrow_key: u256 = order_id * ESCROW_KEY_MULTIPLIER + interval_index.into();
            let escrow = self.dca_pending_escrows.read(escrow_key);

            // Query the Atomiq escrow contract for the current state of this escrow.
            // We always initialize with success_action = None.
            let escrow_state = IAtomiqEscrowStorageDispatcher {
                contract_address: ATOMIQ_ESCROW.try_into().unwrap(),
            }
                .get_state(
                    EscrowDataFull {
                        offerer: escrow.offerer,
                        claimer: escrow.claimer,
                        token: escrow.token,
                        refund_handler: escrow.refund_handler,
                        claim_handler: escrow.claim_handler,
                        flags: escrow.flags,
                        claim_data: escrow.claim_data,
                        refund_data: escrow.refund_data,
                        amount: escrow.amount,
                        fee_token: escrow.fee_token,
                        security_deposit: escrow.security_deposit,
                        claimer_bounty: escrow.claimer_bounty,
                        success_action: Option::None,
                    },
                );

            // Escrow must be settled (claimed or refundable) before we act.
            // States 1 (COMMITED) and 2 (SOFT_CLAIMED) mean still in flight.
            assert(
                escrow_state.state == ESCROW_STATE_CLAIMED
                    || escrow_state.state == ESCROW_STATE_REFUNDABLE,
                Errors::DCA_ESCROW_NOT_SETTLED,
            );

            let zeroed_escrow = EscrowData {
                offerer: ZERO_ADDRESS,
                claimer: ZERO_ADDRESS,
                token: ZERO_ADDRESS,
                refund_handler: ZERO_ADDRESS,
                claim_handler: ZERO_ADDRESS,
                flags: 0,
                claim_data: 0,
                refund_data: 0,
                amount: 0,
                fee_token: ZERO_ADDRESS,
                security_deposit: 0,
                claimer_bounty: 0,
            };

            self.dca_interval_needs_refund.write(order_id, false);
            self.dca_pending_interval_index.write(order_id, 0);
            self.dca_pending_escrows.write(escrow_key, zeroed_escrow);

            if escrow_state.state == ESCROW_STATE_CLAIMED {
                // LP claimed — BTC was delivered. Interval stands, just unlock.
                self.emit(DCAIntervalClaimed { order_id, interval_index });
                return;
            }

            // REFUNDABLE — LP failed. Roll back interval so keeper retries.
            let strk_returned = escrow.amount;

            let mut order = self.dca_orders.read(order_id);
            order.executed_intervals -= 1;
            order.last_execution = order.last_execution - order.interval_seconds;
            if !order.is_active && order.executed_intervals < order.total_intervals {
                order.is_active = true;
            }
            self.dca_orders.write(order_id, order);

            IAtomiqEscrowDispatcher { contract_address: ATOMIQ_ESCROW.try_into().unwrap() }
                .refund(
                    EscrowDataFull {
                        offerer: escrow.offerer,
                        claimer: escrow.claimer,
                        token: escrow.token,
                        refund_handler: escrow.refund_handler,
                        claim_handler: escrow.claim_handler,
                        flags: escrow.flags,
                        claim_data: escrow.claim_data,
                        refund_data: escrow.refund_data,
                        amount: escrow.amount,
                        fee_token: escrow.fee_token,
                        security_deposit: escrow.security_deposit,
                        claimer_bounty: escrow.claimer_bounty,
                        success_action: Option::None,
                    },
                    array![],
                );

            self.emit(DCAIntervalRefunded { order_id, interval_index, strk_returned });
        }

        // ---------------------------------------------------
        // CANCEL DCA
        // ---------------------------------------------------
        fn cancel_dca(ref self: ContractState, order_id: u256) {
            let mut order = self.dca_orders.read(order_id);
            assert(order.is_active, Errors::DCA_NOT_ACTIVE);
            assert(get_caller_address() == order.owner, Errors::DCA_NOT_OWNER);
            assert(!self.dca_interval_needs_refund.read(order_id), Errors::DCA_INTERVAL_PENDING);

            let remaining: u256 = (order.total_intervals - order.executed_intervals).into();
            let usdc_refund = order.usdc_per_interval * remaining;
            let strk_refund = KEEPER_FEE_STRK * remaining;

            order.is_active = false;
            self.dca_orders.write(order_id, order);
            self.dca_strk_reserved.write(order_id, 0);

            if usdc_refund > 0 {
                let ok = IERC20Dispatcher { contract_address: self.usdc.read() }
                    .transfer(order.owner, usdc_refund);
                assert(ok, Errors::USDC_TRANSFER_FAILED);
            }

            if strk_refund > 0 {
                let ok = IERC20Dispatcher { contract_address: self.strk.read() }
                    .transfer(order.owner, strk_refund);
                assert(ok, Errors::STRK_TRANSFER_FAILED);
            }

            self
                .emit(
                    DCACancelled {
                        order_id,
                        owner: order.owner,
                        usdc_refunded: usdc_refund,
                        strk_fee_refunded: strk_refund,
                    },
                );
        }

        // ---------------------------------------------------
        // CHECKER
        //
        // Returns (can_exec, payload) where payload.strk_amount is the live
        // STRK equivalent of the order's usdc_per_interval at the current
        // Pragma oracle price.
        //
        // Derivation — BTC oracle cancels out entirely:
        //   strk = usdc_per_interval * STRK_PRECISION * 10^strk_dec
        //          / (strk_usd * USDC_PRECISION)
        //
        // strk_amount is 0 when can_exec is false — oracle call skipped to
        // avoid reverting on a stale feed when the order is not due.
        // ---------------------------------------------------
        fn checker(self: @ContractState, order_id: u256) -> (bool, ExecPayload) {
            let order = self.dca_orders.read(order_id);
            let now = get_block_timestamp();

            let pending_refund = self.dca_interval_needs_refund.read(order_id);

            let can_exec = !pending_refund
                && order.is_active
                && order.executed_intervals < order.total_intervals
                && now >= order.last_execution + order.interval_seconds
                && self.dca_strk_reserved.read(order_id) >= KEEPER_FEE_STRK;

            let strk_amount: u256 = if can_exec {
                let (strk_usd, strk_dec) = self.fetch_oracle_price(STRK_USD_FEED);
                order.usdc_per_interval
                    * STRK_PRECISION
                    * self.pow10(strk_dec.into())
                    / (strk_usd.into() * USDC_PRECISION)
            } else {
                0
            };

            let payload = ExecPayload {
                target: get_contract_address(),
                selector: "execute_dca",
                calldata: array![order_id.low.into(), order_id.high.into()],
                strk_amount,
            };

            (can_exec, payload)
        }

        // ---------------------------------------------------
        // Views
        // ---------------------------------------------------

        fn owner(self: @ContractState) -> ContractAddress {
            self.owner.read()
        }

        fn wBTC_address(self: @ContractState) -> ContractAddress {
            self.wBTC.read()
        }

        fn strk_address(self: @ContractState) -> ContractAddress {
            self.strk.read()
        }

        fn usdc_address(self: @ContractState) -> ContractAddress {
            self.usdc.read()
        }

        fn vesu_vtoken_address(self: @ContractState) -> ContractAddress {
            self.vesu_vtoken.read()
        }

        fn wBTC_denomination(self: @ContractState) -> u256 {
            BTC_DENOMINATION
        }

        fn get_wbtc_order(self: @ContractState, order_id: u256) -> WbtcOrder {
            self.wbtc_orders.read(order_id)
        }

        fn get_strk_order(self: @ContractState, order_id: u256) -> StrkOrder {
            self.strk_orders.read(order_id)
        }

        fn get_dca_order(self: @ContractState, order_id: u256) -> DCAOrder {
            self.dca_orders.read(order_id)
        }

        fn get_dca_strk_reserved(self: @ContractState, order_id: u256) -> u256 {
            self.dca_strk_reserved.read(order_id)
        }

        fn get_dca_btc_destination(self: @ContractState, order_id: u256) -> ByteArray {
            self.dca_btc_destinations.read(order_id)
        }

        fn keeper_fee_strk(self: @ContractState) -> u256 {
            KEEPER_FEE_STRK
        }

        fn get_yield_balance(self: @ContractState, nullifier_hash: u256) -> u256 {
            if !self.nullifier_earning.read(nullifier_hash) {
                return 0;
            }
            let vtoken_addr = self.vesu_vtoken.read();
            if vtoken_addr == ZERO_ADDRESS {
                return 0;
            }
            let shares = self.nullifier_shares.read(nullifier_hash);
            IVTokenDispatcher { contract_address: vtoken_addr }.convert_to_assets(shares)
        }

        fn is_earning(self: @ContractState, nullifier_hash: u256) -> bool {
            self.nullifier_earning.read(nullifier_hash)
        }

        fn get_yield_recipient(self: @ContractState, nullifier_hash: u256) -> ContractAddress {
            self.nullifier_recipient.read(nullifier_hash)
        }

        fn get_btc_usd_price(self: @ContractState) -> (u128, u32) {
            self.fetch_oracle_price(BTC_USD_FEED)
        }

        fn get_strk_usd_price(self: @ContractState) -> (u128, u32) {
            self.fetch_oracle_price(STRK_USD_FEED)
        }

        fn get_btc_strk_rate(self: @ContractState) -> u256 {
            let (btc_usd, btc_dec) = self.fetch_oracle_price(BTC_USD_FEED);
            let (strk_usd, strk_dec) = self.fetch_oracle_price(STRK_USD_FEED);
            assert(btc_usd > 0, 'invalid BTC price');
            assert(strk_usd > 0, 'invalid STRK price');
            (btc_usd.into() * self.pow10(strk_dec.into()) * STRK_PRECISION)
                / (strk_usd.into() * self.pow10(btc_dec.into()))
        }

        fn get_quoted_strk_amount(self: @ContractState) -> u256 {
            self.get_btc_strk_rate() * BTC_DENOMINATION / WBTC_PRECISION
        }

        fn preview_wbtc_for_usdc(self: @ContractState, usdc_amount: u256) -> u256 {
            self.wbtc_for_usdc(usdc_amount)
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

        fn get_dca_pending_escrow(self: @ContractState, order_id: u256) -> EscrowData {
            let interval_index = self.dca_pending_interval_index.read(order_id);
            let escrow_key: u256 = order_id * ESCROW_KEY_MULTIPLIER + interval_index.into();
            self.dca_pending_escrows.read(escrow_key)
        }

        fn dca_interval_needs_refund(self: @ContractState, order_id: u256) -> bool {
            self.dca_interval_needs_refund.read(order_id)
        }

        fn get_dca_pending_interval_index(self: @ContractState, order_id: u256) -> u32 {
            self.dca_pending_interval_index.read(order_id)
        }

        // ---------------------------------------------------
        // Admin
        // ---------------------------------------------------

        fn set_wbtc(ref self: ContractState, wbtc: ContractAddress) {
            self.assert_only_owner();
            let meta = IERC20MetadataDispatcher { contract_address: wbtc };
            assert(meta.decimals() == 8, 'mock wBTC must have 8 decimals');
            self.wBTC.write(wbtc);
        }

        fn set_vesu_vtoken(ref self: ContractState, vtoken: ContractAddress) {
            self.assert_only_owner();
            self.vesu_vtoken.write(vtoken);
        }

        fn set_usdc(ref self: ContractState, usdc: ContractAddress) {
            self.assert_only_owner();
            let meta = IERC20MetadataDispatcher { contract_address: usdc };
            assert(meta.decimals() == 6, 'USDC must have 6 decimals');
            self.usdc.write(usdc);
        }

        fn add_keeper(ref self: ContractState, keeper: ContractAddress) {
            self.assert_only_owner();
            self.registered_keepers.write(keeper, true);
        }

        fn remove_keeper(ref self: ContractState, keeper: ContractAddress) {
            self.assert_only_owner();
            self.registered_keepers.write(keeper, false);
        }

        fn transfer_ownership(ref self: ContractState, new_owner: ContractAddress) {
            self.assert_only_owner();
            assert(new_owner != ZERO_ADDRESS, Errors::ZERO_ADDRESS);
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

        fn _commit_strk_to_atomiq(
            ref self: ContractState,
            amount: u256,
            payment_hash: felt252,
            expiry: u64,
            flags: u128,
            signature: Array<felt252>,
        ) {
            let this = get_contract_address();
            let strk = IERC20Dispatcher { contract_address: REAL_STRK_ADDRESS.try_into().unwrap() };

            strk.approve(ATOMIQ_ESCROW.try_into().unwrap(), amount);

            IAtomiqEscrowDispatcher { contract_address: ATOMIQ_ESCROW.try_into().unwrap() }
                .initialize(
                    EscrowDataFull {
                        offerer: this,
                        claimer: ATOMIQ_LP.try_into().unwrap(),
                        token: REAL_STRK_ADDRESS.try_into().unwrap(),
                        refund_handler: ATOMIQ_REFUND_HANDLER.try_into().unwrap(),
                        claim_handler: ATOMIQ_CLAIM_HANDLER.try_into().unwrap(),
                        flags,
                        claim_data: payment_hash,
                        refund_data: expiry.into(),
                        amount,
                        fee_token: REAL_STRK_ADDRESS.try_into().unwrap(),
                        security_deposit: 0,
                        claimer_bounty: 0,
                        success_action: Option::None,
                    },
                    signature,
                    expiry,
                    array![].span(),
                );
        }

        fn verify_proof_and_consume(
            ref self: ContractState, proof: Span<felt252>, recipient: ContractAddress,
        ) -> u256 {
            let verifier = IVerifierDispatcher { contract_address: self.verifier.read() };
            let result = verifier.verify_ultra_keccak_zk_honk_proof(proof);
            assert(result.is_ok(), Errors::INVALID_PROOF);

            let out = result.unwrap();
            let root: u256 = *out.at(0);
            let nullifier_hash: u256 = *out.at(1);
            let recipient_hash: u256 = *out.at(2);

            let computed = Poseidon2Trait::hash_1(FieldTrait::from_address(recipient));
            assert(computed.inner() == recipient_hash, Errors::NOT_INTENDED_RECIPIENT);

            assert(self.imt.is_known_root(root), Errors::UNKNOWN_ROOT);
            assert(!self.nullifier_hashes.read(nullifier_hash), Errors::NULLIFIER_USED);
            self.nullifier_hashes.write(nullifier_hash, true);

            nullifier_hash
        }

        fn redeem_vesu_position(ref self: ContractState, nullifier_hash: u256) -> u256 {
            let vtoken_addr = self.vesu_vtoken.read();
            let shares = self.nullifier_shares.read(nullifier_hash);
            let this = get_contract_address();

            self.nullifier_earning.write(nullifier_hash, false);
            self.nullifier_shares.write(nullifier_hash, 0);

            let wbtc_returned = IVTokenDispatcher { contract_address: vtoken_addr }
                .redeem(shares, this, this);

            self.emit(YieldRedeemed { nullifier_hash, shares, wbtc_returned });
            wbtc_returned
        }

        fn fetch_oracle_price(self: @ContractState, feed_address: felt252) -> (u128, u32) {
            let feed = IAggregatorProxyDispatcher {
                contract_address: feed_address.try_into().unwrap(),
            };
            let round = feed.latest_round_data();
            assert(
                round.updated_at + MAX_ORACLE_AGE_SECS >= get_block_timestamp(),
                'stale oracle price',
            );
            assert(round.answer > 0, 'invalid oracle price');
            (round.answer, feed.decimals().into())
        }

        fn wbtc_for_usdc(self: @ContractState, usdc_amount: u256) -> u256 {
            let (btc_usd, btc_dec) = self.fetch_oracle_price(BTC_USD_FEED);
            usdc_amount
                * WBTC_PRECISION
                * self.pow10(btc_dec.into())
                / (btc_usd.into() * USDC_PRECISION)
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
