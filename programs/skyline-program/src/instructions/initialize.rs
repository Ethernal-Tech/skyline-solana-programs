//! Initialize instruction for setting up the validator set, vault, and fee config.
//!
//! Single entry point for full bridge system initialization.
//! Creates: ValidatorSet PDA, Vault PDA, FeeConfig PDA.

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
        space = ValidatorSet::INIT_SPACE + DISC as usize,
        seeds = [VALIDATOR_SET_SEED],
        constraint = validators.len() <= MAX_VALIDATORS as usize @ CustomError::MaxValidatorsExceeded,
        constraint = validators.len() >= MIN_VALIDATORS as usize @ CustomError::MinValidatorsNotMet,
        bump
    )]
    pub validator_set: Account<'info, ValidatorSet>,

    /// The vault account
    #[account(
        init,
        payer = signer,
        space = Vault::INIT_SPACE + DISC as usize,
        seeds = [VAULT_SEED],
        bump
    )]
    pub vault: Account<'info, Vault>,
    /// The fee config PDA — created here, one per program
    #[account(
        init,
        payer = signer,
        space = FeeConfig::INIT_SPACE + DISC as usize,
        seeds = [FEE_CONFIG_SEED],
        bump
    )]
    pub fee_config: Account<'info, FeeConfig>,

    /// The treasury account that will receive operational fees
    /// CHECK: Stored as a Pubkey reference, no ownership constraint required
    pub treasury: UncheckedAccount<'info>,

    /// Relayer account — receives bridge fees directly
    /// CHECK: Stored as Pubkey reference in FeeConfig
    pub relayer: UncheckedAccount<'info>,

    /// The system program for account creation
    pub system_program: Program<'info, System>,
}

impl<'info> Initialize<'info> {
    pub fn process_instruction(
        ctx: Context<Self>,
        validators: Vec<Pubkey>,
        last_id: u64,
        min_operational_fee: u64,
        bridge_fee: u64,
        min_bridging_amount: u64,
        currency_token_id: u16,
    ) -> Result<()> {
        let validator_set = &mut ctx.accounts.validator_set;
        let vault = &mut ctx.accounts.vault;
        let fee_config = &mut ctx.accounts.fee_config;

        // Check for duplicate validators by sorting and deduplicating
        let mut validators_copy = validators.clone();
        validators_copy.sort();
        validators_copy.dedup();
        require!(
            validators_copy.len() == validators.len(),
            CustomError::ValidatorsNotUnique
        );

        // Set the validator list
        validator_set.signers = validators;

        // Calculate consensus threshold as 2/3 of validators, rounded up
        // This ensures that at least 2/3 of validators must approve critical operations
        validator_set.threshold = helpers::calculate_threshold(validator_set.signers.len());

        // Store the bump seed for PDA derivation
        validator_set.bump = ctx.bumps.validator_set;

        // Store the last id
        validator_set.last_batch_id = last_id;
        validator_set.bridge_request_count = 0;

        // Initialize the vault account with the bump seed
        vault.bump = ctx.bumps.vault;
        // Initialize fee config values

        // Validate once here so bridge_request can safely add the two fees together without overflow checks every time
        // If these two values overflow u64 together, reject immediately at init.
        min_operational_fee
            .checked_add(bridge_fee)
            .ok_or(CustomError::FeeConfigOverflow)?;

        require!(min_bridging_amount >= 1, CustomError::InvalidAmount);

        fee_config.min_operational_fee = min_operational_fee;
        fee_config.bridge_fee = bridge_fee;
        fee_config.min_bridging_amount = min_bridging_amount;
        fee_config.treasury = ctx.accounts.treasury.key();
        fee_config.authority = ctx.accounts.signer.key();
        fee_config.bump = ctx.bumps.fee_config;
        fee_config.relayer = ctx.accounts.relayer.key();
        fee_config.currency_token_id = currency_token_id;

        Ok(())
    }
}
