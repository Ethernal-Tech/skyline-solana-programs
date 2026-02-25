//! Fee config update instruction.
//!
//! This file handles authority-gated fee updates after deployment.

use crate::*;

// ─────────────────────────────────────────────
// Update instruction
// ─────────────────────────────────────────────

/// Accounts for updating fee config values.
#[derive(Accounts)]
pub struct UpdateFeeConfig<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [FEE_CONFIG_SEED],
        bump = fee_config.bump,
        has_one = authority @ CustomError::Unauthorized // Only the authority can update fee config
    )]
    pub fee_config: Account<'info, FeeConfig>,
}

impl<'info> UpdateFeeConfig<'info> {
    pub fn process_instruction(
        ctx: Context<UpdateFeeConfig>,
        min_operational_fee: Option<u64>,
        bridge_fee: Option<u64>,
    ) -> Result<()> {
        let fee_config = &mut ctx.accounts.fee_config;

        // Apply updates
        let new_op_fee = min_operational_fee.unwrap_or(fee_config.min_operational_fee);
        let new_bridge_fee = bridge_fee.unwrap_or(fee_config.bridge_fee);

        // Fee overflow guard
        // This ensures stored values never overflow when added.
        new_op_fee
            .checked_add(new_bridge_fee)
            .ok_or(CustomError::FeeConfigOverflow)?;

        fee_config.min_operational_fee = new_op_fee;
        fee_config.bridge_fee = new_bridge_fee;

        Ok(())
    }
}
