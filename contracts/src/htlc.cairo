use starknet::ContractAddress;

#[starknet::interface]
pub trait IHTLC<TContractState> {
    fn create_swap(
        ref self: TContractState,
        swap_id: felt252,
        receiver: ContractAddress,
        token: ContractAddress,
        amount: u256,
        hashlock: felt252,
        timelock: u64,
    );
    fn withdraw(ref self: TContractState, swap_id: felt252, secret: felt252);
    fn refund(ref self: TContractState, swap_id: felt252);
    fn get_swap(self: @TContractState, swap_id: felt252) -> SwapData;
}

#[derive(Drop, Serde, Copy, starknet::Store)]
pub struct SwapData {
    pub sender: ContractAddress,
    pub receiver: ContractAddress,
    pub token: ContractAddress,
    pub amount: u256,
    pub hashlock: felt252,
    pub timelock: u64,
    pub withdrawn: bool,
    pub refunded: bool,
}

#[starknet::contract]
mod HTLC {
    use starknet::storage::{
        StoragePointerReadAccess, StoragePointerWriteAccess, Map, StorageMapWriteAccess,
        StoragePathEntry,
    };
    use starknet::{ContractAddress, get_caller_address, get_block_timestamp, get_contract_address};
    use crate::{erc20::IERC20Dispatcher, erc20::IERC20DispatcherTrait};
    use super::{IHTLC, SwapData};
    use core::pedersen::pedersen;

    #[storage]
    struct Storage {
        swaps: Map<felt252, SwapData>,
    }

    pub mod Errors {
        pub const HTLC_SWAP_EXISTS: felt252 = 'Swap ID already exists';
        pub const HTLC_TIMELOCK_PAST: felt252 = 'Timelock must be in future';
        pub const HTLC_ALREADY_WITHDRAWN: felt252 = 'Already withdrawn';
        pub const HTLC_ALREADY_REFUNDED: felt252 = 'Already refunded';
        pub const HTLC_NOT_RECEIVER: felt252 = 'Not the receiver';
        pub const HTLC_NOT_SENDER: felt252 = 'Not the sender';
        pub const HTLC_TIMELOCK_EXPIRED: felt252 = 'Timelock expired';
        pub const HTLC_TIMELOCK_NOT_EXPIRED: felt252 = 'Timelock not expired yet';
        pub const HTLC_INVALID_SECRET: felt252 = 'Invalid secret';
        pub const HTLC_INSUFFICIENT_ALLOWANCE: felt252 = 'Insufficient allowance';
    }

    #[event]
    #[derive(Copy, Drop, Debug, PartialEq, starknet::Event)]
    pub enum Event {
        SwapCreated: SwapCreated,
        SwapWithdrawn: SwapWithdrawn,
        SwapRefunded: SwapRefunded,
    }

    #[derive(Copy, Drop, Debug, PartialEq, starknet::Event)]
    pub struct SwapCreated {
        pub swap_id: felt252,
        pub sender: ContractAddress,
        pub receiver: ContractAddress,
        pub token: ContractAddress,
        pub amount: u256,
        pub hashlock: felt252,
        pub timelock: u64,
    }

    #[derive(Copy, Drop, Debug, PartialEq, starknet::Event)]
    pub struct SwapWithdrawn {
        pub swap_id: felt252,
        pub receiver: ContractAddress,
        pub secret: felt252,
    }

    #[derive(Copy, Drop, Debug, PartialEq, starknet::Event)]
    pub struct SwapRefunded {
        pub swap_id: felt252,
        pub sender: ContractAddress,
    }

    #[abi(embed_v0)]
    impl HTLCImpl of IHTLC<ContractState> {
        fn create_swap(
            ref self: ContractState,
            swap_id: felt252,
            receiver: ContractAddress,
            token: ContractAddress,
            amount: u256,
            hashlock: felt252,
            timelock: u64,
        ) {
            let caller = get_caller_address();
            let this_contract = get_contract_address();
            let now = get_block_timestamp();

            // Validate
            assert(timelock > now, Errors::HTLC_TIMELOCK_PAST);
            let existing = self.swaps.entry(swap_id).read();
            assert(existing.sender.is_zero(), Errors::HTLC_SWAP_EXISTS);

            // Check allowance and pull tokens in (same pattern as your donate_to_foundation)
            let erc_token = IERC20Dispatcher { contract_address: token };
            let allowance = erc_token.allowance(caller, this_contract);
            assert(allowance >= amount, Errors::HTLC_INSUFFICIENT_ALLOWANCE);
            erc_token.transfer_from(caller, this_contract, amount);

            // Store swap
            self.swaps.write(
                swap_id,
                SwapData {
                    sender: caller,
                    receiver,
                    token,
                    amount,
                    hashlock,
                    timelock,
                    withdrawn: false,
                    refunded: false,
                },
            );

            self.emit(Event::SwapCreated(SwapCreated {
                swap_id, sender: caller, receiver, token, amount, hashlock, timelock,
            }));
        }

        fn withdraw(ref self: ContractState, swap_id: felt252, secret: felt252) {
            let caller = get_caller_address();
            let now = get_block_timestamp();
            let mut swap = self.swaps.entry(swap_id).read();

            assert(!swap.withdrawn, Errors::HTLC_ALREADY_WITHDRAWN);
            assert(!swap.refunded, Errors::HTLC_ALREADY_REFUNDED);
            assert(swap.receiver == caller, Errors::HTLC_NOT_RECEIVER);
            assert(now < swap.timelock, Errors::HTLC_TIMELOCK_EXPIRED);

            // Verify secret: pedersen hash of secret must match hashlock
            let hash = pedersen(0, secret);
            assert(hash == swap.hashlock, Errors::HTLC_INVALID_SECRET);

            swap.withdrawn = true;
            self.swaps.write(swap_id, swap);

            // Transfer tokens to receiver
            IERC20Dispatcher { contract_address: swap.token }
                .transfer(caller, swap.amount);

            self.emit(Event::SwapWithdrawn(SwapWithdrawn { swap_id, receiver: caller, secret }));
        }

        fn refund(ref self: ContractState, swap_id: felt252) {
            let caller = get_caller_address();
            let now = get_block_timestamp();
            let mut swap = self.swaps.entry(swap_id).read();

            assert(!swap.withdrawn, Errors::HTLC_ALREADY_WITHDRAWN);
            assert(!swap.refunded, Errors::HTLC_ALREADY_REFUNDED);
            assert(swap.sender == caller, Errors::HTLC_NOT_SENDER);
            assert(now >= swap.timelock, Errors::HTLC_TIMELOCK_NOT_EXPIRED);

            swap.refunded = true;
            self.swaps.write(swap_id, swap);

            // Return tokens to sender
            IERC20Dispatcher { contract_address: swap.token }
                .transfer(caller, swap.amount);

            self.emit(Event::SwapRefunded(SwapRefunded { swap_id, sender: caller }));
        }

        fn get_swap(self: @ContractState, swap_id: felt252) -> SwapData {
            self.swaps.entry(swap_id).read()
        }
    }
}