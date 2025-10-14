use crate::*;

#[derive(Accounts)]
pub struct CloseRequest<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        close = signer,
    )]
    pub bridging_request: Account<'info, BridgingRequest>,

    #[account(
        seeds = [VALIDATOR_SET_SEED],
        bump = validator_set.bump,
    )]
    pub validator_set: Account<'info, ValidatorSet>,

    pub system_program: Program<'info, System>,
}

impl<'info> CloseRequest<'info> {
    pub fn process_instruction(ctx: Context<Self>) -> Result<()> {
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

        msg!(
            "Closing bridging request account {}",
            ctx.accounts.bridging_request.key()
        );

        Ok(())
    }
}
