//! Account structures for the Skyline bridge program.
//!
//! This module defines the data structures that represent the state of the bridge system.
//! These accounts are stored on-chain and contain the information necessary for bridge operations.

use crate::*;

/// Represents the validator set that controls bridge operations.
///
/// The `ValidatorSet` account stores the list of validators authorized to perform
/// critical bridge operations and the consensus threshold required for approval.
/// This account is initialized once and can be updated through the validator set
/// change instruction with proper consensus.
///
/// # Fields
///
/// * `signers` - Vector of validator public keys (max 128 validators)
/// * `threshold` - Number of signatures required for consensus (automatically calculated)
/// * `bump` - Bump seed for the PDA derivation
/// * `last_batch_id` - The last processed batch ID to prevent replay attacks
/// * `bridge_request_count` - Total count of bridge requests processed
#[account]
#[derive(InitSpace)]
pub struct ValidatorSet {
    /// List of validator public keys that can sign bridge operations
    /// Maximum length is constrained by `MAX_VALIDATORS` constant
    #[max_len(MAX_VALIDATORS)]
    pub signers: Vec<Pubkey>,
    /// Consensus threshold - number of validator signatures required
    /// Automatically calculated using the formula: num_signers - floor((num_signers - 1) / 3)
    pub threshold: u8,
    /// Bump seed for the Program Derived Address (PDA)
    pub bump: u8,
    /// Last batch ID processed to prevent replay attacks and ensure sequential processing
    pub last_batch_id: u64,
    /// Total count of bridge requests processed since initialization
    pub bridge_request_count: u64,
}

/// Represents the vault account that holds bridged tokens.
///
/// The `Vault` account is a Program Derived Address (PDA) that serves as the authority
/// for token operations. It can be set as the mint authority for tokens, allowing it to
/// mint tokens on the destination chain, or it can hold tokens in an associated token
/// account for transfer operations.
///
/// # Fields
///
/// * `address` - The public key of the vault account (same as the account's key)
/// * `bump` - Bump seed for the PDA derivation
#[account]
#[derive(InitSpace)]
pub struct Vault {
    /// Bump seed for the Program Derived Address (PDA)
    pub bump: u8,
}

/// Stores protocol-level fee configuration.
/// Created once by the bridge authority via init_fee_config.
/// Can be updated via update_fee_config.
#[account]
#[derive(InitSpace)]
pub struct FeeConfig {
    /// Minimum fee that goes to the bridge treasury (operational tip)
    pub min_operational_fee: u64,

    /// Estimated fee to refund the relayer for destination chain gas
    pub bridge_fee: u64,

    /// Treasury account where operational fees are sent
    pub treasury: Pubkey,

    /// Relayer account — receives bridge_fee directly per bridge request
    pub relayer: Pubkey,

    /// Who is allowed to update this config (bridge authority)
    pub authority: Pubkey,

    /// PDA bump
    pub bump: u8,
}

// ─────────────────────────────────────────────────────────────────────────────
// TokenRegistry
// ─────────────────────────────────────────────────────────────────────────────
//
// One PDA per registered SPL mint.
// Seeds: [TOKEN_REGISTRY_SEED, mint.key()]
//
// Gateway parity:
//   token_id        ↔ uint16 _tokenId in Gateway.registerToken()
//   mint            ↔ token contract address stored in NativeTokenPredicate
//   is_lock_unlock  ↔ isLockUnlock flag in NativeTokenPredicate
//
// Two registration paths:
//   is_lock_unlock = true  → registered via register_lock_unlock_token
//                            mint pre-exists (e.g. USDC, WSOL)
//                            vault ATA receives tokens on bridge_request
//
//   is_lock_unlock = false → registered via register_mint_burn_token
//                            mint CREATED during registration
//                            vault PDA is mint_authority
//                            tokens burned on bridge_request
//                            tokens minted on bridge_transaction

#[account]
#[derive(InitSpace)]
pub struct TokenRegistry {
    /// Unique token ID assigned by the bridge authority at registration.
    pub token_id: u16,

    /// The SPL mint this registry entry corresponds to.
    /// LockUnlock: pre-existing mint passed by admin.
    /// MintBurn:   newly created mint from register_mint_burn_token.
    pub mint: Pubkey,

    /// Determines token movement direction at bridge_request / bridge_transaction.
    /// true  → Lock/Unlock: transfer to/from vault ATA
    /// false → Mint/Burn:   burn from user ATA / mint to user ATA
    /// Declared once by authority at registration — immutable thereafter.
    pub is_lock_unlock: bool,

    /// Minimum raw token amount allowed per bridge_request.
    pub min_bridging_amount: u64,

    /// Stored to avoid recomputing in CPI calls.
    pub bump: u8,
}

// ─────────────────────────────────────────────────────────────────────────────
// TokenIdGuard
// ─────────────────────────────────────────────────────────────────────────────
//
// One PDA per registered token_id.
// Seeds: [TOKEN_ID_GUARD_SEED, token_id.to_le_bytes()]
//
// Purpose: enforce on-chain uniqueness of token_id values.
//
// Solana has no on-chain "does any account have field X = value?" query.
// The only way to enforce uniqueness of an arbitrary value is to embed
// that value in a PDA seed. The PDA's existence is the uniqueness proof.
//
// If token_id=5 is already taken:
//   TokenIdGuard PDA at [TOKEN_ID_GUARD_SEED, [5,0]] already exists
//   → Anchor init constraint fails → AlreadyInUse → TX rejected

#[account]
#[derive(InitSpace)]
pub struct TokenIdGuard {
    /// The mint assigned to this token_id.
    /// Stored for auditability — lets you trace token_id → mint on-chain.
    pub mint: Pubkey,

    /// Stored to avoid recomputing.
    pub bump: u8,
}
