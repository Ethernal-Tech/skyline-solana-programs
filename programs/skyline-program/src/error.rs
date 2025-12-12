//! Custom error types for the Skyline bridge program.
//!
//! This module defines all the custom error conditions that can occur during
//! bridge operations. These errors provide clear feedback about what went wrong
//! and help with debugging and user experience.

use anchor_lang::prelude::*;

/// Custom error codes for the Skyline bridge program.
///
/// Each error variant represents a specific failure condition that can occur
/// during bridge operations. The error messages are designed to be clear and
/// actionable for developers and users.
#[error_code]
pub enum CustomError {
    /// Maximum number of validators exceeded.
    ///
    /// This error occurs when trying to set more than 10 validators in the validator set.
    /// The limit is imposed by Solana's transaction signing constraints.
    #[msg("Maximum number of validators exceeded")]
    MaxValidatorsExceeded,

    /// Minimum number of validators not met.
    ///
    /// This error occurs when trying to set fewer than 4 validators in the validator set.
    /// A minimum number of validators is required for proper decentralization and security.
    #[msg("Minimum number of validators not met")]
    MinValidatorsNotMet,

    /// Validators need to be unique.
    ///
    /// This error occurs when duplicate validator public keys are provided during
    /// validator set initialization or updates. Each validator must have a unique identity.
    #[msg("Validators need to be unique")]
    ValidatorsNotUnique,

    /// Not enough signers provided.
    ///
    /// This error occurs when the number of validator signatures provided is less than
    /// the required consensus threshold. The threshold is automatically calculated as
    /// 2/3 of the validator count, rounded up.
    #[msg("Not enough signers provided")]
    NotEnoughSigners,

    /// Invalid signer provided.
    ///
    /// This error occurs when a signer is not part of the current validator set.
    /// Only validators from the authorized set can sign critical bridge operations.
    #[msg("Invalid signer provided")]
    InvalidSigner,

    /// Insufficient funds in the account.
    ///
    /// This error occurs when a user tries to bridge more tokens than they have
    /// available in their token account. The user must have sufficient balance
    /// to cover the bridging amount.
    #[msg("Insufficient funds in the account")]
    InsufficientFunds,

    /// Transaction in progress.
    ///
    /// This error occurs when a transaction is already in progress.
    #[msg("Invalid batch id; Batch Id must be higher than last batch id")]
    InvalidBatchId,

    /// Invalid receiver provided.
    ///
    /// This error occurs when a receiver is the same as the payer.
    #[msg("Invalid receiver provided")]
    InvalidReceiver,

    /// Invalid mint token provided.
    ///
    /// This error occurs when a mint token is the same as the payer's mint token.
    #[msg("Invalid mint token provided")]
    InvalidMintToken,

    /// No signers provided.
    ///
    /// This error occurs when no signers are provided.
    #[msg("No signers provided")]
    NoSignersProvided,

    /// Signer already approved.
    ///
    /// This error occurs when a signer is already approved.
    #[msg("Signer already approved")]
    SignerAlreadyApproved,

    /// Invalid proposal hash.
    ///
    /// This error occurs when the proposal hash is not valid.
    #[msg("Invalid proposal hash")]
    InvalidProposalHash,

    /// Adding existing signer.
    ///
    /// This error occurs when a signer is already in the validator set.
    #[msg("Adding existing signer")]
    AddingExistingSigner,

    /// Removing non existent signer.
    ///
    /// This error occurs when a signer is not in the validator set.
    #[msg("Removing non existent signer")]
    RemovingNonExistentSigner,

    /// Duplicate signers provided.
    ///
    /// This error occurs when duplicate signers are provided.
    #[msg("Duplicate signers provided")]
    DuplicateSignersProvided,

    /// Bridging transaction mismatch.
    ///
    /// This error occurs when the bridging transaction details do not match.
    #[msg("Bridging transaction details do not match")]
    BridgingTransactionMismatch,
}
