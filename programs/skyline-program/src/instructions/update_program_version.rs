//! Update on-chain program version metadata after a program upgrade.
//!
//! `initialize` writes `ProgramConfig` once; redeploying the program does not mutate
//! this account. The bridge authority calls this instruction to align the stored
//! version with the deployed build.

use crate::*;

/// Accounts for updating `ProgramConfig.version_string`.
#[derive(Accounts)]
pub struct UpdateProgramVersion<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [PROGRAM_CONFIG_SEED],
        bump,
        has_one = authority @ CustomError::Unauthorized
    )]
    pub program_config: Account<'info, ProgramConfig>,
}

impl<'info> UpdateProgramVersion<'info> {
    pub fn process_instruction(
        ctx: Context<Self>,
        version_string: String,
    ) -> Result<()> {
        require!(
            version_string.len() <= 32,
            CustomError::VersionStringTooLong
        );
        let program_config = &mut ctx.accounts.program_config;
        program_config.version_string = version_string;
        emit!(ProgramVersionUpdatedEvent {
            version_string: program_config.version_string.clone(),
        });
        Ok(())
    }
}
