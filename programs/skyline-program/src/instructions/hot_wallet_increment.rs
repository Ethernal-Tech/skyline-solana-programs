//! Hot wallet increment instruction.
//!
//! Locks lock/unlock tokens into the bridge vault and emits a
//! `HotWalletIncrementEvent` so off-chain systems can track the deposit.
//!
//! ## Eligibility
//!
//! Only mints registered via `register_lock_unlock_token` are accepted:
//!   - The `TokenRegistry` PDA must exist for the mint
//!     (enforced by Anchor's `seeds`/`bump` resolution — unregistered
//!      mints fail account loading before `process_instruction` runs).
//!   - `token_registry.is_lock_unlock == true`
//!     (mint/burn tokens have no vault-held supply to be incremented).
//!
//! ## Process
//! 1. Validate the registry indicates a lock/unlock token (account constraint).
//! 2. Validate amount > 0 and the signer holds enough tokens.
//! 3. Create the vault ATA on-demand if it doesn't exist yet.
//! 4. `transfer_checked` from signer's ATA to vault ATA.
//! 5. Emit `HotWalletIncrementEvent`.

use crate::*;
use anchor_spl::{
    associated_token::{create, get_associated_token_address, AssociatedToken, Create},
    token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked},
};

/// Account structure for the hot_wallet_increment instruction.
#[derive(Accounts)]
pub struct HotWalletIncrement<'info> {
    /// The user depositing tokens into the bridge hot wallet.
    /// Pays rent if the vault ATA needs to be created.
    #[account(mut)]
    pub signer: Signer<'info>,

    /// The signer's source token account. Tokens are debited from here.
    #[account(
        mut,
        token::mint = mint,
        token::authority = signer,
    )]
    pub signers_ata: Account<'info, TokenAccount>,

    /// Bridge vault PDA — owns `vault_ata`.
    #[account(seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,

    /// The vault's associated token account for the deposited mint.
    /// CHECK: Address-validated against the canonical ATA derivation.
    /// Created on-demand inside `process_instruction` if missing —
    /// `init_if_needed` is avoided to keep the program free of that feature.
    #[account(
        mut,
        constraint = vault_ata.key() == get_associated_token_address(
            &vault.key(),
            &mint.key()
        ) @ CustomError::InvalidVault
    )]
    pub vault_ata: UncheckedAccount<'info>,

    /// The mint of the tokens being deposited.
    pub mint: Account<'info, Mint>,

    /// Registry entry proving this mint is a registered lock/unlock token.
    ///
    /// Two-layer check:
    ///   1. `seeds` resolution fails if no registry exists for this mint
    ///      (i.e. the mint was never registered) — Anchor surfaces this
    ///      as `ConstraintSeeds`/`AccountNotInitialized`.
    ///   2. `constraint` enforces the registered token is lock/unlock,
    ///      not mint/burn.
    #[account(
        seeds = [TOKEN_REGISTRY_SEED, mint.key().as_ref()],
        bump = token_registry.bump,
        constraint = token_registry.is_lock_unlock @ CustomError::NotLockUnlock,
    )]
    pub token_registry: Account<'info, TokenRegistry>,

    /// SPL Token program.
    pub token_program: Program<'info, Token>,

    /// System program — required for ATA creation CPI.
    pub system_program: Program<'info, System>,

    /// Associated token program — required for ATA creation CPI.
    pub associated_token_program: Program<'info, AssociatedToken>,
}

impl<'info> HotWalletIncrement<'info> {
    /// Lock `amount` of `mint` into the bridge vault.
    ///
    /// # Arguments
    /// * `ctx`    - Instruction context
    /// * `amount` - Raw token amount (must be > 0). Decimals are honored
    ///              by `transfer_checked`.
    ///
    /// # Errors
    /// * `InvalidAmount`        - `amount == 0`
    /// * `InsufficientFunds`    - signer's ATA balance < `amount`
    /// * `InvalidVault`         - `vault_ata` is not the canonical ATA
    /// * `NotLockUnlock`        - mint is registered as mint/burn, not lock/unlock
    /// * Anchor seeds error     - mint has no registry (i.e. unregistered)
    pub fn process_instruction(ctx: Context<HotWalletIncrement>, amount: u64) -> Result<()> {
        require!(amount > 0, CustomError::InvalidAmount);

        let signer = &ctx.accounts.signer;
        let signers_ata = &ctx.accounts.signers_ata;
        let vault = &ctx.accounts.vault;
        let vault_ata = &ctx.accounts.vault_ata;
        let mint = &ctx.accounts.mint;
        let token_program = &ctx.accounts.token_program;

        require!(signers_ata.amount >= amount, CustomError::InsufficientFunds);

        // Lazily create the vault ATA on first deposit for this mint.
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

        transfer_checked(
            CpiContext::new(
                token_program.to_account_info(),
                TransferChecked {
                    from: signers_ata.to_account_info(),
                    to: vault_ata.to_account_info(),
                    authority: signer.to_account_info(),
                    mint: mint.to_account_info(),
                },
            ),
            amount,
            mint.decimals,
        )?;

        emit!(HotWalletIncrementEvent {
            sender: signer.key(),
            mint: mint.key(),
            amount,
        });

        Ok(())
    }
}
