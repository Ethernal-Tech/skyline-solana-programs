//! Register Lock/Unlock Token instruction.
//!
//! Registers a pre-existing SPL mint as a lock/unlock bridgeable token.
//! On bridge_request, tokens are transferred (locked) into the vault.
//! On bridge_transaction, tokens are transferred (unlocked) back to the recipient.
//!
//! Examples: WSOL, USDC, any pre-minted SPL token the bridge (vault) does not control supply of.
//!
//! # Duplicate prevention
//!   - TokenRegistry PDA seeded by token_id → one entry per id      (Anchor init)
//!   - TokenIdGuard  PDA seeded by token_id → compatibility sentinel (Anchor init)
//!
//! Neither PDA can be created twice; Anchor's `init` rejects any attempt automatically.

use crate::*;
use anchor_spl::token::Mint;

#[derive(Accounts)]
#[instruction(token_id: u16)]
pub struct RegisterLockUnlockToken<'info> {
    /// The bridge admin.
    /// Must match fee_config.authority — enforced by constraint below.
    /// Pays rent for TokenRegistry and TokenIdGuard PDAs.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Read-only. Used solely to validate authority == fee_config.authority.
    #[account(
        seeds = [FEE_CONFIG_SEED],
        bump  = fee_config.bump,
        constraint = authority.key() == fee_config.authority
            @ CustomError::Unauthorized
    )]
    pub fee_config: Account<'info, FeeConfig>,

    /// The pre-existing SPL mint being registered (e.g. WSOL, USDC).
    /// Anchor validates this is a real, initialized SPL mint account.
    pub mint: Account<'info, Mint>,

    /// TokenRegistry PDA — one per token_id.
    ///
    /// This is the Solana-idiomatic "map entry": given any token_id, the
    /// registry for that token is always at a deterministic address:
    ///   PDA([TOKEN_REGISTRY_SEED, token_id.to_le_bytes()])
    ///
    /// Anchor's `init` rejects creation if the account already exists,
    /// making double-registration of the same token_id impossible.
    /// PDA: [TOKEN_REGISTRY_SEED, token_id.to_le_bytes()]
    #[account(
        init,
        payer  = authority,
        space  = DISC as usize + TokenRegistry::INIT_SPACE,
        seeds  = [TOKEN_REGISTRY_SEED, token_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub token_registry: Account<'info, TokenRegistry>,

    /// TokenIdGuard PDA — one per token_id.
    ///
    /// Compatibility sentinel derived by token_id.
    /// PDA: [TOKEN_ID_GUARD_SEED, token_id.to_le_bytes()]
    #[account(
        init,
        payer  = authority,
        space  = DISC as usize + TokenIdGuard::INIT_SPACE,
        seeds  = [TOKEN_ID_GUARD_SEED, token_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub token_id_guard: Account<'info, TokenIdGuard>,

    /// The system program for account creation
    pub system_program: Program<'info, System>,
}

impl<'info> RegisterLockUnlockToken<'info> {
    /// Register a pre-existing SPL mint as a lock/unlock bridgeable token.
    ///
    /// # What this does
    ///   1. Creates TokenRegistry PDA  — one per token_id (is_lock_unlock = true)
    ///   2. Creates TokenIdGuard PDA   — one per token_id (compatibility sentinel)
    ///   3. Stores per-token min_bridging_amount (raw, token-decimal-aware)
    ///   4. Emits LockUnlockTokenRegisteredEvent
    ///
    /// # Arguments
    /// * `ctx`                - Instruction context
    /// * `token_id`           - Gateway-compatible uint16 identifier for this token.
    ///                          Must be unique across all registered tokens.
    ///                          Uniqueness enforced by TokenRegistry PDA init.
    /// * `min_bridging_amount`- Minimum raw token amount allowed per bridge_request.
    ///                          Must be set in the token's native decimals:
    ///                            WSOL (9 dec):  1_000_000_000 = 1 SOL minimum
    ///                            USDC (6 dec):  1_000_000     = 1 USDC minimum
    ///
    /// # Duplicate prevention
    ///   - Same token_id reuse:        rejected by TokenRegistry `init`  (automatic)
    ///   Both fail before process_instruction runs
    ///
    /// # Errors
    /// * `CustomError::Unauthorized` - Signer is not the bridge authority
    /// * `AlreadyInUse`              - mint or token_id already registered (Anchor init)
    pub fn process_instruction(
        ctx: Context<RegisterLockUnlockToken>,
        token_id: u16,
        min_bridging_amount: u64,
    ) -> Result<()> {
        require!(token_id != 0, CustomError::InvalidMintToken);

        let mint = &ctx.accounts.mint;
        let token_registry = &mut ctx.accounts.token_registry;
        let token_id_guard = &mut ctx.accounts.token_id_guard;

        // is_lock_unlock = true is the invariant of this instruction.
        // bridge_request reads this to decide: lock into vault (true) vs burn (false).
        // bridge_transaction reads this to decide: unlock from vault (true) vs mint (false).
        token_registry.token_id = token_id;
        token_registry.mint = mint.key();
        token_registry.is_lock_unlock = true;
        token_registry.min_bridging_amount = min_bridging_amount;
        token_registry.bump = ctx.bumps.token_registry;

        // TokenIdGuard is retained as a token-id-derived compatibility sentinel
        // for existing registration clients.
        token_id_guard.mint = mint.key();
        token_id_guard.bump = ctx.bumps.token_id_guard;

        emit!(LockUnlockTokenRegisteredEvent {
            token_id,
            mint: mint.key(),
            min_bridging_amount,
        });

        Ok(())
    }
}
