//! Hot wallet increment instruction.
//!
//! Tops up the bridge vault with liquidity and emits a
//! `HotWalletIncrementEvent` so off-chain systems can track the deposit.
//!
//! ## Eligible mints
//!
//! Two — and only two — assets can be deposited via this instruction:
//!
//! - **wSOL** (`So11111111111111111111111111111111111111112`) — token branch:
//!   `transfer_checked` from the signer's ATA into the vault ATA.
//! - **Native SOL** (`NATIVE_SOL_MINT` sentinel = System Program ID =
//!   `Pubkey::default()`) — direct lamport `system_program::transfer` from
//!   the signer into the vault PDA. No mint, no ATAs involved. Uses the
//!   same sentinel convention as `bridge_transaction`.
//!
//! ## Process
//! 1. Validate `amount > 0`.
//! 2. Validate `mint.key() == WSOL_MINT || mint.key() == NATIVE_SOL_MINT`.
//! 3. **Native-SOL branch**: `system_program::transfer` signer → vault PDA.
//! 4. **wSOL branch**:
//!    a. Deserialize `mint` / `signers_ata` and validate balance + ownership.
//!    b. Validate `vault_ata` matches the canonical ATA for (vault, mint).
//!    c. Create the vault ATA on-demand if it doesn't exist yet.
//!    d. `transfer_checked` from signer's ATA to vault ATA.
//! 5. Emit `HotWalletIncrementEvent` (works for both branches; `mint` field
//!    carries the sentinel for native SOL).
//!
//! For native-SOL deposits the relayer may pass any account (e.g. the System
//! Program) at the `signers_ata` and `vault_ata` slots — they are unused on
//! that branch but the slots must remain to keep the Anchor account layout
//! stable.

use crate::*;
use anchor_lang::system_program::{transfer as system_transfer, Transfer as SystemTransfer};
use anchor_lang::AccountDeserialize;
use anchor_spl::{
    associated_token::{create, get_associated_token_address, AssociatedToken, Create},
    token::{self, transfer_checked, Mint, Token, TokenAccount, TransferChecked},
};

/// Account structure for the hot_wallet_increment instruction.
#[derive(Accounts)]
pub struct HotWalletIncrement<'info> {
    /// The user depositing liquidity into the bridge hot wallet.
    /// Pays rent if the vault ATA needs to be created (wSOL branch).
    #[account(mut)]
    pub signer: Signer<'info>,

    /// CHECK: wSOL branch — must be the signer's ATA for `mint`; deserialized
    /// and validated at runtime. Native-SOL branch — unused; pass any account
    /// (e.g. the System Program) as a placeholder.
    #[account(mut)]
    pub signers_ata: UncheckedAccount<'info>,

    /// Bridge vault PDA. `mut` because the native-SOL branch credits its
    /// lamport balance directly via `system_program::transfer`.
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,

    /// CHECK: wSOL branch — must equal the canonical ATA for (`vault`, `mint`),
    /// validated at runtime. Native-SOL branch — unused; placeholder allowed.
    #[account(mut)]
    pub vault_ata: UncheckedAccount<'info>,

    /// CHECK: Must equal `WSOL_MINT` (wSOL branch) or `NATIVE_SOL_MINT`
    /// (native-SOL branch); enforced at runtime. For the native-SOL branch
    /// this is the System Program account (since `NATIVE_SOL_MINT == System
    /// Program ID`), matching the convention used by `bridge_transaction`.
    pub mint: UncheckedAccount<'info>,

    /// SPL Token program.
    pub token_program: Program<'info, Token>,

    /// System program — required for ATA creation CPI (wSOL branch) and the
    /// native-SOL lamport transfer.
    pub system_program: Program<'info, System>,

    /// Associated token program — required for ATA creation CPI.
    pub associated_token_program: Program<'info, AssociatedToken>,
}

impl<'info> HotWalletIncrement<'info> {
    /// Lock `amount` of `mint` into the bridge vault.
    ///
    /// # Arguments
    /// * `ctx`    - Instruction context
    /// * `amount` - Raw amount to deposit. For wSOL, decimals are honored by
    ///              `transfer_checked`. For native SOL, `amount` is lamports.
    ///              Must be > 0.
    ///
    /// # Errors
    /// * `InvalidAmount`       - `amount == 0`
    /// * `InvalidMintToken`    - `mint` is neither `WSOL_MINT` nor
    ///                           `NATIVE_SOL_MINT`, or the signer's ATA mint
    ///                           doesn't match (wSOL branch)
    /// * `InsufficientFunds`   - signer doesn't have enough wSOL or lamports
    /// * `InvalidTokenAccount` - signer's ATA failed to deserialize or its
    ///                           owner doesn't match the signer
    /// * `InvalidVault`        - `vault_ata` is not the canonical ATA for
    ///                           (vault, mint) on the wSOL branch
    pub fn process_instruction(ctx: Context<HotWalletIncrement>, amount: u64) -> Result<()> {
        require!(amount > 0, CustomError::InvalidAmount);

        let signer = &ctx.accounts.signer;
        let vault = &ctx.accounts.vault;
        let mint_account = &ctx.accounts.mint;
        let mint_key = mint_account.key();

        // Eligibility gate: only canonical wSOL or the native-SOL sentinel.
        require!(
            mint_key == WSOL_MINT || mint_key == NATIVE_SOL_MINT,
            CustomError::InvalidMintToken
        );

        if mint_key == NATIVE_SOL_MINT {
            // ── Native SOL branch ─────────────────────────────────────────
            //
            // Direct lamport transfer signer → vault PDA. `signer` is
            // system-owned, so the System Program's `transfer` instruction
            // is the right primitive — same pattern used in `bridge_request`
            // for the bridge_fee escrow.
            //
            // No mint deserialization, no ATA creation, no SPL CPI.
            // `signers_ata` and `vault_ata` are unused on this branch.

            require!(signer.lamports() >= amount, CustomError::InsufficientFunds);

            system_transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    SystemTransfer {
                        from: signer.to_account_info(),
                        to: vault.to_account_info(),
                    },
                ),
                amount,
            )?;
        } else {
            // ── wSOL branch ───────────────────────────────────────────────
            //
            // `mint` and `signers_ata` are UncheckedAccount in the struct
            // (because they're conditional on this branch), so we deserialize
            // them and re-impose the constraints that previously lived in
            // `#[account(...)]`: signer's ATA must match the mint and be
            // owned by the signer.

            // We can't use `Account::<T>::try_from(...)` here because
            // `ctx.accounts` lives under a shorter Anchor-generated lifetime
            // than the `'info` that `Account::try_from` would require. Instead
            // we deserialize the SPL data manually and re-impose the owner
            // check that `Account::try_from` would have performed (owner ==
            // SPL Token program).

            require!(
                mint_account.owner == &token::ID,
                CustomError::InvalidMintToken
            );
            require!(
                ctx.accounts.signers_ata.owner == &token::ID,
                CustomError::InvalidTokenAccount
            );

            let mint_data: Mint = {
                let raw = mint_account
                    .try_borrow_data()
                    .map_err(|_| error!(CustomError::InvalidMintToken))?;
                Mint::try_deserialize(&mut &raw[..])
                    .map_err(|_| error!(CustomError::InvalidMintToken))?
            };

            let signers_ata_data: TokenAccount = {
                let raw = ctx
                    .accounts
                    .signers_ata
                    .try_borrow_data()
                    .map_err(|_| error!(CustomError::InvalidTokenAccount))?;
                TokenAccount::try_deserialize(&mut &raw[..])
                    .map_err(|_| error!(CustomError::InvalidTokenAccount))?
            };

            require!(
                signers_ata_data.mint == mint_key,
                CustomError::InvalidMintToken
            );
            require!(
                signers_ata_data.owner == signer.key(),
                CustomError::InvalidTokenAccount
            );
            require!(
                signers_ata_data.amount >= amount,
                CustomError::InsufficientFunds
            );

            // Address-validate vault_ata against the canonical derivation —
            // identical to the constraint we removed from the account macro.
            let expected_vault_ata = get_associated_token_address(&vault.key(), &mint_key);
            require!(
                ctx.accounts.vault_ata.key() == expected_vault_ata,
                CustomError::InvalidVault
            );

            // Lazily create the vault ATA on first deposit for this mint.
            if ctx.accounts.vault_ata.data_is_empty() {
                create(CpiContext::new(
                    ctx.accounts.associated_token_program.to_account_info(),
                    Create {
                        payer: signer.to_account_info(),
                        associated_token: ctx.accounts.vault_ata.to_account_info(),
                        authority: vault.to_account_info(),
                        mint: mint_account.to_account_info(),
                        system_program: ctx.accounts.system_program.to_account_info(),
                        token_program: ctx.accounts.token_program.to_account_info(),
                    },
                ))?;
            }

            transfer_checked(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.signers_ata.to_account_info(),
                        to: ctx.accounts.vault_ata.to_account_info(),
                        authority: signer.to_account_info(),
                        mint: mint_account.to_account_info(),
                    },
                ),
                amount,
                mint_data.decimals,
            )?;
        }

        emit!(HotWalletIncrementEvent {
            sender: signer.key(),
            mint: mint_key,
            amount,
        });

        Ok(())
    }
}
