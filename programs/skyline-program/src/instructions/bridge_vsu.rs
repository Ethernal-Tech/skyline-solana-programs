//! Validator set change instruction for updating the validator set.
//!
//! This module contains the logic for updating the validator set that controls
//! bridge operations. This instruction requires consensus from the current validator
//! set in a single transaction. If threshold is not met, the transaction is rejected.

use crate::*;

/// Account structure for the validator_set_change instruction.
#[derive(Accounts)]
#[instruction(added: Vec<Pubkey>, removed: Vec<Pubkey>, batch_id: u64)]
pub struct BridgeVSU<'info> {
    /// The payer for any rent fees
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The validator set account to be updated
    #[account(
        mut,
        seeds = [VALIDATOR_SET_SEED],
        bump = validator_set.bump,
        constraint = validator_set.last_batch_id < batch_id @ CustomError::InvalidBatchId,
    )]
    pub validator_set: Account<'info, ValidatorSet>,

    /// The system program
    pub system_program: Program<'info, System>,
}

impl<'info> BridgeVSU<'info> {
    pub fn process_instruction(
        ctx: Context<Self>,
        added: Vec<Pubkey>,
        removed: Vec<Pubkey>,
        batch_id: u64,
    ) -> Result<()> {
        let validator_set = &mut ctx.accounts.validator_set;

        // Validate added list
        if !added.is_empty() {
            let mut added_sorted = added.clone();
            added_sorted.sort();
            added_sorted.dedup();
            require!(
                added.len() == added_sorted.len(),
                CustomError::DuplicateValidatorsInAdded
            );
        }

        // Validate removed list
        if !removed.is_empty() {
            let mut removed_sorted = removed.clone();
            removed_sorted.sort();
            removed_sorted.dedup();
            require!(
                removed.len() == removed_sorted.len(),
                CustomError::DuplicateValidatorsInRemoved
            );
        }

        // Validate proposal semantics
        require!(
            !added.iter().any(|pk| removed.contains(pk)),
            CustomError::AddingAndRemovingSameSigner
        );
        require!(
            !added.iter().any(|pk| validator_set.signers.contains(pk)),
            CustomError::AddingExistingSigner
        );
        require!(
            removed.iter().all(|pk| validator_set.signers.contains(pk)),
            CustomError::RemovingNonExistentSigner
        );

        let signers_len = validator_set.signers.len();

        require!(
            removed.len() <= signers_len + added.len(),
            CustomError::TooManyValidatorsRemoved
        );

        let new_signers_len = signers_len + added.len() - removed.len();

        require!(
            new_signers_len <= MAX_VALIDATORS as usize,
            CustomError::MaxValidatorsExceeded
        );
        require!(
            new_signers_len >= MIN_VALIDATORS as usize,
            CustomError::MinValidatorsNotMet
        );

        // Collect and validate signers
        let signers = ctx
            .remaining_accounts
            .iter()
            .filter(|acc| acc.is_signer)
            .map(|acc| acc.key())
            .collect::<Vec<Pubkey>>();

        require!(!signers.is_empty(), CustomError::NoSignersProvided);

        let mut signers_copy = signers.clone();
        signers_copy.sort();
        signers_copy.dedup();
        require!(
            signers.len() == signers_copy.len(),
            CustomError::DuplicateSignersProvided
        );
        require!(
            signers.iter().all(|k| validator_set.signers.contains(k)),
            CustomError::InvalidSigner
        );

        require!(
            (signers.len() as u8) >= validator_set.threshold,
            CustomError::InsufficientSigners
        );

        // Apply validator set mutation
        validator_set.signers.retain(|pk| !removed.contains(pk));

        validator_set.signers.extend(added.iter());

        validator_set.threshold = helpers::calculate_threshold(validator_set.signers.len());

        emit!(ValidatorSetUpdatedEvent {
            new_signers: validator_set.signers.clone(),
            new_threshold: validator_set.threshold,
            batch_id,
        });

        validator_set.last_batch_id = batch_id;

        Ok(())
    }
}
