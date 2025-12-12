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
//! - **Token Bridging**: Transfer tokens to vault on source chain and mint/transfer equivalent tokens on destination chain
//! - **Bridge Requests**: Create and manage cross-chain transfer requests
//! - **Consensus Mechanism**: Require 2/3 validator approval for critical operations
//!
//! ## Architecture
//!
//! The program uses the following main account types:
//! - `ValidatorSet`: Stores the list of validators, consensus threshold, and last batch ID
//! - `Vault`: Represents the vault account that holds bridged tokens
//! - `BridgingRequest`: Represents individual cross-chain transfer requests created by users
//! - `BridgingTransaction`: Represents validator-approved transactions for minting/transferring tokens to recipients
//! - `ValidatorDelta`: Represents pending validator set updates that require consensus
//!
//! ## Security Model
//!
//! - Validator set requires minimum 4 and maximum 10 validators
//! - Consensus threshold is automatically set to 2/3 of validators (rounded up)
//! - All critical operations require validator signatures meeting the threshold
//! - Validator set changes require approval from current validator set
//! - Batch IDs ensure operations are processed in order and prevent replay attacks
//!
//! ## Instructions
//!
//! - `initialize`: Initialize the validator set and vault for the bridge system
//! - `bridge_request`: Create a cross-chain transfer request and transfer source tokens to vault
//! - `create_or_approve_vsu`: Create or approve a validator set update (requires current validator approval)
//! - `bridge_transaction`: Create or approve a bridging transaction to transfer tokens to recipients (requires validator approval)
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

pub mod events;
pub use events::*;

pub mod helpers;
pub use helpers::*;

declare_id!("9r3WeS5AWMXnnt1vepkq8RkaTsR5RYtv7cgBRZ3fs6q3");

#[program]
pub mod skyline_program {
    use super::*;

    /// Initialize the validator set and vault for the bridge system.
    ///
    /// This instruction sets up the initial validator set that will control all bridge operations
    /// and creates the vault account that will hold bridged tokens. The validators must be unique
    /// and meet the minimum/maximum requirements. The consensus threshold is automatically calculated
    /// as 2/3 of the validator count (rounded up).
    ///
    /// # Arguments
    /// * `ctx` - The context containing accounts for initialization
    /// * `validators` - Vector of validator public keys (4-10 validators required)
    /// * `last_id` - Optional initial batch ID (defaults to 0 if not provided)
    ///
    /// # Errors
    /// * `MaxValidatorsExceeded` - If more than 10 validators are provided
    /// * `MinValidatorsNotMet` - If fewer than 4 validators are provided
    /// * `ValidatorsNotUnique` - If duplicate validators are provided
    pub fn initialize(
        ctx: Context<Initialize>,
        validators: Vec<Pubkey>,
        last_id: Option<u64>,
    ) -> Result<()> {
        Initialize::process_instruction(ctx, validators, last_id.unwrap_or(0))
    }

    /// Create a cross-chain bridging request and transfer source tokens to vault.
    ///
    /// This instruction creates a bridging request for transferring tokens to another chain.
    /// The source tokens are transferred to the vault account immediately, and a request is created
    /// that can be processed by validators to transfer equivalent tokens on the destination chain.
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

    /// Create or approve a validator set update (VSU) for the bridge.
    ///
    /// This instruction allows changing the set of validators that control bridge operations.
    /// The first call creates a validator set change proposal, and subsequent calls from validators
    /// approve the proposal. Requires approval from the current validator set meeting the consensus
    /// threshold and maintains the same validation rules as initialization (unique validators, 4-10 count).
    ///
    /// # Arguments
    /// * `ctx` - The context containing accounts for creating or approving the validator set change
    /// * `added` - Vector of new validator public keys to add
    /// * `removed` - Vector of validator indexes to remove
    /// * `batch_id` - The batch ID of the validator set change (must be greater than last_batch_id)
    ///
    /// # Errors
    /// * `MaxValidatorsExceeded` - If more than 10 validators would result from the change
    /// * `MinValidatorsNotMet` - If fewer than 4 validators would result from the change
    /// * `AddingExistingSigner` - If attempting to add a validator that already exists
    /// * `InvalidBatchId` - If the batch_id is not greater than the last_batch_id
    /// * `InvalidProposalHash` - If approving a proposal with a different hash than the original
    /// * `NoSignersProvided` - If no validator signers are provided
    /// * `NotEnoughSigners` - If insufficient current validators have signed (checked when threshold is met)
    /// * `InvalidSigner` - If a signer is not in the current validator set
    pub fn bridge_vsu(
        ctx: Context<BridgeVSU>,
        added: Vec<Pubkey>,
        removed: Vec<u64>,
        batch_id: u64,
    ) -> Result<()> {
        BridgeVSU::process_instruction(ctx, added, removed, batch_id)
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

    /// Create or approve a bridging transaction.
    ///
    /// This instruction creates or approves a bridging transaction for transferring tokens from the vault
    /// to a recipient. The first call creates the transaction, and subsequent calls from validators approve it.
    /// Once the consensus threshold is met, the tokens are automatically transferred from the vault to the
    /// recipient's associated token account, and the transaction account is closed.
    ///
    /// # Arguments
    /// * `ctx` - The context containing accounts for the bridging transaction
    /// * `amount` - The amount of tokens to transfer to the recipient
    /// * `batch_id` - The batch ID of the transaction (must be greater than last_batch_id)
    ///
    /// # Errors
    /// * `InvalidBatchId` - If the batch_id is not greater than the last_batch_id
    /// * `InvalidReceiver` - If the receiver is the same as the payer
    /// * `NoSignersProvided` - If no validator signers are provided
    /// * `SignerAlreadyApproved` - If a signer has already approved this transaction
    /// * `NotEnoughSigners` - If insufficient validators have signed (checked when threshold is met)
    /// * `InvalidSigner` - If a signer is not in the validator set
    pub fn bridge_transaction(
        ctx: Context<BridgeTransaction>,
        amount: u64,
        batch_id: u64,
    ) -> Result<()> {
        BridgeTransaction::process_instruction(ctx, amount, batch_id)
    }
}
