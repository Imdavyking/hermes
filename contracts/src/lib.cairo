use starknet::{ContractAddress, get_block_timestamp, get_caller_address, get_contract_address};
mod field;
mod incremental_merkle_tree;
use crate::poseidon2lib::Poseidon2Trait;
use crate::field::FieldTrait;
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

// ERC-4626 vToken interface (Vesu lending protocol)
//
// Vesu is a non-custodial lending protocol on Starknet.
// When wBTC is deposited, Vesu mints yield-bearing vToken shares.
// These shares appreciate over time as borrowers pay interest.
//
// deposit(assets, receiver) → mints shares to receiver, returns share count
// redeem(shares, receiver, owner) → burns shares, returns underlying wBTC + yield to receiver
// convert_to_assets(shares) → read-only preview of current wBTC value of shares
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

// Represents a pending wBTC → STRK swap posted by Alice (the wBTC seller).
//
// Flow:
//   1. Alice calls post_wbtc_order() with a hashlock = pedersen(0, secret).
//      Her wBTC is already locked in this contract from her earlier deposit.
//   2. Bob calls fill_wbtc_order(), locking STRK into this contract.
//   3. Alice calls withdraw_strk() revealing her secret, claiming STRK.
//      The secret is stored on-chain so Bob can use it next.
//   4. Bob calls withdraw_wbtc() using the now-revealed secret, claiming wBTC.
//
// If either party does not act before expiry, refund functions are available.
// swap_initiated is set to true when Alice reveals her secret, extending
// Bob's withdrawal window even if his expiry has technically passed.
#[derive(Drop, Serde, Copy, starknet::Store)]
struct WbtcOrder {
    wbtc_seller: ContractAddress,      // Alice — posted the order
    wbtc_buyer: ContractAddress,       // Bob — filled the order (zero until filled)
    alice_strk_destination: ContractAddress, // where STRK is sent when Alice withdraws
    hashlock: felt252,                 // pedersen(0, secret) — commitment to the swap secret
    wbtc_amount: u256,                 // always BTC_DENOMINATION
    quoted_strk_amount: u256,          // STRK amount quoted at order creation time
    slippage_tolerance_bps: u256,      // max price movement Alice accepts (in basis points)
    expiry: u64,                       // Alice's order expiry timestamp
    rate_expiry: u64,                  // timestamp after which the quoted rate is considered stale
    is_filled: bool,                   // true once Bob has locked STRK
    is_withdrawn: bool,                // true once Bob has claimed wBTC
    is_refunded: bool,                 // true once Alice has reclaimed her wBTC
    swap_initiated: bool,              // true once Alice reveals secret — protects Bob's claim window
    secret: felt252,                   // revealed by Alice in withdraw_strk; used by Bob in withdraw_wbtc
}

// Represents Bob's locked STRK position, created when Bob fills a wBTC order.
//
// Bob locks STRK with the same hashlock as Alice's wBTC order.
// Alice claims STRK by revealing the secret (withdraw_strk).
// If Alice never reveals, Bob can reclaim STRK after his expiry (refund_strk).
#[derive(Drop, Serde, Copy, starknet::Store)]
struct StrkOrder {
    strk_seller: ContractAddress,  // Bob — locked the STRK
    strk_buyer: ContractAddress,   // Alice's strk destination — receives the STRK
    hashlock: felt252,             // same hashlock as the parent WbtcOrder
    strk_amount: u256,             // STRK locked by Bob (at live rate, not quoted rate)
    expiry: u64,                   // Bob's expiry — must be < Alice's expiry
    is_withdrawn: bool,            // true once Alice has claimed STRK
    is_refunded: bool,             // true once Bob has reclaimed STRK
    wbtc_order_id: u256,           // links back to the parent WbtcOrder
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

    // Fixed deposit size enforces a uniform anonymity set.
    // All deposits look identical on-chain — no amount leaks which note belongs to whom.
    // Value: 1000 satoshis (0.00001 BTC) — small enough for testnet experimentation.
    const BTC_DENOMINATION: u256 = 1_000;

    // wBTC uses 8 decimal places (like Bitcoin itself). 1 BTC = 100_000_000 satoshis.
    // Used when converting between wBTC amounts and oracle prices (which are in USD).
    const WBTC_PRECISION: u256 = 100_000_000;

    // STRK uses 18 decimal places (standard ERC-20).
    // Used in the BTC/STRK rate calculation to preserve precision.
    const STRK_PRECISION: u256 = 1_000_000_000_000_000_000;

    // Depth of the incremental Merkle tree. Supports up to 2^10 = 1024 deposits.
    const TREE_DEPTH: u32 = 10;

    // Pragma oracle feed addresses on Starknet Sepolia.
    // These return (price, decimals) for USD-denominated pairs.
    const BTC_USD_FEED: felt252 = 0x0258b8f498b767c200577227e3e9f009c9b0fe7f6a3c8c2c24efd588c54747a;
    const STRK_USD_FEED: felt252 =
        0x0a5db422ee7c28beead49303646e44ef9cbb8364eeba4d8af9ac06a3b556937;

    // Maximum age of an oracle price before it is considered stale.
    // Set to 7 days for testnet — Sepolia oracles update infrequently.
    // On mainnet, tighten this to 1 hour (3600) or less.
    const MAX_ORACLE_AGE_SECS: u64 = 604800; // 7 days (testnet only)

    // Minimum time between now and an order's expiry when it is posted or filled.
    // Prevents orders that expire immediately and cannot be acted on.
    const MIN_EXPIRY_DURATION_SECS: u64 = 3600; // 1 hour

    // How long a quoted STRK rate stays valid after an order is posted.
    // Bob must fill the order within this window or the quoted rate is considered stale.
    // This protects Alice from accepting a fill at a price that has drifted too far.
    const RATE_VALID_FOR_SECS: u64 = 3600; // 1 hour

    // Slippage tolerance bounds in basis points (1 bps = 0.01%).
    // Alice specifies her tolerance when posting an order.
    // The live rate at fill time must not have moved more than this from the quoted rate.
    // MIN = 0.1% (protects against absurdly tight settings), MAX = 10%.
    const MIN_SLIPPAGE_BPS: u256 = 10;   // 0.1%
    const MAX_SLIPPAGE_BPS: u256 = 1000; // 10%
    const BPS_DENOMINATOR: u256 = 10000;

    // Minimum STRK amount required in a swap order.
    // Prevents dust orders that waste gas and pollute the order book.
    const MIN_STRK_AMOUNT: u256 = 1_000_000_000_000_000_000; // 1 STRK

    // Vesu wBTC on Starknet Sepolia — publicly mintable for testnet use.
    // IMPORTANT: Replace with the real wBTC address before mainnet deployment.
    const VESU_WBTC_ADDRESS: felt252 =
        0x063d32a3fa6074e72e7a1e06fe78c46a0c8473217773e19f11d8c8cbfc4ff8ca;

    // Vesu wBTC vToken (ERC-4626) on Starknet Sepolia.
    // Depositing wBTC here mints yield-bearing shares. Redeeming burns shares and returns wBTC + yield.
    // Set vesu_vtoken storage to zero address to disable yield and keep wBTC idle in this contract.
    const VESU_VTOKEN_ADDRESS: felt252 =
        0x05868ed6b7c57ac071bf6bfe762174a2522858b700ba9fb062709e63b65bf186;

    // Real STRK token address — same on both Sepolia and mainnet.
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
        // Incremental Merkle tree — stores deposit commitments.
        // Each leaf is a commitment = Poseidon2(nullifier, secret).
        // The tree root is used in ZK proofs to prove membership without
        // revealing which specific leaf (deposit) belongs to the prover.
        #[substorage(v0)]
        imt: IncrementalMerkleTreeComponent::Storage,

        // Tracks commitments that have been deposited.
        // Prevents the same commitment from being inserted into the tree twice.
        commitments: Map<u256, bool>,

        // Tracks nullifier hashes that have been spent.
        // A nullifier hash is Poseidon2(nullifier). When a ZK proof is used
        // (withdraw, start_earning, post_wbtc_order), the nullifier is marked spent here.
        // This is the primary double-spend prevention mechanism — a note can only
        // be used once across all three ZK-gated functions.
        nullifier_hashes: Map<u256, bool>,

        wbtc_orders: Map<u256, WbtcOrder>,
        strk_orders: Map<u256, StrkOrder>,
        wBTC: ContractAddress,
        strk: ContractAddress,
        verifier: ContractAddress,
        owner: ContractAddress,

        // Vesu vToken address (ERC-4626). When non-zero, yield earning is enabled.
        // Zero address = Vesu disabled (wBTC sits idle in this contract).
        // Can be updated by owner via set_vesu_vtoken().
        vesu_vtoken: ContractAddress,

        // Per-nullifier yield tracking.
        //
        // nullifier_earning[nh] = true  → this nullifier's wBTC is currently inside Vesu.
        // nullifier_shares[nh]  = N     → N vToken shares held on behalf of this nullifier.
        //                                  Shares are redeemed for wBTC + yield in stop_earning.
        // nullifier_recipient[nh] = addr → the address locked in at start_earning time.
        //                                   Only this address can call stop_earning.
        //                                   Cannot be changed after start_earning is called.
        //
        // IMPORTANT: The nullifier IS marked spent in nullifier_hashes when start_earning
        // is called. This means the original ZK proof is consumed and cannot be reused.
        // stop_earning() is the sole withdrawal path for an earning position — no proof needed,
        // only the committed recipient address can call it.
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
        // Amount is always BTC_DENOMINATION for direct withdrawals.
        // Yield-bearing positions use YieldStopped instead.
        amount: u256,
    }

    #[derive(Drop, starknet::Event)]
    struct YieldStarted {
        #[key]
        nullifier_hash: u256,
        recipient: ContractAddress,
        // vToken shares received from Vesu for BTC_DENOMINATION wBTC.
        // Share value increases over time as lending interest accrues.
        shares: u256,
    }

    #[derive(Drop, starknet::Event)]
    struct YieldStopped {
        #[key]
        nullifier_hash: u256,
        recipient: ContractAddress,
        // wBTC returned to recipient — principal + all accrued yield.
        // Will be >= BTC_DENOMINATION if any interest was earned.
        amount: u256,
    }

    // Emitted internally when Vesu shares are redeemed back to wBTC.
    // Allows off-chain tracking of yield earned per nullifier.
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
        // IMPORTANT: Switch to real wBTC address for mainnet deployment.
        self.wBTC.write(VESU_WBTC_ADDRESS.try_into().unwrap());
        self.strk.write(REAL_STRK_ADDRESS.try_into().unwrap());

        // Configure Vesu vToken for yield earning.
        // Set to zero address to disable yield (idle pool mode).
        self.vesu_vtoken.write(VESU_VTOKEN_ADDRESS.try_into().unwrap());

        // Deploy the ZK verifier as a separate contract using the provided class hash.
        // The verifier is responsible for validating UltraHonk ZK proofs on-chain.
        // Separating it allows the verifier to be upgraded independently if needed.
        let verifier_calldata: Array<felt252> = array![];
        let (verifier_address, _) = deploy_syscall(
            verifier_class_hash, 0, verifier_calldata.span(), false,
        )
            .unwrap_syscall();
        self.verifier.write(verifier_address);

        self.imt.initializer(TREE_DEPTH);

        // Set the deploying account as the initial owner.
        // Owner can update wBTC address, Vesu vToken, and transfer ownership.
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
        //
        // Alice locks BTC_DENOMINATION wBTC and inserts a commitment into the Merkle tree.
        // The commitment = Poseidon2(nullifier, secret), computed off-chain by Alice.
        // The nullifier and secret are known only to Alice and stored in her note file.
        //
        // After depositing, Alice can:
        //   a) zk_withdraw_wbtc()  — privately withdraw wBTC to any address
        //   b) post_wbtc_order()   — privately swap wBTC for STRK via HTLC
        //   c) start_earning()     — earn Vesu yield on her deposit
        //
        // SECURITY: The commitment uniqueness check prevents Alice from inserting
        // the same commitment twice, which would allow double-spending the same note.
        // ---------------------------------------------------
        fn deposit(ref self: ContractState, commitment: u256) {
            // Prevent the same commitment from being deposited twice.
            // Two identical commitments would allow one note to be withdrawn twice.
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
        //
        // Alice opts her deposit into Vesu yield earning using a ZK proof.
        // The proof proves she owns an unspent deposit without revealing which one.
        //
        // SECURITY MODEL:
        //
        // 1. ANTI-FRONTRUNNING: The recipient address is cryptographically bound to the proof
        //    via recipient_hash = Poseidon2(recipient), which is a public input in the ZK circuit.
        //    An attacker copying the proof from the mempool cannot substitute their own address —
        //    changing recipient changes the hash, invalidating the proof.
        //
        // 2. DOUBLE-SPEND PREVENTION: The nullifier is marked spent immediately, before any
        //    external calls. This prevents the same proof from being used in zk_withdraw_wbtc
        //    or post_wbtc_order after this function succeeds.
        //
        // 3. PERMANENT RECIPIENT LOCK: The recipient address is written to storage and cannot
        //    be changed. Only stop_earning() called by this exact address can withdraw.
        //    This means even if Alice loses her note file, her wBTC is still recoverable
        //    as long as she has access to the recipient wallet.
        //
        // 4. ZERO ADDRESS GUARD: A zero recipient would lock funds permanently with no
        //    recovery path, since stop_earning requires caller == recipient.
        //
        // After this call the note is fully consumed. The ONLY exit is stop_earning(nullifier_hash).
        // ---------------------------------------------------
        fn start_earning(
            ref self: ContractState, proof: Span<felt252>, recipient: ContractAddress,
        ) {
            // A zero recipient would lock funds with no recovery — reject early.
            assert(recipient != contract_address_const::<0>(), Errors::INVALID_RECIPIENT);

            let verifier = IVerifierDispatcher { contract_address: self.verifier.read() };
            let verified = verifier.verify_ultra_keccak_zk_honk_proof(proof);
            assert(verified.is_ok(), Errors::INVALID_PROOF);

            // Public inputs returned by the verifier in order:
            //   [0] root          — must match a known Merkle root
            //   [1] nullifier_hash — Poseidon2(nullifier), used for double-spend prevention
            //   [2] recipient_hash — Poseidon2(recipient), binds the proof to the intended recipient
            let result = verified.unwrap();
            let root = *result.at(0);
            let nullifier_hash = *result.at(1);
            let recipient_hash = *result.at(2);

            // Verify the recipient passed as a function argument matches the one committed
            // inside the ZK proof. This prevents frontrunning: an attacker who copies the
            // proof cannot change the recipient because doing so changes the hash,
            // causing this assertion to fail.
            let computed_recipient_hash = Poseidon2Trait::hash_1(
                FieldTrait::from_address(recipient),
            );
            assert(
                computed_recipient_hash.inner() == recipient_hash, Errors::NOT_INTENDED_RECIPIENT,
            );

            // The root must be one that existed when Alice generated her proof.
            // The IMT retains a history of recent roots to handle the case where
            // new deposits are made between proof generation and submission.
            assert(self.imt.is_known_root(root), Errors::UNKNOWN_ROOT);

            // Nullifier must not already be spent.
            // A spent nullifier means this note was already used in one of:
            // zk_withdraw_wbtc, start_earning, or post_wbtc_order.
            assert(!self.nullifier_hashes.read(nullifier_hash), Errors::NULLIFIER_USED);

            // Belt-and-suspenders: also check earning state directly,
            // in case storage gets into an unexpected state.
            assert(!self.nullifier_earning.read(nullifier_hash), Errors::ALREADY_EARNING);

            // Mark nullifier spent BEFORE any external calls (CEI pattern).
            // This prevents reentrancy: if Vesu or the ERC-20 were to call back into
            // this contract, the nullifier is already spent and cannot be reused.
            self.nullifier_hashes.write(nullifier_hash, true);

            let vtoken_addr = self.vesu_vtoken.read();
            assert(vtoken_addr != contract_address_const::<0>(), Errors::VESU_NOT_CONFIGURED);

            let wbtc_addr = self.wBTC.read();
            let this = get_contract_address();

            // Approve exactly BTC_DENOMINATION — no excess allowance left after deposit.
            let wbtc = IERC20Dispatcher { contract_address: wbtc_addr };
            wbtc.approve(vtoken_addr, BTC_DENOMINATION);

            // Deposit wBTC into Vesu. Shares represent Alice's proportional claim on the
            // lending pool. Their value increases as borrowers pay interest.
            let vtoken = IVTokenDispatcher { contract_address: vtoken_addr };
            let shares = vtoken.deposit(BTC_DENOMINATION, this);

            // Zero shares would mean the deposit silently failed — reject it.
            assert(shares > 0, Errors::VESU_DEPOSIT_FAILED);

            // Record the earning position and permanently lock the recipient.
            self.nullifier_earning.write(nullifier_hash, true);
            self.nullifier_shares.write(nullifier_hash, shares);
            self.nullifier_recipient.write(nullifier_hash, recipient);

            self.emit(YieldStarted { nullifier_hash, recipient, shares });
        }

        // ---------------------------------------------------
        // STOP EARNING
        //
        // Redeems the Vesu position and sends wBTC + accrued yield to the recipient.
        // No ZK proof required — the recipient address committed during start_earning
        // is the sole credential.
        //
        // SECURITY MODEL:
        //
        // 1. CALLER CHECK: Only the exact recipient committed at start_earning time can
        //    call this. The recipient is locked in storage and cannot be changed.
        //
        // 2. CEI PATTERN: The earning position is cleared (via redeem_vesu_position)
        //    before the wBTC transfer. This prevents reentrancy — if the wBTC transfer
        //    somehow called back into stop_earning, nullifier_earning would be false
        //    and the second call would revert with NOT_EARNING.
        //
        // 3. RECIPIENT CLEARED: After redemption, nullifier_recipient is set to zero.
        //    This is a cleanup step — the primary guard is nullifier_earning being false.
        // ---------------------------------------------------
        fn stop_earning(ref self: ContractState, nullifier_hash: u256) {
            let recipient = self.nullifier_recipient.read(nullifier_hash);

            // A zero recipient means start_earning was never called for this nullifier.
            assert(recipient != contract_address_const::<0>(), Errors::NOT_EARNING);

            // Only the committed recipient can trigger redemption.
            // This prevents anyone else from forcing an early exit on Alice's behalf.
            assert(get_caller_address() == recipient, Errors::NOT_RECIPIENT);

            // Must still be in the earning state.
            // This also protects against reentrancy — redeem_vesu_position sets this to false.
            assert(self.nullifier_earning.read(nullifier_hash), Errors::NOT_EARNING);

            // Redeem Vesu shares → wBTC + yield lands in this contract.
            // This also clears nullifier_earning and nullifier_shares (CEI pattern).
            let amount = self.redeem_vesu_position(nullifier_hash);

            // Clear the recipient slot as a cleanup step.
            self.nullifier_recipient.write(nullifier_hash, contract_address_const::<0>());

            let wbtc = IERC20Dispatcher { contract_address: self.wBTC.read() };
            let success = wbtc.transfer(recipient, amount);
            assert(success, Errors::TRANSFER_FAILED);

            self.emit(YieldStopped { nullifier_hash, recipient, amount });
        }

        // ---------------------------------------------------
        // ZK WITHDRAW wBTC
        //
        // Alice proves she owns an unspent deposit and withdraws directly to any address.
        //
        // SECURITY MODEL:
        //
        // 1. ANTI-FRONTRUNNING: The recipient is bound to the ZK proof via
        //    recipient_hash = Poseidon2(recipient) as a public input in the circuit.
        //    An attacker who copies this transaction from the mempool cannot change
        //    the recipient — doing so changes recipient_hash, which invalidates the proof.
        //    The proof is only valid for the exact recipient Alice committed to.
        //
        // 2. DOUBLE-SPEND PREVENTION: The nullifier is marked spent before the transfer.
        //    If this note was already used (in this function, start_earning, or post_wbtc_order),
        //    the nullifier_hash check will catch it and revert.
        //
        // 3. MERKLE ROOT HISTORY: The root check accepts any recent root, not just the
        //    current one. This allows Alice's proof to remain valid even if new deposits
        //    were made between when she generated her proof and when she submits it.
        //
        // 4. CEI PATTERN: The nullifier is marked spent before the ERC-20 transfer.
        //    This prevents any reentrancy attack via the wBTC token contract.
        // ---------------------------------------------------
        fn zk_withdraw_wbtc(
            ref self: ContractState, proof: Span<felt252>, recipient: ContractAddress,
        ) {
            let verifier = IVerifierDispatcher { contract_address: self.verifier.read() };
            let verified = verifier.verify_ultra_keccak_zk_honk_proof(proof);
            assert(verified.is_ok(), Errors::INVALID_PROOF);

            // Public inputs returned by the verifier in order:
            //   [0] root          — must match a known Merkle root
            //   [1] nullifier_hash — Poseidon2(nullifier), used for double-spend prevention
            //   [2] recipient_hash — Poseidon2(recipient), binds the proof to the intended recipient
            let result = verified.unwrap();
            let root = *result.at(0);
            let nullifier_hash = *result.at(1);
            let recipient_hash = *result.at(2);

            // Verify the recipient argument matches the one committed in the ZK proof.
            // Poseidon2 is a ZK-friendly hash — both the circuit and this contract
            // use the same implementation, so the hashes are directly comparable.
            // A ContractAddress fits in a single felt252, so no splitting is needed.
            let computed_recipient_hash = Poseidon2Trait::hash_1(
                FieldTrait::from_address(recipient),
            );
            assert(computed_recipient_hash.inner() == recipient_hash, Errors::NOT_INTENDED_RECIPIENT);

            assert(self.imt.is_known_root(root), Errors::UNKNOWN_ROOT);

            // Check and mark nullifier spent BEFORE the transfer (CEI pattern).
            assert(!self.nullifier_hashes.read(nullifier_hash), Errors::NULLIFIER_USED);
            self.nullifier_hashes.write(nullifier_hash, true);

            // Direct withdrawals always receive exactly BTC_DENOMINATION.
            // Yield-bearing positions exit via stop_earning instead, which returns
            // principal + accrued interest.
            let amount = BTC_DENOMINATION;

            let wbtc = IERC20Dispatcher { contract_address: self.wBTC.read() };
            let success = wbtc.transfer(recipient, amount);
            assert(success, Errors::TRANSFER_FAILED);

            self.emit(Withdrawal { recipient, nullifier_hash, amount });
        }

        // ---------------------------------------------------
        // POST WBTC ORDER
        //
        // Alice uses her ZK proof to post a wBTC → STRK swap order (HTLC).
        // Her wBTC remains locked in this contract until Bob fills the order
        // and the HTLC is completed, or until Alice refunds after expiry.
        //
        // The same ZK security properties as zk_withdraw_wbtc apply here.
        // The recipient binding uses alice_strk_destination instead of a withdrawal address —
        // this is where Alice will receive STRK when she reveals her secret.
        //
        // SECURITY: hashlock must not be pedersen(0, 0) — this would mean Alice's
        // secret is 0, which is publicly known. Bob could call withdraw_strk(secret=0)
        // immediately after filling, claiming STRK without Alice ever revealing anything,
        // breaking the atomicity of the HTLC.
        // ---------------------------------------------------
        fn post_wbtc_order(
            ref self: ContractState,
            proof: Span<felt252>,
            alice_strk_destination: ContractAddress,
            hashlock: felt252,
            expiry: u64,
            slippage_tolerance_bps: u256,
        ) {
            // Reject trivially broken hashlocks before paying proof verification gas.
            // pedersen(0, 0) is the hashlock you'd get if secret == 0.
            assert(hashlock != pedersen(0, 0), Errors::SECRET_CANNOT_BE_ZERO);

            let verifier = IVerifierDispatcher { contract_address: self.verifier.read() };
            let verified = verifier.verify_ultra_keccak_zk_honk_proof(proof);
            assert(verified.is_ok(), Errors::INVALID_PROOF);

            let result = verified.unwrap();
            let root = *result.at(0);
            let nullifier_hash = *result.at(1);
            let recipient_hash = *result.at(2);

            // The ZK proof binds alice_strk_destination as the STRK recipient.
            // This prevents an attacker from substituting a different destination address
            // while replaying Alice's proof from the mempool.
            let computed_recipient_hash = Poseidon2Trait::hash_1(
                FieldTrait::from_address(alice_strk_destination),
            );
            assert(computed_recipient_hash.inner() == recipient_hash, Errors::NOT_INTENDED_RECIPIENT);

            assert(self.imt.is_known_root(root), Errors::UNKNOWN_ROOT);

            // Mark nullifier spent BEFORE writing order state (CEI pattern).
            assert(!self.nullifier_hashes.read(nullifier_hash), Errors::NULLIFIER_USED);
            self.nullifier_hashes.write(nullifier_hash, true);

            let now = get_block_timestamp();

            // Expiry must be far enough in the future that Bob has time to fill and act.
            assert(expiry >= now + MIN_EXPIRY_DURATION_SECS, Errors::EXPIRY_TOO_SOON);

            // Slippage tolerance must be in range [MIN_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS].
            // Too tight a tolerance would cause fills to fail on minor price movements.
            assert(
                slippage_tolerance_bps >= MIN_SLIPPAGE_BPS
                    && slippage_tolerance_bps <= MAX_SLIPPAGE_BPS,
                Errors::SLIPPAGE_OUT_OF_RANGE,
            );

            // Snapshot the current BTC/STRK rate. Bob must fill at a rate within
            // slippage_tolerance_bps of this value, and only within RATE_VALID_FOR_SECS.
            let quoted_strk_amount = self.get_btc_strk_rate() * BTC_DENOMINATION / WBTC_PRECISION;
            assert(quoted_strk_amount >= MIN_STRK_AMOUNT, Errors::STRK_AMOUNT_TOO_LOW);

            // The nullifier_hash doubles as the order ID. This is safe because nullifiers
            // are unique per note, so order IDs are globally unique with no extra storage.
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
        //
        // Bob locks STRK into this contract against Alice's pending wBTC order.
        // This creates a Hashed Time-Lock Contract (HTLC) pair:
        //   - Alice's wBTC is locked here (deposited earlier)
        //   - Bob's STRK is now locked here (deposited in this call)
        //
        // Both sides share the same hashlock. Atomicity is guaranteed:
        // Alice can only claim Bob's STRK by revealing the secret,
        // and revealing the secret lets Bob claim Alice's wBTC.
        //
        // SECURITY:
        // - Bob's expiry must be strictly less than Alice's expiry, ensuring Alice
        //   has time to refund her wBTC after Bob's STRK refund window opens.
        // - The live rate is checked against the quoted rate + slippage tolerance
        //   to protect Alice from price manipulation between quote and fill.
        // - The strk_order_id is derived from the hashlock so it is deterministic
        //   and Bob cannot create duplicate STRK orders for the same wBTC order.
        // ---------------------------------------------------
        fn fill_wbtc_order(ref self: ContractState, wbtc_order_id: u256, bob_expiry: u64) {
            let mut order = self.wbtc_orders.read(wbtc_order_id);
            let now = get_block_timestamp();

            assert(!order.is_filled, Errors::ORDER_ALREADY_FILLED);
            assert(!order.is_refunded, Errors::ALREADY_REFUNDED);
            assert(!order.is_withdrawn, Errors::ALREADY_WITHDRAWN);

            // wbtc_amount == 0 means this order_id was never posted.
            assert(order.wbtc_amount > 0, Errors::NOT_A_WBTC_ORDER);

            assert(now < order.expiry, Errors::ORDER_EXPIRED);

            // The quoted rate must still be fresh. Alice's slippage tolerance is relative
            // to the rate snapshotted at post_wbtc_order time.
            assert(now <= order.rate_expiry, Errors::QUOTED_RATE_EXPIRED);

            // Bob's expiry must be before Alice's. This ensures Alice's refund window
            // opens only after Bob can no longer claim his STRK refund.
            assert(bob_expiry < order.expiry, Errors::BOB_EXPIRY_TOO_LONG);
            assert(bob_expiry >= now + MIN_EXPIRY_DURATION_SECS, Errors::EXPIRY_TOO_SOON);

            // Use the live rate at fill time — Bob pays what BTC is worth right now.
            let live_strk_amount = self.get_btc_strk_rate() * order.wbtc_amount / WBTC_PRECISION;
            assert(live_strk_amount >= MIN_STRK_AMOUNT, Errors::STRK_AMOUNT_TOO_LOW);

            // Enforce Alice's slippage tolerance.
            // If the price has moved adversely beyond Alice's tolerance, reject the fill.
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

            // Derive a deterministic STRK order ID from the hashlock.
            // Using the hashlock ensures the ID is unique to this specific swap
            // and cannot be forged or collided with other orders.
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
        // WITHDRAW wBTC (Bob's side of the HTLC)
        //
        // Bob calls this after Alice reveals her secret via withdraw_strk.
        // The secret is stored on-chain by withdraw_strk, so Bob does not
        // need to pass it as a parameter — he just needs to be the registered buyer.
        //
        // SECURITY:
        // - swap_initiated acts as an emergency override: if Bob's expiry has passed
        //   but Alice already revealed her secret (swap_initiated = true), Bob can
        //   still claim his wBTC. This prevents Alice from racing Bob's expiry to
        //   reclaim wBTC after already receiving STRK.
        // ---------------------------------------------------
        fn withdraw_wbtc(ref self: ContractState, wbtc_order_id: u256) {
            let mut order = self.wbtc_orders.read(wbtc_order_id);
            let caller = get_caller_address();

            assert(!order.is_withdrawn, Errors::ALREADY_WITHDRAWN);
            assert(!order.is_refunded, Errors::ALREADY_REFUNDED);

            // Only Bob (the registered buyer) can claim the wBTC.
            assert(order.wbtc_buyer == caller, Errors::NOT_THE_BUYER);

            // The secret must have been revealed on-chain by Alice calling withdraw_strk.
            // This is what makes the HTLC atomic: Alice can only get STRK by revealing
            // the secret, and revealing it automatically enables Bob's wBTC claim.
            assert(order.secret != 0, Errors::SECRET_UNKNOWN);

            // Allow claim if either: not yet expired, or Alice already initiated the swap.
            // swap_initiated protects Bob if Alice deliberately waits until near Bob's expiry
            // to reveal her secret, hoping Bob misses his window.
            assert(
                get_block_timestamp() < order.expiry || order.swap_initiated, Errors::ORDER_EXPIRED,
            );

            // Verify the revealed secret matches the original hashlock — final sanity check.
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
        // WITHDRAW STRK (Alice's side of the HTLC)
        //
        // Alice reveals her secret to claim Bob's locked STRK.
        // Revealing the secret on-chain simultaneously enables Bob to claim his wBTC.
        //
        // SECURITY:
        // - The secret is stored in the wBTC order so Bob can retrieve it and call
        //   withdraw_wbtc. swap_initiated is also set to true, protecting Bob's
        //   claim window even if his expiry is near.
        // - Only alice_strk_destination (set at order creation) can receive the STRK.
        //   This is enforced by strk_buyer == caller check.
        // ---------------------------------------------------
        fn withdraw_strk(ref self: ContractState, strk_order_id: u256, secret: felt252) {
            let mut order = self.strk_orders.read(strk_order_id);
            let caller = get_caller_address();

            assert(secret != 0, Errors::SECRET_CANNOT_BE_ZERO);
            assert(!order.is_withdrawn, Errors::ALREADY_WITHDRAWN);
            assert(!order.is_refunded, Errors::ALREADY_REFUNDED);

            // Only Alice's designated STRK destination can claim.
            assert(order.strk_buyer == caller, Errors::NOT_THE_BUYER);
            assert(get_block_timestamp() < order.expiry, Errors::ORDER_EXPIRED);

            let hash = pedersen(0, secret);
            assert(hash == order.hashlock, Errors::INVALID_SECRET);

            // Store the revealed secret in the parent wBTC order and set swap_initiated.
            // This atomically enables Bob to call withdraw_wbtc without knowing the secret
            // in advance — he just reads it from chain after Alice's tx is confirmed.
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
        //
        // Alice reclaims her wBTC if Bob never filled the order, or if the swap
        // was never completed after the expiry.
        //
        // SECURITY: swap_initiated must be false — if Alice already revealed her
        // secret (claimed STRK), she cannot also refund her wBTC. This enforces
        // the atomicity guarantee from Alice's side.
        // ---------------------------------------------------
        fn refund_wbtc(ref self: ContractState, wbtc_order_id: u256) {
            let mut order = self.wbtc_orders.read(wbtc_order_id);
            assert(order.wbtc_amount > 0, Errors::NOT_A_WBTC_ORDER);
            assert(!order.is_withdrawn, Errors::ALREADY_WITHDRAWN);
            assert(!order.is_refunded, Errors::ALREADY_REFUNDED);

            // If Alice already revealed her secret (swap_initiated = true), she has
            // received STRK and cannot reclaim her wBTC — that would be double-dipping.
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
        //
        // Bob reclaims his locked STRK if Alice never revealed the secret
        // before Bob's expiry. Bob's expiry is always less than Alice's,
        // so this can only succeed after Bob's window closes but while
        // Alice's refund window may still be open.
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
        // Uses Vesu's convert_to_assets() which reads the live exchange rate
        // of shares → wBTC, reflecting all accrued interest.
        // Returns 0 if the nullifier is not earning or Vesu is not configured.
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
            // Formula: (BTC_USD / STRK_USD) * STRK_PRECISION
            // Decimal adjustment: multiply by 10^strk_dec and divide by 10^btc_dec
            // to cancel out the oracle's fixed-point representation differences.
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

        // Override the wBTC token address. Only callable by owner.
        // The new token must have exactly 8 decimals to match BTC_DENOMINATION accounting.
        fn set_mock_wbtc(ref self: ContractState, wbtc: ContractAddress) {
            self.assert_only_owner();
            let wBTC = IERC20MetadataDispatcher { contract_address: wbtc };
            assert(wBTC.decimals() == 8, 'mock wBTC must have 8 decimals');
            self.wBTC.write(wbtc);
        }

        // Update the Vesu vToken address.
        // Set to zero address to disable yield earning (wBTC stays idle in this contract).
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

        // Redeems the vToken shares for an earning position and clears all earning state.
        //
        // This is an internal helper called only by stop_earning.
        // It follows the CEI pattern: state is cleared BEFORE the Vesu external call,
        // preventing reentrancy into stop_earning.
        //
        // Returns the wBTC amount received from Vesu (principal + yield).
        fn redeem_vesu_position(ref self: ContractState, nullifier_hash: u256) -> u256 {
            let vtoken_addr = self.vesu_vtoken.read();
            let shares = self.nullifier_shares.read(nullifier_hash);
            let this = get_contract_address();

            // Clear earning state BEFORE the external call (CEI pattern).
            // If Vesu's redeem somehow re-enters stop_earning, nullifier_earning
            // is already false and the second call will revert with NOT_EARNING.
            self.nullifier_earning.write(nullifier_hash, false);
            self.nullifier_shares.write(nullifier_hash, 0);

            let vtoken = IVTokenDispatcher { contract_address: vtoken_addr };
            // redeem(shares, receiver, owner):
            //   shares — how many vToken shares to burn
            //   receiver (this) — where the returned wBTC lands
            //   owner (this) — who owns the shares being redeemed
            let wbtc_returned = vtoken.redeem(shares, this, this);

            self.emit(YieldRedeemed { nullifier_hash, shares, wbtc_returned });

            wbtc_returned
        }

        // Fetches price from a Pragma oracle feed and validates freshness.
        // Reverts if the price is stale (older than MAX_ORACLE_AGE_SECS) or zero.
        // Returns (price, decimals) — price is in USD with `decimals` fixed-point precision.
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

        // Integer power of 10. Used for decimal normalization in oracle price calculations.
        // Common values are matched directly for gas efficiency.
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
