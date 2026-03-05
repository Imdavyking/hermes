// pragma_oracle.cairo
// Manual Pragma ABI — avoids pragma_lib dependency conflict

#[derive(Drop, Copy, Serde)]
pub struct PragmaPricesResponse {
    pub price: u128,
    pub decimals: u32,
    pub last_updated_timestamp: u64,
    pub num_sources_aggregated: u32,
    pub expiration_timestamp: Option<u64>,
}

#[derive(Drop, Copy, Serde)]
pub enum DataType {
    SpotEntry: felt252,
    FutureEntry: (felt252, u64),
    GenericEntry: felt252,
}

// Ignore this warnings -> so we match the Pragma ABI exactly, which has no parentheses for the enum
// variants
#[derive(Drop, Copy, Serde)]
pub enum AggregationMode {
    Median,
    Mean,
    Error,
}

#[starknet::interface]
pub trait IPragmaABI<TContractState> {
    fn get_data(
        self: @TContractState, data_type: DataType, aggregation_mode: AggregationMode,
    ) -> PragmaPricesResponse;
}
