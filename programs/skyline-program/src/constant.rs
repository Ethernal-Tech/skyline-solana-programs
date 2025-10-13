/// Maximum number of validator signers allowed in Solana protocol
pub const MAX_VALIDATORS: usize = 19;

/// Discriminator size
pub const DISC: usize = 8;

/// ValidatorSet account seed
pub const VALIDATOR_SET_SEED: &[u8] = b"validator-set";

/// BridgingRequest account seed
pub const BRIDGING_REQUEST_SEED: &[u8] = b"bridging_request";

/// Minimum number of validators
pub const MIN_VALIDATORS: usize = 4;
