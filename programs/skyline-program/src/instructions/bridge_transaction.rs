//! Bridge transaction instruction for transferring tokens to recipients.
//!
//! This module contains the logic for transferring tokens to recipients on the destination chain.
//! This instruction is typically called after tokens have been transferred to the vault or
//! burned on the source chain and requires validator consensus to execute.

use anchor_spl::{
    associated_token::{self, get_associated_token_address, AssociatedToken},
    token::{self, transfer_checked, Mint, Token, TransferChecked},
};

use crate::*;

/// Account structure for the bridge_transaction instruction.
///
/// This struct defines the accounts required to transfer tokens to a recipient.
/// It includes the validator set for consensus validation and token accounts for minting/transferring.
#[derive(Accounts)]
#[instruction(amount: u64, batch_id: u64)]
pub struct BridgeTransaction<'info> {
    /// The payer for any associated token account creation
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The validator set account for consensus validation
    #[account(
        mut,
        seeds = [VALIDATOR_SET_SEED],
        bump = validator_set.bump,
        constraint = validator_set.last_batch_id < batch_id @CustomError::InvalidBatchId,
    )]
    pub validator_set: Account<'info, ValidatorSet>,

    #[account(mut)]
    pub mint_token: Account<'info, Mint>,

    /// The recipient of the bridged tokens
    /// CHECK: This account is validated through the associated token account creation
    pub recipient: UncheckedAccount<'info>,

    /// The recipient's associated token account for the mint
    /// Validated to be the canonical ATA address, created manually after threshold check
    /// CHECK: Address is validated via constraint to be the canonical ATA for (recipient, mint_token)
    #[account(
    mut,
    // The address must be the canonical ATA for (recipient, mint_token)
    constraint = recipient_ata.key() == get_associated_token_address(
        &recipient.key(),
        &mint_token.key()
    ) @ CustomError::InvalidTokenAccount
)]
    pub recipient_ata: UncheckedAccount<'info>,

    /// The vault account
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,

    /// The vault associated token account for the mint
    /// Validated to be the canonical ATA address
    /// CHECK: Address is validated via constraint to be the canonical ATA for (vault, mint_token)
    #[account(
    mut,
    constraint = vault_ata.key() == get_associated_token_address(
        &vault.key(),
        &mint_token.key()
    ) @ CustomError::InvalidVault
)]
    pub vault_ata: UncheckedAccount<'info>,

    /// The TokenRegistry PDA for this mint.
    ///
    /// Determines the release mechanic for this token:
    ///   - is_lock_unlock = false → vault mints tokens to recipient
    ///   - is_lock_unlock = true  → vault transfers (unlocks) tokens from vault ATA to recipient
    ///
    /// Only tokens registered via register_lock_unlock_token or register_mint_burn_token
    /// are permitted. Unregistered mints will fail this account constraint before any
    /// logic runs.
    #[account(
        seeds = [TOKEN_REGISTRY_SEED, mint_token.key().as_ref()],
        bump = token_registry.bump,
    )]
    pub token_registry: Account<'info, TokenRegistry>,

    /// The token program for minting operations
    pub token_program: Program<'info, Token>,

    /// The system program for account creation
    pub system_program: Program<'info, System>,

    /// The associated token program for creating token accounts
    pub associated_token_program: Program<'info, AssociatedToken>,
}

impl<'info> BridgeTransaction<'info> {
    /// Process the bridge_transaction instruction.
    ///
    /// Validates that enough validators have signed this transaction in a single call.
    /// If the threshold is not met, the transaction is rejected outright — there is no
    /// multi-round accumulation. On success, tokens are minted or transferred to the
    /// recipient and `last_batch_id` is updated to prevent replay.
    ///
    /// # Arguments
    /// * `ctx` - The instruction context containing all required accounts
    /// * `amount` - The amount of tokens to transfer to the recipient
    /// * `batch_id` - The batch ID (must be strictly greater than `last_batch_id`)
    ///
    /// # Errors
    /// * `InvalidBatchId` - If `batch_id` is not greater than `last_batch_id`
    /// * `InvalidAmount` - If amount is zero
    /// * `NoSignersProvided` - If no validator signers are in remaining accounts
    /// * `DuplicateSignersProvided` - If duplicate signers are present
    /// * `InvalidSigner` - If any signer is not a registered validator
    /// * `InsufficientSigners` - If signer count is below the threshold
    ///
    /// # Process Flow
    /// 1. Validate amount > 0
    /// 2. Collect and deduplicate validator signers from remaining accounts
    /// 3. Verify all signers are valid validators
    /// 4. Verify signer count meets threshold — reject if not
    /// 5. Create recipient ATA if needed
    /// 6. Mint or transfer tokens to recipient
    /// 7. Update `last_batch_id`

    pub fn process_instruction(ctx: Context<Self>, amount: u64, batch_id: u64) -> Result<()> {
        let payer = &ctx.accounts.payer;
        let validator_set = &mut ctx.accounts.validator_set;
        let recipient = &ctx.accounts.recipient;
        let recipient_ata = &ctx.accounts.recipient_ata;
        let vault = &ctx.accounts.vault;
        let vault_ata = &ctx.accounts.vault_ata;
        let mint = &ctx.accounts.mint_token;
        let associated_token_program = &ctx.accounts.associated_token_program;
        let token_program = &ctx.accounts.token_program;
        let token_registry = &ctx.accounts.token_registry;

        // Validate amount
        require!(amount > 0, CustomError::InvalidAmount);

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

        // Create recipient ATA if it doesn't exist (only after threshold met)
        if recipient_ata.data_is_empty() {
            let cpi_context = CpiContext::new(
                associated_token_program.to_account_info(),
                associated_token::Create {
                    payer: payer.to_account_info(),
                    associated_token: recipient_ata.to_account_info(),
                    authority: recipient.to_account_info(),
                    mint: mint.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    token_program: token_program.to_account_info(),
                },
            );
            associated_token::create(cpi_context)?;
        }

        let seeds = &[VAULT_SEED, &[vault.bump]];
        let signer_seeds = &[&seeds[..]];

        if !token_registry.is_lock_unlock {
            let cpi_accounts = token::MintTo {
                mint: mint.to_account_info(),
                to: recipient_ata.to_account_info(),
                authority: vault.to_account_info(),
            };

            token::mint_to(
                CpiContext::new_with_signer(
                    token_program.to_account_info(),
                    cpi_accounts,
                    signer_seeds,
                ),
                amount,
            )?;
        } else {
            // Prepare the mint_to instruction with validator set as authority
            let cpi_accounts = TransferChecked {
                from: vault_ata.to_account_info(),
                to: recipient_ata.to_account_info(),
                authority: vault.to_account_info(),
                mint: mint.to_account_info(),
            };

            // Transfer tokens to the recipient
            transfer_checked(
                CpiContext::new_with_signer(
                    token_program.to_account_info(),
                    cpi_accounts,
                    signer_seeds,
                ),
                amount,
                mint.decimals,
            )?;
        }

        emit!(TransactionExecutedEvent { batch_id: batch_id });

        validator_set.last_batch_id = batch_id;

        Ok(())
    }
}
