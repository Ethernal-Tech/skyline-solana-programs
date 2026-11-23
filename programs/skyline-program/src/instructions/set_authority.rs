//! Rotate the bridge admin to a new key.
//!
//! The admin lives in two accounts: `FeeConfig.authority` (fee, token registration and
//! min-bridging-amount instructions) and `ProgramConfig.authority` (program version
//! updates). Rotation updates both fields after the current and incoming authorities sign.

use crate::*;

/// Accounts for rotating `FeeConfig.authority` and `ProgramConfig.authority`.
#[derive(Accounts)]
pub struct SetAuthority<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [FEE_CONFIG_SEED],
        bump = fee_config.bump,
        has_one = authority @ CustomError::Unauthorized
    )]
    pub fee_config: Account<'info, FeeConfig>,
    #[account(
        mut,
        seeds = [PROGRAM_CONFIG_SEED],
        bump,
        has_one = authority @ CustomError::Unauthorized
    )]
    pub program_config: Account<'info, ProgramConfig>,
    /// Accepts the role for the public key named in the instruction.
    pub new_authority_signer: Signer<'info>,
}

impl<'info> SetAuthority<'info> {
    /// Sets both authority fields to `new_authority` and emits `AuthorityChangedEvent`.
    pub fn process_instruction(ctx: Context<Self>, new_authority: Pubkey) -> Result<()> {
        let old_authority = ctx.accounts.authority.key();
        require!(
            new_authority != Pubkey::default() && new_authority != old_authority,
            CustomError::InvalidNewAuthority
        );
        require_keys_eq!(
            new_authority,
            ctx.accounts.new_authority_signer.key(),
            CustomError::InvalidNewAuthority
        );

        ctx.accounts.fee_config.authority = new_authority;
        ctx.accounts.program_config.authority = new_authority;

        emit!(AuthorityChangedEvent {
            old_authority,
            new_authority,
        });
        Ok(())
    }
}
