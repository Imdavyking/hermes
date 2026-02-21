use crate::field::FieldTrait;
use crate::poseidon2lib::Poseidon2Trait;


const ROOT_HISTORY_SIZE: u32 = 30;

// -------------------------------------------------------
// Errors
// -------------------------------------------------------
pub mod Errors {
    pub const DEPTH_ZERO: felt252 = 'depth must be > 0';
    pub const DEPTH_TOO_LARGE: felt252 = 'depth must be < 32';
    pub const INDEX_OUT_OF_BOUNDS: felt252 = 'index out of bounds';
    pub const TREE_FULL: felt252 = 'merkle tree is full';
}

// -------------------------------------------------------
// Component — embed into any contract
// -------------------------------------------------------
#[starknet::component]
pub mod IncrementalMerkleTreeComponent {
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use super::{Errors, FieldTrait, Poseidon2Trait, ROOT_HISTORY_SIZE, pow2, zeros};

    #[storage]
    pub struct Storage {
        imt_depth: u32,
        imt_roots: Map<u32, u256>, // circular buffer of last 30 roots
        imt_current_root_index: u32,
        imt_next_leaf_index: u32,
        imt_cached_subtrees: Map<u32, u256> // cached left siblings per level
    }

    #[generate_trait]
    pub impl InternalImpl<
        TContractState, +HasComponent<TContractState>,
    > of InternalTrait<TContractState> {
        // Call once from constructor
        fn initializer(ref self: ComponentState<TContractState>, depth: u32) {
            assert(depth > 0, Errors::DEPTH_ZERO);
            assert(depth < 32, Errors::DEPTH_TOO_LARGE);
            self.imt_depth.write(depth);
            // store initial all-zero root
            self.imt_roots.write(0, zeros(depth));
        }

        // Insert a leaf, returns the inserted leaf index
        fn _insert(ref self: ComponentState<TContractState>, leaf: u256) -> u32 {
            let next_index = self.imt_next_leaf_index.read();
            let depth = self.imt_depth.read();

            assert(next_index < pow2(depth), Errors::TREE_FULL);

            let mut current_index = next_index;
            let mut current_hash: u256 = leaf;

            let mut i: u32 = 0;
            while i < depth {
                let (left, right) = if current_index % 2 == 0 {
                    // even index — we're the left child, right sibling is a zero subtree
                    self.imt_cached_subtrees.write(i, current_hash);
                    (current_hash, zeros(i))
                } else {
                    // odd index — we're the right child, left sibling is cached
                    (self.imt_cached_subtrees.read(i), current_hash)
                };
                // hash(left, right) using Poseidon2 over BN254
                let result = Poseidon2Trait::hash_2(
                    FieldTrait::new_unchecked(left), FieldTrait::new_unchecked(right),
                );
                current_hash = result.inner();
                current_index /= 2;
                i += 1;
            }

            // store new root in circular buffer
            let new_root_index = (self.imt_current_root_index.read() + 1) % ROOT_HISTORY_SIZE;
            self.imt_current_root_index.write(new_root_index);
            self.imt_roots.write(new_root_index, current_hash);
            self.imt_next_leaf_index.write(next_index + 1);

            next_index
        }

        // Check if a root is in the last ROOT_HISTORY_SIZE roots
        fn is_known_root(self: @ComponentState<TContractState>, root: u256) -> bool {
            if root == 0 {
                return false;
            }

            let current = self.imt_current_root_index.read();
            let mut i = current;

            loop {
                if self.imt_roots.read(i) == root {
                    break true;
                }
                // walk backwards through circular buffer
                i = if i == 0 {
                    ROOT_HISTORY_SIZE - 1
                } else {
                    i - 1
                };
                if i == current {
                    break false;
                }
            }
        }

        fn current_root(self: @ComponentState<TContractState>) -> u256 {
            let idx = self.imt_current_root_index.read();
            self.imt_roots.read(idx)
        }

        fn next_leaf_index(self: @ComponentState<TContractState>) -> u32 {
            self.imt_next_leaf_index.read()
        }
    }
}

// -------------------------------------------------------
// Precomputed Poseidon2 zero subtrees (BN254)
// zeros(0) = Poseidon2(0)
// zeros(i) = Poseidon2(zeros(i-1), zeros(i-1))
// These match the Solidity contract exactly.
// -------------------------------------------------------
fn zeros(i: u32) -> u256 {
    match i {
        0 => 0x0d823319708ab99ec915efd4f7e03d11ca1790918e8f04cd14100aceca2aa9ff,
        1 => 0x170a9598425eb05eb8dc06986c6afc717811e874326a79576c02d338bdf14f13,
        2 => 0x273b1a40397b618dac2fc66ceb71399a3e1a60341e546e053cbfa5995e824caf,
        3 => 0x16bf9b1fb2dfa9d88cfb1752d6937a1594d257c2053dff3cb971016bfcffe2a1,
        4 => 0x1288271e1f93a29fa6e748b7468a77a9b8fc3db6b216ce5fc2601fc3e9bd6b36,
        5 => 0x1d47548adec1068354d163be4ffa348ca89f079b039c9191378584abd79edeca,
        6 => 0x0b98a89e6827ef697b8fb2e280a2342d61db1eb5efc229f5f4a77fb333b80bef,
        7 => 0x231555e37e6b206f43fdcd4d660c47442d76aab1ef552aef6db45f3f9cf2e955,
        8 => 0x03d0dc8c92e2844abcc5fdefe8cb67d93034de0862943990b09c6b8e3fa27a86,
        9 => 0x1d51ac275f47f10e592b8e690fd3b28a76106893ac3e60cd7b2a3a443f4e8355,
        10 => 0x16b671eb844a8e4e463e820e26560357edee4ecfdbf5d7b0a28799911505088d,
        11 => 0x115ea0c2f132c5914d5bb737af6eed04115a3896f0d65e12e761ca560083da15,
        12 => 0x139a5b42099806c76efb52da0ec1dde06a836bf6f87ef7ab4bac7d00637e28f0,
        13 => 0x0804853482335a6533eb6a4ddfc215a08026db413d247a7695e807e38debea8e,
        14 => 0x2f0b264ab5f5630b591af93d93ec2dfed28eef017b251e40905cdf7983689803,
        15 => 0x170fc161bf1b9610bf196c173bdae82c4adfd93888dc317f5010822a3ba9ebee,
        16 => 0x0b2e7665b17622cc0243b6fa35110aa7dd0ee3cc9409650172aa786ca5971439,
        17 => 0x12d5a033cbeff854c5ba0c5628ac4628104be6ab370699a1b2b4209e518b0ac5,
        18 => 0x1bc59846eb7eafafc85ba9a99a89562763735322e4255b7c1788a8fe8b90bf5d,
        19 => 0x1b9421fbd79f6972a348a3dd4721781ec25a5d8d27342942ae00aba80a3904d4,
        20 => 0x087fde1c4c9c27c347f347083139eee8759179d255ec8381c02298d3d6ccd233,
        21 => 0x1e26b1884cb500b5e6bbfdeedbdca34b961caf3fa9839ea794bfc7f87d10b3f1,
        22 => 0x09fc1a538b88bda55a53253c62c153e67e8289729afd9b8bfd3f46f5eecd5a72,
        23 => 0x14cd0edec3423652211db5210475a230ca4771cd1e45315bcd6ea640f14077e2,
        24 => 0x1d776a76bc76f4305ef0b0b27a58a9565864fe1b9f2a198e8247b3e599e036ca,
        25 => 0x1f93e3103fed2d3bd056c3ac49b4a0728578be33595959788fa25514cdb5d42f,
        26 => 0x138b0576ee7346fb3f6cfb632f92ae206395824b9333a183c15470404c977a3b,
        27 => 0x0745de8522abfcd24bd50875865592f73a190070b4cb3d8976e3dbff8fdb7f3d,
        28 => 0x2ffb8c798b9dd2645e9187858cb92a86c86dcd1138f5d610c33df2696f5f6860,
        29 => 0x2612a1395168260c9999287df0e3c3f1b0d8e008e90cd15941e4c2df08a68a5a,
        30 => 0x10ebedce66a910039c8edb2cd832d6a9857648ccff5e99b5d08009b44b088edf,
        31 => 0x213fb841f9de06958cf4403477bdbff7c59d6249daabfee147f853db7c808082,
        _ => { panic!("depth out of bounds"); },
    }
}

// 2^n for u32
fn pow2(n: u32) -> u32 {
    let mut result: u32 = 1;
    let mut i: u32 = 0;
    while i < n {
        result *= 2;
        i += 1;
    }
    result
}
