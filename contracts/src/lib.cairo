use starknet::{ContractAddress, get_block_timestamp, get_caller_address, get_contract_address};
mod field;
mod incremental_merkle_tree;
mod pBTC;
mod pSTRK;
mod poseidon2;
mod poseidon2lib;
mod pragma_oracle;

// -------------------------------------------------------
// Interfaces
// -------------------------------------------------------

#[starknet::interface]
trait IVerifier<TContractState> {
    fn verify_ultra_keccak_zk_honk_proof(
        self: @TContractState, full_proof_with_hints: Span<felt252>,
    ) -> Result<Span<u256>, felt252>;
}

#[starknet::interface]
trait IPSTRKMint<TContractState> {
    fn mint(ref self: TContractState, recipient: ContractAddress, amount: u256);
}

#[starknet::interface]
trait IPBTCMint<TContractState> {
    fn mint(ref self: TContractState, recipient: ContractAddress, amount: u256);
}

#[starknet::interface]
trait IPrivateSwap<TContractState> {
    fn deposit(ref self: TContractState, commitment: u256);
    fn withdraw(
        ref self: TContractState,
        proof: Span<felt252>,
        root: u256,
        nullifier_hash: u256,
        recipient: ContractAddress,
    );
    fn mock_btc_mint(ref self: TContractState, recipient: ContractAddress, amount: u256);
    fn current_root(self: @TContractState) -> u256;
    fn next_leaf_index(self: @TContractState) -> u32;
    fn is_known_root(self: @TContractState, root: u256) -> bool;
    fn pstrk_address(self: @TContractState) -> ContractAddress;
    fn pbtc_address(self: @TContractState) -> ContractAddress;
    fn get_btc_usd_price(self: @TContractState) -> (u128, u32);
    fn get_strk_usd_price(self: @TContractState) -> (u128, u32);
    fn get_btc_strk_rate(self: @TContractState) -> u256;
}

// -------------------------------------------------------
// Contract
// -------------------------------------------------------

#[starknet::contract]
mod PrivateSwap {
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
    use crate::pragma_oracle::{
        AggregationMode, DataType, IPragmaABIDispatcher, IPragmaABIDispatcherTrait,
        PragmaPricesResponse,
    };
    use super::{
        ContractAddress, IPBTCMintDispatcher, IPBTCMintDispatcherTrait, IPSTRKMintDispatcher,
        IPSTRKMintDispatcherTrait, IVerifierDispatcher, IVerifierDispatcherTrait,
        get_block_timestamp, get_caller_address, get_contract_address,
    };
    component!(path: IncrementalMerkleTreeComponent, storage: imt, event: ImtEvent);

    // 1 pBTC — 8 decimals
    const DENOMINATION: u256 = 100_000_000;
    // Merkle tree depth — supports up to 2^20 = ~1M deposits
    const TREE_DEPTH: u32 = 20;
    // Pragma pair keys
    const BTC_USD: felt252 = 'BTC/USD';
    const STRK_USD: felt252 = 'STRK/USD';

    // -------------------------------------------------------
    // Storage
    // -------------------------------------------------------
    #[storage]
    struct Storage {
        #[substorage(v0)]
        imt: IncrementalMerkleTreeComponent::Storage,
        commitments: Map<u256, bool>,
        nullifier_hashes: Map<u256, bool>,
        pbtc: ContractAddress,
        pstrk: ContractAddress,
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
    fn constructor(
        ref self: ContractState,
        pbtc_class_hash: ClassHash,
        pstrk_class_hash: ClassHash,
        verifier_class_hash: ClassHash,
    ) {
        // Deploy pBTC — no minter restriction, mock_btc_mint is open
        let mut pbtc_calldata: Array<felt252> = array![];
        let (pbtc_address, _) = deploy_syscall(pbtc_class_hash, 0, pbtc_calldata.span(), false)
            .unwrap_syscall();
        self.pbtc.write(pbtc_address);

        // Deploy pSTRK — minter is this contract so withdraw can mint
        let contract_address = get_contract_address();
        let mut pstrk_calldata: Array<felt252> = array![];
        pstrk_calldata.append(contract_address.into());
        let (pstrk_address, _) = deploy_syscall(pstrk_class_hash, 0, pstrk_calldata.span(), false)
            .unwrap_syscall();
        self.pstrk.write(pstrk_address);

        // Deploy Verifier — no constructor args needed
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
        // MOCK MINT — for testing only
        // Lets anyone mint pBTC to test the deposit/withdraw flow
        // ---------------------------------------------------
        fn mock_btc_mint(ref self: ContractState, recipient: ContractAddress, amount: u256) {
            let pbtc = IPBTCMintDispatcher { contract_address: self.pbtc.read() };
            pbtc.mint(recipient, amount);
        }

        // ---------------------------------------------------
        // DEPOSIT
        // User generates commitment = Poseidon2(nullifier, secret) offchain
        // Sends 1 pBTC + the commitment hash
        // ---------------------------------------------------
        fn deposit(ref self: ContractState, commitment: u256) {
            assert(!self.commitments.read(commitment), 'commitment already used');

            // pull exactly 1 pBTC from caller
            let pbtc = IERC20Dispatcher { contract_address: self.pbtc.read() };
            let success = pbtc
                .transfer_from(get_caller_address(), get_contract_address(), DENOMINATION);
            assert(success, 'pBTC transfer failed');

            let leaf_index = self.imt._insert(commitment);
            self.commitments.write(commitment, true);
            self.emit(Deposit { commitment, leaf_index, timestamp: get_block_timestamp() });
        }

        // ---------------------------------------------------
        // WITHDRAW
        // User submits a Noir proof that they know a secret
        // corresponding to a commitment in the tree.
        // Contract mints pSTRK at BTC/STRK market rate via Pragma.
        // ---------------------------------------------------
        fn withdraw(
            ref self: ContractState,
            proof: Span<felt252>,
            root: u256,
            nullifier_hash: u256,
            recipient: ContractAddress,
        ) {
            // 1. root must be a root we've seen (last 30)
            assert(self.imt.is_known_root(root), 'unknown root');

            // 2. nullifier must not be spent
            assert(!self.nullifier_hashes.read(nullifier_hash), 'nullifier used');

            // 3. verify Noir proof via Garaga
            let verifier = IVerifierDispatcher { contract_address: self.verifier.read() };
            let result = verifier.verify_ultra_keccak_zk_honk_proof(proof);
            assert(result.is_ok(), 'invalid proof');

            // 4. mark nullifier spent before external calls — reentrancy guard
            self.nullifier_hashes.write(nullifier_hash, true);
            // 5. fetch BTC/USD and STRK/USD from Pragma, derive BTC/STRK cross rate
            let (btc_usd, btc_dec) = self.get_token_price(DataType::SpotEntry(BTC_USD));
            let (strk_usd, strk_dec) = self.get_token_price(DataType::SpotEntry(STRK_USD));

            assert(btc_usd > 0, 'invalid BTC price');
            assert(strk_usd > 0, 'invalid STRK price');

            //     BTC/STRK = (BTC/USD) / (STRK/USD)
            // normalise decimal factors then scale to pSTRK 18 decimals
            let pstrk_amount: u256 = (DENOMINATION * btc_usd.into() * self.pow10(strk_dec.into()))
                / (strk_usd.into() * self.pow10(btc_dec.into()));

            assert(pstrk_amount > 0, 'pSTRK amount is zero');

            // 6. mint pSTRK to recipient
            let pstrk = IPSTRKMintDispatcher { contract_address: self.pstrk.read() };
            pstrk.mint(recipient, pstrk_amount);

            self.emit(Withdrawal { recipient, nullifier_hash });
        }

        fn get_btc_usd_price(self: @ContractState) -> (u128, u32) {
            self.get_token_price(DataType::SpotEntry(BTC_USD))
        }

        fn get_strk_usd_price(self: @ContractState) -> (u128, u32) {
            self.get_token_price(DataType::SpotEntry(STRK_USD))
        }

        fn get_btc_strk_rate(self: @ContractState) -> u256 {
            let (btc_usd, btc_dec) = self.get_token_price(DataType::SpotEntry(BTC_USD));
            let (strk_usd, strk_dec) = self.get_token_price(DataType::SpotEntry(STRK_USD));

            assert(btc_usd > 0, 'invalid BTC price');
            assert(strk_usd > 0, 'invalid STRK price');

            // how many pSTRK you get for 1 pBTC
            (DENOMINATION * btc_usd.into() * self.pow10(strk_dec.into()))
                / (strk_usd.into() * self.pow10(btc_dec.into()))
        }

        // ---------------------------------------------------
        // Views
        // ---------------------------------------------------
        fn current_root(self: @ContractState) -> u256 {
            self.imt.current_root()
        }

        fn next_leaf_index(self: @ContractState) -> u32 {
            self.imt.next_leaf_index()
        }

        fn is_known_root(self: @ContractState, root: u256) -> bool {
            self.imt.is_known_root(root)
        }

        fn pstrk_address(self: @ContractState) -> ContractAddress {
            self.pstrk.read()
        }

        fn pbtc_address(self: @ContractState) -> ContractAddress {
            self.pbtc.read()
        }
    }

    // -------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------

    #[generate_trait]
    impl Private of PrivateTrait {
        fn get_token_price(self: @ContractState, asset: DataType) -> (u128, u32) {
            let oracle_address: ContractAddress =
                0x036031daa264c24520b11d93af622c848b2499b66b41d611bac95e13cfca131a
                .try_into()
                .unwrap();
            let oracle = IPragmaABIDispatcher { contract_address: oracle_address };
            // Ignore this warnings -> so we match the Pragma ABI exactly, which has no parentheses
            // for the enum variants
            let output: PragmaPricesResponse = oracle.get_data(asset, AggregationMode::Median(()));
            (output.price, output.decimals)
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
