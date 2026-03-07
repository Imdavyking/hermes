#[starknet::contract]
mod MockUSDC {
    use openzeppelin::token::erc20::{ERC20Component, ERC20HooksEmptyImpl};
    use starknet::ContractAddress;

    component!(path: ERC20Component, storage: erc20, event: ERC20Event);

    #[abi(embed_v0)]
    impl ERC20Impl = ERC20Component::ERC20Impl<ContractState>;
    #[abi(embed_v0)]
    impl ERC20MetadataImpl of openzeppelin::token::erc20::interface::IERC20Metadata<ContractState> {
        fn name(self: @ContractState) -> ByteArray {
            self.erc20.name()
        }
        fn symbol(self: @ContractState) -> ByteArray {
            self.erc20.symbol()
        }
        fn decimals(self: @ContractState) -> u8 {
            6
        }
    }
    impl ERC20InternalImpl = ERC20Component::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        erc20: ERC20Component::Storage,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        ERC20Event: ERC20Component::Event,
    }

    #[constructor]
    fn constructor(ref self: ContractState) {
        self.erc20.initializer("USDC", "USDC");
    }

    #[external(v0)]
    fn mint(ref self: ContractState, recipient: ContractAddress, amount: u256) {
        self.erc20.mint(recipient, amount);
    }
}
