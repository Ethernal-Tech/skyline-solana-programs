//! # Skyline Program
//!
//! A Solana program that implements a cross-chain bridging system with validator-based consensus.
//! This program enables secure token transfers between different blockchain networks through a
//! multi-signature validator set that provides security guarantees for bridge operations.
//!
//! ## Overview
//!
//! The Skyline program provides the following core functionality:
//!
//! - **Validator Management**: Initialize and manage a set of validators that control bridge operations
//! - **Token Bridging**: Burn tokens on source chain and mint equivalent tokens on destination chain
//! - **Bridge Requests**: Create and manage cross-chain transfer requests
//! - **Consensus Mechanism**: Require 2/3 validator approval for critical operations
//!
//! ## Architecture
//!
//! The program uses two main account types:
//! - `ValidatorSet`: Stores the list of validators and consensus threshold
//! - `BridgingRequest`: Represents individual cross-chain transfer requests
//!
//! ## Security Model
//!
//! - Validator set requires minimum 4 and maximum 10 validators
//! - Consensus threshold is automatically set to 2/3 of validators (rounded up)
//! - All critical operations require validator signatures meeting the threshold
//! - Validator set changes require approval from current validator set
//!
//! ## Instructions
//!
//! - `initialize`: Initialize the validator set for the bridge
//! - `bridge_tokens`: Mint tokens to a recipient (requires validator approval)
//! - `bridge_request`: Create a cross-chain transfer request and burn source tokens
//! - `validator_set_change`: Update the validator set (requires current validator approval)
//! - `close_request`: Close a bridging request account (requires validator approval)

use anchor_lang::prelude::*;

pub mod account;
pub use account::*;

pub mod constant;
pub use constant::*;

pub mod error;
pub use error::*;

pub mod instructions;
pub use instructions::*;

declare_id!("9r3WeS5AWMXnnt1vepkq8RkaTsR5RYtv7cgBRZ3fs6q3");

#[program]
pub mod skyline_program {
    use super::*;

    /// Initialize the validator set for the bridge system.
    ///
    /// This instruction sets up the initial validator set that will control all bridge operations.
    /// The validators must be unique and meet the minimum/maximum requirements.
    ///
    /// # Arguments
    /// * `ctx` - The context containing accounts for initialization
    /// * `validators` - Vector of validator public keys (4-10 validators required)
    ///
    /// # Errors
    /// * `MaxValidatorsExceeded` - If more than 10 validators are provided
    /// * `MinValidatorsNotMet` - If fewer than 4 validators are provided
    /// * `ValidatorsNotUnique` - If duplicate validators are provided
    pub fn initialize(ctx: Context<Initialize>, validators: Vec<Pubkey>) -> Result<()> {
        Initialize::process_instruction(ctx, validators)
    }

    /// Mint tokens to a recipient on the destination chain.
    ///
    /// This instruction mints tokens to a specified recipient, typically called after
    /// tokens have been burned on the source chain. Requires approval from a sufficient
    /// number of validators based on the consensus threshold.
    ///
    /// # Arguments
    /// * `ctx` - The context containing accounts for token minting
    /// * `amount` - The amount of tokens to mint
    ///
    /// # Errors
    /// * `NotEnoughSigners` - If insufficient validators have signed
    /// * `InvalidSigner` - If a signer is not in the validator set
    pub fn bridge_tokens(ctx: Context<BridgeTokens>, amount: u64) -> Result<()> {
        BridgeTokens::process_instruction(ctx, amount)
    }

    /// Create a cross-chain bridging request and burn source tokens.
    ///
    /// This instruction creates a bridging request for transferring tokens to another chain.
    /// The source tokens are burned immediately, and a request is created that can be
    /// processed by validators to mint equivalent tokens on the destination chain.
    ///
    /// # Arguments
    /// * `ctx` - The context containing accounts for the bridge request
    /// * `amount` - The amount of tokens to bridge
    /// * `receiver` - The receiver's address on the destination chain (57 bytes)
    /// * `destination_chain` - The chain ID of the destination blockchain
    ///
    /// # Errors
    /// * `InsufficientFunds` - If the sender doesn't have enough tokens
    pub fn bridge_request(
        ctx: Context<BridgeRequest>,
        amount: u64,
        receiver: [u8; 57],
        destination_chain: u8,
    ) -> Result<()> {
        BridgeRequest::process_instruction(ctx, amount, receiver, destination_chain)
    }

    /// Update the validator set for the bridge.
    ///
    /// This instruction allows changing the set of validators that control bridge operations.
    /// Requires approval from the current validator set and maintains the same validation rules
    /// as initialization (unique validators, 4-10 count).
    ///
    /// # Arguments
    /// * `ctx` - The context containing accounts for validator set change
    /// * `new_validator_set` - Vector of new validator public keys
    ///
    /// # Errors
    /// * `MaxValidatorsExceeded` - If more than 10 validators are provided
    /// * `MinValidatorsNotMet` - If fewer than 4 validators are provided
    /// * `ValidatorsNotUnique` - If duplicate validators are provided
    /// * `NotEnoughSigners` - If insufficient current validators have signed
    /// * `InvalidSigner` - If a signer is not in the current validator set
    pub fn validator_set_change(
        ctx: Context<ValidatorSetChange>,
        new_validator_set: Vec<Pubkey>,
    ) -> Result<()> {
        ValidatorSetChange::process_instruction(ctx, new_validator_set)
    }

    /// Close a bridging request account.
    ///
    /// This instruction closes a bridging request account, typically called after
    /// the request has been processed or cancelled. Requires validator approval.
    ///
    /// # Arguments
    /// * `ctx` - The context containing accounts for closing the request
    ///
    /// # Errors
    /// * `NotEnoughSigners` - If insufficient validators have signed
    /// * `InvalidSigner` - If a signer is not in the validator set
    pub fn close_request(ctx: Context<CloseRequest>) -> Result<()> {
        CloseRequest::process_instruction(ctx)
    }
}
