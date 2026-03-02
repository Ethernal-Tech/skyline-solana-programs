//! Register Mint/Burn token instruction.
//!
//! Creates a brand-new SPL mint, assigns the Vault PDA as mint_authority,
//! attaches Metaplex metadata (name, symbol, uri), then writes
//! TokenRegistry + TokenIdGuard PDAs and emits MintBurnTokenRegisteredEvent.
//!
//! On bridge_request:     tokens are BURNED from user ATA (vault is authority)
//! On bridge_transaction: tokens are MINTED to recipient ATA

use anchor_spl::{
    metadata::{
        create_metadata_accounts_v3, mpl_token_metadata::types::DataV2, CreateMetadataAccountsV3,
        Metadata,
    },
    token::{Mint, Token},
};

use crate::*;

// ─────────────────────────────────────────────────────────────────────────────
// Accounts
// ─────────────────────────────────────────────────────────────────────────────

/// Accounts required to register a MintBurn token.
#[derive(Accounts)]
#[instruction(token_id: u16, decimals: u8)]
pub struct RegisterMintBurnToken<'info> {
    // ── Signer / Payer ────────────────────────────────────────────────────────
    /// Bridge authority — must match fee_config.authority.
    /// Pays rent for: new Mint, Metadata, TokenRegistry, TokenIdGuard.
    #[account(mut)]
    pub authority: Signer<'info>,

    // ── Config ────────────────────────────────────────────────────────────────
    /// Read-only. Validates authority
    /// PDA: [FEE_CONFIG_SEED]
    #[account(
        seeds = [FEE_CONFIG_SEED],
        bump = fee_config.bump,
        has_one = authority @ CustomError::Unauthorized,
    )]
    pub fee_config: Account<'info, FeeConfig>,

    // ── Vault PDA ─────────────────────────────────────────────────────────────
    /// Vault PDA — will be set as mint_authority + freeze_authority for the new mint.
    /// This is what gives the bridge exclusive minting rights.
    /// PDA: [VAULT_SEED]
    ///
    /// CHECK: PDA validated by seeds constraint. No data read or written here —
    /// it is only used as an authority pubkey in CPI calls.
    #[account(
        seeds = [VAULT_SEED],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    // ── New SPL Mint ──────────────────────────────────────────────────────────
    /// The brand-new SPL mint created by this instruction.
    /// Client generates the keypair off-chain and passes it as a signer.
    /// mint_authority and freeze_authority → vault PDA.
    /// decimals → provided by caller (typically 6 or 9).
    #[account(
        init,
        payer    = authority,
        mint::decimals  = decimals,
        mint::authority = vault,
        mint::freeze_authority = vault,
    )]
    pub mint: Account<'info, Mint>,

    // ── Metaplex Metadata ─────────────────────────────────────────────────────
    /// Metaplex metadata account for the new mint.
    /// Derived by Metaplex program — seeds are managed by the metadata CPI.
    ///
    /// CHECK: Account is uninitialized. Seeds and ownership are validated
    /// inside the Metaplex create_metadata_accounts_v3 CPI call.
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,

    // ── TokenRegistry PDA ─────────────────────────────────────────────────────
    /// One PDA per mint — enforces mint uniqueness across the registry.
    /// Anchor init fails with AlreadyInUse if this mint was already registered.
    /// PDA: [TOKEN_REGISTRY_SEED, mint.key()]
    #[account(
        init,
        payer = authority,
        space = 8 + TokenRegistry::INIT_SPACE,
        seeds = [TOKEN_REGISTRY_SEED, mint.key().as_ref()],
        bump,
    )]
    pub token_registry: Account<'info, TokenRegistry>,

    // ── TokenIdGuard PDA ──────────────────────────────────────────────────────
    /// One PDA per token_id — enforces token_id uniqueness across the registry.
    /// Anchor init fails with AlreadyInUse if this token_id is already taken.
    /// PDA: [TOKEN_ID_GUARD_SEED, token_id.to_le_bytes()]
    #[account(
        init,
        payer = authority,
        space = 8 + TokenIdGuard::INIT_SPACE,
        seeds = [TOKEN_ID_GUARD_SEED, token_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub token_id_guard: Account<'info, TokenIdGuard>,

    // ── Programs ──────────────────────────────────────────────────────────────
    pub token_program: Program<'info, Token>,
    pub metadata_program: Program<'info, Metadata>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Instruction implementation
// ─────────────────────────────────────────────────────────────────────────────

impl<'info> RegisterMintBurnToken<'info> {
    /// Register a brand-new SPL mint as a MintBurn bridgeable token.
    ///
    /// # What this does
    ///   1. Creates SPL mint with vault as mint_authority (via Anchor init)
    ///   2. Creates Metaplex metadata via CPI (name, symbol, uri)
    ///   3. Creates TokenRegistry PDA  (is_lock_unlock = false)
    ///   4. Creates TokenIdGuard PDA   (uniqueness sentinel)
    ///   5. Emits MintBurnTokenRegisteredEvent
    ///
    /// # Arguments
    /// * `ctx`      - Instruction context
    /// * `token_id` - Unique token dentifier.        
    /// * `decimals` - Decimal precision for the new SPL mint (e.g. 6 or 9).
    /// * `name`     - Token name stored in Metaplex metadata.
    /// * `symbol`   - Token symbol stored in Metaplex metadata.
    /// * `uri`      - Metadata URI (e.g. IPFS JSON link).
    ///
    /// # Errors
    /// * `CustomError::Unauthorized`    - Signer is not the bridge authority
    /// * `AlreadyInUse`                 - mint or token_id already registered
    pub fn process_instruction(
        ctx: Context<RegisterMintBurnToken>,
        token_id: u16,
        _decimals: u8, // consumed by #[instruction] constraint, not used directly
        min_bridging_amount: u64,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        let vault = &ctx.accounts.vault;
        let mint = &ctx.accounts.mint;
        let token_registry = &mut ctx.accounts.token_registry;
        let token_id_guard = &mut ctx.accounts.token_id_guard;

        // ── Metaplex metadata CPI ─────────────────────────────────────────────
        //
        // Vault PDA signs the CPI as update_authority + mint_authority.
        // We rebuild the vault seeds here so Anchor can produce the PDA signer.
        //
        // is_mutable = false: metadata is set once at registration and never changed.
        // update_authority = vault: bridge retains authority over metadata.

        let vault_bump = vault.bump;
        let vault_seeds = &[VAULT_SEED, &[vault_bump]];
        let signer_seeds = &[vault_seeds.as_ref()];

        create_metadata_accounts_v3(
            CpiContext::new_with_signer(
                ctx.accounts.metadata_program.to_account_info(),
                CreateMetadataAccountsV3 {
                    metadata: ctx.accounts.metadata.to_account_info(),
                    mint: mint.to_account_info(),
                    mint_authority: vault.to_account_info(),
                    payer: ctx.accounts.authority.to_account_info(),
                    update_authority: vault.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    rent: ctx.accounts.rent.to_account_info(),
                },
                signer_seeds,
            ),
            DataV2 {
                name: name.clone(),
                symbol: symbol.clone(),
                uri: uri.clone(),
                seller_fee_basis_points: 0,
                creators: None,
                collection: None,
                uses: None,
            },
            true, // is_mutable — set true to allow future URI updates by vault
            true, // update_authority_is_signer
            None, // collection_details
        )?;

        // ── Write TokenRegistry ───────────────────────────────────────────────
        //
        // is_lock_unlock = false is the invariant of this instruction.
        // bridge_request reads this to decide: burn (false) vs transfer (true).
        // bridge_transaction reads this to decide: mint (false) vs unlock (true).

        token_registry.token_id = token_id;
        token_registry.mint = mint.key();
        token_registry.is_lock_unlock = false;
        token_registry.min_bridging_amount = min_bridging_amount;
        token_registry.bump = ctx.bumps.token_registry;

        // ── Write TokenIdGuard ────────────────────────────────────────────────

        token_id_guard.mint = mint.key();
        token_id_guard.bump = ctx.bumps.token_id_guard;

        // ── Emit ──────────────────────────────────────────────────────────────

        emit!(MintBurnTokenRegisteredEvent {
            token_id,
            mint: mint.key(),
            name: name.clone(),
            symbol: symbol.clone(),
        });

        Ok(())
    }
}
