use crate::*;

#[derive(Accounts)]
#[instruction(new_validator_set: Vec<Pubkey>)]
pub struct ValidatorSetChange<'info> {
    #[account(
        mut,
        constraint = new_validator_set.len() <= MAX_VALIDATORS @ CustomError::MaxValidatorsExceeded,
        constraint = new_validator_set.len() >= MIN_VALIDATORS @ CustomError::MinValidatorsNotMet,
        seeds = [VALIDATOR_SET_SEED],
        bump = validator_set.bump,
    )]
    pub validator_set: Account<'info, ValidatorSet>,
}

impl<'info> ValidatorSetChange<'info> {
    pub fn process_instruction(ctx: Context<Self>, new_validator_set: Vec<Pubkey>) -> Result<()> {
        let validator_set = &mut ctx.accounts.validator_set;

        let signers = ctx
            .remaining_accounts
            .iter()
            .filter(|acc| acc.is_signer)
            .collect::<Vec<&AccountInfo>>();

        require!(
            signers.len() as u8 >= validator_set.threshold,
            CustomError::NotEnoughSigners
        );

        for signer in signers {
            require!(
                validator_set.signers.contains(signer.key),
                CustomError::InvalidSigner
            );
        }

        let mut validators_copy = new_validator_set.clone();
        validators_copy.sort();
        validators_copy.dedup();
        require!(
            validators_copy.len() == new_validator_set.len(),
            CustomError::ValidatorsNotUnique
        );

        validator_set.signers = new_validator_set;
        // Set the threshold to 2/3 of the validators, rounded up
        validator_set.threshold = ((validator_set.signers.len() as f32) * 2.0 / 3.0).ceil() as u8;

        Ok(())
    }
}