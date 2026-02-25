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
/// * `signers` - Vector of validator public keys (max 128 validators)
/// * `threshold` - Number of signatures required for consensus (automatically calculated)
/// * `bump` - Bump seed for the PDA derivation
/// * `last_batch_id` - The last processed batch ID to prevent replay attacks
/// * `bridge_request_count` - Total count of bridge requests processed
#[account]
#[derive(InitSpace)]
pub struct ValidatorSet {
    /// List of validator public keys that can sign bridge operations
    /// Maximum length is constrained by `MAX_VALIDATORS` constant
    #[max_len(MAX_VALIDATORS)]
    pub signers: Vec<Pubkey>,
    /// Consensus threshold - number of validator signatures required
    /// Automatically calculated using the formula: num_signers - floor((num_signers - 1) / 3)
    pub threshold: u8,
    /// Bump seed for the Program Derived Address (PDA)
    pub bump: u8,
    /// Last batch ID processed to prevent replay attacks and ensure sequential processing
    pub last_batch_id: u64,
    /// Total count of bridge requests processed since initialization
    pub bridge_request_count: u64,
}

/// Represents the vault account that holds bridged tokens.
///
/// The `Vault` account is a Program Derived Address (PDA) that serves as the authority
/// for token operations. It can be set as the mint authority for tokens, allowing it to
/// mint tokens on the destination chain, or it can hold tokens in an associated token
/// account for transfer operations.
///
/// # Fields
///
/// * `address` - The public key of the vault account (same as the account's key)
/// * `bump` - Bump seed for the PDA derivation
#[account]
#[derive(InitSpace)]
pub struct Vault {
    /// Bump seed for the Program Derived Address (PDA)
    pub bump: u8,
}

/// Represents a bridging transaction that transfers tokens to a recipient.
///
/// The `BridgingTransaction` account tracks a pending token transfer that requires
/// validator consensus. Once enough validators have approved the transaction (meeting
/// the threshold), the tokens are automatically transferred or minted to the recipient,
/// and the account is closed.
///
/// # Fields
///
/// * `id` - Unique identifier for the transaction (same as the account's key)
/// * `amount` - The amount of tokens to transfer to the recipient
/// * `receiver` - The public key of the recipient on the destination chain
/// * `mint_token` - The public key of the token mint being bridged
/// * `signers` - List of validator public keys that have approved this transaction
/// * `bump` - Bump seed for the PDA derivation
/// * `batch_id` - The batch ID of this transaction (must be greater than last_batch_id)
#[account]
#[derive(InitSpace)]
pub struct BridgingTransaction {
    /// Unique identifier for the transaction
    pub id: Pubkey,
    /// The amount of tokens to transfer to the recipient
    pub amount: u64,
    /// The public key of the recipient on the destination chain
    pub receiver: Pubkey,
    /// The public key of the token mint being bridged
    pub mint_token: Pubkey,
    /// List of validator public keys that have approved this transaction
    #[max_len(MAX_VALIDATORS)]
    pub signers: Vec<Pubkey>,
    /// Bump seed for the Program Derived Address (PDA)
    pub bump: u8,
    /// The batch ID of this transaction (must be greater than last_batch_id)
    pub batch_id: u64,
}

/// Represents a pending validator set update that requires consensus.
///
/// The `ValidatorDelta` account tracks a proposed change to the validator set that
/// requires approval from the current validators. Once enough validators have approved
/// the proposal (meeting the threshold), the changes are applied to the validator set,
/// and the account is closed.
///
/// # Fields
///
/// * `id` - Unique identifier for the validator set change (same as the account's key)
/// * `added` - List of new validator public keys to add to the validator set
/// * `removed` - List of validator indices to remove from the validator set
/// * `bump` - Bump seed for the PDA derivation
/// * `batch_id` - The batch ID of this validator set change (must be greater than last_batch_id)
/// * `signers` - List of validator public keys that have approved this change
/// * `proposal_hash` - Hash of the proposal to ensure all validators approve the same change
#[account]
#[derive(InitSpace)]
pub struct ValidatorDelta {
    /// Unique identifier for the validator set change
    pub id: Pubkey,
    /// List of new validator public keys to add (max 10 per change)
    #[max_len(MAX_VALIDATORS_CHANGE)]
    pub added: Vec<Pubkey>,
    /// List of validator public keys to remove (max 10 per change)
    #[max_len(MAX_VALIDATORS_CHANGE)]
    pub removed: Vec<Pubkey>,
    /// Bump seed for the Program Derived Address (PDA)
    pub bump: u8,
    /// The batch ID of this validator set change (must be greater than last_batch_id)
    pub batch_id: u64,
    /// List of validator public keys that have approved this change
    #[max_len(MAX_VALIDATORS)]
    pub signers: Vec<Pubkey>,
    /// Hash of the proposal to ensure all validators approve the same change
    pub proposal_hash: [u8; 32],
}

/// Stores protocol-level fee configuration.
/// Created once by the bridge authority via init_fee_config.
/// Can be updated via update_fee_config.
#[account]
#[derive(InitSpace)]
pub struct FeeConfig {
    /// Minimum fee that goes to the bridge treasury (operational tip)
    pub min_operational_fee: u64,

    /// Estimated fee to refund the relayer for destination chain gas
    pub bridge_fee: u64,

    /// Treasury account where operational fees are sent
    pub treasury: Pubkey,

    /// Relayer account — receives bridge_fee directly per bridge request
    pub relayer: Pubkey,

    /// Who is allowed to update this config (bridge authority)
    pub authority: Pubkey,

    /// PDA bump
    pub bump: u8,
}
