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
    /// This error occurs when trying to set more than 128 validators in the validator set.
    /// The limit is defined by the `MAX_VALIDATORS` constant.
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
    /// the required consensus threshold. The threshold is automatically calculated using
    /// the formula: num_signers - floor((num_signers - 1) / 3).
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

    /// Invalid batch ID provided.
    ///
    /// This error occurs when the batch_id is not greater than the last_batch_id.
    /// Batch IDs must be strictly increasing to prevent replay attacks and ensure
    /// sequential processing of operations.
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

    /// Invalid vault provided.
    ///
    /// This error occurs when the vault is not valid.
    #[msg("Invalid vault provided")]
    InvalidVault,

    /// Invalid amount provided.
    ///
    /// This error occurs when the amount is zero.
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    /// Invalid token account.
    ///
    /// This error occurs when the token account is not valid.
    #[msg("Invalid token account")]
    InvalidTokenAccount,

    /// Duplicate validators found in added list.
    ///
    /// This error occurs when there are duplicate validators in the added list during a validator set update.
    #[msg("Duplicate validators found in added list")]
    DuplicateValidatorsInAdded,

    /// Duplicate validators found in removed list.
    ///
    /// This error occurs when there are duplicate validators in the removed list during a validator set update.
    #[msg("Duplicate validators found in removed list")]
    DuplicateValidatorsInRemoved,

    /// Cannot add and remove the same signer.
    ///     
    /// This error occurs when the same validator is present in both the added and removed lists during a validator set update.
    #[msg("Cannot add and remove the same signer")]
    AddingAndRemovingSameSigner,

    /// Cannot remove more validators than will exist after additions.
    ///
    /// This error occurs when the number of validators being removed exceeds the number of validators that will remain after additions during a validator set update.
    #[msg("Cannot remove more validators than will exist after additions")]
    TooManyValidatorsRemoved,

    #[msg("Insufficient bridge fee provided")]
    InsufficientFee,

    #[msg("Treasury account does not match fee config")]
    InvalidTreasury,

    #[msg("Unauthorized: Only the fee config authority can perform this action")]
    Unauthorized,

    #[msg("Relayer account does not match fee config")]
    InvalidRelayer,

    #[msg("Fee values overflow when combined — reduce min_operational_fee or bridge_fee")]
    FeeConfigOverflow,
}
