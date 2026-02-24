import { type Abi } from "@starknet-react/core";
const contractAbi = [
  {
    type: "impl",
    name: "PrivateSwapImpl",
    interface_name: "contracts::IPrivateSwap",
  },
  {
    type: "struct",
    name: "core::integer::u256",
    members: [
      { name: "low", type: "core::integer::u128" },
      { name: "high", type: "core::integer::u128" },
    ],
  },
  {
    type: "struct",
    name: "core::array::Span::<core::felt252>",
    members: [
      { name: "snapshot", type: "@core::array::Array::<core::felt252>" },
    ],
  },
  {
    type: "enum",
    name: "core::bool",
    variants: [
      { name: "False", type: "()" },
      { name: "True", type: "()" },
    ],
  },
  {
    type: "interface",
    name: "contracts::IPrivateSwap",
    items: [
      {
        type: "function",
        name: "deposit",
        inputs: [{ name: "commitment", type: "core::integer::u256" }],
        outputs: [],
        state_mutability: "external",
      },
      {
        type: "function",
        name: "withdraw",
        inputs: [
          { name: "proof", type: "core::array::Span::<core::felt252>" },
          { name: "root", type: "core::integer::u256" },
          { name: "nullifier_hash", type: "core::integer::u256" },
          {
            name: "recipient",
            type: "core::starknet::contract_address::ContractAddress",
          },
        ],
        outputs: [],
        state_mutability: "external",
      },
      {
        type: "function",
        name: "mock_btc_mint",
        inputs: [
          {
            name: "recipient",
            type: "core::starknet::contract_address::ContractAddress",
          },
          { name: "amount", type: "core::integer::u256" },
        ],
        outputs: [],
        state_mutability: "external",
      },
      {
        type: "function",
        name: "current_root",
        inputs: [],
        outputs: [{ type: "core::integer::u256" }],
        state_mutability: "view",
      },
      {
        type: "function",
        name: "next_leaf_index",
        inputs: [],
        outputs: [{ type: "core::integer::u32" }],
        state_mutability: "view",
      },
      {
        type: "function",
        name: "is_known_root",
        inputs: [{ name: "root", type: "core::integer::u256" }],
        outputs: [{ type: "core::bool" }],
        state_mutability: "view",
      },
      {
        type: "function",
        name: "pstrk_address",
        inputs: [],
        outputs: [
          { type: "core::starknet::contract_address::ContractAddress" },
        ],
        state_mutability: "view",
      },
      {
        type: "function",
        name: "wBTC_address",
        inputs: [],
        outputs: [
          { type: "core::starknet::contract_address::ContractAddress" },
        ],
        state_mutability: "view",
      },
      {
        type: "function",
        name: "get_btc_usd_price",
        inputs: [],
        outputs: [{ type: "(core::integer::u128, core::integer::u32)" }],
        state_mutability: "view",
      },
      {
        type: "function",
        name: "get_strk_usd_price",
        inputs: [],
        outputs: [{ type: "(core::integer::u128, core::integer::u32)" }],
        state_mutability: "view",
      },
      {
        type: "function",
        name: "get_btc_strk_rate",
        inputs: [],
        outputs: [{ type: "core::integer::u256" }],
        state_mutability: "view",
      },
    ],
  },
  {
    type: "constructor",
    name: "constructor",
    inputs: [
      {
        name: "wBTC_class_hash",
        type: "core::starknet::class_hash::ClassHash",
      },
      {
        name: "pstrk_class_hash",
        type: "core::starknet::class_hash::ClassHash",
      },
      {
        name: "verifier_class_hash",
        type: "core::starknet::class_hash::ClassHash",
      },
    ],
  },
  {
    type: "event",
    name: "contracts::incremental_merkle_tree::IncrementalMerkleTreeComponent::Event",
    kind: "enum",
    variants: [],
  },
  {
    type: "event",
    name: "contracts::PrivateSwap::Deposit",
    kind: "struct",
    members: [
      { name: "commitment", type: "core::integer::u256", kind: "key" },
      { name: "leaf_index", type: "core::integer::u32", kind: "data" },
      { name: "timestamp", type: "core::integer::u64", kind: "data" },
    ],
  },
  {
    type: "event",
    name: "contracts::PrivateSwap::Withdrawal",
    kind: "struct",
    members: [
      {
        name: "recipient",
        type: "core::starknet::contract_address::ContractAddress",
        kind: "key",
      },
      {
        name: "nullifier_hash",
        type: "core::integer::u256",
        kind: "key",
      },
    ],
  },
  {
    type: "event",
    name: "contracts::PrivateSwap::Event",
    kind: "enum",
    variants: [
      {
        name: "ImtEvent",
        type: "contracts::incremental_merkle_tree::IncrementalMerkleTreeComponent::Event",
        kind: "nested",
      },
      {
        name: "Deposit",
        type: "contracts::PrivateSwap::Deposit",
        kind: "nested",
      },
      {
        name: "Withdrawal",
        type: "contracts::PrivateSwap::Withdrawal",
        kind: "nested",
      },
    ],
  },
] as const satisfies Abi;

export default contractAbi;
