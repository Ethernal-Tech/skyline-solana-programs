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
#[instruction(amount: u64, batch_id: u64)]
pub struct CreateOrApproveTransaction<'info> {
    /// The payer for any associated token account creation
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The validator set account for consensus validation
    #[account(
        seeds = [VALIDATOR_SET_SEED],
        bump = validator_set.bump,
        constraint = validator_set.last_batch_id < batch_id @CustomError::InvalidBatchId,
    )]
    pub validator_set: Account<'info, ValidatorSet>,

    /// The bridging transaction account to be created
    #[account(
        init_if_needed,
        payer = payer,
        space = DISC + BridgingTransaction::INIT_SPACE,
        seeds = [BRIDGING_TRANSACTION_SEED, batch_id.to_le_bytes().as_ref()],
        bump
    )]
    pub bridging_transaction: Account<'info, BridgingTransaction>,

    /// CHECK: ....
    pub receiver: UncheckedAccount<'info>,

    pub mint_token: Account<'info, Mint>,

    /// The system program for account creation
    pub system_program: Program<'info, System>,
}

impl<'info> CreateOrApproveTransaction<'info> {
    pub fn process_instruction(ctx: Context<Self>, amount: u64, batch_id: u64) -> Result<()> {
        let bridging_transaction = &mut ctx.accounts.bridging_transaction;
        let payer = &ctx.accounts.payer;
        let receiver = &ctx.accounts.receiver;
        let mint_token = &ctx.accounts.mint_token;

        // Validate that the receiver is not the same as the payer
        require!(receiver.key() != payer.key(), CustomError::InvalidReceiver);

        // // Store the transaction details
        bridging_transaction.id = bridging_transaction.key();
        bridging_transaction.amount = amount;
        bridging_transaction.receiver = receiver.key();
        bridging_transaction.mint_token = mint_token.key();
        bridging_transaction.batch_id = batch_id;
        bridging_transaction.bump = ctx.bumps.bridging_transaction;

        let signers = ctx
            .remaining_accounts
            .iter()
            .filter(|acc| acc.is_signer && ctx.accounts.validator_set.signers.contains(acc.key))
            .map(|acc| acc.key())
            .collect::<Vec<Pubkey>>();

        require!(signers.len() > 0, CustomError::NoSignersProvided);
        require!(
            !signers
                .iter()
                .any(|s| bridging_transaction.signers.contains(s)),
            CustomError::SignerAlreadyApproved
        );

        bridging_transaction.signers.extend(signers.iter());

        Ok(())
    }
}
