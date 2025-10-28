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
}
