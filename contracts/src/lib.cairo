use starknet::{ContractAddress, get_block_timestamp, get_caller_address, get_contract_address};
mod pragma_oracle;
mod mockUSDC;

// -------------------------------------------------------
// External Interfaces
// -------------------------------------------------------

#[starknet::interface]
trait IAggregatorProxy<TContractState> {
    fn latest_round_data(self: @TContractState) -> Round;
    fn decimals(self: @TContractState) -> u8;
}

#[starknet::interface]
trait IResolver<TContractState> {
    fn checker(self: @TContractState, order_id: u256) -> (bool, ExecPayload);
}

#[derive(Drop, Serde, Copy, starknet::Store)]
struct EscrowExecution {
    hash: felt252,
    expiry: u64,
    fee: u256,
}

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
    success_action: Option<EscrowExecution>,
}

// EscrowState is returned by IAtomiqEscrowStorage::get_state.
// state values (from Atomiq SDK):
//   1 = COMMITED     — in flight, not yet claimed or refunded
//   2 = SOFT_CLAIMED — payment seen off-chain, not yet claimed on-chain
//   3 = CLAIMED      — LP claimed, BTC was delivered
//   4 = REFUNDABLE   — LP failed to process, user can refund
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
        escrow: EscrowData,
        signature: Array<felt252>,
        timeout: u64,
        extra_data: Span<felt252>,
    );
    fn refund(ref self: TContractState, escrow: EscrowData, witness: Array<felt252>);
}

#[starknet::interface]
trait IAtomiqEscrowStorage<TContractState> {
    fn get_state(self: @TContractState, escrow: EscrowData) -> EscrowState;
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
// Derivation:
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
trait IHermes<TContractState> {
    // --- DCA (USDC → BTC via Atomiq) ---
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
        escrow: EscrowData,
        signature: Array<felt252>,
        timeout: u64,
        extra_data: Span<felt252>,
    );
    fn claim_dca_interval(ref self: TContractState, order_id: u256);
    fn cancel_dca(ref self: TContractState, order_id: u256);

    // --- Views ---
    fn checker(self: @TContractState, order_id: u256) -> (bool, ExecPayload);
    fn get_dca_order(self: @TContractState, order_id: u256) -> DCAOrder;
    fn get_btc_usd_price(self: @TContractState) -> (u128, u32);
    fn get_strk_usd_price(self: @TContractState) -> (u128, u32);
    fn get_dca_strk_reserved(self: @TContractState, order_id: u256) -> u256;
    fn get_dca_btc_destination(self: @TContractState, order_id: u256) -> ByteArray;
    fn keeper_fee_strk(self: @TContractState) -> u256;
    fn strk_address(self: @TContractState) -> ContractAddress;
    fn usdc_address(self: @TContractState) -> ContractAddress;
    fn owner(self: @TContractState) -> ContractAddress;
    fn get_dca_pending_escrow(self: @TContractState, order_id: u256) -> EscrowData;
    fn dca_interval_needs_refund(self: @TContractState, order_id: u256) -> bool;
    fn get_dca_pending_interval_index(self: @TContractState, order_id: u256) -> u32;
    fn is_using_pragma(self: @TContractState) -> bool;

    // --- Admin ---
    fn withdraw_strk_admin(ref self: TContractState, amount: u256, recipient: ContractAddress);
    fn set_usdc(ref self: TContractState, usdc: ContractAddress);
    fn transfer_ownership(ref self: TContractState, new_owner: ContractAddress);
    fn add_keeper(ref self: TContractState, keeper: ContractAddress);
    fn remove_keeper(ref self: TContractState, keeper: ContractAddress);
    fn set_use_pragma(ref self: TContractState, use_pragma: bool);
}

// -------------------------------------------------------
// Contract
// -------------------------------------------------------

#[starknet::contract]
mod Hermes {
    use openzeppelin::token::erc20::interface::{
        IERC20Dispatcher, IERC20DispatcherTrait, IERC20MetadataDispatcher,
        IERC20MetadataDispatcherTrait,
    };
    use starknet::get_tx_info;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use crate::pragma_oracle::{
        AggregationMode, DataType, IPragmaABIDispatcher, IPragmaABIDispatcherTrait,
        PragmaPricesResponse,
    };
    use super::{
        ContractAddress, DCAOrder, EscrowData, ExecPayload, IAggregatorProxyDispatcher,
        IAggregatorProxyDispatcherTrait, IAtomiqEscrowDispatcher, IAtomiqEscrowDispatcherTrait,
        IAtomiqEscrowStorageDispatcher, IAtomiqEscrowStorageDispatcherTrait, get_block_timestamp,
        get_caller_address, get_contract_address,
    };

    // -------------------------------------------------------
    // Constants
    // -------------------------------------------------------

    const STRK_PRECISION: u256 = 1_000_000_000_000_000_000;
    const USDC_PRECISION: u256 = 1_000_000;

    // Universal asset keys — used as the single identifier passed to fetch_oracle_price.
    // When use_pragma=true  → used directly as Pragma SpotEntry asset id.
    // When use_pragma=false → looked up in chainlink_feeds map to get the feed address.
    const BTC_USD: felt252 = 'BTC/USD';
    const STRK_USD: felt252 = 'STRK/USD';

    // Chainlink feed addresses (Sepolia)
    const BTC_USD_CHAINLINK: felt252 =
        0x0258b8f498b767c200577227e3e9f009c9b0fe7f6a3c8c2c24efd588c54747a;
    const STRK_USD_CHAINLINK: felt252 =
        0x0a5db422ee7c28beead49303646e44ef9cbb8364eeba4d8af9ac06a3b556937;

    // Pragma oracle address (Sepolia)
    const PRAGMA_ORACLE_ADDRESS: felt252 =
        0x036031daa264c24520b11d93af622c848b2499b66b41d611bac95e13cfca131a;

    const ZERO_ADDRESS: ContractAddress = 0.try_into().unwrap();

    // 2 weeks — generous for testnet where feeds update infrequently
    const MAX_ORACLE_AGE_SECS: u64 = 1_209_600;

    const BPS_DENOMINATOR: u256 = 10_000;

    const MIN_USDC_PER_INTERVAL: u256 = 1_000_000;

    const DCA_MAX_INTERVALS: u32 = 1_000;
    const DCA_MAX_INTERVAL_HOURS: u64 = 720;

    // 0.5 STRK per interval
    const KEEPER_FEE_STRK: u256 = 500_000_000_000_000_000;

    const REAL_STRK_ADDRESS: felt252 =
        0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d;
    const USDC_ADDRESS: felt252 =
        0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8;

    const ATOMIQ_ESCROW: felt252 =
        0x017bf50dd28b6d823a231355bb25813d4396c8e19d2df03026038714a22f0413;

    const ESCROW_KEY_MULTIPLIER: u256 = 1_000_000;

    // 5% tolerance window for the keeper-supplied strk_amount in execute_dca.
    // Prevents keeper from committing a stale or manipulated amount to Atomiq.
    const STRK_TOLERANCE_BPS: u256 = 500;

    // Atomiq escrow state values (from SDK):
    //   1 = COMMITED     — in flight
    //   2 = SOFT_CLAIMED — payment seen off-chain, not yet claimed on-chain
    //   3 = CLAIMED      — LP claimed, BTC delivered
    //   4 = REFUNDABLE   — LP failed, offerer can refund
    const ESCROW_STATE_SOFT_CLAIMED: u8 = 2;
    const ESCROW_STATE_CLAIMED: u8 = 3;
    const ESCROW_STATE_REFUNDABLE: u8 = 4;

    // -------------------------------------------------------
    // Errors
    // -------------------------------------------------------

    pub mod Errors {
        pub const DCA_NOT_ACTIVE: felt252 = 'dca order not active';
        pub const DCA_NOT_DUE: felt252 = 'interval not elapsed yet';
        pub const DCA_NOT_OWNER: felt252 = 'caller is not dca owner';
        pub const DCA_COMPLETED: felt252 = 'dca order completed';
        pub const DCA_INVALID_INTERVALS: felt252 = 'total intervals must be > 0';
        pub const DCA_TOO_MANY_INTERVALS: felt252 = 'exceeds max intervals';
        pub const DCA_INVALID_INTERVAL_HOURS: felt252 = 'interval hours must be > 0';
        pub const DCA_INTERVAL_TOO_LONG: felt252 = 'interval exceeds 30 days';
        pub const DCA_USDC_TOO_LOW: felt252 = 'usdc_per_interval below min';
        pub const DCA_STRK_FEE_ALLOWANCE: felt252 = 'insufficient STRK fee allowance';
        pub const DCA_INTERVAL_PENDING: felt252 = 'prior escrow still pending';
        pub const DCA_NO_PENDING_ESCROW: felt252 = 'no pending escrow for order';
        pub const DCA_ESCROW_NOT_SETTLED: felt252 = 'escrow not yet settled';
        pub const DCA_STRK_AMOUNT_OUT_OF_RANGE: felt252 = 'strk amount out of 5% tolerance';
        pub const DCA_INSUFFICIENT_STRK: felt252 = 'strk balance < escrow amount';
        pub const NOT_OWNER: felt252 = 'caller is not the owner';
        pub const ZERO_ADDRESS: felt252 = 'address cannot be zero';
        pub const NO_CHAINLINK_FEED: felt252 = 'no chainlink feed for asset';
        pub const BOTH_ORACLES_STALE: felt252 = 'both oracles stale';
        pub const USDC_TRANSFER_FAILED: felt252 = 'USDC transfer failed';
        pub const STRK_TRANSFER_FAILED: felt252 = 'STRK transfer failed';
        pub const INSUFFICIENT_ALLOWANCE: felt252 = 'insufficient token allowance';
    }

    // -------------------------------------------------------
    // Storage
    // -------------------------------------------------------

    #[storage]
    struct Storage {
        registered_keepers: Map<ContractAddress, bool>,
        dca_orders: Map<u256, DCAOrder>,
        dca_order_count: u256,
        dca_btc_destinations: Map<u256, ByteArray>,
        dca_strk_reserved: Map<u256, u256>,
        dca_pending_escrows: Map<u256, EscrowData>,
        dca_pending_interval_index: Map<u256, u32>,
        dca_interval_needs_refund: Map<u256, bool>,
        strk: ContractAddress,
        usdc: ContractAddress,
        owner: ContractAddress,
        // Oracle toggle:
        //   true  = Pragma primary, Chainlink fallback  (mainnet)
        //   false = Chainlink primary, Pragma fallback  (Sepolia testnet)
        use_pragma: bool,
        // Maps universal asset key ('BTC/USD', 'STRK/USD') → Chainlink feed address.
        chainlink_feeds: Map<felt252, felt252>,
    }

    // -------------------------------------------------------
    // Events
    // -------------------------------------------------------

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        OwnershipTransferred: OwnershipTransferred,
        DCAOrderCreated: DCAOrderCreated,
        DCAExecuted: DCAExecuted,
        DCACancelled: DCACancelled,
        DCAIntervalRefunded: DCAIntervalRefunded,
        DCAIntervalClaimed: DCAIntervalClaimed,
        OracleToggled: OracleToggled,
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
        btc_destination: ByteArray,
    }

    #[derive(Drop, starknet::Event)]
    struct DCAExecuted {
        #[key]
        order_id: u256,
        owner: ContractAddress,
        usdc_spent: u256,
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

    #[derive(Drop, starknet::Event)]
    struct DCAIntervalRefunded {
        #[key]
        order_id: u256,
        interval_index: u32,
        strk_returned: u256,
    }

    #[derive(Drop, starknet::Event)]
    struct DCAIntervalClaimed {
        #[key]
        order_id: u256,
        interval_index: u32,
    }

    #[derive(Drop, starknet::Event)]
    struct OracleToggled {
        use_pragma: bool,
    }

    // -------------------------------------------------------
    // Constructor
    // -------------------------------------------------------

    #[constructor]
    fn constructor(ref self: ContractState) {
        let tx_info = get_tx_info();

        self.strk.write(REAL_STRK_ADDRESS.try_into().unwrap());
        self.usdc.write(USDC_ADDRESS.try_into().unwrap());
        self.dca_order_count.write(0);

        self.chainlink_feeds.write(BTC_USD, BTC_USD_CHAINLINK);
        self.chainlink_feeds.write(STRK_USD, STRK_USD_CHAINLINK);

        // Sepolia testnet: Chainlink primary, Pragma fallback
        self.use_pragma.write(false);

        let owner = tx_info.account_contract_address;
        self.owner.write(owner);
        self.emit(OwnershipTransferred { previous_owner: ZERO_ADDRESS, new_owner: owner });
    }

    // -------------------------------------------------------
    // Implementation
    // -------------------------------------------------------

    #[abi(embed_v0)]
    impl HermesImpl of super::IHermes<ContractState> {
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

            // Pull full USDC for all intervals upfront
            let total_usdc: u256 = usdc_per_interval * total_intervals.into();
            let usdc = IERC20Dispatcher { contract_address: self.usdc.read() };
            assert(usdc.allowance(caller, this) >= total_usdc, Errors::INSUFFICIENT_ALLOWANCE);
            let ok = usdc.transfer_from(caller, this, total_usdc);
            assert(ok, Errors::USDC_TRANSFER_FAILED);

            // Pull full STRK keeper fee reserve for all intervals upfront
            let total_strk_fee: u256 = KEEPER_FEE_STRK * total_intervals.into();
            let strk = IERC20Dispatcher { contract_address: self.strk.read() };
            assert(strk.allowance(caller, this) >= total_strk_fee, Errors::DCA_STRK_FEE_ALLOWANCE);
            let ok2 = strk.transfer_from(caller, this, total_strk_fee);
            assert(ok2, Errors::STRK_TRANSFER_FAILED);

            let order_id = self.dca_order_count.read() + 1;
            self.dca_order_count.write(order_id);

            let btc_destination_for_event = btc_destination.clone();
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
                        btc_destination: btc_destination_for_event,
                    },
                );

            order_id
        }

        // ---------------------------------------------------
        // EXECUTE DCA
        // Called by keeper once per interval.
        // Validates strk_amount is within 5% of live oracle,
        // commits STRK to Atomiq escrow, pays keeper fee.
        // ---------------------------------------------------
        fn execute_dca(
            ref self: ContractState,
            order_id: u256,
            escrow: EscrowData,
            signature: Array<felt252>,
            timeout: u64,
            extra_data: Span<felt252>,
        ) {
            let mut order = self.dca_orders.read(order_id);
            let now = get_block_timestamp();
            let keeper = get_caller_address();

            assert(order.is_active, Errors::DCA_NOT_ACTIVE);
            assert(order.executed_intervals < order.total_intervals, Errors::DCA_COMPLETED);
            assert(now >= order.last_execution + order.interval_seconds, Errors::DCA_NOT_DUE);
            assert(!self.dca_interval_needs_refund.read(order_id), Errors::DCA_INTERVAL_PENDING);

            // Validate keeper-supplied strk_amount is within 5% of live oracle.
            let (strk_usd, strk_dec) = self.fetch_oracle_price(STRK_USD);
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
                escrow.amount >= lower_bound && escrow.amount <= upper_bound,
                Errors::DCA_STRK_AMOUNT_OUT_OF_RANGE,
            );

            let interval_index = order.executed_intervals + 1;
            order.last_execution = order.last_execution + order.interval_seconds;
            order.executed_intervals = interval_index;
            if order.executed_intervals == order.total_intervals {
                order.is_active = false;
            }
            self.dca_orders.write(order_id, order);

            // Store pending escrow — cleared by claim_dca_interval
            let escrow_key: u256 = order_id * ESCROW_KEY_MULTIPLIER + interval_index.into();
            self.dca_pending_escrows.write(escrow_key, escrow);
            self.dca_pending_interval_index.write(order_id, interval_index);
            self.dca_interval_needs_refund.write(order_id, true);

            self._commit_strk_to_atomiq(escrow, signature, timeout, extra_data);

            // Pay keeper fee if registered
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
        // CLAIM DCA INTERVAL
        // Settles a pending Atomiq escrow.
        // SOFT_CLAIMED / CLAIMED → interval confirmed, unlock next execution.
        // REFUNDABLE → LP failed, roll back interval counter, keeper retries.
        // ---------------------------------------------------
        fn claim_dca_interval(ref self: ContractState, order_id: u256) {
            assert(self.dca_interval_needs_refund.read(order_id), Errors::DCA_NO_PENDING_ESCROW);

            let interval_index = self.dca_pending_interval_index.read(order_id);
            let escrow_key: u256 = order_id * ESCROW_KEY_MULTIPLIER + interval_index.into();
            let escrow = self.dca_pending_escrows.read(escrow_key);

            let escrow_state = IAtomiqEscrowStorageDispatcher {
                contract_address: ATOMIQ_ESCROW.try_into().unwrap(),
            }
                .get_state(escrow);

            assert(
                escrow_state.state == ESCROW_STATE_SOFT_CLAIMED
                    || escrow_state.state == ESCROW_STATE_CLAIMED
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
                success_action: Option::None,
            };

            self.dca_interval_needs_refund.write(order_id, false);
            self.dca_pending_interval_index.write(order_id, 0);
            self.dca_pending_escrows.write(escrow_key, zeroed_escrow);

            if escrow_state.state == ESCROW_STATE_SOFT_CLAIMED
                || escrow_state.state == ESCROW_STATE_CLAIMED {
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
                    EscrowData {
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
        // Owner cancels active order — refunds remaining USDC + STRK fee reserve.
        // Cannot cancel while an interval escrow is pending.
        // ---------------------------------------------------
        fn cancel_dca(ref self: ContractState, order_id: u256) {
            let mut order = self.dca_orders.read(order_id);
            assert(order.is_active, Errors::DCA_NOT_ACTIVE);
            assert(get_caller_address() == order.owner, Errors::DCA_NOT_OWNER);
            assert(!self.dca_interval_needs_refund.read(order_id), Errors::DCA_INTERVAL_PENDING);

            let remaining: u256 = (order.total_intervals - order.executed_intervals).into();
            let usdc_refund = order.usdc_per_interval * remaining;
            let strk_refund = KEEPER_FEE_STRK * remaining;

            // Mark inactive before transfers (CEI)
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
        // Gelato-style keeper resolver.
        // Returns (can_exec, payload) — keeper fires execute_dca when can_exec is true.
        // payload.strk_amount is the live oracle-priced STRK for this interval.
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
                let (strk_usd, strk_dec) = self.fetch_oracle_price(STRK_USD);
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

        fn strk_address(self: @ContractState) -> ContractAddress {
            self.strk.read()
        }

        fn usdc_address(self: @ContractState) -> ContractAddress {
            self.usdc.read()
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

        fn get_btc_usd_price(self: @ContractState) -> (u128, u32) {
            self.fetch_oracle_price(BTC_USD)
        }

        fn get_strk_usd_price(self: @ContractState) -> (u128, u32) {
            self.fetch_oracle_price(STRK_USD)
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

        fn is_using_pragma(self: @ContractState) -> bool {
            self.use_pragma.read()
        }

        // ---------------------------------------------------
        // Admin
        // ---------------------------------------------------

        fn withdraw_strk_admin(ref self: ContractState, amount: u256, recipient: ContractAddress) {
            self.assert_only_owner();
            assert(recipient != ZERO_ADDRESS, Errors::ZERO_ADDRESS);
            let ok = IERC20Dispatcher { contract_address: self.strk.read() }
                .transfer(recipient, amount);
            assert(ok, Errors::STRK_TRANSFER_FAILED);
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

        fn set_use_pragma(ref self: ContractState, use_pragma: bool) {
            self.assert_only_owner();
            self.use_pragma.write(use_pragma);
            self.emit(OracleToggled { use_pragma });
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
            escrow: EscrowData,
            signature: Array<felt252>,
            timeout: u64,
            extra_data: Span<felt252>,
        ) {
            let strk = IERC20Dispatcher {
                contract_address: REAL_STRK_ADDRESS.try_into().unwrap(),
            };
            let balance = strk.balance_of(get_contract_address());
            assert(balance >= escrow.amount, Errors::DCA_INSUFFICIENT_STRK);

            strk.approve(ATOMIQ_ESCROW.try_into().unwrap(), escrow.amount);
            IAtomiqEscrowDispatcher { contract_address: ATOMIQ_ESCROW.try_into().unwrap() }
                .initialize(escrow, signature, timeout, extra_data);
        }

        // -------------------------------------------------------
        // UNIFIED ORACLE FETCH
        //
        // Takes a universal asset key ('BTC/USD' or 'STRK/USD').
        //
        // use_pragma=true  (mainnet):
        //   1. Try Pragma  — accurate, native Starknet oracle
        //   2. Fallback    → Chainlink if Pragma is stale
        //
        // use_pragma=false (Sepolia testnet):
        //   1. Try Chainlink — closer to real price on Sepolia
        //   2. Fallback      → Pragma if Chainlink is stale
        //
        // Reverts with BOTH_ORACLES_STALE if neither is fresh.
        // -------------------------------------------------------
        fn fetch_oracle_price(self: @ContractState, asset_key: felt252) -> (u128, u32) {
            let (primary, fallback) = if self.use_pragma.read() {
                (self.try_pragma_price(asset_key), self.try_chainlink_price(asset_key))
            } else {
                (self.try_chainlink_price(asset_key), self.try_pragma_price(asset_key))
            };

            primary.unwrap_or(fallback.expect(Errors::BOTH_ORACLES_STALE))
        }

        fn try_pragma_price(self: @ContractState, asset_key: felt252) -> Option<(u128, u32)> {
            let oracle = IPragmaABIDispatcher {
                contract_address: PRAGMA_ORACLE_ADDRESS.try_into().unwrap(),
            };
            let output: PragmaPricesResponse = oracle
                .get_data(DataType::SpotEntry(asset_key), AggregationMode::Median);

            if output.price > 0
                && output.last_updated_timestamp + MAX_ORACLE_AGE_SECS >= get_block_timestamp() {
                Option::Some((output.price, output.decimals))
            } else {
                Option::None
            }
        }

        fn try_chainlink_price(self: @ContractState, asset_key: felt252) -> Option<(u128, u32)> {
            let feed_address = self.chainlink_feeds.read(asset_key);
            assert(feed_address != 0, Errors::NO_CHAINLINK_FEED);
            let feed = IAggregatorProxyDispatcher {
                contract_address: feed_address.try_into().unwrap(),
            };
            let round = feed.latest_round_data();

            if round.answer > 0
                && round.updated_at + MAX_ORACLE_AGE_SECS >= get_block_timestamp() {
                Option::Some((round.answer, feed.decimals().into()))
            } else {
                Option::None
            }
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
