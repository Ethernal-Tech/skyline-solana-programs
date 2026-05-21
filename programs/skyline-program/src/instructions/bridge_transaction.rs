//! Bridge transaction instruction for transferring tokens to multiple recipients.
//!
//! Supports up to 5 recipients in a single batched instruction. Each transfer
//! specifies a recipient wallet, a token index (into a deduplicated token-id list),
//! and an amount.
//!
//! All variable accounts are passed via `remaining_accounts` in a strict
//! positional layout — no scanning, O(1) indexing throughout.
//!
//! Validator consensus is enforced in a single call — no multi-round accumulation.
//! The `batch_id` must strictly increase to prevent replay attacks.
//!
//! ## Branch types
//!
//! Each token-id slot selects one of three branches:
//!
//! - **Mint/Burn**: `is_lock_unlock = false` in TokenRegistry → vault is mint
//!   authority, `mint_to` recipient ATA.
//! - **Lock/Unlock**: `is_lock_unlock = true` in TokenRegistry → `transfer_checked`
//!   from vault ATA to recipient ATA.
//! - **Native SOL**: `token_id == 0` with `NATIVE_SOL_MINT` (= `Pubkey::default()` /
//!   System Program ID) in the mint slot → direct lamport transfer from the
//!   vault PDA to the recipient wallet. No TokenRegistry, no ATAs involved.
//!
//! ## `remaining_accounts` layout
//!
//! ```text
//! ┌──────────────────────────────────────────────────────────────────────────┐
//! │ Section            │ Count          │ Notes                              │
//! ├──────────────────────────────────────────────────────────────────────────┤
//! │ mint accounts      │ num_mints      │ parallel to token-id list, writable │
//! │ recipient wallets  │ num_transfers  │ one per TransferItem               │
//! │ token registries   │ num_mints      │ one per unique mint, read-only     │
//! │ recipient ATAs     │ num_transfers  │ one per transfer, writable         │
//! │ vault ATAs         │ num_mints      │ one per unique mint, writable      │
//! └──────────────────────────────────────────────────────────────────────────┘
//! ```
//!
//! For native-SOL slots the layout is preserved (so slicing stays O(1)) but
//! the per-mint and per-transfer accounts at those slots are unused. The
//! relayer can pass the System Program account as a placeholder for each
//! unused slot — the code skips all token-specific checks when the
//! corresponding token_id is 0.
//!
//! **Writability**: Mint accounts must be writable (`mint_to` updates supply
//! for mint-burn tokens). Recipient ATAs and vault ATAs must be writable for
//! token transfers. Wallets and registries are read-only for token transfers,
//! but for native-SOL transfers the recipient wallet must be writable (it
//! receives lamports directly).
//!
//! All addresses are validated on-chain against their derived/expected values.
//! The relayer must pass accounts in this exact order or the instruction fails.

use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};
use anchor_spl::{
    associated_token::{self, get_associated_token_address, AssociatedToken},
    token::{self, transfer_checked, Mint, Token, TransferChecked},
};

use crate::*;

/// Maximum number of recipients allowed in a single batched bridge transaction.
pub const MAX_TRANSFERS: usize = 4;

/// Token id and amount pair inside a validator-signed [`SolanaPayload`].
///
/// Matches `wallet.TokenAmount` in solana-infrastructure (token_id as u16,
/// then amount as u64 LE).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BridgingTokenAmount {
    pub token_id: u16,
    pub amount: u64,
}

/// Single receiver entry inside a validator-signed [`SolanaPayload`].
///
/// Matches `sendtx.BridgingTxReceiver` in solana-infrastructure.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BridgingTxReceiver {
    pub address: [u8; 32],
    pub token_amount: BridgingTokenAmount,
}

/// Validator-signed batch payload embedded in the ed25519 instruction message.
///
/// Binary layout matches `sendtx.SolanaPayload` (`gagliardetto/binary` bin encoding):
/// `blockhash` ([u8;32]), `receivers` (uvarint-prefixed vec),
/// `fee_amount` (u64 LE), `batch_id` (u64 LE).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SolanaPayload {
    pub blockhash: [u8; 32],
    pub receivers: Vec<BridgingTxReceiver>,
    pub fee_amount: u64,
    pub batch_id: u64,
}

/// Result of parsing the neighboring ed25519 verify instruction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ed25519BatchVerification {
    pub signers: Vec<Pubkey>,
    pub payload: SolanaPayload,
}

/// Describes a single transfer within a batched bridge transaction.
///
/// `mint_index` references into the deduplicated token-id list derived from
/// the validator-signed payload; mint accounts in `remaining_accounts` are
/// parallel to that list.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TransferItem {
    /// The destination wallet pubkey (not the ATA — the raw owner wallet).
    pub recipient: Pubkey,
    /// Zero-based index into the deduplicated token-id list.
    pub mint_index: u8,
    /// Amount of tokens to transfer, in the mint's native base unit.
    pub amount: u64,
}

/// Account structure for the bridge_transaction instruction.
///
/// All per-transfer and per-mint accounts are passed via `remaining_accounts`
/// in the strict positional layout described in the module-level doc.
#[derive(Accounts)]
pub struct BridgeTransaction<'info> {
    /// Pays rent for any recipient ATAs that need to be created (~0.002 SOL each)
    /// and receives the `fee` lamport payout from the vault (relayer compensation,
    /// analogous to EVM's `msg.sender`).
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Validator set — holds threshold, registered signers, and last_batch_id.
    /// `last_batch_id` is compared against the signed payload in the handler.
    #[account(
        mut,
        seeds = [VALIDATOR_SET_SEED],
        bump = validator_set.bump,
    )]
    pub validator_set: Account<'info, ValidatorSet>,

    /// Bridge vault PDA — signing authority for mint_to and transfer_checked CPIs.
    #[account(
        mut,
        seeds = [VAULT_SEED],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    /// SPL Token program.
    pub token_program: Program<'info, Token>,

    /// System program — required for ATA creation CPIs.
    pub system_program: Program<'info, System>,

    /// Associated token program — required for ATA creation CPIs.
    pub associated_token_program: Program<'info, AssociatedToken>,

    /// Instructions sysvar used to read and validate the preceding ed25519 ix.
    /// CHECK: Address-constrained to the instructions sysvar.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
}

/// Derive deduplicated token IDs and transfer items from the validator-signed payload.
///
/// Index assignment matches `tx_sender.buildBridgeTransactionInstruction` in
/// solana-infrastructure (first-seen order per token_id).
fn derive_bridge_data(payload: &SolanaPayload) -> Result<(Vec<u16>, Vec<TransferItem>)> {
    let mut token_ids: Vec<u16> = Vec::new();
    let mut transfers: Vec<TransferItem> = Vec::with_capacity(payload.receivers.len());

    for receiver in &payload.receivers {
        let token_id = receiver.token_amount.token_id;
        let mint_index = match token_ids.iter().position(|id| *id == token_id) {
            Some(idx) => idx as u8,
            None => {
                require!(
                    token_ids.len() < MAX_TRANSFERS,
                    CustomError::InvalidMintList
                );
                token_ids.push(token_id);
                (token_ids.len() - 1) as u8
            }
        };

        transfers.push(TransferItem {
            recipient: Pubkey::new_from_array(receiver.address),
            mint_index,
            amount: receiver.token_amount.amount,
        });
    }

    require!(!token_ids.is_empty(), CustomError::InvalidMintList);
    require!(
        token_ids.len() <= transfers.len(),
        CustomError::InvalidMintList
    );

    Ok((token_ids, transfers))
}

impl<'info> BridgeTransaction<'info> {
    /// Process a batched multi-receiver bridge transaction.
    ///
    /// Transfer list, token-id list, `batch_id`, and `fee` are read exclusively from
    /// the validator-signed payload in the neighboring ed25519 instruction.
    ///
    /// # Errors
    /// * `InvalidBatchId`           - `batch_id` ≤ `last_batch_id` (caught by constraint)
    /// * `InvalidTransferCount`     - 0 or more than 5 transfers provided
    /// * `InvalidMintList`          - Token-id list empty, or longer than `transfers`
    /// * `InvalidMintIndex`         - Any `mint_index` out of bounds of the token-id list
    /// * `InvalidAmount`            - Any transfer amount is zero
    /// * `InvalidRemainingAccounts` - `remaining_accounts` count doesn't match expected layout
    /// * `InvalidMintList`          - A mint account key doesn't match its TokenRegistry
    /// * `NoSignersProvided`        - No validator signers found in the validator section
    /// * `DuplicateSignersProvided` - Duplicate signer pubkeys detected
    /// * `InvalidSigner`            - A signer is not a registered validator
    /// * `InsufficientSigners`      - Signer count is below the threshold
    /// * `InvalidRemainingAccounts` - A TokenRegistry PDA address doesn't match expected
    /// * `AccountNotFound`          - A TokenRegistry account failed to deserialize
    /// * `InvalidTokenAccount`      - A recipient ATA address doesn't match derived value
    /// * `InvalidVault`             - A vault ATA address doesn't match derived value
    /// * `InsufficientVaultLamports` - A native-SOL transfer would drop the vault PDA below rent-exempt
    ///
    /// # Process Flow
    /// 1.  Validate transfer count (1–5) and token-id list bounds
    /// 2.  Validate all mint_index values and amounts per transfer
    /// 3.  Compute section offsets, validate total remaining_accounts count
    /// 4.  Slice remaining_accounts into 6 typed sections
    /// 5.  Slice token/mint sections from remaining_accounts
    /// 6.  Validate and collect validator signers, check threshold
    /// 7.  Slice and validate TokenRegistry PDAs (positional, address-verified)
    /// 8.  For each transfer:
    ///       a. Validate recipient ATA and vault ATA addresses (positional)
    ///       b. Create recipient ATA on-demand if it doesn't exist
    ///       c. Mint or transfer_checked based on token_registry.is_lock_unlock
    /// 9.  Pay `fee` lamports from vault PDA to payer (skipped when `fee == 0`)
    /// 10. Emit BatchTransactionExecutedEvent
    /// 11. Advance validator_set.last_batch_id
    pub fn process_instruction(ctx: Context<'_, '_, 'info, 'info, Self>) -> Result<()> {
        // Validator pubkeys and signed payload are sourced from the neighboring ed25519 ix.
        let ed25519_batch = verify_ed25519_batch(&ctx.accounts.instructions.to_account_info())?;
        let pubkeys = ed25519_batch.signers;
        let signed_payload = ed25519_batch.payload;

        // ── 1. Validate transfer count and batch_id ────────────────────────────

        require!(
            !signed_payload.receivers.is_empty() && signed_payload.receivers.len() <= MAX_TRANSFERS,
            CustomError::InvalidTransferCount
        );

        require!(
            ctx.accounts.validator_set.last_batch_id < signed_payload.batch_id,
            CustomError::InvalidBatchId
        );

        // ── 2. Validate per-receiver fields and derive token IDs / transfers ─────

        for receiver in &signed_payload.receivers {
            require!(receiver.token_amount.amount > 0, CustomError::InvalidAmount);
        }

        let (token_ids, transfers) = derive_bridge_data(&signed_payload)?;

        // ── 3. Compute section offsets ───────────────────────────────────────────
        //
        // remaining_accounts strict layout:
        //
        //   [mints_start      .. wallets_start)      → mint accounts
        //   [wallets_start    .. registries_start)   → recipient wallets
        //   [registries_start .. atas_start)         → TokenRegistry PDAs
        //   [atas_start       .. vault_atas_start)   → recipient ATAs
        //   [vault_atas_start .. expected_total)     → vault ATAs
        //
        // Validators come first and are detected by is_signer.
        // All other section sizes are derived from token_id/transfers counts.

        let num_mints = token_ids.len();
        let num_transfers = transfers.len();

        let mints_start = 0;
        let wallets_start = mints_start + num_mints;
        let registries_start = wallets_start + num_transfers;
        let atas_start = registries_start + num_mints;
        let vault_atas_start = atas_start + num_transfers;
        let expected_total = vault_atas_start + num_mints;

        require!(
            ctx.remaining_accounts.len() == expected_total,
            CustomError::InvalidRemainingAccounts
        );

        // ── 4. Slice remaining_accounts into typed sections ──────────────────────

        let mint_accounts = &ctx.remaining_accounts[mints_start..wallets_start];
        let wallet_accounts = &ctx.remaining_accounts[wallets_start..registries_start];
        let registry_accounts = &ctx.remaining_accounts[registries_start..atas_start];
        let recipient_ata_accounts = &ctx.remaining_accounts[atas_start..vault_atas_start];
        let vault_ata_accounts = &ctx.remaining_accounts[vault_atas_start..expected_total];

        // ── 5. Validate validator signers and check threshold ────────────────────

        let validator_set = &mut ctx.accounts.validator_set;

        // 1. Dedup
        let mut sorted_keys = pubkeys.clone();
        sorted_keys.sort();
        sorted_keys.dedup();
        require!(
            sorted_keys.len() == pubkeys.len(),
            CustomError::DuplicateSignersProvided
        );

        // 2. Validator membership
        require!(
            pubkeys.iter().all(|k| validator_set.signers.contains(k)),
            CustomError::InvalidSigner
        );

        // 3. Threshold
        require!(
            (pubkeys.len() as u8) >= validator_set.threshold,
            CustomError::InsufficientSigners
        );

        // ── 6. Load and validate TokenRegistry PDAs ──────────────────────────────
        //
        // Registry accounts are at a known position in remaining_accounts,
        // indexed parallel to mint_accounts. Registries are keyed by token_id,
        // so we load the account, ensure it points back at the expected mint,
        // then verify its address matches the PDA for its stored token_id.
        //
        // Native-SOL slots use reserved token_id 0 and `NATIVE_SOL_MINT` as the
        // mint placeholder. They have no TokenRegistry; we store `None` and skip
        // the per-slot account at registries[i].

        let program_id = ctx.program_id;
        let mut token_registries: Vec<Option<TokenRegistry>> = Vec::with_capacity(num_mints);

        for (i, mint_account) in mint_accounts.iter().enumerate() {
            let token_id = token_ids[i];

            if token_id == 0 {
                require!(
                    mint_account.key() == NATIVE_SOL_MINT,
                    CustomError::InvalidMintList
                );
                token_registries.push(None);
                continue;
            }

            let registry_account = &registry_accounts[i];

            let registry: TokenRegistry = Account::<TokenRegistry>::try_from(registry_account)
                .map_err(|_| error!(CustomError::AccountNotFound))?
                .into_inner();

            require!(registry.token_id == token_id, CustomError::InvalidMintList);
            require!(
                registry.mint == mint_account.key(),
                CustomError::InvalidMintList
            );

            let token_id_bytes = token_id.to_le_bytes();
            let (expected_pda, _bump) =
                Pubkey::find_program_address(&[TOKEN_REGISTRY_SEED, &token_id_bytes], program_id);
            require!(
                registry_account.key() == expected_pda,
                CustomError::InvalidRemainingAccounts
            );

            token_registries.push(Some(registry));
        }

        // ── 8. Execute each transfer ─────────────────────────────────────────────

        let vault = &ctx.accounts.vault;
        let payer = &ctx.accounts.payer;
        let token_program = &ctx.accounts.token_program;
        let assoc_program = &ctx.accounts.associated_token_program;
        let system_program = &ctx.accounts.system_program;

        // Vault signs all CPIs — build its signer seeds once
        let vault_bump_slice = &[vault.bump];
        let seeds = &[VAULT_SEED, vault_bump_slice as &[u8]];
        let signer_seeds = &[&seeds[..]];

        for (i, item) in transfers.iter().enumerate() {
            let mint_index = item.mint_index as usize;

            let mint_account = &mint_accounts[mint_index];
            let wallet_account = &wallet_accounts[i];
            let recipient_ata_account = &recipient_ata_accounts[i]; // indexed by transfer
            let vault_ata_account = &vault_ata_accounts[mint_index]; // indexed by mint

            require!(
                wallet_account.key() == item.recipient,
                CustomError::InvalidRemainingAccounts
            );

            // ── 8a. Native SOL branch ────────────────────────────────────────────
            //
            // `token_ids[mint_index] == 0` means this transfer pays
            // lamports directly from the vault PDA to the recipient wallet.
            // No TokenRegistry, no ATAs, no token program CPIs.
            //
            // Vault is a program-owned PDA → we mutate its lamports directly.
            // Recipient wallet must be writable (relayer's responsibility);
            // try_borrow_mut_lamports will fail at runtime otherwise.
            //
            // Rent-exempt invariant: vault must keep at least its rent-exempt
            // minimum after the transfer, otherwise the runtime would close it.

            if token_ids[mint_index] == 0 {
                let vault_info = vault.to_account_info();
                let rent_exempt_min = Rent::get()?.minimum_balance(vault_info.data_len());
                let available = vault_info
                    .lamports()
                    .checked_sub(rent_exempt_min)
                    .unwrap_or(0);
                require!(
                    item.amount <= available,
                    CustomError::InsufficientVaultLamports
                );

                **vault_info.try_borrow_mut_lamports()? -= item.amount;
                **wallet_account.try_borrow_mut_lamports()? += item.amount;
                continue;
            }

            // From here on, this is a token transfer — registry must be Some.
            let registry = token_registries[mint_index]
                .as_ref()
                .ok_or_else(|| error!(CustomError::InvalidMintList))?;

            // ── 8b. Validate ATA addresses ───────────────────────────────────────
            //
            // Even though the relayer passes these at known positions, we still
            // verify addresses match their canonical derivation. This prevents
            // the relayer from passing an incorrect or malicious ATA at the
            // right index position.

            let expected_recipient_ata =
                get_associated_token_address(&wallet_account.key(), &mint_account.key());
            let expected_vault_ata =
                get_associated_token_address(&vault.key(), &mint_account.key());

            require!(
                recipient_ata_account.key() == expected_recipient_ata,
                CustomError::InvalidTokenAccount
            );
            require!(
                vault_ata_account.key() == expected_vault_ata,
                CustomError::InvalidVault
            );

            // ── 8c. Create recipient ATA on-demand ───────────────────────────────
            //
            // The relayer includes the ATA address in the TX whether or not it
            // exists. The runtime loads it as an empty account if not created.
            // We create it here (funded by payer) if data_is_empty() is true.

            if recipient_ata_account.data_is_empty() {
                associated_token::create(CpiContext::new(
                    assoc_program.to_account_info(),
                    associated_token::Create {
                        payer: payer.to_account_info(),
                        associated_token: recipient_ata_account.to_account_info(),
                        authority: wallet_account.to_account_info(),
                        mint: mint_account.to_account_info(),
                        system_program: system_program.to_account_info(),
                        token_program: token_program.to_account_info(),
                    },
                ))?;
            }

            // ── 8d. Mint or unlock based on token type ───────────────────────────
            //
            // Mint-burn tokens: vault is the mint authority → mint_to
            // Lock-unlock tokens: vault holds pre-locked supply → transfer_checked

            if !registry.is_lock_unlock {
                // Mint-burn: create new tokens and deposit directly to recipient ATA
                token::mint_to(
                    CpiContext::new_with_signer(
                        token_program.to_account_info(),
                        token::MintTo {
                            mint: mint_account.to_account_info(),
                            to: recipient_ata_account.to_account_info(),
                            authority: vault.to_account_info(),
                        },
                        signer_seeds,
                    ),
                    item.amount,
                )?;
            } else {
                // Lock-unlock: release tokens from vault ATA to recipient ATA
                // Deserialize mint inline to read decimals for transfer_checked
                let mint_data: Mint = Account::<Mint>::try_from(mint_account)
                    .map_err(|_| error!(CustomError::InvalidMintList))?
                    .into_inner();

                transfer_checked(
                    CpiContext::new_with_signer(
                        token_program.to_account_info(),
                        TransferChecked {
                            from: vault_ata_account.to_account_info(),
                            to: recipient_ata_account.to_account_info(),
                            authority: vault.to_account_info(),
                            mint: mint_account.to_account_info(),
                        },
                        signer_seeds,
                    ),
                    item.amount,
                    mint_data.decimals,
                )?;
            }
        }

        // ── 9. Pay relayer compensation ──────────────────────────────────────────
        //
        // `fee` lamports go directly from the vault PDA to the payer (whoever
        // submitted this TX). This is the `msg.sender`-style payout: it avoids
        // an explicit `TransferItem` + recipient wallet + ATA placeholder slots
        // for what is structurally always "pay the relayer".
        //
        // Same rent-exempt invariant as the per-transfer native-SOL branch:
        // the vault must keep at least its rent-exempt minimum after the
        // deduction, otherwise the runtime would close it.

        if signed_payload.fee_amount > 0 {
            let vault_info = ctx.accounts.vault.to_account_info();
            let rent_exempt_min = Rent::get()?.minimum_balance(vault_info.data_len());
            let available = vault_info
                .lamports()
                .checked_sub(rent_exempt_min)
                .unwrap_or(0);
            require!(
                signed_payload.fee_amount <= available,
                CustomError::InsufficientVaultLamports
            );

            **vault_info.try_borrow_mut_lamports()? -= signed_payload.fee_amount;
            **ctx
                .accounts
                .payer
                .to_account_info()
                .try_borrow_mut_lamports()? += signed_payload.fee_amount;
        }

        // ── 10. Emit event ───────────────────────────────────────────────────────

        emit!(TransactionExecutedEvent {
            batch_id: signed_payload.batch_id,
            transfer_count: signed_payload.receivers.len() as u8,
            fee: signed_payload.fee_amount,
        });

        // ── 11. Advance batch_id — final replay protection ───────────────────────
        //
        // This combined with the constraint on the account struct guarantees
        // batch_ids are strictly monotonically increasing and non-replayable.

        validator_set.last_batch_id = signed_payload.batch_id;

        Ok(())
    }
}

pub fn verify_ed25519_batch(instructions_sysvar: &AccountInfo) -> Result<Ed25519BatchVerification> {
    let current_ix_idx = load_current_index_checked(instructions_sysvar)
        .map_err(|_| error!(CustomError::InvalidRemainingAccounts))?;
    let ed25519_program_id = pubkey!("Ed25519SigVerify111111111111111111111111111");
    let mut candidates: Vec<u16> = Vec::with_capacity(2);
    if current_ix_idx > 0 {
        candidates.push(current_ix_idx - 1);
    }
    candidates.push(current_ix_idx + 1);

    for candidate_idx in candidates {
        let ix = match load_instruction_at_checked(candidate_idx as usize, instructions_sysvar) {
            Ok(ix) => ix,
            Err(_) => continue,
        };

        if ix.program_id != ed25519_program_id {
            continue;
        }

        return parse_ed25519_batch(ix.data.as_slice(), candidate_idx);
    }

    err!(CustomError::InvalidRemainingAccounts)
}

fn parse_ed25519_batch(data: &[u8], ed_ix_idx: u16) -> Result<Ed25519BatchVerification> {
    require!(data.len() >= 2, CustomError::InvalidRemainingAccounts);
    let sig_count = data[0] as usize;
    require!(sig_count > 0, CustomError::NoSignersProvided);

    let mut cursor = 2;
    let mut pubkeys = Vec::with_capacity(sig_count);
    let mut shared_message: Option<&[u8]> = None;

    for _ in 0..sig_count {
        require!(
            cursor + 14 <= data.len(),
            CustomError::InvalidRemainingAccounts
        );
        let sig_offset = u16::from_le_bytes([data[cursor], data[cursor + 1]]) as usize;
        let sig_ix_idx = u16::from_le_bytes([data[cursor + 2], data[cursor + 3]]);
        let pk_offset = u16::from_le_bytes([data[cursor + 4], data[cursor + 5]]) as usize;
        let pk_ix_idx = u16::from_le_bytes([data[cursor + 6], data[cursor + 7]]);
        let msg_offset = u16::from_le_bytes([data[cursor + 8], data[cursor + 9]]) as usize;
        let msg_size = u16::from_le_bytes([data[cursor + 10], data[cursor + 11]]) as usize;
        let msg_ix_idx = u16::from_le_bytes([data[cursor + 12], data[cursor + 13]]);

        cursor += 14;

        // Allow either "current instruction" (0xFFFF) or explicit ed25519 index.
        let valid_sig_idx = sig_ix_idx == u16::MAX || sig_ix_idx == ed_ix_idx;
        let valid_pk_idx = pk_ix_idx == u16::MAX || pk_ix_idx == ed_ix_idx;
        let valid_msg_idx = msg_ix_idx == u16::MAX || msg_ix_idx == ed_ix_idx;
        require!(
            valid_sig_idx && valid_pk_idx && valid_msg_idx,
            CustomError::InvalidRemainingAccounts
        );

        require!(
            sig_offset + 64 <= data.len()
                && pk_offset + 32 <= data.len()
                && msg_offset + msg_size <= data.len(),
            CustomError::InvalidRemainingAccounts
        );

        let _sig = &data[sig_offset..sig_offset + 64];
        let pk_bytes: [u8; 32] = data[pk_offset..pk_offset + 32]
            .try_into()
            .map_err(|_| error!(CustomError::InvalidRemainingAccounts))?;

        let message = &data[msg_offset..msg_offset + msg_size];
        match shared_message {
            None => shared_message = Some(message),
            Some(prev) => require!(prev == message, CustomError::InvalidRemainingAccounts),
        }

        pubkeys.push(Pubkey::new_from_array(pk_bytes));
    }

    let message = shared_message.ok_or_else(|| error!(CustomError::InvalidRemainingAccounts))?;
    let payload = parse_solana_payload(message)?;

    Ok(Ed25519BatchVerification {
        signers: pubkeys,
        payload,
    })
}

/// gagliardetto `binary` bin-encoding reader for validator-signed payloads.
struct BinPayloadReader<'a> {
    data: &'a [u8],
    cursor: usize,
}

impl<'a> BinPayloadReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, cursor: 0 }
    }

    fn remaining(&self) -> usize {
        self.data.len().saturating_sub(self.cursor)
    }

    fn read_byte(&mut self) -> Result<u8> {
        require!(
            self.cursor < self.data.len(),
            CustomError::InvalidSignedPayload
        );
        let b = self.data[self.cursor];
        self.cursor += 1;
        Ok(b)
    }

    fn read_exact(&mut self, len: usize) -> Result<&'a [u8]> {
        require!(
            self.cursor + len <= self.data.len(),
            CustomError::InvalidSignedPayload
        );
        let slice = &self.data[self.cursor..self.cursor + len];
        self.cursor += len;
        Ok(slice)
    }

    fn read_uvarint(&mut self) -> Result<usize> {
        let mut result: u64 = 0;
        let mut shift = 0u32;
        loop {
            let byte = self.read_byte()?;
            result |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                break;
            }
            shift += 7;
            require!(shift < 64, CustomError::InvalidSignedPayload);
        }
        usize::try_from(result).map_err(|_| error!(CustomError::InvalidSignedPayload))
    }

    fn read_u64(&mut self) -> Result<u64> {
        let bytes = self.read_exact(8)?;
        Ok(u64::from_le_bytes(bytes.try_into().unwrap()))
    }

    fn read_u16(&mut self) -> Result<u16> {
        let bytes = self.read_exact(2)?;
        Ok(u16::from_le_bytes(bytes.try_into().unwrap()))
    }

    fn ensure_eof(&self) -> Result<()> {
        require!(self.remaining() == 0, CustomError::InvalidSignedPayload);
        Ok(())
    }
}

/// Decode `sendtx.SolanaPayload` bytes (`gagliardetto/binary` bin encoding).
fn parse_solana_payload(data: &[u8]) -> Result<SolanaPayload> {
    let mut reader = BinPayloadReader::new(data);

    let blockhash: [u8; 32] = reader
        .read_exact(32)?
        .try_into()
        .map_err(|_| error!(CustomError::InvalidSignedPayload))?;

    let receivers_len = reader.read_uvarint()?;
    let mut receivers = Vec::with_capacity(receivers_len);
    for _ in 0..receivers_len {
        let address: [u8; 32] = reader
            .read_exact(32)?
            .try_into()
            .map_err(|_| error!(CustomError::InvalidSignedPayload))?;

        let token_id = reader.read_u16()?;
        let amount = reader.read_u64()?;

        receivers.push(BridgingTxReceiver {
            address,
            token_amount: BridgingTokenAmount { token_id, amount },
        });
    }

    let fee_amount = reader.read_u64()?;
    let batch_id = reader.read_u64()?;
    reader.ensure_eof()?;

    Ok(SolanaPayload {
        blockhash,
        receivers,
        fee_amount,
        batch_id,
    })
}
