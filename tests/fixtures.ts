// tests/fixtures.ts
import * as anchor from "@coral-xyz/anchor";
import { Program, web3, BN } from "@coral-xyz/anchor";
import { SkylineProgram } from "../target/types/skyline_program";
import { expect } from "chai";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAssociatedTokenAddressSync
} from "@solana/spl-token";

import { TransactionMessage, VersionedTransaction } from "@solana/web3.js";

// ============================================================================
// CONSTANTS
// ============================================================================

export const SEEDS = {
  VALIDATOR_SET: "validator-set",
  VAULT: "vault",
  FEE_CONFIG: "fee_config",
  TOKEN_REGISTRY: "token_registry",
  TOKEN_ID_GUARD: "token_id_guard"
} as const;

export const LIMITS = {
  MIN_VALIDATORS: 4,
  MAX_VALIDATORS: 128,
  MAX_VALIDATORS_CHANGE: 10,
  MAX_TX_VALIDATORS: 29 // Solana transaction size limit
} as const;

// ============================================================================
// TYPES
// ============================================================================

export interface TestContext {
  provider: anchor.AnchorProvider;
  program: Program<SkylineProgram>;
  owner: anchor.Wallet;
  connection: anchor.web3.Connection;
}

export interface ValidatorSetData {
  signers: web3.PublicKey[];
  threshold: number;
  bump: number;
  lastBatchId: BN;
  bridgeRequestCount: BN;
}

export interface VaultData {
  bump: number;
}

export interface BridgingTransactionData {
  id: web3.PublicKey;
  amount: BN;
  receiver: web3.PublicKey;
  mintToken: web3.PublicKey;
  signers: web3.PublicKey[];
  bump: number;
  batchId: BN;
}

/** On-chain FeeConfig account shape */
export interface FeeConfigData {
  minOperationalFee: BN;
  bridgeFee: BN;
  treasury: web3.PublicKey;
  relayer: web3.PublicKey;
  authority: web3.PublicKey;
  bump: number;
}

/** On-chain TokenRegistry account shape */
export interface TokenRegistryData {
  tokenId: number;
  mint: web3.PublicKey;
  isLockUnlock: boolean;
  minBridgingAmount: BN;
  bump: number;
}

// ============================================================================
// TEST DATA GENERATORS
// ============================================================================

/**
 * Generate a pool of validator keypairs for testing
 */
export function generateValidators(count: number): web3.Keypair[] {
  const validators: web3.Keypair[] = [];
  for (let i = 0; i < count; i++) {
    validators.push(anchor.web3.Keypair.generate());
  }
  return validators;
}

/**
 * Airdrop SOL to an account
 */
export async function airdrop(
  connection: web3.Connection,
  publicKey: web3.PublicKey,
  amount: number = 10 * web3.LAMPORTS_PER_SOL
): Promise<void> {
  const signature = await connection.requestAirdrop(publicKey, amount);
  const latestBlockhash = await connection.getLatestBlockhash();
  await connection.confirmTransaction({
    signature,
    ...latestBlockhash
  });
}

/**
 * Calculate expected threshold for a given number of validators
 * Formula: num_signers - floor((num_signers - 1) / 3)
 */
export function calculateExpectedThreshold(validatorCount: number): number {
  return validatorCount - Math.floor((validatorCount - 1) / 3);
}

// ============================================================================
// PDA HELPERS
// ============================================================================

export class PDAs {
  private programId: web3.PublicKey;
  constructor(programId: web3.PublicKey) {
    this.programId = programId;
  }

  validatorSet(): web3.PublicKey {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from(SEEDS.VALIDATOR_SET)],
      this.programId
    )[0];
  }

  vault(): web3.PublicKey {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from(SEEDS.VAULT)],
      this.programId
    )[0];
  }

  /** FeeConfig PDA — global, one per program */
  feeConfig(): web3.PublicKey {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from(SEEDS.FEE_CONFIG)],
      this.programId
    )[0];
  }

  /** TokenRegistry PDA — one per registered mint */
  tokenRegistry(mint: web3.PublicKey): web3.PublicKey {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from(SEEDS.TOKEN_REGISTRY), mint.toBuffer()],
      this.programId
    )[0];
  }

  /** TokenIdGuard PDA — one per registered token_id */
  tokenIdGuard(tokenId: number): web3.PublicKey {
    const idBuf = Buffer.alloc(2);
    idBuf.writeUInt16LE(tokenId, 0);
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from(SEEDS.TOKEN_ID_GUARD), idBuf],
      this.programId
    )[0];
  }
}

// ============================================================================
// ACCOUNT FETCHERS
// ============================================================================

export class AccountFetchers {
  private program: Program<SkylineProgram>;
  constructor(program: Program<SkylineProgram>) {
    this.program = program;
  }

  async getValidatorSet(pda: web3.PublicKey): Promise<ValidatorSetData> {
    return await this.program.account.validatorSet.fetch(pda);
  }

  async getValidatorSetNullable(
    pda: web3.PublicKey
  ): Promise<ValidatorSetData | null> {
    return await this.program.account.validatorSet.fetchNullable(pda);
  }

  async getVault(pda: web3.PublicKey): Promise<VaultData> {
    return await this.program.account.vault.fetch(pda);
  }

  async getVaultNullable(pda: web3.PublicKey): Promise<VaultData | null> {
    return await this.program.account.vault.fetchNullable(pda);
  }

  async getFeeConfig(pda: web3.PublicKey): Promise<FeeConfigData> {
    return await this.program.account.feeConfig.fetch(pda);
  }

  async getFeeConfigNullable(
    pda: web3.PublicKey
  ): Promise<FeeConfigData | null> {
    return await this.program.account.feeConfig.fetchNullable(pda);
  }

  async getTokenRegistry(pda: web3.PublicKey): Promise<TokenRegistryData> {
    return await this.program.account.tokenRegistry.fetch(pda);
  }

  async getTokenRegistryNullable(
    pda: web3.PublicKey
  ): Promise<TokenRegistryData | null> {
    return await this.program.account.tokenRegistry.fetchNullable(pda);
  }
}

// ============================================================================
// BATCH ID MANAGEMENT
// ============================================================================

export class BatchIdManager {
  private batchCursor: number = 0;
  private accounts: AccountFetchers;
  private vsPDA: web3.PublicKey;

  constructor(accounts: AccountFetchers, vsPDA: web3.PublicKey) {
    this.accounts = accounts;
    this.vsPDA = vsPDA;
  }

  /**
   * Get the next valid batch ID from on-chain state
   */
  async nextBatchId(): Promise<number> {
    const vs = await this.accounts.getValidatorSet(this.vsPDA);
    return vs.lastBatchId.toNumber() + 1;
  }

  /**
   * Get a fresh batch ID (locally incremented after first on-chain fetch)
   * This is more efficient for tests that create many sequential batches
   */
  async freshBatchId(): Promise<number> {
    if (this.batchCursor === 0) {
      this.batchCursor = await this.nextBatchId();
    }
    return this.batchCursor++;
  }

  /**
   * Reset the local cursor (useful for tests that need to sync with on-chain state)
   */
  reset(): void {
    this.batchCursor = 0;
  }
}

// ============================================================================
// TOKEN BALANCE HELPERS - Add new section
// ============================================================================

export class TokenBalanceHelper {
  private connection: web3.Connection;

  constructor(connection: web3.Connection) {
    this.connection = connection;
  }

  /**
   * Get token balance or 0 if account doesn't exist
   */
  async getBalance(tokenAccount: web3.PublicKey): Promise<bigint> {
    try {
      const response = await this.connection.getTokenAccountBalance(
        tokenAccount
      );
      return BigInt(response.value.amount);
    } catch {
      return BigInt(0);
    }
  }

  /**
   * Get token balance difference (after - before)
   */
  async getBalanceDelta(
    tokenAccount: web3.PublicKey,
    beforeBalance: bigint
  ): Promise<bigint> {
    const afterBalance = await this.getBalance(tokenAccount);
    return afterBalance - beforeBalance;
  }

  /**
   * Snapshot balance for later comparison
   */
  async snapshot(tokenAccount: web3.PublicKey): Promise<bigint> {
    return await this.getBalance(tokenAccount);
  }
}

// ============================================================================
// ASSERTION HELPERS
// ============================================================================

/**
 * Assert validator set matches expected state
 */
export function assertValidatorSetState(
  actual: ValidatorSetData,
  expected: {
    validators: web3.PublicKey[];
    threshold: number;
    lastBatchId: number | BN;
    bridgeRequestCount: number | BN;
  }
) {
  // Sort both arrays for comparison
  const actualSigners = actual.signers.map((pk) => pk.toBase58()).sort();
  const expectedSigners = expected.validators.map((pk) => pk.toBase58()).sort();

  expect(actualSigners, "validator signers mismatch").to.deep.equal(
    expectedSigners
  );
  expect(actual.threshold, "threshold mismatch").to.equal(expected.threshold);

  const expectedBatchId =
    typeof expected.lastBatchId === "number"
      ? new BN(expected.lastBatchId)
      : expected.lastBatchId;
  expect(actual.lastBatchId.toString(), "lastBatchId mismatch").to.equal(
    expectedBatchId.toString()
  );

  const expectedRequestCount =
    typeof expected.bridgeRequestCount === "number"
      ? new BN(expected.bridgeRequestCount)
      : expected.bridgeRequestCount;
  expect(
    actual.bridgeRequestCount.toString(),
    "bridgeRequestCount mismatch"
  ).to.equal(expectedRequestCount.toString());
}

/**
 * Assert bump is valid (0-255)
 */
export function assertValidBump(bump: number) {
  expect(bump, "bump should be >= 0").to.be.at.least(0);
  expect(bump, "bump should be <= 255").to.be.at.most(255);
}

/**
 * Assert bridging transaction fields match expected values
 */
export function assertBridgingTransactionState(
  actual: BridgingTransactionData,
  expected: {
    amount: number | BN;
    receiver: web3.PublicKey;
    mintToken: web3.PublicKey;
    batchId: number | BN;
    expectedPDA: web3.PublicKey;
  }
) {
  const expectedAmount =
    typeof expected.amount === "number"
      ? new BN(expected.amount)
      : expected.amount;
  const expectedBatchId =
    typeof expected.batchId === "number"
      ? new BN(expected.batchId)
      : expected.batchId;

  expect(actual.amount.toString(), "amount mismatch").to.equal(
    expectedAmount.toString()
  );
  expect(
    actual.receiver.equals(expected.receiver),
    "receiver mismatch"
  ).to.equal(true);
  expect(
    actual.mintToken.equals(expected.mintToken),
    "mintToken mismatch"
  ).to.equal(true);
  expect(actual.batchId.toString(), "batchId mismatch").to.equal(
    expectedBatchId.toString()
  );
  expect(
    actual.id.equals(expected.expectedPDA),
    "id should match PDA"
  ).to.equal(true);
  assertValidBump(actual.bump);
}

// ============================================================================
// INSTRUCTION HELPERS - INITIALIZE
// ============================================================================

export interface InitializeParams {
  validators: web3.PublicKey[];
  lastId?: number | BN;
  minOperationalFee?: number | BN; // ← NEW (lamports, defaults to 0)
  bridgeFee?: number | BN; // ← NEW (lamports, defaults to 0)
  treasury?: web3.PublicKey; // ← NEW (defaults to owner pubkey)
  relayer?: web3.PublicKey; // ← NEW (defaults to owner pubkey)
}

export class InitializeHelper {
  private program: Program<SkylineProgram>;
  private owner: anchor.Wallet;

  constructor(program: Program<SkylineProgram>, owner: anchor.Wallet) {
    this.program = program;
    this.owner = owner;
  }

  /**
   * Build the shared methods call for initialize instruction, with flexible params and defaults
   */
  private buildCall(params: InitializeParams) {
    const lastIdBN =
      params.lastId === undefined
        ? null // program accepts Option<u64>, null → None → defaults to 0
        : typeof params.lastId === "number"
        ? new BN(params.lastId)
        : params.lastId;

    const minOpFee =
      params.minOperationalFee === undefined
        ? new BN(0)
        : typeof params.minOperationalFee === "number"
        ? new BN(params.minOperationalFee)
        : params.minOperationalFee;

    const bridgeFee =
      params.bridgeFee === undefined
        ? new BN(0)
        : typeof params.bridgeFee === "number"
        ? new BN(params.bridgeFee)
        : params.bridgeFee;

    const treasury = params.treasury ?? this.owner.publicKey;
    const relayer = params.relayer ?? this.owner.publicKey;

    return this.program.methods
      .initialize(params.validators, lastIdBN, minOpFee, bridgeFee)
      .accounts({
        signer: this.owner.publicKey,
        treasury,
        relayer
      });
  }

  async call(
    validators: web3.PublicKey[],
    lastId: number | BN = 0,
    options: Omit<InitializeParams, "validators" | "lastId"> = {}
  ): Promise<string> {
    return await this.buildCall({ validators, lastId, ...options }).rpc();
  }

  /** Full-params call for tests that need to set fees / treasury / relayer */
  async callFull(params: InitializeParams): Promise<string> {
    return await this.buildCall(params).rpc();
  }

  /** Expect a specific Anchor error code */
  async expectError(
    validators: web3.PublicKey[],
    expectedErrorCode: string,
    lastId: number | BN = 0,
    options: Omit<InitializeParams, "validators" | "lastId"> = {}
  ): Promise<void> {
    let thrown = false;
    try {
      await this.buildCall({ validators, lastId, ...options }).rpc();
    } catch (e: any) {
      thrown = true;
      expect(e.error?.errorCode?.code).to.equal(expectedErrorCode);
    }
    if (!thrown) {
      throw new Error(
        `Expected initialize to fail with ${expectedErrorCode}, but it succeeded`
      );
    }
  }

  /** Expect failure for any reason */
  async expectFailure(
    validators: web3.PublicKey[],
    lastId: number | BN = 0,
    options: Omit<InitializeParams, "validators" | "lastId"> = {}
  ): Promise<void> {
    let thrown = false;
    try {
      await this.buildCall({ validators, lastId, ...options }).rpc();
    } catch {
      thrown = true;
    }
    if (!thrown) {
      throw new Error("Expected initialize to fail, but it succeeded");
    }
  }
}

// ============================================================================
// INSTRUCTION HELPERS - TOKEN REGISTRY
// ============================================================================

export interface RegisterLockUnlockParams {
  mint: web3.PublicKey;
  tokenId: number;
  minBridgingAmount?: number | BN; // defaults to 1
}

export interface RegisterMintBurnParams {
  tokenId: number;
  decimals: number;
  minBridgingAmount?: number | BN; // defaults to 1
  name: string;
  symbol: string;
  uri: string;
}

export class TokenRegistryHelper {
  private program: Program<SkylineProgram>;
  private owner: anchor.Wallet;

  constructor(program: Program<SkylineProgram>, owner: anchor.Wallet) {
    this.program = program;
    this.owner = owner;
  }

  /**
   * Register a pre-existing mint as a Lock/Unlock token.
   * Vault receives tokens on bridge_request; vault sends tokens on bridge_transaction.
   * is_lock_unlock = true
   */
  async registerLockUnlock(params: RegisterLockUnlockParams): Promise<string> {
    const minBridgingAmount =
      params.minBridgingAmount === undefined
        ? new BN(1)
        : typeof params.minBridgingAmount === "number"
        ? new BN(params.minBridgingAmount)
        : params.minBridgingAmount;

    return await this.program.methods
      .registerLockUnlockToken(params.tokenId, minBridgingAmount)
      .accounts({
        authority: this.owner.publicKey,
        mint: params.mint
      })
      .rpc();
  }

  /**
   * Register a new Mint/Burn token (program creates the mint, vault becomes mint authority).
   * Tokens are burned on bridge_request; minted on bridge_transaction.
   * is_lock_unlock = false
   *
   * Returns the new mint public key derived from the transaction.
   */
  async registerMintBurn(
    params: RegisterMintBurnParams
  ): Promise<{ signature: string; mint: web3.PublicKey }> {
    const minBridgingAmount =
      params.minBridgingAmount === undefined
        ? new BN(1)
        : typeof params.minBridgingAmount === "number"
        ? new BN(params.minBridgingAmount)
        : params.minBridgingAmount;

    // The mint keypair must be provided as a signer because `register_mint_burn_token`
    // calls `init` on it. Anchor resolves the mint account from the IDL accounts list;
    // we pass a fresh Keypair so Anchor knows the address and signs the allocation.
    const mintKeypair = web3.Keypair.generate();

    const signature = await this.program.methods
      .registerMintBurnToken(
        params.tokenId,
        params.decimals,
        minBridgingAmount,
        params.name,
        params.symbol,
        params.uri
      )
      .accountsPartial({
        authority: this.owner.publicKey,
        mint: mintKeypair.publicKey
      })
      .signers([mintKeypair])
      .rpc();

    return { signature, mint: mintKeypair.publicKey };
  }

  /**
   * Check if a mint is already registered
   */
  async isRegistered(mint: web3.PublicKey, pdas: PDAs): Promise<boolean> {
    const pda = pdas.tokenRegistry(mint);
    const account = await this.program.account.tokenRegistry
      .fetchNullable(pda)
      .catch(() => null);
    return account !== null;
  }
}

// ============================================================================
// INSTRUCTION HELPERS - BRIDGE TRANSACTION (new multi-transfer API)
// ============================================================================

/** Mirrors the on-chain TransferItem struct */
export interface TransferItem {
  recipient: web3.PublicKey;
  mintIndex: number; // u8 — index into the mints array
  amount: BN;
}

export interface BridgeTransactionParams {
  transfers: TransferItem[];
  mints: web3.PublicKey[];
  batchId: number | BN;
  validators: web3.Keypair[];
  vaultPDA: web3.PublicKey;
}

/**
 * All the AccountMeta arrays that make up remaining_accounts.
 * Exposed so individual tests can corrupt a specific section.
 */
export interface BridgeTxRemainingAccounts {
  validatorMetas: {
    pubkey: web3.PublicKey;
    isSigner: boolean;
    isWritable: boolean;
  }[];
  mintMetas: {
    pubkey: web3.PublicKey;
    isSigner: boolean;
    isWritable: boolean;
  }[];
  walletMetas: {
    pubkey: web3.PublicKey;
    isSigner: boolean;
    isWritable: boolean;
  }[];
  registryMetas: {
    pubkey: web3.PublicKey;
    isSigner: boolean;
    isWritable: boolean;
  }[];
  recipientAtaMetas: {
    pubkey: web3.PublicKey;
    isSigner: boolean;
    isWritable: boolean;
  }[];
  vaultAtaMetas: {
    pubkey: web3.PublicKey;
    isSigner: boolean;
    isWritable: boolean;
  }[];
}

export interface V0CallResult {
  signature: string;
  wireSize: number; // full serialized tx (sigs + message)
  messageSize: number; // message only — this is what counts against 1232
}

export class BridgeTransactionHelper {
  private program: Program<SkylineProgram>;
  private owner: anchor.Wallet;

  constructor(program: Program<SkylineProgram>, owner: anchor.Wallet) {
    this.program = program;
    this.owner = owner;
  }

  /** Derive the canonical token_registry PDA for a mint */
  tokenRegistryPDA(mint: web3.PublicKey): web3.PublicKey {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from(SEEDS.TOKEN_REGISTRY), mint.toBuffer()],
      this.program.programId
    )[0];
  }

  /**
   * Build the six remaining_accounts sections from params.
   * This is the canonical correct layout — tests that need to
   * corrupt a section can call this, mutate one section, then
   * call sendWithSections() directly.
   */
  buildSections(params: BridgeTransactionParams): BridgeTxRemainingAccounts {
    const { transfers, mints, validators, vaultPDA } = params;

    // Section 1 — validator signers (isSigner = true)
    const validatorMetas = validators.map((v) => ({
      pubkey: v.publicKey,
      isSigner: true,
      isWritable: false
    }));

    // Section 2 — mint accounts (read-only, parallel to mints[])
    const mintMetas = mints.map((m) => ({
      pubkey: m,
      isSigner: false,
      isWritable: false
    }));

    // Section 3 — recipient wallets (one per transfer, read-only)
    const walletMetas = transfers.map((t) => ({
      pubkey: t.recipient,
      isSigner: false,
      isWritable: false
    }));

    // Section 4 — token registry PDAs (one per mint, read-only)
    const registryMetas = mints.map((m) => ({
      pubkey: this.tokenRegistryPDA(m),
      isSigner: false,
      isWritable: false
    }));

    // Section 5 — recipient ATAs (one per transfer, writable)
    const recipientAtaMetas = transfers.map((t) => ({
      pubkey: getAssociatedTokenAddressSync(mints[t.mintIndex], t.recipient),
      isSigner: false,
      isWritable: true
    }));

    // Section 6 — vault ATAs (one per unique mint, writable)
    const vaultAtaMetas = mints.map((m) => ({
      pubkey: getAssociatedTokenAddressSync(m, vaultPDA, true),
      isSigner: false,
      isWritable: true
    }));

    return {
      validatorMetas,
      mintMetas,
      walletMetas,
      registryMetas,
      recipientAtaMetas,
      vaultAtaMetas
    };
  }

  /** Flatten sections into a single remaining_accounts array in order */
  private flattenSections(sections: BridgeTxRemainingAccounts) {
    return [
      ...sections.validatorMetas,
      ...sections.mintMetas,
      ...sections.walletMetas,
      ...sections.registryMetas,
      ...sections.recipientAtaMetas,
      ...sections.vaultAtaMetas
    ];
  }

  /**
   * Serialize transfers for the instruction — matches on-chain TransferItem layout.
   * { recipient: Pubkey, mint_index: u8, amount: u64 }
   */
  private serializeTransfers(transfers: TransferItem[]) {
    // Anchor will serialize these via AnchorSerialize — we pass plain objects
    // matching the IDL struct shape. Field names must be camelCase as the IDL
    // generates them from the snake_case Rust fields.
    return transfers.map((t) => ({
      recipient: t.recipient,
      mintIndex: t.mintIndex,
      amount: t.amount
    }));
  }

  /**
   * Call the new bridge_transaction instruction with the correct layout.
   */
  async call(params: BridgeTransactionParams): Promise<string> {
    const batchIdBN =
      typeof params.batchId === "number"
        ? new BN(params.batchId)
        : params.batchId;

    const sections = this.buildSections(params);
    const remainingAccounts = this.flattenSections(sections);

    return await this.program.methods
      .bridgeTransaction(
        this.serializeTransfers(params.transfers),
        params.mints,
        batchIdBN
      )
      .accounts({
        payer: this.owner.publicKey
      })
      .signers(params.validators)
      .remainingAccounts(remainingAccounts)
      .rpc();
  }

  async callV0(params: BridgeTransactionParams): Promise<V0CallResult> {
    const connection = this.program.provider.connection;
    const sections = this.buildSections(params);
    const remainingAccounts = this.flattenSections(sections);
    const batchIdBN =
      typeof params.batchId === "number"
        ? new BN(params.batchId)
        : params.batchId;

    // 1. Build the instruction WITHOUT sending (.instruction() not .rpc())
    const ix = await this.program.methods
      .bridgeTransaction(
        this.serializeTransfers(params.transfers),
        params.mints,
        batchIdBN
      )
      .accounts({ payer: this.owner.publicKey })
      .remainingAccounts(remainingAccounts)
      // NOTE: no .signers() here — we sign manually below
      .instruction();

    // 2. Fresh blockhash
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();

    // 3. Compile to V0 message (no Address Lookup Table — pure format change)
    const messageV0 = new TransactionMessage({
      payerKey: this.owner.publicKey,
      recentBlockhash: blockhash,
      instructions: [ix]
    }).compileToV0Message(); // ← this is the only v0-specific line

    // 4. Wrap in VersionedTransaction
    const tx = new VersionedTransaction(messageV0);

    // 5. Sign: payer first, then all validators
    //    VersionedTransaction.sign() takes Keypair[] not Signer[]
    tx.sign([
      (this.owner as anchor.Wallet).payer, // payer keypair
      ...params.validators // validator keypairs
    ]);

    // 6. Measure sizes BEFORE sending
    const wireBytes = tx.serialize();
    const messageBytes = tx.message.serialize();

    // 7. Send raw
    const signature = await connection.sendRawTransaction(wireBytes, {
      skipPreflight: false
    });

    await connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight
    });

    return {
      signature,
      wireSize: wireBytes.length, // sigs + message (informational)
      messageSize: messageBytes.length // ← compare this against 1232
    };
  }

  /**
   * Call with manually constructed sections — used by error tests that
   * need to corrupt one specific section without rebuilding everything.
   */
  async callWithSections(
    transfers: TransferItem[],
    mints: web3.PublicKey[],
    batchId: number | BN,
    validators: web3.Keypair[],
    sections: BridgeTxRemainingAccounts
  ): Promise<string> {
    const batchIdBN = typeof batchId === "number" ? new BN(batchId) : batchId;

    const remainingAccounts = this.flattenSections(sections);

    return await this.program.methods
      .bridgeTransaction(this.serializeTransfers(transfers), mints, batchIdBN)
      .accounts({ payer: this.owner.publicKey })
      .signers(validators)
      .remainingAccounts(remainingAccounts)
      .rpc();
  }
  async callV0WithSections(
    transfers: TransferItem[],
    mints: web3.PublicKey[],
    batchId: number | BN,
    validators: web3.Keypair[],
    sections: BridgeTxRemainingAccounts
  ): Promise<V0CallResult> {
    const connection = this.program.provider.connection;
    const remainingAccounts = this.flattenSections(sections);
    const batchIdBN = typeof batchId === "number" ? new BN(batchId) : batchId;
    const ix = await this.program.methods
      .bridgeTransaction(this.serializeTransfers(transfers), mints, batchIdBN)
      .accounts({ payer: this.owner.publicKey })
      .remainingAccounts(remainingAccounts)
      .instruction();

    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();

    const messageV0 = new TransactionMessage({
      payerKey: this.owner.publicKey,
      recentBlockhash: blockhash,
      instructions: [ix]
    }).compileToV0Message();

    const tx = new VersionedTransaction(messageV0);
    tx.sign([(this.owner as anchor.Wallet).payer, ...validators]);

    const wireBytes = tx.serialize();
    const messageBytes = tx.message.serialize();

    const signature = await connection.sendRawTransaction(wireBytes);
    await connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight
    });

    return {
      signature,
      wireSize: wireBytes.length,
      messageSize: messageBytes.length
    };
  }

  /** Expect a specific Anchor error code */
  async expectError(
    params: BridgeTransactionParams,
    expectedErrorCode: string
  ): Promise<void> {
    let thrown = false;
    try {
      await this.call(params);
    } catch (e: any) {
      thrown = true;
      const code = e.error?.errorCode?.code ?? e.errorCode?.code;
      const message = e.error?.errorMessage ?? e.message ?? "No error message";
      //console.log("Caught error code:", code);
      //console.log("Caught error message:", message);

      expect(code, `expected error ${expectedErrorCode}`).to.equal(
        expectedErrorCode
      );
    }
    if (!thrown) {
      throw new Error(
        `Expected bridgeTransaction to fail with ${expectedErrorCode}, but it succeeded`
      );
    }
  }

  /** Expect a specific error code when using custom sections */
  async expectErrorWithSections(
    transfers: TransferItem[],
    mints: web3.PublicKey[],
    batchId: number | BN,
    validators: web3.Keypair[],
    sections: BridgeTxRemainingAccounts,
    expectedErrorCode: string
  ): Promise<void> {
    let thrown = false;
    try {
      await this.callWithSections(
        transfers,
        mints,
        batchId,
        validators,
        sections
      );
    } catch (e: any) {
      thrown = true;
      const code = e.error?.errorCode?.code ?? e.errorCode?.code;
      expect(code, `expected error ${expectedErrorCode}`).to.equal(
        expectedErrorCode
      );
    }
    if (!thrown) {
      throw new Error(
        `Expected bridgeTransaction to fail with ${expectedErrorCode}, but it succeeded`
      );
    }
  }
}

// ============================================================================
// TOKEN/MINT HELPERS
// ============================================================================

export class MintHelper {
  private connection: web3.Connection;
  private payer: web3.Keypair;

  constructor(connection: web3.Connection, payer: web3.Keypair) {
    this.connection = connection;
    this.payer = payer;
  }

  /**
   * Create a new mint
   */
  async create(
    authority: web3.PublicKey,
    decimals: number = 9
  ): Promise<web3.PublicKey> {
    return await createMint(
      this.connection,
      this.payer,
      authority,
      null,
      decimals
    );
  }

  /**
   * Mint tokens to an account
   */
  async mintTo(
    mint: web3.PublicKey,
    destination: web3.PublicKey,
    amount: number,
    allowPDA: boolean = false
  ): Promise<void> {
    const ata = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.payer,
      mint,
      destination,
      allowPDA
    );

    await mintTo(
      this.connection,
      this.payer,
      mint,
      ata.address,
      this.payer,
      amount
    );
  }
  /**
   * Freeze a token account (requires freeze authority)
   */
  async freezeTokenAccount(
    mint: web3.PublicKey,
    tokenAccount: web3.PublicKey,
    freezeAuthority: web3.Keypair
  ): Promise<void> {
    const { freezeAccount } = await import("@solana/spl-token");

    await freezeAccount(
      this.connection,
      this.payer,
      tokenAccount,
      mint,
      freezeAuthority
    );
  }

  /**
   * Create a mint with freeze authority
   */
  async createWithFreezeAuthority(
    mintAuthority: web3.PublicKey,
    freezeAuthority: web3.PublicKey,
    decimals: number = 9
  ): Promise<web3.PublicKey> {
    return await createMint(
      this.connection,
      this.payer,
      mintAuthority,
      freezeAuthority, // Set freeze authority
      decimals
    );
  }

  /**
   * Get token account balance
   */
  async getTokenAccountBalance(tokenAccount: web3.PublicKey): Promise<number> {
    const balance = await this.connection.getTokenAccountBalance(tokenAccount);
    return parseInt(balance.value.amount);
  }

  /**
   * Get mint info
   */
  async getMintInfo(mint: web3.PublicKey): Promise<any> {
    const { getMint } = await import("@solana/spl-token");
    return await getMint(this.connection, mint);
  }
  /**
   * Set mint authority (transfer authority to new owner)
   */
  async setMintAuthority(
    mint: web3.PublicKey,
    newAuthority: web3.PublicKey
  ): Promise<void> {
    const { setAuthority, AuthorityType } = await import("@solana/spl-token");

    await setAuthority(
      this.connection,
      this.payer, // Current authority (must sign)
      mint,
      this.payer.publicKey, // Current authority
      AuthorityType.MintTokens,
      newAuthority // New authority (can be PDA)
    );
  }
}

// ============================================================================
// BRIDGE REQUEST TYPES
// ============================================================================

export interface BridgeRequestParams {
  amount: number | BN;
  receiver: string;
  destinationChain: string;
  mint: web3.PublicKey;
  fees: number | BN; // ← NEW: total SOL fee in lamports
  signer?: web3.Keypair; // Optional, defaults to owner
  /** Override treasury (default: from fee_config) */
  treasuryOverride?: web3.PublicKey;
  /** Override relayer (default: from fee_config) */
  relayerOverride?: web3.PublicKey;
}

// ============================================================================
// BRIDGE REQUEST HELPER
// ============================================================================

export class BridgeRequestHelper {
  private program: Program<SkylineProgram>;
  private owner: anchor.Wallet;
  private vaultPDA: web3.PublicKey;

  constructor(
    program: Program<SkylineProgram>,
    owner: anchor.Wallet,
    vaultPDA: web3.PublicKey
  ) {
    this.program = program;
    this.owner = owner;
    this.vaultPDA = vaultPDA;
  }

  /** Derive the canonical fee_config PDA */
  feeConfigPDA(): web3.PublicKey {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from(SEEDS.FEE_CONFIG)],
      this.program.programId
    )[0];
  }

  /** Derive the canonical token_registry PDA for a mint */
  tokenRegistryPDA(mint: web3.PublicKey): web3.PublicKey {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from(SEEDS.TOKEN_REGISTRY), mint.toBuffer()],
      this.program.programId
    )[0];
  }

  /**
   * Resolve treasury + relayer from the on-chain fee_config.
   * Called lazily when not overridden.
   */
  private async resolveFeeAccounts(): Promise<{
    treasury: web3.PublicKey;
    relayer: web3.PublicKey;
  }> {
    const feeConfig = await this.program.account.feeConfig.fetch(
      this.feeConfigPDA()
    );
    return {
      treasury: feeConfig.treasury,
      relayer: feeConfig.relayer
    };
  }

  /**
   * Call bridgeRequest instruction.
   * Treasury and relayer are resolved automatically from fee_config unless overridden.
   */
  async call(params: BridgeRequestParams): Promise<string> {
    const amountBN =
      typeof params.amount === "number" ? new BN(params.amount) : params.amount;
    const feesBN =
      typeof params.fees === "number" ? new BN(params.fees) : params.fees;
    const signer = params.signer ?? this.owner.payer;

    const signerAta = getAssociatedTokenAddressSync(
      params.mint,
      signer.publicKey
    );
    const vaultAta = getAssociatedTokenAddressSync(
      params.mint,
      this.vaultPDA,
      true
    );

    const { treasury, relayer } = await this.resolveFeeAccounts();

    return await this.program.methods
      .bridgeRequest(amountBN, params.receiver, params.destinationChain, feesBN)
      .accountsPartial({
        signer: signer.publicKey,
        signersAta: signerAta,
        vaultAta: vaultAta,
        mint: params.mint,
        tokenRegistry: this.tokenRegistryPDA(params.mint),
        feeConfig: this.feeConfigPDA(),
        treasury: params.treasuryOverride ?? treasury,
        relayer: params.relayerOverride ?? relayer
      })
      .signers(signer === this.owner.payer ? [] : [signer])
      .rpc();
  }

  /**
   * Call with fully custom accounts (for error testing).
   */
  async callWithCustomAccounts(
    amount: number | BN,
    receiver: string,
    destinationChain: string,
    accounts: {
      signer: web3.PublicKey;
      signersAta: web3.PublicKey;
      vaultAta: web3.PublicKey;
      mint: web3.PublicKey;
      fees?: number | BN;
      tokenRegistry?: web3.PublicKey;
      feeConfig?: web3.PublicKey;
      treasury?: web3.PublicKey;
      relayer?: web3.PublicKey;
    },
    signers: web3.Keypair[]
  ): Promise<string> {
    const amountBN = typeof amount === "number" ? new BN(amount) : amount;
    const feesBN =
      accounts.fees === undefined
        ? new BN(0)
        : typeof accounts.fees === "number"
        ? new BN(accounts.fees)
        : accounts.fees;

    // Resolve defaults from fee_config when not overridden
    let treasury = accounts.treasury;
    let relayer = accounts.relayer;
    if (!treasury || !relayer) {
      const resolved = await this.resolveFeeAccounts();
      treasury = treasury ?? resolved.treasury;
      relayer = relayer ?? resolved.relayer;
    }

    return await this.program.methods
      .bridgeRequest(amountBN, receiver, destinationChain, feesBN)
      .accountsPartial({
        signer: accounts.signer,
        signersAta: accounts.signersAta,
        vaultAta: accounts.vaultAta,
        mint: accounts.mint,
        tokenRegistry:
          accounts.tokenRegistry ?? this.tokenRegistryPDA(accounts.mint),
        feeConfig: accounts.feeConfig ?? this.feeConfigPDA(),
        treasury,
        relayer
      })
      .signers(signers)
      .rpc();
  }

  /** Call and expect a specific error code */
  async expectError(
    params: BridgeRequestParams,
    expectedErrorCode: string
  ): Promise<void> {
    let thrown = false;
    try {
      await this.call(params);
    } catch (e: any) {
      thrown = true;
      const code = e.error?.errorCode?.code ?? e.errorCode?.code;
      expect(code).to.equal(expectedErrorCode);
    }
    if (!thrown) {
      throw new Error(
        `Expected bridgeRequest to fail with ${expectedErrorCode}, but it succeeded`
      );
    }
  }
}

// ============================================================================
// EVENT PARSING HELPERS
// ============================================================================

export interface BridgeRequestEventData {
  sender: web3.PublicKey;
  amount: BN;
  receiver: Buffer;
  destinationChain: number;
  mintToken: web3.PublicKey;
  batchRequestId: BN;
  bridgeFee: BN;
  operationalFee: BN;
}

export interface ValidatorSetUpdatedEventData {
  newSigners: web3.PublicKey[];
  newThreshold: number;
  batchId: BN;
}

export class EventParser {
  // Event discriminator for BridgeRequestEvent
  // From your IDL: [162, 122, 193, 76, 126, 59, 162, 143]
  private static readonly BRIDGE_REQUEST_DISCRIMINATOR = Buffer.from([
    162, 122, 193, 76, 126, 59, 162, 143
  ]);

  private program: Program<SkylineProgram>;
  private connection: web3.Connection;

  constructor(program: Program<SkylineProgram>, connection: web3.Connection) {
    this.program = program;
    this.connection = connection;
  }

  /**
   * Parse BridgeRequestEvent from transaction signature
   */
  async parseBridgeRequestEvent(
    signature: string
  ): Promise<BridgeRequestEventData | null> {
    // Wait for confirmation
    await new Promise((resolve) => setTimeout(resolve, 500));

    const tx = await this.connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0
    });

    if (!tx || !tx.meta || !tx.meta.logMessages) {
      console.error("Transaction not found or missing logs");
      return null;
    }

    // Find the "Program data:" log entry
    const logs = tx.meta.logMessages;
    const dataLog = logs.find((log) => log.includes("Program data:"));

    if (!dataLog) {
      console.error("No 'Program data:' log found");
      return null;
    }

    try {
      // Extract base64 data after "Program data: "
      const base64Data = dataLog.split("Program data: ")[1].trim();
      const data = Buffer.from(base64Data, "base64");

      // First 8 bytes are the discriminator
      const discriminator = data.slice(0, 8);

      // Check if this is a BridgeRequestEvent
      if (!discriminator.equals(EventParser.BRIDGE_REQUEST_DISCRIMINATOR)) {
        console.error("Event discriminator does not match BridgeRequestEvent");
        console.error("Expected:", EventParser.BRIDGE_REQUEST_DISCRIMINATOR);
        console.error("Got:", discriminator);
        return null;
      }

      // Decode event data (starts after 8-byte discriminator)
      return this.decodeBridgeRequestEvent(data.slice(8));
    } catch (error) {
      console.error("Error parsing event:", error);
      return null;
    }
  }

  /**
   * Manually decode BridgeRequestEvent based on Rust struct layout
   */
  private decodeBridgeRequestEvent(data: Buffer): BridgeRequestEventData {
    let offset = 0;

    // Field 1: sender (Pubkey - 32 bytes)
    const sender = new web3.PublicKey(data.slice(offset, offset + 32));
    offset += 32;

    // Field 2: amount (u64 - 8 bytes, little-endian)
    const amount = new BN(data.slice(offset, offset + 8), "le");
    offset += 8;

    // Field 3: receiver (Vec<u8> - 4 bytes length prefix + data)
    const receiverLength = data.readUInt32LE(offset);
    offset += 4;
    const receiver = Buffer.from(data.slice(offset, offset + receiverLength));
    offset += receiverLength;

    // Field 4: destination_chain (u8 - 1 byte)
    const destinationChain = data.readUInt8(offset);
    offset += 1;

    // Field 5: mint_token (Pubkey - 32 bytes)
    const mintToken = new web3.PublicKey(data.slice(offset, offset + 32));
    offset += 32;

    // Field 6: batch_request_id (u64 - 8 bytes, little-endian)
    const batchRequestId = new BN(data.slice(offset, offset + 8), "le");
    offset += 8;

    // Field 7: bridge_fee (u64 - 8 bytes, little-endian)
    const bridgeFee = new BN(data.slice(offset, offset + 8), "le");
    offset += 8;
    // Field 8: operational_fee (u64 - 8 bytes, little-endian)
    const operationalFee = new BN(data.slice(offset, offset + 8), "le");

    return {
      sender,
      amount,
      receiver,
      destinationChain,
      mintToken,
      batchRequestId,
      bridgeFee,
      operationalFee
    };
  }

  // Event discriminator for ValidatorSetUpdatedEvent
  private static readonly VALIDATOR_SET_UPDATED_DISCRIMINATOR = Buffer.from([
    92, 126, 111, 2, 195, 25, 244, 136
  ]);

  /**
   * Parse ValidatorSetUpdatedEvent from transaction signature
   */
  async parseValidatorSetUpdatedEvent(
    signature: string
  ): Promise<ValidatorSetUpdatedEventData | null> {
    await new Promise((resolve) => setTimeout(resolve, 500));

    const tx = await this.connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0
    });

    if (!tx || !tx.meta || !tx.meta.logMessages) {
      console.error("Transaction not found or missing logs");
      return null;
    }

    const logs = tx.meta.logMessages;
    const dataLog = logs.find((log) => log.includes("Program data:"));

    if (!dataLog) {
      console.error("No 'Program data:' log found");
      return null;
    }

    try {
      const base64Data = dataLog.split("Program data: ")[1].trim();
      const data = Buffer.from(base64Data, "base64");

      const discriminator = data.slice(0, 8);

      if (
        !discriminator.equals(EventParser.VALIDATOR_SET_UPDATED_DISCRIMINATOR)
      ) {
        console.error(
          "Event discriminator does not match ValidatorSetUpdatedEvent"
        );
        return null;
      }

      return this.decodeValidatorSetUpdatedEvent(data.slice(8));
    } catch (error) {
      console.error("Error parsing event:", error);
      return null;
    }
  }

  /**
   * Manually decode ValidatorSetUpdatedEvent
   */
  private decodeValidatorSetUpdatedEvent(
    data: Buffer
  ): ValidatorSetUpdatedEventData {
    let offset = 0;

    // new_signers: Vec<Pubkey> (4 bytes length + data)
    const signersLength = data.readUInt32LE(offset);
    offset += 4;
    const newSigners: web3.PublicKey[] = [];
    for (let i = 0; i < signersLength; i++) {
      newSigners.push(new web3.PublicKey(data.slice(offset, offset + 32)));
      offset += 32;
    }

    // new_threshold: u8 (1 byte)
    const newThreshold = data.readUInt8(offset);
    offset += 1;

    // batch_id: u64 (8 bytes, little-endian)
    const batchId = new BN(data.slice(offset, offset + 8), "le");

    return {
      newSigners,
      newThreshold,
      batchId
    };
  }
}

// ============================================================================
// INSTRUCTION HELPERS - BRIDGE VSU
// ============================================================================

export interface BridgeVSUParams {
  added: web3.PublicKey[];
  removed: web3.PublicKey[];
  batchId: number | BN;
  /** Keypairs that will sign as remaining_accounts validators */
  signerKeypairs: web3.Keypair[];
  /** Override the payer (defaults to owner) */
  payerOverride?: web3.Keypair;
}

export class BridgeVSUHelper {
  private program: Program<SkylineProgram>;
  private owner: anchor.Wallet;

  constructor(program: Program<SkylineProgram>, owner: anchor.Wallet) {
    this.program = program;
    this.owner = owner;
  }

  /**
   * Build the remaining_accounts array: each signing validator is passed
   * as isSigner=true, isWritable=false.
   *
   * Non-signing "witness" accounts can be passed separately via
   * extraNonSignerAccounts if you need to test duplicate detection
   * while keeping signers below threshold.
   */
  buildRemainingAccounts(
    signerKeypairs: web3.Keypair[],
    extraNonSignerAccounts: web3.PublicKey[] = []
  ): { pubkey: web3.PublicKey; isSigner: boolean; isWritable: boolean }[] {
    const signerMetas = signerKeypairs.map((kp) => ({
      pubkey: kp.publicKey,
      isSigner: true,
      isWritable: false
    }));
    const extraMetas = extraNonSignerAccounts.map((pk) => ({
      pubkey: pk,
      isSigner: false,
      isWritable: false
    }));
    return [...signerMetas, ...extraMetas];
  }

  /**
   * Execute bridgeVsu instruction.
   */
  async call(params: BridgeVSUParams): Promise<string> {
    const batchIdBN =
      typeof params.batchId === "number"
        ? new BN(params.batchId)
        : params.batchId;

    const payer = params.payerOverride ?? this.owner.payer;
    const remainingAccounts = this.buildRemainingAccounts(
      params.signerKeypairs
    );

    return await this.program.methods
      .bridgeVsu(params.added, params.removed, batchIdBN)
      .accounts({
        payer: payer.publicKey
      })
      .signers(
        params.payerOverride
          ? [params.payerOverride, ...params.signerKeypairs]
          : params.signerKeypairs
      )
      .remainingAccounts(remainingAccounts)
      .rpc();
  }

  /**
   * Execute with a raw remaining_accounts array.
   * Used by error tests that need to inject non-signers, duplicates, etc.
   */
  async callRaw(
    added: web3.PublicKey[],
    removed: web3.PublicKey[],
    batchId: number | BN,
    signerKeypairs: web3.Keypair[],
    remainingAccounts: {
      pubkey: web3.PublicKey;
      isSigner: boolean;
      isWritable: boolean;
    }[],
    payerOverride?: web3.Keypair
  ): Promise<string> {
    const batchIdBN = typeof batchId === "number" ? new BN(batchId) : batchId;
    const payer = payerOverride ?? this.owner.payer;

    return await this.program.methods
      .bridgeVsu(added, removed, batchIdBN)
      .accounts({
        payer: payer.publicKey
      })
      .signers(
        payerOverride ? [payerOverride, ...signerKeypairs] : signerKeypairs
      )
      .remainingAccounts(remainingAccounts)
      .rpc();
  }

  /**
   * Expect a specific Anchor error code.
   */
  async expectError(
    params: BridgeVSUParams,
    expectedErrorCode: string
  ): Promise<void> {
    let thrown = false;
    try {
      await this.call(params);
    } catch (e: any) {
      thrown = true;
      const code = e.error?.errorCode?.code ?? e.errorCode?.code;
      expect(
        code,
        `expected error ${expectedErrorCode}, got ${code} — ${e.message}`
      ).to.equal(expectedErrorCode);
    }
    if (!thrown) {
      throw new Error(
        `Expected bridgeVsu to fail with ${expectedErrorCode}, but it succeeded`
      );
    }
  }

  /**
   * Expect error using raw remaining_accounts (for signer-level error tests).
   */
  async expectErrorRaw(
    added: web3.PublicKey[],
    removed: web3.PublicKey[],
    batchId: number | BN,
    signerKeypairs: web3.Keypair[],
    remainingAccounts: {
      pubkey: web3.PublicKey;
      isSigner: boolean;
      isWritable: boolean;
    }[],
    expectedErrorCode: string
  ): Promise<void> {
    let thrown = false;
    try {
      await this.callRaw(
        added,
        removed,
        batchId,
        signerKeypairs,
        remainingAccounts
      );
    } catch (e: any) {
      thrown = true;
      const code = e.error?.errorCode?.code ?? e.errorCode?.code;
      expect(code, `expected error ${expectedErrorCode}, got ${code}`).to.equal(
        expectedErrorCode
      );
    }
    if (!thrown) {
      throw new Error(
        `Expected bridgeVsu to fail with ${expectedErrorCode}, but it succeeded`
      );
    }
  }
}

// ============================================================================
// MAIN TEST FIXTURE CLASS
// ============================================================================

export class SkylineTestFixture {
  public pdas: PDAs;
  public accounts: AccountFetchers;
  public initialize: InitializeHelper;
  public bridgeTransaction: BridgeTransactionHelper;
  public bridgeRequest: BridgeRequestHelper;
  public mints: MintHelper;
  public batchIds: BatchIdManager;
  public tokenBalances: TokenBalanceHelper;
  public events: EventParser;
  public bridgeVSU: BridgeVSUHelper;
  public tokenRegistry: TokenRegistryHelper;

  constructor(ctx: TestContext) {
    this.pdas = new PDAs(ctx.program.programId);
    this.accounts = new AccountFetchers(ctx.program);
    this.initialize = new InitializeHelper(ctx.program, ctx.owner);
    this.bridgeTransaction = new BridgeTransactionHelper(
      ctx.program,
      ctx.owner
    );
    this.bridgeRequest = new BridgeRequestHelper(
      ctx.program,
      ctx.owner,
      this.pdas.vault()
    );
    this.mints = new MintHelper(ctx.connection, ctx.owner.payer);
    this.batchIds = new BatchIdManager(this.accounts, this.pdas.validatorSet());
    this.tokenBalances = new TokenBalanceHelper(ctx.connection);
    this.events = new EventParser(ctx.program, ctx.connection);
    this.tokenRegistry = new TokenRegistryHelper(ctx.program, ctx.owner);
    this.bridgeVSU = new BridgeVSUHelper(ctx.program, ctx.owner);
  }

  /** Check if validator set is already initialized */
  async isInitialized(): Promise<boolean> {
    const vs = await this.accounts.getValidatorSetNullable(
      this.pdas.validatorSet()
    );
    return vs !== null;
  }

  /** Get current validator set or throw if not initialized */
  async getValidatorSet(): Promise<ValidatorSetData> {
    return await this.accounts.getValidatorSet(this.pdas.validatorSet());
  }

  /** Get next batch ID from on-chain state */
  async nextBatchId(): Promise<number> {
    const vs = await this.getValidatorSet();
    return vs.lastBatchId.toNumber() + 1;
  }

  /**
   * Fetch on-chain fee_config.
   * Useful in tests that need to read treasury/relayer/fee values.
   */
  async getFeeConfig(): Promise<FeeConfigData> {
    return await this.accounts.getFeeConfig(this.pdas.feeConfig());
  }

  /**
   * Compute the minimum fee required by the current fee_config.
   * Convenience so tests don't have to re-derive this manually.
   */
  async requiredFee(): Promise<BN> {
    const fc = await this.getFeeConfig();
    return fc.minOperationalFee.add(fc.bridgeFee);
  }
}
