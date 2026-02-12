//! Validator set change instruction for updating the validator set.
//!
//! This module contains the logic for updating the validator set that controls
//! bridge operations. This instruction requires consensus from the current validator
//! set and maintains the same validation rules as initialization.

use blake3;

use crate::*;

/// Account structure for the validator_set_change instruction.
///
/// This struct defines the accounts required to update the validator set.
/// It includes validation constraints to ensure the new validator set meets security requirements.
#[derive(Accounts)]
#[instruction(added: Vec<Pubkey>, removed: Vec<Pubkey>, batch_id: u64)]
pub struct BridgeVSU<'info> {
    /// The payer for any associated token account creation
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

    /// The validator set change account to be created
    #[account(
        init_if_needed,
        payer = payer,
        space = DISC as usize + ValidatorDelta::INIT_SPACE,
        seeds = [VALIDATOR_SET_CHANGE_SEED, batch_id.to_le_bytes().as_ref()],
        bump
    )]
    pub validator_set_change: Account<'info, ValidatorDelta>,

    /// The system program for account creation
    pub system_program: Program<'info, System>,
}

impl<'info> BridgeVSU<'info> {
    fn concat_pubkeys(pubkeys: &Vec<Pubkey>) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(pubkeys.len() * 32);
        for pk in pubkeys {
            bytes.extend_from_slice(pk.as_ref());
        }

        bytes
    }

    pub fn process_instruction(
        ctx: Context<Self>,
        added: Vec<Pubkey>,
        removed: Vec<Pubkey>,
        batch_id: u64,
    ) -> Result<()> {
        let validator_set = &mut ctx.accounts.validator_set;
        let validator_set_change: &mut Account<'info, ValidatorDelta> =
            &mut ctx.accounts.validator_set_change;
        let payer = &ctx.accounts.payer;

        let proposal_hash =
            blake3::hash(&[Self::concat_pubkeys(&added), Self::concat_u64(&removed)].concat());

        // Validate no duplicates in added list
        if !added.is_empty() {
            let mut added_sorted = added.clone();
            added_sorted.sort();
            added_sorted.dedup();
            require!(
                added.len() == added_sorted.len(),
                CustomError::DuplicateValidatorsInAdded
            );
        }
        // Validate no duplicates in removed
        if !removed.is_empty() {
            let mut removed_sorted = removed.clone();
            removed_sorted.sort();
            removed_sorted.dedup();
            require!(
                removed.len() == removed_sorted.len(),
                CustomError::DuplicateValidatorsInRemoved
            );
        }

        let proposal_hash =
            blake3::hash(&[Self::concat_pubkeys(&added), Self::concat_pubkeys(&removed)].concat());

        if validator_set_change.id == Pubkey::default() {
            let signers_len = validator_set.signers.len();
            require!(
                !added.iter().any(|pk| removed.contains(pk)),
                CustomError::AddingAndRemovingSameSigner
            );
            // Validate that no added validator is already in the validator set
            require!(
                !added.iter().any(|pk| validator_set.signers.contains(pk)),
                CustomError::AddingExistingSigner
            );
            // Validate we won't underflow when calculating new validator count
            require!(
                removed.len() <= signers_len + added.len(),
                CustomError::TooManyValidatorsRemoved
            );

            let new_signers_len = added.len() + signers_len - removed.len();

            require!(
                new_signers_len <= MAX_VALIDATORS as usize,
                CustomError::MaxValidatorsExceeded
            );
            require!(
                new_signers_len >= MIN_VALIDATORS as usize,
                CustomError::MinValidatorsNotMet
            );

            validator_set_change.id = validator_set_change.key();
            validator_set_change.proposal_hash = *proposal_hash.as_bytes();
            validator_set_change.added = added;
            validator_set_change.removed = removed;
            validator_set_change.batch_id = batch_id;
            validator_set_change.bump = ctx.bumps.validator_set_change;
        } else {
            require!(
                validator_set_change.proposal_hash == *proposal_hash.as_bytes(),
                CustomError::InvalidProposalHash
            );
        }

        // Collect all signers from remaining accounts
        let signers = ctx
            .remaining_accounts
            .iter()
            .filter(|acc| acc.is_signer)
            .map(|acc| acc.key())
            .collect::<Vec<Pubkey>>();
        // Validate no duplicate signers in current call
        let mut signers_copy = signers.clone();
        signers_copy.sort();
        signers_copy.dedup();
        require!(
            signers.len() == signers_copy.len(),
            CustomError::DuplicateSignersProvided
        );
        // Validate all signers are valid validators
        require!(
            signers.iter().all(|k| validator_set.signers.contains(k)),
            CustomError::InvalidSigner
        );
        // Validate signers haven't already approved
        require!(
            signers
                .iter()
                .all(|s| !validator_set_change.signers.contains(s)),
            CustomError::SignerAlreadyApproved
        );
        require!(!signers.is_empty(), CustomError::NoSignersProvided);

        validator_set_change.signers.extend(signers.iter());
        // Check if threshold is met
        if (validator_set_change.signers.len() as u8) < validator_set.threshold {
            return Ok(());
        }

        // Safe removal using retain (no index issues, no panics)
        validator_set
            .signers
            .retain(|pk| !validator_set_change.removed.contains(pk));

        // Add new validators
        validator_set
            .signers
            .extend(validator_set_change.added.iter());
        // Recalculate threshold
        validator_set.threshold = helpers::calculate_threshold(validator_set.signers.len());

        emit!(ValidatorSetUpdatedEvent {
            new_signers: validator_set.signers.clone(),
            new_threshold: validator_set.threshold,
            batch_id,
        });

        validator_set.last_batch_id = batch_id;
        validator_set_change.close(payer.to_account_info())?;

        Ok(())
    }
}
