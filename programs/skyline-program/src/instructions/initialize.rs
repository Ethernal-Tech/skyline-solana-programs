use anchor_lang::prelude::*;
use crate::*;

#[derive(Accounts)]
#[instruction(validators: Vec<Pubkey>)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        init, 
        payer = signer, 
        space = ValidatorSet::INIT_SPACE + DISC,
        seeds = [VALIDATOR_SET_SEED],
        constraint = validators.len() <= MAX_VALIDATORS @ CustomError::MaxValidatorsExceeded,
        constraint = validators.len() >= MIN_VALIDATORS @ CustomError::MinValidatorsNotMet,
        bump
    )]
    pub validator_set: Account<'info, ValidatorSet>,

    pub system_program: Program<'info, System>,
}

impl<'info> Initialize<'info> {
    pub fn process_instruction(ctx: Context<Self>, validators: Vec<Pubkey>) -> Result<()> {
        let validator_set = &mut ctx.accounts.validator_set;

        let mut validators_copy = validators.clone();
        validators_copy.sort();
        validators_copy.dedup();
        require!(validators_copy.len() == validators.len(), CustomError::ValidatorsNotUnique);

        validator_set.signers = validators;
        validator_set.threshold = ((validator_set.signers.len() as f32) * 2.0 / 3.0).ceil() as u8;
        validator_set.bump = ctx.bumps.validator_set;

        Ok(())
    }
}