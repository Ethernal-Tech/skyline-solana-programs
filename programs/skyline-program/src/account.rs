//! Account structures for the Skyline bridge program.
//!
//! This module defines the data structures that represent the state of the bridge system.
//! These accounts are stored on-chain and contain the information necessary for bridge operations.

use crate::*;

/// Represents the validator set that controls bridge operations.
///
/// The `ValidatorSet` account stores the list of validators authorized to perform
/// critical bridge operations and the consensus threshold required for approval.
/// This account is initialized once and can be updated through the validator set
/// change instruction with proper consensus.
///
/// # Fields
///
/// * `signers` - Vector of validator public keys (max 10 validators)
/// * `threshold` - Number of signatures required for consensus (automatically set to 2/3)
/// * `bump` - Bump seed for the PDA derivation
#[account]
#[derive(InitSpace)]
pub struct ValidatorSet {
    /// List of validator public keys that can sign bridge operations
    /// Maximum length is constrained by `MAX_VALIDATORS` constant
    #[max_len(MAX_VALIDATORS)]
    pub signers: Vec<Pubkey>,
    /// Consensus threshold - number of validator signatures required
    /// Automatically calculated as 2/3 of validator count, rounded up
    pub threshold: u8,
    /// Bump seed for the Program Derived Address (PDA)
    pub bump: u8,
    /// Last batch id
    pub last_batch_id: u64,
    /// Count of bridge requests processed
    pub bridge_request_count: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    /// Vault address
    pub address: Pubkey,
    /// Vault bump
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct BridgingTransaction {
    /// The ID of the transaction
    pub id: Pubkey,
    /// The amount of tokens that were bridged
    pub amount: u64,
    /// The receiver's address
    pub receiver: Pubkey,
    /// The public key of the token mint being bridged
    pub mint_token: Pubkey,
    /// Signers that have approved the transaction
    #[max_len(MAX_VALIDATORS)]
    pub signers: Vec<Pubkey>,
    /// Bump
    pub bump: u8,
    /// Batch ID
    pub batch_id: u64,
}

#[account]
#[derive(InitSpace)]
pub struct ValidatorDelta {
    pub id: Pubkey,
    #[max_len(MAX_VALIDATORS_CHANGE)]
    pub added: Vec<Pubkey>,
    #[max_len(MAX_VALIDATORS_CHANGE)]
    pub removed: Vec<u64>,
    /// Bump
    pub bump: u8,
    /// Batch ID
    pub batch_id: u64,
    /// Signers that have approved the validator set change
    #[max_len(MAX_VALIDATORS)]
    pub signers: Vec<Pubkey>,
    /// Proposal hash
    pub proposal_hash: [u8; 32],
}
