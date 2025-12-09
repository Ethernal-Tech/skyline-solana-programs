//! Bridge tokens instruction for minting tokens to recipients.
//!
//! This module contains the logic for minting tokens to recipients on the destination chain.
//! This instruction is typically called after tokens have been burned on the source chain
//! and requires validator consensus to execute.

use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::*;

/// Account structure for the bridge_tokens instruction.
///
/// This struct defines the accounts required to mint tokens to a recipient.
/// It includes the validator set for consensus validation and token accounts for minting.
#[derive(Accounts)]
pub struct CreateTransaction<'info> {
    /// The payer for any associated token account creation
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The validator set account for consensus validation
    #[account(
        mut,
        seeds = [VALIDATOR_SET_SEED],
        bump = validator_set.bump,
        constraint = validator_set.transaction_in_progress == false @ CustomError::TransactionInProgress,
    )]
    pub validator_set: Account<'info, ValidatorSet>,

    /// The bridging transaction account to be created
    #[account(
        init,
        payer = payer,
        space = DISC + BridgingTransaction::INIT_SPACE,
        seeds = [BRIDGING_TRANSACTION_SEED, validator_set.last_batch_id.to_le_bytes().as_ref()],
        bump
    )]
    pub bridging_transaction: Account<'info, BridgingTransaction>,

    /// The token mint that will be used to mint tokens
    pub mint_token: Account<'info, Mint>,

    /// The system program for account creation
    pub system_program: Program<'info, System>,
}

impl<'info> CreateTransaction<'info> {
    pub fn process_instruction(ctx: Context<Self>, amount: u64, receiver: Pubkey) -> Result<()> {
        let validator_set = &mut ctx.accounts.validator_set;
        let bridging_transaction = &mut ctx.accounts.bridging_transaction;
        let payer = &ctx.accounts.payer;
        let mint_token = &ctx.accounts.mint_token;

        // Validate that the transaction is not already in progress
        require!(
            validator_set.transaction_in_progress == false,
            CustomError::TransactionInProgress
        );

        // Validate that the receiver is not the same as the payer
        require!(receiver != payer.key(), CustomError::InvalidReceiver);

        // Store the transaction details
        bridging_transaction.id = Pubkey::new_unique();
        bridging_transaction.amount = amount;
        bridging_transaction.receiver = receiver;
        bridging_transaction.mint_token = mint_token.key();
        bridging_transaction.batch_id = validator_set.last_batch_id;

        Ok(())
    }
}
