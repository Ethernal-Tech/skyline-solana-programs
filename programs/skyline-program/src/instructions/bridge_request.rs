//! Bridge request instruction for creating cross-chain transfer requests.
//!
//! This module contains the logic for creating bridging requests that initiate
//! cross-chain token transfers. Users can burn tokens on the source chain and
//! create a request that validators can process to mint equivalent tokens on
//! the destination chain.

use crate::*;
use anchor_spl::{
    associated_token,
    token::{self, Mint, TokenAccount, Transfer},
};

/// Account structure for the bridge_request instruction.
///
/// This struct defines the accounts required to create a bridging request.
/// It includes the user's token account, the bridging request account to be created,
/// and the token mint for the tokens being bridged.
#[derive(Accounts)]
pub struct BridgeRequest<'info> {
    /// The user initiating the bridge request
    #[account(mut)]
    pub signer: Signer<'info>,

    /// The validator set account
    #[account(
        mut, 
        seeds = [VALIDATOR_SET_SEED], 
        bump = validator_set.bump
    )]
    pub validator_set: Account<'info, ValidatorSet>,

    /// The user's associated token account for the tokens being bridged
    #[account(
        mut,
        token::mint = mint,
        token::authority = signer
    )]
    pub signers_ata: Account<'info, TokenAccount>,

    /// The vault account
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,

    /// The vault associated token account for the tokens being bridged
    /// CHECK: This account is validated through the associated token account creation
    #[account(mut)]
    pub vault_ata: UncheckedAccount<'info>,

    /// The token mint for the tokens being bridged
    #[account(mut)]
    pub mint: Account<'info, Mint>,

    /// The token program for burning operations
    pub token_program: Program<'info, anchor_spl::token::Token>,

    /// The system program for account creation
    pub system_program: Program<'info, System>,

    /// The associated token program for creating token accounts
    pub associated_token_program: Program<'info, associated_token::AssociatedToken>,
}

impl<'info> BridgeRequest<'info> {
    /// Process the bridge_request instruction.
    ///
    /// This function validates the user has sufficient tokens, burns the specified amount,
    /// and creates a bridging request account with the transfer details. The request can
    /// then be processed by validators to mint equivalent tokens on the destination chain.
    ///
    /// # Arguments
    /// * `ctx` - The instruction context containing all required accounts
    /// * `amount` - The amount of tokens to bridge to the destination chain
    /// * `receiver` - The receiver's address on the destination chain (57 bytes)
    /// * `destination_chain` - The chain ID of the destination blockchain
    ///
    /// # Returns
    /// * `Result<()>` - Returns Ok(()) on success or an error on failure
    ///
    /// # Errors
    /// * `InsufficientFunds` - If the user doesn't have enough tokens to bridge
    ///
    /// # Process Flow
    /// 1. Validates that the user has sufficient token balance
    /// 2. Burns the specified amount of tokens from the user's account
    /// 3. Creates a bridging request account with transfer details
    /// 4. Stores the request information for validator processing
    pub fn process_instruction(
        ctx: Context<BridgeRequest>,
        amount: u64,
        receiver: Vec<u8>,
        destination_chain: u8,
    ) -> Result<()> {
        let mint = &ctx.accounts.mint;
        let from = &ctx.accounts.signers_ata;
        let signer = &ctx.accounts.signer;
        let token_program = &ctx.accounts.token_program;
        let vault = &ctx.accounts.vault;
        let vault_ata = &ctx.accounts.vault_ata;
        let associated_token_program = &ctx.accounts.associated_token_program;
        let validator_set = &mut ctx.accounts.validator_set;

        // Validate that the user has sufficient tokens to bridge
        require!(from.amount >= amount, CustomError::InsufficientFunds);

        if vault_ata.data_is_empty() {
            let cpi_context = CpiContext::new(
                associated_token_program.to_account_info(),
                associated_token::Create {
                    payer: signer.to_account_info(),
                    associated_token: vault_ata.to_account_info(),
                    authority: vault.to_account_info(),
                    mint: mint.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    token_program: token_program.to_account_info(),
                },
            );

            associated_token::create(cpi_context)?;
        }

        if is_vault_mint_authority(mint, &vault.to_account_info()) {
            let cpi_accounts = token::Burn {
                mint: mint.to_account_info(),
                from: from.to_account_info(),
                authority: signer.to_account_info(),
            };

            let cpi_context = CpiContext::new(token_program.to_account_info(), cpi_accounts);
            token::burn(cpi_context, amount)?;
        } else {
            let cpi_accounts = Transfer {
                from: from.to_account_info(),
                to: vault_ata.to_account_info(),
                authority: signer.to_account_info(),
            };

            let cpi_context = CpiContext::new(token_program.to_account_info(), cpi_accounts);
            token::transfer(cpi_context, amount)?;
        }

        emit!(BridgeRequestEvent{
            sender: signer.key(),
            amount,
            receiver,
            destination_chain,
            mint_token: mint.key(),
            batch_request_id: validator_set.bridge_request_count,
        });

        // Increment the bridge request count
       validator_set.bridge_request_count += 1;

        Ok(())
    }
}
