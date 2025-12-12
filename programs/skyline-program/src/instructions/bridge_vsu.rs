//! Validator set change instruction for updating the validator set.
//!
//! This module contains the logic for updating the validator set that controls
//! bridge operations. This instruction requires consensus from the current validator
//! set and maintains the same validation rules as initialization.

use anchor_lang::solana_program::hash::hash;

use crate::*;

/// Account structure for the validator_set_change instruction.
///
/// This struct defines the accounts required to update the validator set.
/// It includes validation constraints to ensure the new validator set meets security requirements.
#[derive(Accounts)]
#[instruction(added: Vec<Pubkey>, removed: Vec<u64>, batch_id: u64)]
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
        space = DISC + ValidatorDelta::INIT_SPACE,
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

    fn concat_u64(indexes: &Vec<u64>) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(indexes.len() * 8);
        for idx in indexes {
            bytes.extend_from_slice(idx.to_le_bytes().as_ref());
        }

        bytes
    }

    pub fn process_instruction(
        ctx: Context<Self>,
        added: Vec<Pubkey>,
        removed: Vec<u64>,
        batch_id: u64,
    ) -> Result<()> {
        let validator_set = &mut ctx.accounts.validator_set;
        let validator_set_change = &mut ctx.accounts.validator_set_change;
        let payer = &ctx.accounts.payer;

        let proposal_hash =
            hash(&[Self::concat_pubkeys(&added), Self::concat_u64(&removed)].concat());

        if validator_set_change.proposal_hash.is_empty() {
            let signers_len = validator_set.signers.len();

            require!(
                !added.iter().any(|pk| validator_set.signers.contains(pk)),
                CustomError::AddingExistingSigner
            );

            let new_signers_len = added.len() + signers_len - removed.len();
            require!(
                new_signers_len <= MAX_VALIDATORS,
                CustomError::MaxValidatorsExceeded
            );
            require!(
                new_signers_len >= MIN_VALIDATORS,
                CustomError::MinValidatorsNotMet
            );

            require!(
                removed.iter().all(|id| (*id as usize) < signers_len),
                CustomError::RemovingNonExistentSigner
            );

            validator_set_change.proposal_hash = proposal_hash.to_bytes();
            validator_set_change.added = added;
            validator_set_change.removed = removed;
            validator_set_change.batch_id = batch_id;
            validator_set_change.bump = ctx.bumps.validator_set_change;
        } else {
            require!(
                validator_set_change
                    .proposal_hash
                    .eq(proposal_hash.to_bytes().as_ref()),
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
            signers
                .iter()
                .all(|s| !validator_set_change.signers.contains(s)),
            CustomError::SignerAlreadyApproved
        );

        require!(signers.len() > 0, CustomError::NoSignersProvided);

        validator_set_change.signers.extend(signers.iter());

        if (validator_set_change.signers.len() as u8) < validator_set.threshold {
            return Ok(());
        }

        validator_set_change.removed.sort_by(|a, b| b.cmp(a));

        // Apply the validator set changes
        for id in &validator_set_change.removed {
            validator_set.signers.remove(*id as usize);
        }

        for pk in &validator_set_change.added {
            validator_set.signers.push(*pk);
        }

        validator_set.threshold = ((validator_set.signers.len() as f32) * 2.0 / 3.0).ceil() as u8;

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
