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
}

/// Represents a cross-chain bridging request.
///
/// The `BridgingRequest` account is created when a user initiates a cross-chain
/// token transfer. It contains all the information needed to process the transfer
/// on the destination chain, including the amount, recipient, and destination chain ID.
///
/// This account is created per transfer request and can be closed after the
/// transfer is completed or cancelled.
///
/// # Fields
///
/// * `sender` - Public key of the user initiating the bridge request
/// * `amount` - Amount of tokens to be bridged
/// * `receiver` - Receiver's address on the destination chain (57 bytes)
/// * `destination_chain` - Chain ID of the destination blockchain
/// * `mint_token` - Public key of the token mint being bridged
#[account]
#[derive(InitSpace)]
pub struct BridgingRequest {
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
}
