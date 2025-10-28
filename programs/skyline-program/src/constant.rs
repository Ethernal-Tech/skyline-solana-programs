//! Constants used throughout the Skyline bridge program.
//!
//! This module defines all the constant values used in the program, including
//! validator limits, seed strings for Program Derived Addresses (PDAs), and
//! other configuration parameters.

/// Maximum number of validator signers allowed in the Solana protocol.
///
/// This limit is imposed by Solana's transaction signing constraints.
/// Each transaction can have a maximum of 10 signers, which includes
/// all validator signatures plus any other required signers.
pub const MAX_VALIDATORS: usize = 10;

/// Size of the account discriminator in bytes.
///
/// The discriminator is an 8-byte prefix used by Anchor to identify
/// account types and prevent account substitution attacks.
pub const DISC: usize = 8;

/// Seed string used to derive the ValidatorSet Program Derived Address (PDA).
///
/// This seed is used in conjunction with the program ID to generate
/// a deterministic address for the validator set account.
pub const VALIDATOR_SET_SEED: &[u8] = b"validator-set";

/// Seed string used to derive BridgingRequest Program Derived Addresses (PDAs).
///
/// This seed is combined with the sender's public key to create unique
/// addresses for each bridging request account.
pub const BRIDGING_REQUEST_SEED: &[u8] = b"bridging_request";

/// Minimum number of validators required for the bridge system.
///
/// This ensures sufficient decentralization and security for the bridge.
/// With fewer than 4 validators, the system would be vulnerable to
/// various attack vectors and lack proper consensus mechanisms.
pub const MIN_VALIDATORS: usize = 4;
