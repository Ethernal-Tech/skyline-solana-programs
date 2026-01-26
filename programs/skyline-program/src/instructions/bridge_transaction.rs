//! Bridge transaction instruction for transferring tokens to recipients.
//!
//! This module contains the logic for transferring tokens to recipients on the destination chain.
//! This instruction is typically called after tokens have been transferred to the vault or
//! burned on the source chain and requires validator consensus to execute.

use anchor_spl::{
    associated_token::{self, get_associated_token_address, AssociatedToken},
    token::{self, Mint, Token, Transfer},
};

use crate::*;

/// Account structure for the bridge_transaction instruction.
///
/// This struct defines the accounts required to transfer tokens to a recipient.
/// It includes the validator set for consensus validation and token accounts for minting/transferring.
#[derive(Accounts)]
#[instruction(batch_id: u64)]
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

    /// The bridging transaction account to be created
    #[account(
        init_if_needed,
        payer = payer,
        space = DISC as usize + BridgingTransaction::INIT_SPACE,
        seeds = [BRIDGING_TRANSACTION_SEED, batch_id.to_le_bytes().as_ref()],
        bump
    )]
    pub bridging_transaction: Account<'info, BridgingTransaction>,

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
    /// This function creates or approves a bridging transaction for transferring tokens
    /// to a recipient. The first call creates the transaction with the specified details,
    /// and subsequent calls from validators approve it. Once the consensus threshold is met,
    /// the tokens are automatically minted (if vault is mint authority) or transferred
    /// from the vault to the recipient's associated token account, and the transaction
    /// account is closed.
    ///
    /// # Arguments
    /// * `ctx` - The instruction context containing all required accounts
    /// * `amount` - The amount of tokens to transfer to the recipient
    /// * `batch_id` - The batch ID of the transaction (must be greater than last_batch_id)
    ///
    /// # Returns
    /// * `Result<()>` - Returns Ok(()) on success or an error on failure
    ///
    /// # Errors
    /// * `InvalidBatchId` - If the batch_id is not greater than the last_batch_id
    /// * `BridgingTransactionMismatch` - If transaction details don't match on subsequent approvals
    /// * `NoSignersProvided` - If no validator signers are provided
    /// * `DuplicateSignersProvided` - If duplicate signers are provided
    /// * `InvalidSigner` - If a signer is not in the validator set
    /// * `SignerAlreadyApproved` - If a signer has already approved this transaction
    ///
    /// # Process Flow
    /// 1. Creates the transaction account if it doesn't exist, or validates details match
    /// 2. Validates and collects validator signers from remaining accounts
    /// 3. Checks for duplicate signers and ensures all are valid validators
    /// 4. Adds signers to the approval list
    /// 5. If threshold is met, creates recipient ATA if needed and transfers/mints tokens
    /// 6. Updates last_batch_id and closes the transaction account
    pub fn process_instruction(ctx: Context<Self>, amount: u64, batch_id: u64) -> Result<()> {
        let bridging_transaction = &mut ctx.accounts.bridging_transaction;
        let payer = &ctx.accounts.payer;
        let validator_set = &mut ctx.accounts.validator_set;
        let recipient = &ctx.accounts.recipient;
        let recipient_ata = &ctx.accounts.recipient_ata;
        let vault = &ctx.accounts.vault;
        let vault_ata = &ctx.accounts.vault_ata;
        let mint = &ctx.accounts.mint_token;
        let associated_token_program = &ctx.accounts.associated_token_program;
        let token_program = &ctx.accounts.token_program;

        // Validate amount
        require!(amount > 0, CustomError::InvalidAmount);

        // Store the transaction details
        if bridging_transaction.id == Pubkey::default() {
            bridging_transaction.id = bridging_transaction.key();
            bridging_transaction.amount = amount;
            bridging_transaction.receiver = recipient.key();
            bridging_transaction.mint_token = mint.key();
            bridging_transaction.batch_id = batch_id;
            bridging_transaction.bump = ctx.bumps.bridging_transaction;
        } else {
            require!(
                bridging_transaction.amount == amount
                    && bridging_transaction.receiver == recipient.key()
                    && bridging_transaction.mint_token == mint.key(),
                CustomError::BridgingTransactionMismatch
            );
        }

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
            !signers
                .iter()
                .any(|s| bridging_transaction.signers.contains(s)),
            CustomError::SignerAlreadyApproved
        );

        bridging_transaction.signers.extend(signers.iter());

        if (bridging_transaction.signers.len() as u8) < validator_set.threshold {
            return Ok(());
        }

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

        if is_vault_mint_authority(mint, &vault.to_account_info()) {
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
                bridging_transaction.amount,
            )?;
        } else {
            // Prepare the mint_to instruction with validator set as authority
            let cpi_accounts = Transfer {
                from: vault_ata.to_account_info(),
                to: recipient_ata.to_account_info(),
                authority: vault.to_account_info(),
            };

            // Transfer tokens to the recipient
            token::transfer(
                // q should we use transfer_checked?
                CpiContext::new_with_signer(
                    token_program.to_account_info(),
                    cpi_accounts,
                    signer_seeds,
                ),
                bridging_transaction.amount,
            )?;
        }

        emit!(TransactionExecutedEvent {
            transaction_id: bridging_transaction.id,
            batch_id: bridging_transaction.batch_id,
        });

        validator_set.last_batch_id = bridging_transaction.batch_id;

        // Close the bridging transaction account if enough signers have approved
        bridging_transaction.close(payer.to_account_info())?;

        Ok(())
    }
}
