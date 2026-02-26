use crate::*;
use anchor_spl::token::Mint;

#[derive(Accounts)]
#[instruction(token_id: u16)]
pub struct RegisterLockUnlockToken<'info> {
    /// The admin who owns the bridge.
    /// Must match fee_config.authority — enforced by constraint below.
    /// Pays rent for TokenRegistry and TokenIdGuard PDAs.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Read-only. Used solely to validate that authority == fee_config.authority.
    /// PDA: [FEE_CONFIG_SEED]
    #[account(
        seeds = [FEE_CONFIG_SEED],
        bump  = fee_config.bump,
        constraint = authority.key() == fee_config.authority
            @ CustomError::Unauthorized // Only the authority can register tokens,
    )]
    pub fee_config: Account<'info, FeeConfig>,

    /// The pre-existing SPL mint being registered (e.g. USDC, WSOL).
    /// NOT created here — must already exist on-chain.
    /// Anchor validates this is a real, initialized SPL mint account.
    pub mint: Account<'info, Mint>,

    /// One PDA per mint. Anchor init fails if it already exists.
    /// That failure surfaces as MintAlreadyRegistered (via init constraint).
    /// PDA: [TOKEN_REGISTRY_SEED, mint.key()]
    #[account(
        init,
        payer  = authority,
        space  = DISC as usize + TokenRegistry::INIT_SPACE,
        seeds  = [TOKEN_REGISTRY_SEED, mint.key().as_ref()],
        bump,
    )]
    pub token_registry: Account<'info, TokenRegistry>,

    /// One PDA per token_id. Anchor init fails if it already exists.
    /// That failure prevents two mints sharing the same token_id,
    /// which would corrupt destination-chain routing.
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
    /// Register a pre-existing SPL mint as a LockUnlock bridgeable token.
    ///
    /// # What this does
    ///   1. Validates token_id is not the reserved currency_token_id
    ///   2. Creates TokenRegistry PDA  — one per mint
    ///   3. Creates TokenIdGuard PDA   — one per token_id (uniqueness sentinel)
    ///   4. Emits LockUnlockTokenRegisteredEvent
    ///
    /// # Arguments
    /// * `ctx`      - Instruction context
    /// * `token_id` - Gateway-compatible uint16 identifier for this token.
    ///                Must be unique across all registered tokens.
    ///                Must not equal fee_config.currency_token_id (reserved).
    ///
    /// # Errors
    /// * `CustomError::Unauthorized`    - Signer is not the bridge authority
    /// * `CustomError::CurrencyTokenId` - token_id is reserved for native currency
    /// * `AlreadyInUse`                 - mint or token_id already registered
    ///                                    (Anchor init constraint — automatic)
    pub fn process_instruction(ctx: Context<RegisterLockUnlockToken>, token_id: u16) -> Result<()> {
        let fee_config = &ctx.accounts.fee_config;
        let mint = &ctx.accounts.mint;
        let token_registry = &mut ctx.accounts.token_registry;
        let token_id_guard = &mut ctx.accounts.token_id_guard;

        // Guard: token_id cannot be the reserved currency token_id
        //
        // Gateway parity: CurrencyTokenId() revert in Gateway.registerToken()
        // The currency slot is reserved for native SOL bridging.
        // Registering an SPL token under this id would corrupt currency routing.
        require!(
            token_id != fee_config.currency_token_id,
            CustomError::CurrencyTokenId
        );

        // is_lock_unlock = true is the invariant of this instruction.
        // bridge_request will read this field to decide vault transfer vs burn.
        token_registry.token_id = token_id;
        token_registry.mint = mint.key();
        token_registry.is_lock_unlock = true;
        token_registry.bump = ctx.bumps.token_registry;

        // Stores mint for auditability: given a token_id you can derive this
        // PDA and read which mint owns that token_id slot.
        token_id_guard.mint = mint.key();
        token_id_guard.bump = ctx.bumps.token_id_guard;

        emit!(LockUnlockTokenRegisteredEvent {
            token_id,
            mint: mint.key(),
        });

        Ok(())
    }
}
