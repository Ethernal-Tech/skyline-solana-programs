//! Constants used throughout the Skyline bridge program.
//!
//! This module defines all the constant values used in the program, including
//! validator limits, seed strings for Program Derived Addresses (PDAs), and
//! other configuration parameters.

use anchor_lang::constant;

/// Maximum number of validators allowed in the validator set.
///
/// This constant defines the upper limit for the number of validators that can be
/// included in the validator set. The limit is set to 128 to balance security,
/// decentralization, and practical constraints.
#[constant]
pub const MAX_VALIDATORS: u32 = 128;

/// Size of the account discriminator in bytes.
///
/// The discriminator is an 8-byte prefix used by Anchor to identify
/// account types and prevent account substitution attacks.
#[constant]
pub const DISC: u32 = 8;

/// Seed string used to derive the ValidatorSet Program Derived Address (PDA).
///
/// This seed is used in conjunction with the program ID to generate
/// a deterministic address for the validator set account.
#[constant]
pub const VALIDATOR_SET_SEED: &[u8] = b"validator-set";

/// Seed string used to derive BridgingRequest Program Derived Addresses (PDAs).
///
/// This seed is combined with the sender's public key to create unique
/// addresses for each bridging request account.
#[constant]
pub const BRIDGING_REQUEST_SEED: &[u8] = b"bridging_request";

/// Minimum number of validators required for the bridge system.
///
/// This ensures sufficient decentralization and security for the bridge.
/// With fewer than 4 validators, the system would be vulnerable to
/// various attack vectors and lack proper consensus mechanisms.
#[constant]
pub const MIN_VALIDATORS: u32 = 4;

/// Seed string used to derive Vault Program Derived Addresses (PDAs).
///
/// This seed is combined with the vault address to create a unique address for the vault account.
#[constant]
pub const VAULT_SEED: &[u8] = b"vault";

/// Maximum number of validators allowed to be added or removed in a single validator set change.
///
/// This limit is imposed by Solana's transaction signing constraints.
/// Each transaction can have a maximum of 10 validators added or removed.
#[constant]
pub const MAX_VALIDATORS_CHANGE: u32 = 10;

/// Seed string used to derive FeeConfig PDA
#[constant]
pub const FEE_CONFIG_SEED: &[u8] = b"fee_config";

/// Seed string used to derive TokenRegistry PDA
#[constant]
pub const TOKEN_REGISTRY_SEED: &[u8] = b"token_registry";

/// Seed string used to derive TokenIdGuard PDA
#[constant]
pub const TOKEN_ID_GUARD_SEED: &[u8] = b"token_id_guard";
