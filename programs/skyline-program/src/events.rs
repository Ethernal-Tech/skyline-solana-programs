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

#[event]
pub struct BridgeRequestEvent {
    /// Public key of the user who initiated the bridge request
    pub sender: Pubkey,
    /// Amount of tokens to be bridged to the destination chain
    pub amount: u64,
    /// Receiver's address on the destination chain (fixed 57-byte array)
    /// This format accommodates various address formats across different blockchains
    pub receiver: [u8; 57],
    /// Chain ID identifying the destination blockchain network
    pub destination_chain: u8,
    /// Public key of the token mint being bridged
    pub mint_token: Pubkey,
    /// The batch request ID associated with this bridge request
    pub batch_request_id: u64,
}
