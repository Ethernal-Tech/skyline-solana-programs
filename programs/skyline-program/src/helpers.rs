use anchor_lang::{prelude::*, solana_program::program_option::COption};
use anchor_spl::token::Mint;

pub fn calculate_threshold(num_signers: usize) -> u8 {
    num_signers as u8 - (((num_signers as f32) - 1.0) / 3.0).floor() as u8
}

pub fn is_vault_mint_authority(mint: &Account<Mint>, vault: &AccountInfo) -> bool {
    match mint.mint_authority {
        COption::Some(authority) => authority == vault.key(),
        COption::None => false,
    }
}
