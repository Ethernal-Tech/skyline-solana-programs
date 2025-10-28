//! Validator set change instruction for updating the validator set.
//!
//! This module contains the logic for updating the validator set that controls
//! bridge operations. This instruction requires consensus from the current validator
//! set and maintains the same validation rules as initialization.

use crate::*;

/// Account structure for the validator_set_change instruction.
///
/// This struct defines the accounts required to update the validator set.
/// It includes validation constraints to ensure the new validator set meets security requirements.
#[derive(Accounts)]
#[instruction(new_validator_set: Vec<Pubkey>)]
pub struct ValidatorSetChange<'info> {
    /// The validator set account to be updated
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
    /// Process the validator_set_change instruction.
    ///
    /// This function validates the current validator signatures, validates the new validator set,
    /// and updates the validator set with the new configuration. It requires consensus from
    /// the current validator set and maintains the same validation rules as initialization.
    ///
    /// # Arguments
    /// * `ctx` - The instruction context containing all required accounts
    /// * `new_validator_set` - Vector of new validator public keys
    ///
    /// # Returns
    /// * `Result<()>` - Returns Ok(()) on success or an error on failure
    ///
    /// # Errors
    /// * `NotEnoughSigners` - If insufficient current validators have signed
    /// * `InvalidSigner` - If a signer is not in the current validator set
    /// * `ValidatorsNotUnique` - If duplicate validators are provided in the new set
    ///
    /// # Security Checks
    /// * Validates that enough current validators have signed (meets threshold requirement)
    /// * Ensures all signers are part of the current authorized validator set
    /// * Validates that all new validators are unique (no duplicates)
    /// * Automatically recalculates the consensus threshold for the new validator set
    pub fn process_instruction(ctx: Context<Self>, new_validator_set: Vec<Pubkey>) -> Result<()> {
        let validator_set = &mut ctx.accounts.validator_set;

        // Collect all signers from remaining accounts
        let signers = ctx
            .remaining_accounts
            .iter()
            .filter(|acc| acc.is_signer)
            .collect::<Vec<&AccountInfo>>();

        // Validate that enough current validators have signed
        require!(
            signers.len() as u8 >= validator_set.threshold,
            CustomError::NotEnoughSigners
        );

        // Validate that all signers are part of the current validator set
        for signer in signers {
            require!(
                validator_set.signers.contains(signer.key),
                CustomError::InvalidSigner
            );
        }

        // Check for duplicate validators in the new set
        let mut validators_copy = new_validator_set.clone();
        validators_copy.sort();
        validators_copy.dedup();
        require!(
            validators_copy.len() == new_validator_set.len(),
            CustomError::ValidatorsNotUnique
        );

        // Update the validator set
        validator_set.signers = new_validator_set;
        
        // Recalculate the consensus threshold for the new validator set
        // Set the threshold to 2/3 of the validators, rounded up
        validator_set.threshold = ((validator_set.signers.len() as f32) * 2.0 / 3.0).ceil() as u8;

        Ok(())
    }
}