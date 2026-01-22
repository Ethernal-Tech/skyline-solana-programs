//! Helper functions for the Skyline bridge program.
//!
//! This module contains utility functions used throughout the bridge program
//! for common operations like threshold calculation and authority validation.

use anchor_lang::{prelude::*, solana_program::program_option::COption};
use anchor_spl::token::{Mint, TokenAccount};

use crate::CustomError;

/// Calculates the consensus threshold for a given number of validators.
///
/// Formula: `num_signers - floor((num_signers - 1) / 3)`
///
/// This ensures Byzantine Fault Tolerance: the system can tolerate up to
/// `floor((num_signers - 1) / 3)` Byzantine (malicious or offline) validators
/// while still reaching consensus.
///
/// # Arguments
///
/// * `num_signers` - The number of validators in the validator set
///
/// # Returns
///
/// The minimum number of validator signatures required for consensus
///
/// # Examples
///
/// ```
/// // 4 validators: 4 - 1 = 3 (75%) - tolerates 0 Byzantine
/// // 5 validators: 5 - 1 = 4 (80%) - tolerates 1 Byzantine  
/// // 7 validators: 7 - 2 = 5 (71%) - tolerates 2 Byzantine
/// // 10 validators: 10 - 3 = 7 (70%) - tolerates 3 Byzantine
/// ```
pub fn calculate_threshold(num_signers: usize) -> u8 {
    // Integer division automatically floors in Rust
    num_signers as u8 - ((num_signers - 1) / 3) as u8
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

pub fn validate_token_account(
    account: &UncheckedAccount,
    mint: &Account<Mint>,
    vault: &AccountInfo,
) -> Result<()> {
    let token_account = TokenAccount::try_deserialize(&mut &account.data.borrow()[..])?;
    require!(
        token_account.mint == mint.key(),
        CustomError::InvalidMintToken
    );
    require!(
        token_account.owner == vault.key(),
        CustomError::InvalidVault
    );
    // q vault_ata.key() missing check?

    Ok(())
}
