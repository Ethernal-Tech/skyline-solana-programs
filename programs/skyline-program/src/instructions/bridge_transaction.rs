//! Bridge transaction instruction for transferring tokens to multiple recipients.
//!
//! Supports up to 5 recipients in a single batched instruction. Each transfer
//! specifies a recipient wallet, a mint index (into a deduplicated mint list),
//! and an amount.
//!
//! All variable accounts are passed via `remaining_accounts` in a strict
//! positional layout — no scanning, O(1) indexing throughout.
//!
//! Validator consensus is enforced in a single call — no multi-round accumulation.
//! The `batch_id` must strictly increase to prevent replay attacks.
//!
//! ## `remaining_accounts` layout
//!
//! ```text
//! ┌─────────────────────────────────────────────────────────────────────┐
//! │ Section            │ Count          │ Notes                         │
//! ├─────────────────────────────────────────────────────────────────────┤
//! │ validator signers  │ num_validators │ all have is_signer = true     │
//! │ mint accounts      │ num_mints      │ parallel to `mints` arg       │
//! │ recipient wallets  │ num_transfers  │ one per TransferItem          │
//! │ token registries   │ num_mints      │ one per unique mint, indexed  │
//! │ recipient ATAs     │ num_transfers  │ one per transfer, isWritable  │
//! │ vault ATAs         │ num_mints      │ one per unique mint, indexed  │
//! └─────────────────────────────────────────────────────────────────────┘
//! ```
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
pub const MAX_TRANSFERS: usize = 5;

/// Describes a single transfer within a batched bridge transaction.
///
/// `mint_index` references into the deduplicated `mints` instruction argument,
/// which is also parallel to the mint accounts section in `remaining_accounts`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TransferItem {
    /// The destination wallet pubkey (not the ATA — the raw owner wallet).
    pub recipient: Pubkey,
    /// Zero-based index into the `mints: Vec<Pubkey>` instruction argument.
    pub mint_index: u8,
    /// Amount of tokens to transfer, in the mint's native base unit.
    pub amount: u64,
}

/// Account structure for the bridge_transaction instruction.
///
/// All per-transfer and per-mint accounts are passed via `remaining_accounts`
/// in the strict positional layout described in the module-level doc.
#[derive(Accounts)]
#[instruction(transfers: Vec<TransferItem>, mints: Vec<Pubkey>, batch_id: u64)]
pub struct BridgeTransaction<'info> {
    /// Pays rent for any recipient ATAs that need to be created (~0.002 SOL each).
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Validator set — holds threshold, registered signers, and last_batch_id.
    /// The `batch_id` constraint is the first line of replay protection.
    #[account(
        mut,
        seeds = [VALIDATOR_SET_SEED],
        bump = validator_set.bump,
        constraint = validator_set.last_batch_id < batch_id @ CustomError::InvalidBatchId,
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

impl<'info> BridgeTransaction<'info> {
    /// Process a batched multi-receiver bridge transaction.
    ///
    /// # Arguments
    /// * `ctx`       - Instruction context
    /// * `transfers` - Up to 5 transfer items (recipient wallet, mint_index, amount)
    /// * `mints`     - Deduplicated list of mint pubkeys, referenced by `mint_index`
    /// * `batch_id`  - Must be strictly greater than `validator_set.last_batch_id`
    ///
    /// # Errors
    /// * `InvalidBatchId`           - `batch_id` ≤ `last_batch_id` (caught by constraint)
    /// * `InvalidTransferCount`     - 0 or more than 5 transfers provided
    /// * `InvalidMintList`          - Mints empty, or `mints.len()` > `transfers.len()`
    /// * `InvalidMintIndex`         - Any `mint_index` out of bounds of `mints`
    /// * `InvalidAmount`            - Any transfer amount is zero
    /// * `InvalidRemainingAccounts` - `remaining_accounts` count doesn't match expected layout
    /// * `InvalidMintList`          - A mint account key doesn't match the `mints` arg
    /// * `NoSignersProvided`        - No validator signers found in the validator section
    /// * `DuplicateSignersProvided` - Duplicate signer pubkeys detected
    /// * `InvalidSigner`            - A signer is not a registered validator
    /// * `InsufficientSigners`      - Signer count is below the threshold
    /// * `InvalidRemainingAccounts` - A TokenRegistry PDA address doesn't match expected
    /// * `AccountNotFound`          - A TokenRegistry account failed to deserialize
    /// * `InvalidTokenAccount`      - A recipient ATA address doesn't match derived value
    /// * `InvalidVault`             - A vault ATA address doesn't match derived value
    ///
    /// # Process Flow
    /// 1.  Validate transfer count (1–5) and mint list bounds
    /// 2.  Validate all mint_index values and amounts per transfer
    /// 3.  Compute section offsets, validate total remaining_accounts count
    /// 4.  Slice remaining_accounts into 6 typed sections
    /// 5.  Validate mint account keys match the `mints` instruction arg
    /// 6.  Validate and collect validator signers, check threshold
    /// 7.  Slice and validate TokenRegistry PDAs (positional, address-verified)
    /// 8.  For each transfer:
    ///       a. Validate recipient ATA and vault ATA addresses (positional)
    ///       b. Create recipient ATA on-demand if it doesn't exist
    ///       c. Mint or transfer_checked based on token_registry.is_lock_unlock
    /// 9.  Emit BatchTransactionExecutedEvent
    /// 10. Advance validator_set.last_batch_id
    pub fn process_instruction(
        ctx: Context<'_, '_, 'info, 'info, Self>,
        transfers: Vec<TransferItem>,
        mints: Vec<Pubkey>,
        batch_id: u64,
    ) -> Result<()> {
        // ── 1. Validate transfer count and mint list bounds ──────────────────────

        require!(!transfers.is_empty(), CustomError::InvalidTransferCount);
        require!(
            transfers.len() <= MAX_TRANSFERS,
            CustomError::InvalidTransferCount
        );

        // mints must be non-empty and cannot outnumber transfers
        // (every mint must be referenced by at least one transfer)
        require!(
            !mints.is_empty() && mints.len() <= transfers.len(),
            CustomError::InvalidMintList
        );

        // ── 2. Validate per-transfer fields ─────────────────────────────────────

        for item in &transfers {
            require!(
                (item.mint_index as usize) < mints.len(),
                CustomError::InvalidMintIndex
            );
            require!(item.amount > 0, CustomError::InvalidAmount);
        }

        // ── 3. Compute section offsets ───────────────────────────────────────────
        //
        // remaining_accounts strict layout:
        //
        //   [validators_start .. mints_start)       → validator signers
        //   [mints_start      .. wallets_start)      → mint accounts
        //   [wallets_start    .. registries_start)   → recipient wallets
        //   [registries_start .. atas_start)         → TokenRegistry PDAs
        //   [atas_start       .. vault_atas_start)   → recipient ATAs
        //   [vault_atas_start .. expected_total)     → vault ATAs
        //
        // Validators come first and are detected by is_signer.
        // All other section sizes are derived from mints/transfers counts.

        let num_mints = mints.len();
        let num_transfers = transfers.len();

        // Validator pubkeys are sourced from the preceding ed25519 instruction.
        let message = batch_id.to_le_bytes();
        let pubkeys = verify_ed25519_batch(&ctx.accounts.instructions.to_account_info(), &message)?;

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

        // ── 5. Validate mint accounts match the `mints` instruction arg ──────────
        //
        // Guards against a relayer passing mint accounts in the wrong order
        // or substituting a different mint than what the transfers reference.

        for (i, mint_account) in mint_accounts.iter().enumerate() {
            require!(mint_account.key() == mints[i], CustomError::InvalidMintList);
        }

        // ── 6. Validate validator signers and check threshold ────────────────────

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

        // ── 7. Load and validate TokenRegistry PDAs ──────────────────────────────
        //
        // Registry accounts are at a known position in remaining_accounts,
        // indexed parallel to mint_accounts. We validate each address matches
        // the expected PDA before deserializing — prevents a spoofed account
        // at the correct index from bypassing the is_lock_unlock check.

        let program_id = ctx.program_id;
        let mut token_registries: Vec<TokenRegistry> = Vec::with_capacity(num_mints);

        for (i, mint_account) in mint_accounts.iter().enumerate() {
            let registry_account = &registry_accounts[i];

            // Derive the expected PDA and validate the provided account matches
            let (expected_pda, _bump) = Pubkey::find_program_address(
                &[TOKEN_REGISTRY_SEED, mint_account.key().as_ref()],
                program_id,
            );
            require!(
                registry_account.key() == expected_pda,
                CustomError::InvalidRemainingAccounts
            );

            let registry: TokenRegistry = Account::<TokenRegistry>::try_from(registry_account)
                .map_err(|_| error!(CustomError::AccountNotFound))?
                .into_inner();

            token_registries.push(registry);
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
            let registry = &token_registries[mint_index];
            let recipient_ata_account = &recipient_ata_accounts[i]; // indexed by transfer
            let vault_ata_account = &vault_ata_accounts[mint_index]; // indexed by mint

            require!(
                wallet_account.key() == item.recipient,
                CustomError::InvalidRemainingAccounts
            );

            // ── 8a. Validate ATA addresses ───────────────────────────────────────
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

            // ── 8b. Create recipient ATA on-demand ───────────────────────────────
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

            // ── 8c. Mint or unlock based on token type ───────────────────────────
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

        // ── 9. Emit event ────────────────────────────────────────────────────────

        emit!(TransactionExecutedEvent {
            batch_id,
            transfer_count: transfers.len() as u8,
        });

        // ── 10. Advance batch_id — final replay protection ───────────────────────
        //
        // This combined with the constraint on the account struct guarantees
        // batch_ids are strictly monotonically increasing and non-replayable.

        validator_set.last_batch_id = batch_id;

        Ok(())
    }
}

pub fn verify_ed25519_batch(
    instructions_sysvar: &AccountInfo,
    message: &[u8],
) -> Result<Vec<Pubkey>> {
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

        return parse_ed25519_batch(ix.data.as_slice(), message, candidate_idx);
    }

    err!(CustomError::InvalidRemainingAccounts)
}

fn parse_ed25519_batch(data: &[u8], message: &[u8], ed_ix_idx: u16) -> Result<Vec<Pubkey>> {
    require!(data.len() >= 2, CustomError::InvalidRemainingAccounts);
    let sig_count = data[0] as usize;
    require!(sig_count > 0, CustomError::NoSignersProvided);

    let mut cursor = 2;
    let mut pubkeys = Vec::with_capacity(sig_count);

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
        let msg = &data[msg_offset..msg_offset + msg_size];
        let pk_bytes: [u8; 32] = data[pk_offset..pk_offset + 32]
            .try_into()
            .map_err(|_| error!(CustomError::InvalidRemainingAccounts))?;

        require!(msg == message, CustomError::InvalidBatchId);
        pubkeys.push(Pubkey::new_from_array(pk_bytes));
    }

    Ok(pubkeys)
}
