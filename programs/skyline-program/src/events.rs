use anchor_lang::prelude::*;

#[event]
pub struct TransactionExecutedEvent {
    /// The ID of the transaction that was executed
    pub transaction_id: Pubkey,
    /// The amount of tokens that were executed
    pub batch_id: u64,
}
