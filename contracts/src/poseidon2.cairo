// poseidon2_contract.cairo
// Thin wrapper around Poseidon2 library — exposes hash functions as contract entrypoints
// Useful for calling from other contracts or for testing on-chain

use super::field::{Field, FieldTrait};


#[starknet::interface]
trait IPoseidon2<TContractState> {
    fn hash_1(self: @TContractState, x: u256) -> u256;
    fn hash_2(self: @TContractState, x: u256, y: u256) -> u256;
    fn hash_3(self: @TContractState, x: u256, y: u256, z: u256) -> u256;
    fn hash(self: @TContractState, input: Array<u256>) -> u256;
    fn hash_variable(
        self: @TContractState,
        input: Array<u256>,
        std_input_length: usize,
        is_variable_length: bool,
    ) -> u256;
}

#[starknet::contract]
mod Poseidon2Contract {
    use crate::poseidon2lib::Poseidon2Trait;
    use super::{Field, FieldTrait};


    #[storage]
    struct Storage {}

    #[abi(embed_v0)]
    impl Poseidon2Impl of super::IPoseidon2<ContractState> {
        fn hash_1(self: @ContractState, x: u256) -> u256 {
            let result = Poseidon2Trait::hash_1(FieldTrait::new(x));
            result.inner()
        }

        fn hash_2(self: @ContractState, x: u256, y: u256) -> u256 {
            let result = Poseidon2Trait::hash_2(FieldTrait::new(x), FieldTrait::new(y));
            result.inner()
        }

        fn hash_3(self: @ContractState, x: u256, y: u256, z: u256) -> u256 {
            let result = Poseidon2Trait::hash_3(
                FieldTrait::new(x), FieldTrait::new(y), FieldTrait::new(z),
            );
            result.inner()
        }

        fn hash(self: @ContractState, input: Array<u256>) -> u256 {
            let len = input.len();
            let mut fields: Array<Field> = ArrayTrait::new();
            let mut i: usize = 0;
            while i < len {
                fields.append(FieldTrait::new(*input[i]));
                i += 1;
            }
            let result = Poseidon2Trait::hash(ref fields, len, false);
            result.inner()
        }

        fn hash_variable(
            self: @ContractState,
            input: Array<u256>,
            std_input_length: usize,
            is_variable_length: bool,
        ) -> u256 {
            let mut fields: Array<Field> = ArrayTrait::new();
            let mut i: usize = 0;
            while i < input.len() {
                fields.append(FieldTrait::new(*input[i]));
                i += 1;
            }
            let result = Poseidon2Trait::hash(ref fields, std_input_length, is_variable_length);
            result.inner()
        }
    }
}
