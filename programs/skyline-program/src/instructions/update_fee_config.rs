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

    /// New treasury account — only needed when updating treasury.
    /// CHECK: Stored as Pubkey reference. Validated to be non-default below.
    pub new_treasury: UncheckedAccount<'info>,

    /// New relayer account — only needed when updating relayer.
    /// CHECK: Stored as Pubkey reference. Validated to be non-default below.
    pub new_relayer: UncheckedAccount<'info>,
}

impl<'info> UpdateFeeConfig<'info> {
    /// Update any combination of fee config values.
    ///
    /// All parameters are `Option<T>`:
    ///   - `Some(value)` → update to new value
    ///   - `None`        → keep existing value unchanged
    ///
    /// # Overflow invariant
    ///   min_operational_fee + bridge_fee must not overflow u64.
    ///   This is checked here so bridge_request can use .expect() safely.
    ///
    /// # Treasury / Relayer update
    ///   Pass the new address in the account AND Some(true) in the flag.
    ///   Passing None keeps the existing address unchanged.
    ///   The account field must always be provided (Anchor requires it),
    ///   but it is only written when the flag is Some(true).
    pub fn process_instruction(
        ctx: Context<UpdateFeeConfig>,
        min_operational_fee: Option<u64>,
        bridge_fee: Option<u64>,
        min_bridging_amount: Option<u64>,
        update_treasury: Option<bool>,
        update_relayer: Option<bool>,
    ) -> Result<()> {
        let fee_config = &mut ctx.accounts.fee_config;

        // Resolve new fee values (keep existing if None)
        let new_op_fee = min_operational_fee.unwrap_or(fee_config.min_operational_fee);
        let new_bridge_fee = bridge_fee.unwrap_or(fee_config.bridge_fee);
        let new_min_bridging = min_bridging_amount.unwrap_or(fee_config.min_bridging_amount);

        // Overflow guard
        // Validate BEFORE writing. Once stored, bridge_request can safely
        // add fees without overflow checks, using .expect() to catch any issues.
        new_op_fee
            .checked_add(new_bridge_fee)
            .ok_or(CustomError::FeeConfigOverflow)?;

        // Resolve treasury
        let new_treasury = if update_treasury.unwrap_or(false) {
            let key = ctx.accounts.new_treasury.key();
            // Pubkey::default() is the zero address — an invalid treasury
            require!(key != Pubkey::default(), CustomError::InvalidTreasury);
            key
        } else {
            fee_config.treasury
        };

        // Resolve relayer
        let new_relayer = if update_relayer.unwrap_or(false) {
            let key = ctx.accounts.new_relayer.key();
            require!(key != Pubkey::default(), CustomError::InvalidRelayer);
            key
        } else {
            fee_config.relayer
        };

        // Write updated values to the fee config account
        fee_config.min_operational_fee = new_op_fee;
        fee_config.bridge_fee = new_bridge_fee;
        fee_config.min_bridging_amount = new_min_bridging;
        fee_config.treasury = new_treasury;
        fee_config.relayer = new_relayer;

        emit!(FeeConfigUpdatedEvent {
            min_operational_fee: new_op_fee,
            bridge_fee: new_bridge_fee,
            min_bridging_amount: new_min_bridging,
            treasury: new_treasury,
            relayer: new_relayer,
        });

        Ok(())
    }
}
