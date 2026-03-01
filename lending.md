You're already halfway there — you're using Vesu for yield deposits. Vesu also supports borrowing against collateral, it's the same protocol.
The flow you need to add:
User deposits wBTC (via ZK proof, already exists)
↓
Instead of just earning yield, they can borrow USDC against it
↓
Contract deposits wBTC into Vesu as collateral
↓
Contract calls Vesu borrow() to draw USDC to the user
↓
User repays USDC + interest later to reclaim wBTC
New Vesu interface you need:
rust#[starknet::interface]
trait IVesuPool<TContractState> {
// Deposit collateral and borrow in one call
fn modify_position(
ref self: TContractState,
pool_id: felt252,
collateral_asset: ContractAddress,
debt_asset: ContractAddress,
user: ContractAddress,
collateral_delta: Amount, // how much wBTC to add
debt_delta: Amount, // how much USDC to borrow
data: Span<felt252>,
) -> (Position, u256, u256);

    fn get_position(
        self: @TContractState,
        pool_id: felt252,
        collateral_asset: ContractAddress,
        debt_asset: ContractAddress,
        user: ContractAddress,
    ) -> Position;

}

// Track debt positions per nullifier
nullifier_debt: Map<u256, u256>, // USDC borrowed
nullifier_collateral: Map<u256, u256>, // wBTC locked as collateral
nullifier_pool_id: Map<u256, felt252>, // which Vesu pool

// Borrow USDC against deposited wBTC
fn borrow_usdc(
ref self: ContractState,
proof: Span<felt252>,
recipient: ContractAddress,
usdc_amount: u256,
) {
// ZK proof proves ownership of the wBTC deposit
let nullifier_hash = self.verify_proof_and_consume(proof, recipient);

    // Deposit wBTC into Vesu as collateral
    // Borrow USDC against it
    // Send USDC to recipient
    // Record debt against nullifier_hash

}

// Repay USDC debt and reclaim wBTC
fn repay_and_reclaim(
ref self: ContractState,
nullifier_hash: u256,
repay_amount: u256,
) {
// No ZK proof needed — nullifier_hash is the credential
// Same pattern as stop_earning()
let recipient = self.nullifier_recipient.read(nullifier_hash);
assert(get_caller_address() == recipient, Errors::NOT_RECIPIENT);

    // Pull USDC from caller
    // Repay Vesu debt
    // Return wBTC to recipient

}
