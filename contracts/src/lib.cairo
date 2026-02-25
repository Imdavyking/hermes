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

/// Chainlink round response struct
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
// Ekubo types
// -------------------------------------------------------

/// Identifies a specific pool on Ekubo.
/// token0 must be < token1 (sorted by address).
#[derive(Copy, Drop, Serde)]
struct PoolKey {
    token0: ContractAddress,
    token1: ContractAddress,
    fee: u128, // 0.128 fixed-point, e.g. 0.3% = floor(0.003 * 2^128)
    tick_spacing: u128,
    extension: ContractAddress // 0 for standard pools
}

/// A signed 129-bit integer used for swap amounts.
/// positive = exact input, negative = exact output
#[derive(Copy, Drop, Serde)]
struct i129 {
    mag: u128,
    sign: bool // false = positive, true = negative
}

#[derive(Copy, Drop, Serde)]
struct SwapParameters {
    amount: i129,
    is_token1: bool, // true if the input token is token1 in the pool
    sqrt_ratio_limit: u256, // price limit (slippage), use MIN/MAX for no limit
    skip_ahead: u128 // set to 0
}

/// Token balance delta returned from a swap
#[derive(Copy, Drop, Serde)]
struct Delta {
    amount0: i129,
    amount1: i129,
}

/// A single hop in a multi-hop route
#[derive(Copy, Drop, Serde)]
struct RouteNode {
    pool_key: PoolKey,
    sqrt_ratio_limit: u256,
    skip_ahead: u128,
}

/// Amount of a specific token
#[derive(Copy, Drop, Serde)]
struct TokenAmount {
    token: ContractAddress,
    amount: i129,
}

/// Ekubo Core interface — all interactions go through lock()
#[starknet::interface]
trait IEkuboCore<TContractState> {
    fn lock(ref self: TContractState, data: Array<felt252>) -> Array<felt252>;
    fn swap(ref self: TContractState, pool_key: PoolKey, params: SwapParameters) -> Delta;
    // Pay tokens owed to the core after a swap
    fn pay(ref self: TContractState, token: ContractAddress);
    // Withdraw tokens from core to a recipient
    fn withdraw(
        ref self: TContractState, token: ContractAddress, recipient: ContractAddress, amount: u128,
    );
}

/// ILocker — your contract must implement this; Ekubo core calls back into it
#[starknet::interface]
trait ILocker<TContractState> {
    fn locked(ref self: TContractState, id: u32, data: Span<felt252>) -> Span<felt252>;
}

/// Callback data passed through the lock/locked round-trip
#[derive(Drop, Serde)]
struct SwapCallbackData {
    route: RouteNode, // single-hop: wBTC → STRK pool
    token_amount: TokenAmount, // exact input: how much wBTC to sell
    recipient: ContractAddress // where to send the output STRK
}

#[starknet::interface]
trait IPrivateSwap<TContractState> {
    fn deposit(ref self: TContractState, commitment: u256);
    fn withdraw(ref self: TContractState, proof: Span<felt252>, recipient: ContractAddress);
    fn current_root(self: @TContractState) -> u256;
    fn next_leaf_index(self: @TContractState) -> u32;
    fn is_known_root(self: @TContractState, root: u256) -> bool;
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
    use ekubo::components::shared_locker::{call_core_with_callback, consume_callback_data};
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
        ContractAddress, Delta, IAggregatorProxyDispatcher, IAggregatorProxyDispatcherTrait,
        IEkuboCoreDispatcher, IEkuboCoreDispatcherTrait, IVerifierDispatcher,
        IVerifierDispatcherTrait, PoolKey, RouteNode, SwapCallbackData, SwapParameters, TokenAmount,
        get_block_timestamp, get_caller_address, get_contract_address, i129,
    };
    component!(path: IncrementalMerkleTreeComponent, storage: imt, event: ImtEvent);

    const BTC_DENOMINATION: u256 = 1_000; // satoshis (wBTC has 8 decimals)
    const TREE_DEPTH: u32 = 10;

    // Chainlink Sepolia feed addresses
    const BTC_USD_FEED: felt252 = 0x0258b8f498b767c200577227e3e9f009c9b0fe7f6a3c8c2c24efd588c54747a;
    const STRK_USD_FEED: felt252 =
        0x0a5db422ee7c28beead49303646e44ef9cbb8364eeba4d8af9ac06a3b556937;
    const MAX_PRICE_AGE: u64 = 86400; // 24h for testnet

    // Ekubo Core on StarkNet Sepolia
    const EKUBO_CORE: felt252 = 0x0444a09d96389aa7148f1aada508e30b71299ffe650d9c97fdaae38cb9a23384;

    // STRK token on StarkNet Sepolia
    const STRK_TOKEN: felt252 = 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d;

    // Ekubo wBTC/STRK pool parameters (Sepolia)
    // fee: 0.3% = floor(0.003 * 2^128) = 0xc49ba5e353f7d00000000000000000
    const WBTC_STRK_FEE: u128 = 0xc49ba5e353f7d00000000000000000;
    const WBTC_STRK_TICK_SPACING: u128 = 60;

    // sqrt_ratio limits — use these as "no price limit" (accept any price)
    // MIN_SQRT_RATIO + 1 when selling token0, MAX_SQRT_RATIO - 1 when selling token1
    const MIN_SQRT_RATIO: u256 = 18446748437148339061;
    const MAX_SQRT_RATIO: u256 = 6277100250585753475930931601400621808602321654880405518632;

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
    fn constructor(ref self: ContractState, verifier_class_hash: ClassHash) {
        self
            .wBTC
            .write(
                0x00452bd5c0512a61df7c7be8cfea5e4f893cb40e126bdc40aee6054db955129e
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
        // WITHDRAW
        // 1. Verify ZK proof
        // 2. Swap locked wBTC → STRK via Ekubo
        // 3. STRK lands directly at recipient
        // ---------------------------------------------------
        fn withdraw(ref self: ContractState, proof: Span<felt252>, recipient: ContractAddress) {
            // ── Verify proof
            // ─────────────────────────────────────────────
            let verifier = IVerifierDispatcher { contract_address: self.verifier.read() };
            let verified_proof = verifier.verify_ultra_keccak_zk_honk_proof(proof);
            assert(verified_proof.is_ok(), 'invalid proof');

            let result = verified_proof.unwrap();
            let root = *result.at(0);
            let nullifier_hash = *result.at(1);

            assert(self.imt.is_known_root(root), 'unknown root');
            assert(!self.nullifier_hashes.read(nullifier_hash), 'nullifier used');

            // Mark nullifier spent BEFORE external calls — reentrancy guard
            self.nullifier_hashes.write(nullifier_hash, true);

            // ── Swap wBTC → STRK via Ekubo
            // ───────────────────────────────
            let wbtc_address = self.wBTC.read();
            let strk_address: ContractAddress = STRK_TOKEN.try_into().unwrap();
            let core_address: ContractAddress = EKUBO_CORE.try_into().unwrap();

            // Approve Ekubo Core to pull wBTC from this contract
            let wBTC = IERC20Dispatcher { contract_address: wbtc_address };
            wBTC.approve(core_address, BTC_DENOMINATION);

            // // token0 must be the lower address — sort wBTC and STRK
            // let (token0, token1, is_token1) = if wbtc_address.into() < strk_address.into() {
            //     (wbtc_address, strk_address, false) // selling token0 (wBTC)
            // } else {
            //     (strk_address, wbtc_address, true) // selling token1 (wBTC)
            // };

            // let pool_key = PoolKey {
            //     token0,
            //     token1,
            //     fee: WBTC_STRK_FEE,
            //     tick_spacing: WBTC_STRK_TICK_SPACING,
            //     extension: 0.try_into().unwrap(),
            // };

            // // Exact input: sell exactly BTC_DENOMINATION wBTC
            // let amount = i129 { mag: BTC_DENOMINATION.try_into().unwrap(), sign: false };

            // // sqrt_ratio_limit: no price cap — accept whatever the pool gives
            // let sqrt_ratio_limit = if is_token1 {
            //     MIN_SQRT_RATIO + 1
            // } else {
            //     MAX_SQRT_RATIO - 1
            // };

            // let route = RouteNode { pool_key, sqrt_ratio_limit, skip_ahead: 0 };
            // let token_amount = TokenAmount { token: wbtc_address, amount };

            // let callback_data = SwapCallbackData { route, token_amount, recipient };

            // let core = IEkuboCoreDispatcher { contract_address: core_address };

            // // Triggers core.lock() → core calls back into our locked() below
            // call_core_with_callback::<SwapCallbackData, Delta>(core, @callback_data);

            // self.emit(Withdrawal { recipient, nullifier_hash });
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
            let precision: u256 = 1_000_000_000_000_000_000;
            (btc_usd.into() * self.pow10(strk_dec.into()) * precision)
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

        fn wBTC_address(self: @ContractState) -> ContractAddress {
            self.wBTC.read()
        }

        fn wBTC_denomination(self: @ContractState) -> u256 {
            BTC_DENOMINATION
        }
    }

    // -------------------------------------------------------
    // ILocker — Ekubo calls back here inside the lock
    // This is where the actual swap + pay + withdraw happens
    // -------------------------------------------------------
    #[abi(embed_v0)]
    impl LockerImpl of super::ILocker<ContractState> {
        fn locked(ref self: ContractState, id: u32, data: Span<felt252>) -> Span<felt252> {
            let core_address: ContractAddress = EKUBO_CORE.try_into().unwrap();
            let core = IEkuboCoreDispatcher { contract_address: core_address };

            // Decode the callback data we passed through lock()
            let cb: SwapCallbackData = consume_callback_data::<SwapCallbackData>(core, data);

            let pool_key = cb.route.pool_key;
            let token_amount = cb.token_amount;
            let recipient = cb.recipient;

            // Determine which side of the pool wBTC is on
            let is_token1 = token_amount.token == pool_key.token1;

            // Execute the swap inside the lock
            let delta = core
                .swap(
                    pool_key,
                    SwapParameters {
                        amount: token_amount.amount,
                        is_token1,
                        sqrt_ratio_limit: cb.route.sqrt_ratio_limit,
                        skip_ahead: cb.route.skip_ahead,
                    },
                );

            // Pay the input (wBTC) that we owe to core
            // core.pay() pulls from this contract's balance
            core.pay(token_amount.token);

            // Determine the output token (STRK) and amount
            let (output_token, output_amount) = if is_token1 {
                (pool_key.token0, delta.amount0)
            } else {
                (pool_key.token1, delta.amount1)
            };

            // amount is negative for output tokens (you receive them)
            let strk_out: u128 = output_amount.mag;
            assert(strk_out > 0, 'zero STRK output');

            // Withdraw STRK from core directly to recipient — no intermediate transfer
            core.withdraw(output_token, recipient, strk_out);

            // Return empty span — callback return value unused here
            array![].span()
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
