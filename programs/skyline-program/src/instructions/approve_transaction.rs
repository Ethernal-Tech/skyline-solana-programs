use anchor_lang::prelude::*;

use crate::*;

#[derive(Accounts)]
pub struct ApproveTransaction<'info> {
    /// The payer for any associated token account creation
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The validator set account for consensus validation
    #[account(
        mut,
        seeds = [VALIDATOR_SET_SEED],
        bump = validator_set.bump,
    )]
    pub validator_set: Account<'info, ValidatorSet>,

    /// The bridging transaction account to be approved
    #[account(
        mut,
        seeds = [BRIDGING_TRANSACTION_SEED, validator_set.last_batch_id.to_le_bytes().as_ref()],
        bump = bridging_transaction.bump,
    )]
    pub bridging_transaction: Account<'info, BridgingTransaction>,
}

impl<'info> ApproveTransaction<'info> {
    pub fn process_instruction(ctx: Context<Self>) -> Result<()> {
        let validator_set = &mut ctx.accounts.validator_set;
        let bridging_transaction = &mut ctx.accounts.bridging_transaction;

        let signers = ctx
            .remaining_accounts
            .iter()
            .filter(|acc| acc.is_signer && validator_set.signers.contains(acc.key))
            .filter(|acc| !bridging_transaction.signers.contains(acc.key))
            .collect::<Vec<&AccountInfo>>();

        require!(signers.len() > 0, CustomError::NoSignersProvided);

        let keys = signers.iter().map(|acc| acc.key);
        bridging_transaction.signers.extend(keys);

        Ok(())
    }
}
