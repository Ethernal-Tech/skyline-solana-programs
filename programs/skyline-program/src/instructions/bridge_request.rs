//! Bridge request instruction for creating cross-chain transfer requests.
//!
//! This module contains the logic for creating bridging requests that initiate
//! cross-chain token transfers. Users transfer tokens to the vault (or burn them
//! if the vault is the mint authority) and emit a request event that validators
//! can process to mint/transfer equivalent tokens on the destination chain.

use crate::*;
use anchor_spl::{
    associated_token::{create, get_associated_token_address, AssociatedToken, Create},
    token::{self, Burn, Mint, TokenAccount, Transfer},
};

/// Account structure for the bridge_request instruction.
///
/// This struct defines the accounts required to create a bridging request.
/// It includes the user's token account, the vault account, the vault's associated
/// token account (conditionally created), and the token mint for the tokens being bridged.
#[derive(Accounts)]
pub struct BridgeRequest<'info> {
    /// The user initiating the bridge request
    #[account(mut)]
    pub signer: Signer<'info>,

    /// The validator set account
    #[account(
        mut,
        seeds = [VALIDATOR_SET_SEED],
        bump = validator_set.bump
    )]
    pub validator_set: Account<'info, ValidatorSet>,

    /// The user's associated token account for the tokens being bridged
    #[account(
        mut,
        token::mint = mint,
        token::authority = signer
    )]
    pub signers_ata: Account<'info, TokenAccount>,

    /// The vault account
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,

    /// The vault associated token account for the tokens being bridged.
    /// Only created if transfer branch is taken (not burn).
    /// CHECK: Address is validated via constraint to be the canonical ATA for (vault, mint).
    /// Manual creation is used instead of init_if_needed because the burn branch doesn't
    /// need this account, avoiding unnecessary rent costs.
    #[account(
        mut,
        constraint = vault_ata.key() == get_associated_token_address(
            &vault.key(),
            &mint.key()
        ) @ CustomError::InvalidVault
    )]
    pub vault_ata: UncheckedAccount<'info>,

    /// The token mint for the tokens being bridged
    #[account(mut)]
    pub mint: Account<'info, Mint>,

    /// The token program for token operations (burn/transfer)
    pub token_program: Program<'info, anchor_spl::token::Token>,

    /// The system program for account creation
    pub system_program: Program<'info, System>,

    /// The associated token program for creating token accounts
    pub associated_token_program: Program<'info, AssociatedToken>,
}

impl<'info> BridgeRequest<'info> {
    /// Process the bridge_request instruction.
    ///
    /// This function validates the user has sufficient tokens, then either burns them
    /// (if the vault is the mint authority) or transfers them to the vault's associated
    /// token account. It then emits a bridge request event that validators can process
    /// to mint/transfer equivalent tokens on the destination chain.
    ///
    /// # Arguments
    /// * `ctx` - The instruction context containing all required accounts
    /// * `amount` - The amount of tokens to bridge to the destination chain
    /// * `receiver` - The receiver's address on the destination chain (variable length byte vector)
    /// * `destination_chain` - The chain ID of the destination blockchain
    ///
    /// # Returns
    /// * `Result<()>` - Returns Ok(()) on success or an error on failure
    ///
    /// # Errors
    /// * `InvalidAmount` - If amount is zero
    /// * `InsufficientFunds` - If the user doesn't have enough tokens to bridge
    /// * `InvalidVault` - If vault_ata address doesn't match the canonical ATA for (vault, mint)
    ///
    /// # Process Flow
    /// 1. Validates that the amount is greater than zero
    /// 2. Validates that the user has sufficient token balance
    /// 3. If vault is mint authority: burns tokens from user's account
    /// 4. If vault is not mint authority:
    ///    a. Creates vault's ATA if it doesn't exist (manual creation)
    ///    b. Transfers tokens to vault's ATA
    /// 5. Emits a bridge request event with transfer details
    /// 6. Increments the bridge request count
    pub fn process_instruction(
        ctx: Context<BridgeRequest>,
        amount: u64,
        receiver: Vec<u8>,
        destination_chain: u8,
    ) -> Result<()> {
        let mint = &ctx.accounts.mint;
        let from = &ctx.accounts.signers_ata;
        let signer = &ctx.accounts.signer;
        let token_program = &ctx.accounts.token_program;
        let vault = &ctx.accounts.vault;
        let vault_ata = &ctx.accounts.vault_ata;
        let validator_set = &mut ctx.accounts.validator_set;

        // Validate amount
        require!(amount > 0, CustomError::InvalidAmount);

        // Validate that the user has sufficient tokens to bridge
        require!(from.amount >= amount, CustomError::InsufficientFunds);

        // Determine whether to burn or transfer based on vault's mint authority
        if is_vault_mint_authority(mint, &vault.to_account_info()) {
            // Burn branch: vault is mint authority
            // Tokens are burned from user's account, no vault ATA needed
            let cpi_accounts = Burn {
                mint: mint.to_account_info(),
                from: from.to_account_info(),
                authority: signer.to_account_info(),
            };

            let cpi_context = CpiContext::new(token_program.to_account_info(), cpi_accounts);
            token::burn(cpi_context, amount)?;
        } else {
            // Transfer branch: vault is not mint authority
            // Create vault ATA if it doesn't exist, then transfer tokens
            // Manual creation is necessary because:
            // 1. The burn branch doesn't need vault_ata (would waste rent with init_if_needed)
            // 2. We only create the account when we actually need it
            if vault_ata.data_is_empty() {
                create(CpiContext::new(
                    ctx.accounts.associated_token_program.to_account_info(),
                    Create {
                        payer: signer.to_account_info(),
                        associated_token: vault_ata.to_account_info(),
                        authority: vault.to_account_info(),
                        mint: mint.to_account_info(),
                        system_program: ctx.accounts.system_program.to_account_info(),
                        token_program: token_program.to_account_info(),
                    },
                ))?;
            }

            // Transfer tokens from user to vault
            let cpi_accounts = TransferChecked {
                from: from.to_account_info(),
                to: vault_ata.to_account_info(),
                authority: signer.to_account_info(),
                mint: mint.to_account_info(),
            };

            let cpi_context = CpiContext::new(token_program.to_account_info(), cpi_accounts);
            transfer_checked(cpi_context, amount, mint.decimals)?;
        }

        // Emit bridge request event for validators to process
        emit!(BridgeRequestEvent {
            sender: signer.key(),
            amount,
            receiver,
            destination_chain,
            mint_token: mint.key(),
            batch_request_id: validator_set.bridge_request_count,
        });

        // Increment the bridge request count
        validator_set.bridge_request_count += 1;

        Ok(())
    }
}
