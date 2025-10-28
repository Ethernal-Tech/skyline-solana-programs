//! Bridge tokens instruction for minting tokens to recipients.
//!
//! This module contains the logic for minting tokens to recipients on the destination chain.
//! This instruction is typically called after tokens have been burned on the source chain
//! and requires validator consensus to execute.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token,
    token::{self, Mint, MintTo, Token},
};

use crate::*;

/// Account structure for the bridge_tokens instruction.
///
/// This struct defines the accounts required to mint tokens to a recipient.
/// It includes the validator set for consensus validation and token accounts for minting.
#[derive(Accounts)]
pub struct BridgeTokens<'info> {
    /// The token mint that will be used to mint tokens
    #[account(mut)]
    pub mint: Account<'info, Mint>,
    
    /// The payer for any associated token account creation
    #[account(mut)]
    pub payer: Signer<'info>,
    
    /// The validator set account for consensus validation
    #[account(
        seeds = [VALIDATOR_SET_SEED],
        bump = validator_set.bump,
    )]
    pub validator_set: Account<'info, ValidatorSet>,
    
    /// The recipient of the bridged tokens
    /// CHECK: This account is validated through the associated token account creation
    pub recipient: UncheckedAccount<'info>,
    
    /// The recipient's associated token account for the mint
    /// CHECK: This account is validated through the associated token account creation
    #[account(mut)]
    pub recipient_ata: UncheckedAccount<'info>,

    /// The token program for minting operations
    pub token_program: Program<'info, Token>,
    
    /// The system program for account creation
    pub system_program: Program<'info, System>,
    
    /// The associated token program for creating token accounts
    pub associated_token_program: Program<'info, associated_token::AssociatedToken>,
}

impl<'info> BridgeTokens<'info> {
    /// Process the bridge_tokens instruction.
    ///
    /// This function validates validator signatures, creates the recipient's token account
    /// if needed, and mints tokens to the recipient. It requires consensus from validators
    /// based on the threshold defined in the validator set.
    ///
    /// # Arguments
    /// * `ctx` - The instruction context containing all required accounts
    /// * `amount` - The amount of tokens to mint to the recipient
    ///
    /// # Returns
    /// * `Result<()>` - Returns Ok(()) on success or an error on failure
    ///
    /// # Errors
    /// * `NotEnoughSigners` - If insufficient validators have signed the transaction
    /// * `InvalidSigner` - If a signer is not in the validator set
    ///
    /// # Security Checks
    /// * Validates that enough validators have signed (meets threshold requirement)
    /// * Ensures all signers are part of the authorized validator set
    /// * Creates recipient's associated token account if it doesn't exist
    /// * Mints tokens using the validator set as the minting authority
    pub fn process_instruction(ctx: Context<Self>, amount: u64) -> Result<()> {
        let token_program = &ctx.accounts.token_program;
        let validator_set = &ctx.accounts.validator_set;
        let recipient = &ctx.accounts.recipient;
        let recipient_ata = &ctx.accounts.recipient_ata;
        let mint = &ctx.accounts.mint;
        let associated_token_program = &ctx.accounts.associated_token_program;

        // Collect all signers from remaining accounts
        let signers = ctx
            .remaining_accounts
            .iter()
            .filter(|acc| acc.is_signer)
            .collect::<Vec<&AccountInfo>>();

        // Validate that enough validators have signed
        require!(
            signers.len() as u8 >= ctx.accounts.validator_set.threshold,
            CustomError::NotEnoughSigners
        );

        // Validate that all signers are part of the validator set
        for signer in signers {
            require!(
                validator_set.signers.contains(signer.key),
                CustomError::InvalidSigner
            );
        }

        // Create the recipient's associated token account if it doesn't exist
        if recipient_ata.data_is_empty() {
            let cpi_context = CpiContext::new(
                associated_token_program.to_account_info(),
                associated_token::Create {
                    payer: ctx.accounts.payer.to_account_info(),
                    associated_token: recipient_ata.to_account_info(),
                    authority: recipient.to_account_info(),
                    mint: mint.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    token_program: token_program.to_account_info(),
                },
            );

            associated_token::create(cpi_context)?;
        }

        // Prepare the mint_to instruction with validator set as authority
        let cpi_accounts = MintTo {
            mint: mint.to_account_info(),
            to: recipient_ata.to_account_info(),
            authority: validator_set.to_account_info(),
        };

        // Create signer seeds for the validator set PDA
        let seeds = &[VALIDATOR_SET_SEED, &[validator_set.bump]];
        let signer_seeds = &[&seeds[..]];

        // Mint tokens to the recipient
        token::mint_to(
            CpiContext::new_with_signer(
                token_program.to_account_info(),
                cpi_accounts,
                signer_seeds,
            ),
            amount,
        )?;

        Ok(())
    }
}
