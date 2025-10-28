//! Close request instruction for closing bridging request accounts.
//!
//! This module contains the logic for closing bridging request accounts.
//! This instruction is typically called after a bridging request has been
//! processed or cancelled, and requires validator consensus to execute.

use crate::*;

/// Account structure for the close_request instruction.
///
/// This struct defines the accounts required to close a bridging request account.
/// It includes the bridging request account to be closed and the validator set for consensus validation.
#[derive(Accounts)]
pub struct CloseRequest<'info> {
    /// The signer who will receive the rent from closing the account
    #[account(mut)]
    pub signer: Signer<'info>,

    /// The bridging request account to be closed
    #[account(
        mut,
        close = signer,
    )]
    pub bridging_request: Account<'info, BridgingRequest>,

    /// The validator set account for consensus validation
    #[account(
        seeds = [VALIDATOR_SET_SEED],
        bump = validator_set.bump,
    )]
    pub validator_set: Account<'info, ValidatorSet>,

    /// The system program for account closure
    pub system_program: Program<'info, System>,
}

impl<'info> CloseRequest<'info> {
    /// Process the close_request instruction.
    ///
    /// This function validates validator signatures and closes the bridging request account.
    /// It requires consensus from validators based on the threshold defined in the validator set.
    /// The rent from the closed account is returned to the specified signer.
    ///
    /// # Arguments
    /// * `ctx` - The instruction context containing all required accounts
    ///
    /// # Returns
    /// * `Result<()>` - Returns Ok(()) on success or an error on failure
    ///
    /// # Errors
    /// * `NotEnoughSigners` - If insufficient validators have signed the transaction
    /// * `InvalidSigner` - If a signer is not in the validator set
    ///
    /// # Security Checks
    /// * Validates that enough validators have signed (meets threshold requirement)
    /// * Ensures all signers are part of the authorized validator set
    /// * Closes the bridging request account and returns rent to the signer
    pub fn process_instruction(ctx: Context<Self>) -> Result<()> {
        let validator_set = &mut ctx.accounts.validator_set;

        // Collect all signers from remaining accounts
        let signers = ctx
            .remaining_accounts
            .iter()
            .filter(|acc| acc.is_signer)
            .collect::<Vec<&AccountInfo>>();

        // Validate that enough validators have signed
        require!(
            signers.len() as u8 >= validator_set.threshold,
            CustomError::NotEnoughSigners
        );

        // Validate that all signers are part of the validator set
        for signer in signers {
            require!(
                validator_set.signers.contains(signer.key),
                CustomError::InvalidSigner
            );
        }

        // Log the account closure for transparency
        msg!(
            "Closing bridging request account {}",
            ctx.accounts.bridging_request.key()
        );

        Ok(())
    }
}
