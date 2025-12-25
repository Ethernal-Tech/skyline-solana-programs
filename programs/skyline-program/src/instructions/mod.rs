//! Instruction modules for the Skyline bridge program.
//!
//! This module contains all the instruction implementations for the bridge system.
//! Each instruction module handles a specific operation and includes proper
//! account validation, security checks, and business logic.

/// Initialize the validator set for the bridge system.
pub mod initialize;
pub use initialize::*;

/// Create cross-chain bridging requests and transfer/burn source tokens.
pub mod bridge_request;
pub use bridge_request::*;

/// Update the validator set with proper consensus.
pub mod bridge_vsu;
pub use bridge_vsu::*;

/// Create or approve a bridging transaction.
pub mod bridge_transaction;
pub use bridge_transaction::*;
