use anchor_lang::prelude::*;

#[event]
pub struct TransactionExecutedEvent {
    /// The ID of the transaction that was executed
    pub transaction_id: Pubkey,
    /// The amount of tokens that were executed
    pub batch_id: u64,
}

#[event]
pub struct ValidatorSetUpdatedEvent {
    /// The new list of validator signers
    pub new_signers: Vec<Pubkey>,
    /// The new threshold for the validator set
    pub new_threshold: u8,
    /// The batch ID associated with the update
    pub batch_id: u64,
}
