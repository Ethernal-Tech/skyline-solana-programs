//! Initialize instruction for setting up the validator set.
//!
//! This module contains the logic for initializing the bridge system with an initial
//! set of validators. The validators must meet certain requirements and will control
//! all subsequent bridge operations.

use anchor_lang::prelude::*;
use crate::*;

/// Account structure for the initialize instruction.
///
/// This struct defines the accounts required to initialize the validator set.
/// It includes validation constraints to ensure the validator set meets security requirements.
#[derive(Accounts)]
#[instruction(validators: Vec<Pubkey>)]
pub struct Initialize<'info> {
    /// The signer who is initializing the bridge system
    #[account(mut)]
    pub signer: Signer<'info>,

    /// The validator set account to be initialized
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

    /// The system program for account creation
    pub system_program: Program<'info, System>,
}

impl<'info> Initialize<'info> {
    /// Process the initialize instruction.
    ///
    /// This function validates the provided validators and initializes the validator set.
    /// It performs several checks to ensure the validator set is secure and properly configured.
    ///
    /// # Arguments
    /// * `ctx` - The instruction context containing all required accounts
    /// * `validators` - Vector of validator public keys to initialize
    ///
    /// # Returns
    /// * `Result<()>` - Returns Ok(()) on success or an error on failure
    ///
    /// # Errors
    /// * `ValidatorsNotUnique` - If duplicate validators are provided
    ///
    /// # Security Checks
    /// * Validates that all validators are unique (no duplicates)
    /// * Automatically calculates the consensus threshold as 2/3 of validators (rounded up)
    /// * Stores the bump seed for PDA derivation
    pub fn process_instruction(ctx: Context<Self>, validators: Vec<Pubkey>) -> Result<()> {
        let validator_set = &mut ctx.accounts.validator_set;

        // Check for duplicate validators by sorting and deduplicating
        let mut validators_copy = validators.clone();
        validators_copy.sort();
        validators_copy.dedup();
        require!(validators_copy.len() == validators.len(), CustomError::ValidatorsNotUnique);

        // Set the validator list
        validator_set.signers = validators;
        
        // Calculate consensus threshold as 2/3 of validators, rounded up
        // This ensures that at least 2/3 of validators must approve critical operations
        validator_set.threshold = ((validator_set.signers.len() as f32) * 2.0 / 3.0).ceil() as u8;
        
        // Store the bump seed for PDA derivation
        validator_set.bump = ctx.bumps.validator_set;

        Ok(())
    }
}