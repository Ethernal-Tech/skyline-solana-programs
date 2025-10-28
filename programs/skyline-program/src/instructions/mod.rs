//! Instruction modules for the Skyline bridge program.
//!
//! This module contains all the instruction implementations for the bridge system.
//! Each instruction module handles a specific operation and includes proper
//! account validation, security checks, and business logic.

/// Initialize the validator set for the bridge system.
pub mod initialize;
pub use initialize::*;

/// Mint tokens to recipients on the destination chain.
pub mod bridge_tokens;
pub use bridge_tokens::*;

/// Create cross-chain bridging requests and burn source tokens.
pub mod bridge_request;
pub use bridge_request::*;

/// Update the validator set with proper consensus.
pub mod validator_set_change;
pub use validator_set_change::*;

/// Close bridging request accounts.
pub mod close_requests;
pub use close_requests::*;
