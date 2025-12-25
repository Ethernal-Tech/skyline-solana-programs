//! Helper functions for the Skyline bridge program.
//!
//! This module contains utility functions used throughout the bridge program
//! for common operations like threshold calculation and authority validation.

use anchor_lang::{prelude::*, solana_program::program_option::COption};
use anchor_spl::token::Mint;

/// Calculates the consensus threshold for a given number of validators.
///
/// The threshold is calculated using the formula: `num_signers - floor((num_signers - 1) / 3)`.
/// This ensures that at least a supermajority of validators must approve critical operations.
///
/// # Arguments
///
/// * `num_signers` - The number of validators in the validator set
///
/// # Returns
///
/// The number of validator signatures required for consensus (as u8)
///
/// # Examples
///
/// ```
/// // For 4 validators: 4 - floor(3/3) = 4 - 1 = 3
/// // For 6 validators: 6 - floor(5/3) = 6 - 1 = 5
/// // For 9 validators: 9 - floor(8/3) = 9 - 2 = 7
/// ```
pub fn calculate_threshold(num_signers: usize) -> u8 {
    num_signers as u8 - (((num_signers as f32) - 1.0) / 3.0).floor() as u8
}

/// Checks if the vault is the mint authority for a given token mint.
///
/// This function determines whether the vault has mint authority over a token,
/// which affects how tokens are handled during bridge operations:
/// - If the vault is the mint authority, tokens can be burned/minted
/// - If not, tokens must be transferred to/from the vault's associated token account
///
/// # Arguments
///
/// * `mint` - The token mint account to check
/// * `vault` - The vault account info to compare against
///
/// # Returns
///
/// `true` if the vault is the mint authority, `false` otherwise
pub fn is_vault_mint_authority(mint: &Account<Mint>, vault: &AccountInfo) -> bool {
    match mint.mint_authority {
        COption::Some(authority) => authority == vault.key(),
        COption::None => false,
    }
}
