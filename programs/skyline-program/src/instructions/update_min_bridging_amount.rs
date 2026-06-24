//! Update minimum bridging amount for a registered token.
//!
//! Authority-gated post-registration update of `TokenRegistry.min_bridging_amount`.

use crate::*;

/// Accounts for updating a token's minimum bridging amount.
#[derive(Accounts)]
#[instruction(token_id: u16)]
pub struct UpdateMinBridgingAmount<'info> {
    /// The bridge admin. Must match `fee_config.authority`.
    pub authority: Signer<'info>,

    #[account(
        seeds = [FEE_CONFIG_SEED],
        bump = fee_config.bump,
        constraint = authority.key() == fee_config.authority @ CustomError::Unauthorized
    )]
    pub fee_config: Account<'info, FeeConfig>,

    /// TokenRegistry PDA for the given `token_id`.
    #[account(
        mut,
        seeds = [TOKEN_REGISTRY_SEED, token_id.to_le_bytes().as_ref()],
        bump = token_registry.bump,
        constraint = token_registry.token_id == token_id @ CustomError::InvalidMintToken
    )]
    pub token_registry: Account<'info, TokenRegistry>,
}

impl<'info> UpdateMinBridgingAmount<'info> {
    /// Update the minimum raw token amount allowed per `bridge_request` for a token.
    ///
    /// # Arguments
    /// * `token_id`            - Gateway-compatible identifier of the registered token
    /// * `min_bridging_amount` - New minimum in the mint's native decimals
    ///
    /// # Errors
    /// * `CustomError::Unauthorized` - Signer is not the bridge authority
    pub fn process_instruction(
        ctx: Context<UpdateMinBridgingAmount>,
        token_id: u16,
        min_bridging_amount: u64,
    ) -> Result<()> {
        let token_registry = &mut ctx.accounts.token_registry;
        token_registry.min_bridging_amount = min_bridging_amount;

        emit!(MinBridgingAmountUpdatedEvent {
            token_id,
            mint: token_registry.mint,
            min_bridging_amount,
        });

        Ok(())
    }
}
