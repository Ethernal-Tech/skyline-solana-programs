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
//! - **Token Bridging**: Transfer tokens to vault or burn tokens on source chain and mint/transfer equivalent tokens on destination chain
//! - **Bridge Requests**: Create and manage cross-chain transfer requests
//! - **Consensus Mechanism**: Require threshold validator approval for critical operations (calculated as ceil(2/3) of validators)
//!
//! ## Architecture
//!
//! The program uses the following main account types:
//! - `ValidatorSet`: Stores the list of validators, consensus threshold, last batch ID, and bridge request count
//! - `Vault`: Represents the vault account that holds bridged tokens
//!
//! ## Security Model
//!
//! - Validator set requires minimum 4 and maximum 128 validators
//! - Consensus threshold is automatically calculated using the formula: num_signers - floor((num_signers - 1) / 3)
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

declare_id!("CkTNcuk9EELmuR65eCfzKfz8XpDvJ27FPFHauGHVD1E9");

#[program]
pub mod skyline_program {
    use super::*;

    /// Initializes the full bridge system:
    ///   1. ValidatorSet — validators, threshold, bump
    ///   2. Vault        — bump
    ///   3. FeeConfig    — operational fee, relayer fee estimate, treasury, authority
    ///
    /// # Arguments
    /// * `ctx`                  - The instruction context
    /// * `validators`           - Vector of validator public keys
    /// * `last_id`              - Last known batch ID (for replay protection)
    /// * `min_operational_fee`  - Minimum bridge tip sent to treasury (lamports)
    /// * `bridge_fee`           - Estimated destination chain gas cost (lamports)
    ///
    /// # Errors
    /// * `ValidatorsNotUnique`    - Duplicate validators provided
    /// * `MaxValidatorsExceeded`  - Too many validators
    /// * `MinValidatorsNotMet`    - Too few validators
    pub fn initialize(
        ctx: Context<Initialize>,
        validators: Vec<Pubkey>,
        last_id: Option<u64>,
        min_operational_fee: u64,
        bridge_fee: u64,
    ) -> Result<()> {
        Initialize::process_instruction(
            ctx,
            validators,
            last_id.unwrap_or(0),
            min_operational_fee,
            bridge_fee,
        )
    }

    /// Create a cross-chain bridging request and transfer source tokens to vault.
    ///
    /// This instruction creates a bridging request for transferring tokens to another chain.
    /// The source tokens are either burned (if the vault is the mint authority) or transferred
    /// to the vault account, and a request event is emitted that can be processed by validators
    /// to mint/transfer equivalent tokens on the destination chain.
    ///
    /// # Arguments
    /// * `ctx` - The context containing accounts for the bridge request
    /// * `amount` - The amount of tokens to bridge
    /// * `receiver` - The receiver's address on the destination chain (variable length byte vector)
    /// * `destination_chain` - The chain ID of the destination blockchain
    ///
    /// # Errors
    /// * `InsufficientFunds` - If the sender doesn't have enough tokens
    pub fn bridge_request(
        ctx: Context<BridgeRequest>,
        amount: u64,
        receiver: Vec<u8>,
        destination_chain: u8,
        fees: u64,
    ) -> Result<()> {
        BridgeRequest::process_instruction(ctx, amount, receiver, destination_chain, fees)
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
        removed: Vec<Pubkey>,
        batch_id: u64,
    ) -> Result<()> {
        BridgeVSU::process_instruction(ctx, added, removed, batch_id)
    }

    /// Create or approve a bridging transaction.
    ///
    /// This instruction creates or approves a bridging transaction for transferring tokens from the vault
    /// to a recipient. The first call creates the transaction, and subsequent calls from validators approve it.
    /// Once the consensus threshold is met, the tokens are automatically minted (if vault is mint authority)
    /// or transferred from the vault to the recipient's associated token account, and the transaction account is closed.
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
    /// * `NotEnoughSigners` - If insufficient validators have signed (checked when threshold is met)
    /// * `InvalidSigner` - If a signer is not in the validator set
pub fn bridge_transaction<'info>(
        ctx: Context<'_, '_, 'info, 'info, BridgeTransaction<'info>>,
        transfers: Vec<TransferItem>,
        mints: Vec<Pubkey>,
        batch_id: u64,
    ) -> Result<()> {
        BridgeTransaction::process_instruction(ctx, transfers, mints, batch_id)
    }
    /// Update the fee configuration for the bridge.
    ///
    /// This instruction allows the authority to update the fee configuration parameters for the bridge,
    /// including the minimum operational fee, bridge fee, minimum bridging amount, treasury address, and
    /// relayer address. The authority can choose to update any subset of these parameters, and the instruction
    /// will validate the new values and emit an event with the updated configuration.
    ///
    /// # Arguments
    /// * `ctx` - The context containing accounts for updating the fee configuration
    /// * `min_operational_fee` - Optional new minimum operational fee (lamports)
    /// * `bridge_fee` - Optional new bridge fee (lamports)     
    /// * `update_treasury` - Optional flag indicating whether to update the treasury address
    /// * `update_relayer` - Optional flag indicating whether to update the relayer address
    ///
    /// # Errors
    /// * `InvalidRelayer` - If the new relayer address is invalid
    /// * `InvalidTreasury` - If the new treasury address is invalid
    pub fn update_fee_config(
        ctx: Context<UpdateFeeConfig>,
        min_operational_fee: Option<u64>,
        bridge_fee: Option<u64>,
        update_treasury: Option<bool>,
        update_relayer: Option<bool>,
    ) -> Result<()> {
        UpdateFeeConfig::process_instruction(
            ctx,
            min_operational_fee,
            bridge_fee,
            update_treasury,
            update_relayer,
        )
    }

    pub fn register_lock_unlock_token(
        ctx: Context<RegisterLockUnlockToken>,
        token_id: u16,
        min_bridging_amount: u64,
    ) -> Result<()> {
        RegisterLockUnlockToken::process_instruction(ctx, token_id, min_bridging_amount)
    }

    /// Register a new SPL mint as a MintBurn bridgeable token.
    ///
    /// Creates the mint, assigns vault as mint_authority, attaches Metaplex
    /// metadata, and writes TokenRegistry + TokenIdGuard PDAs.
    ///
    /// Only callable by the bridge authority.
    ///
    /// # Arguments
    /// * `ctx`      - Instruction context
    /// * `token_id` - Unique gateway-compatible uint16 identifier
    /// * `decimals` - Decimal precision of the new mint (e.g. 6 or 9)
    /// * `min_bridging_amount` - Minimum raw token amount allowed per bridge_request
    /// * `name`     - Token name for Metaplex metadata
    /// * `symbol`   - Token symbol for Metaplex metadata
    /// * `uri`      - Metadata URI (IPFS / Arweave JSON)
    ///
    /// # Errors
    /// * `CustomError::Unauthorized`    - Signer is not the bridge authority
    pub fn register_mint_burn_token(
        ctx: Context<RegisterMintBurnToken>,
        token_id: u16,
        decimals: u8,
        min_bridging_amount: u64,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        RegisterMintBurnToken::process_instruction(
            ctx,
            token_id,
            decimals,
            min_bridging_amount,
            name,
            symbol,
            uri,
        )
    }
}
