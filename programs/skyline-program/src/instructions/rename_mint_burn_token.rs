//! Update the on-chain name and symbol of a registered mint/burn token.

use anchor_lang::solana_program::sysvar;
use anchor_spl::{
    metadata::{
        mpl_token_metadata::{instructions::UpdateV1CpiBuilder, types::Data},
        Metadata, MetadataAccount,
    },
    token::Mint,
};

use crate::*;

#[derive(Accounts)]
#[instruction(token_id: u16)]
pub struct RenameMintBurnToken<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [FEE_CONFIG_SEED],
        bump = fee_config.bump,
        has_one = authority @ CustomError::Unauthorized,
    )]
    pub fee_config: Account<'info, FeeConfig>,

    #[account(
        seeds = [TOKEN_REGISTRY_SEED, token_id.to_le_bytes().as_ref()],
        bump = token_registry.bump,
        has_one = mint @ CustomError::InvalidMintToken,
        constraint = !token_registry.is_lock_unlock @ CustomError::NotMintBurn,
    )]
    pub token_registry: Account<'info, TokenRegistry>,
    pub mint: Account<'info, Mint>,

    #[account(seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [b"metadata", metadata_program.key().as_ref(), mint.key().as_ref()],
        bump,
        seeds::program = metadata_program.key(),
    )]
    pub metadata: Account<'info, MetadataAccount>,
    pub metadata_program: Program<'info, Metadata>,
    pub system_program: Program<'info, System>,
    /// CHECK: The address constraint pins the instructions sysvar required by Metaplex.
    #[account(address = sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
}

impl RenameMintBurnToken<'_> {
    pub fn process_instruction(
        ctx: Context<RenameMintBurnToken>,
        _token_id: u16,
        name: String,
        symbol: String,
    ) -> Result<()> {
        let accounts = ctx.accounts;
        let metadata = &accounts.metadata;
        // Metaplex replaces Data as a whole. Carry the other fields forward.
        let data = Data {
            name,
            symbol,
            uri: metadata.uri.clone(),
            seller_fee_basis_points: metadata.seller_fee_basis_points,
            creators: metadata.creators.clone(),
        };

        UpdateV1CpiBuilder::new(&accounts.metadata_program.to_account_info())
            .authority(&accounts.vault.to_account_info())
            .mint(&accounts.mint.to_account_info())
            .metadata(&metadata.to_account_info())
            .payer(&accounts.authority.to_account_info())
            .system_program(&accounts.system_program.to_account_info())
            .sysvar_instructions(&accounts.instructions.to_account_info())
            .data(data)
            .invoke_signed(&[&[VAULT_SEED, &[accounts.vault.bump]]])?;
        Ok(())
    }
}
