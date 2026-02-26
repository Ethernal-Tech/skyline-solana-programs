//! Event definitions for the Skyline bridge program.
//!
//! This module defines all the events that are emitted by the bridge program.
//! Events are used to notify off-chain systems about important state changes
//! and can be indexed by blockchain explorers and monitoring systems.

use anchor_lang::prelude::*;

/// Event emitted when a bridging transaction is successfully executed.
///
/// This event is emitted after a bridging transaction has received sufficient
/// validator approvals and the tokens have been transferred or minted to the recipient.
#[event]
pub struct TransactionExecutedEvent {
    /// The unique identifier of the transaction that was executed
    pub transaction_id: Pubkey,
    /// The batch ID of the executed transaction
    pub batch_id: u64,
}

/// Event emitted when the validator set is successfully updated.
///
/// This event is emitted after a validator set change proposal has received
/// sufficient validator approvals and the changes have been applied to the validator set.
#[event]
pub struct ValidatorSetUpdatedEvent {
    /// The new list of validator signers after the update
    pub new_signers: Vec<Pubkey>,
    /// The new consensus threshold for the validator set
    pub new_threshold: u8,
    /// The batch ID associated with the validator set update
    pub batch_id: u64,
}

/// Event emitted when a bridge request is created.
///
/// This event is emitted when a user initiates a cross-chain token transfer.
/// The event contains all the information needed for validators to process
/// the request and execute the corresponding transaction on the destination chain.
#[event]
pub struct BridgeRequestEvent {
    /// Public key of the user who initiated the bridge request
    pub sender: Pubkey,
    /// Amount of tokens to be bridged to the destination chain
    pub amount: u64,
    /// Receiver's address on the destination chain (variable length byte vector)
    /// This format accommodates various address formats across different blockchains
    pub receiver: Vec<u8>,
    /// Chain ID identifying the destination blockchain network
    pub destination_chain: u8,
    /// Public key of the token mint being bridged
    pub mint_token: Pubkey,
    /// The batch request ID associated with this bridge request
    pub batch_request_id: u64,
    /// The fee amount for the relayer to process this bridge request
    pub bridge_fee: u64,
    /// The operational fee for the bridge to maintain its operations
    pub operational_fee: u64,
}

/// Emitted when fee config values are updated by the authority.
#[event]
pub struct FeeConfigUpdatedEvent {
    /// Minimum operational fee (SOL lamports)
    pub min_operational_fee: u64,

    /// Bridge fee paid to relayer (SOL lamports)
    pub bridge_fee: u64,

    /// Minimum bridging amount
    pub min_bridging_amount: u64,

    /// Treasury address
    pub treasury: Pubkey,

    /// Relayer address
    pub relayer: Pubkey,
}

/// Emitted when a LockUnlock token is registered.
/// Gateway parity: TokenRegistered event in Gateway.sol
///
/// LockUnlock path:
///   mint pre-exists (e.g. USDC, WSOL)
///   vault ATA receives/releases tokens
///   no new SPL mint is created
///   is_lock_unlock always true
#[event]
pub struct LockUnlockTokenRegisteredEvent {
    /// Gateway-compatible uint16 identifier.
    /// Destination chain uses this to route events.
    pub token_id: u16,

    /// The pre-existing SPL mint being registered.
    pub mint: Pubkey,
}

/// Emitted when a MintBurn token is registered.
/// Gateway parity: TokenRegistered event in Gateway.sol
///
/// MintBurn path:
///   new SPL mint CREATED during this instruction
///   vault PDA is set as mint_authority
///   tokens burned on bridge_request
///   tokens minted on bridge_transaction
///   is_lock_unlock always false
#[event]
pub struct MintBurnTokenRegisteredEvent {
    /// Gateway-compatible uint16 identifier.
    pub token_id: u16,

    /// The NEWLY CREATED SPL mint.
    /// Client generated the keypair — this is its public key.
    pub mint: Pubkey,

    /// On-chain token name stored in Metaplex metadata.
    pub name: String,

    /// On-chain token symbol stored in Metaplex metadata.
    pub symbol: String,
}
