// tests/fixtures.ts
import * as anchor from "@coral-xyz/anchor";
import { Program, web3, BN } from "@coral-xyz/anchor";
import { SkylineProgram } from "../target/types/skyline_program";
import { expect } from "chai";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

// ============================================================================
// CONSTANTS
// ============================================================================

export const SEEDS = {
  VALIDATOR_SET: "validator-set",
  VAULT: "vault",
  BRIDGING_TRANSACTION: "bridging_transaction",
  VALIDATOR_SET_CHANGE: "validator_set_change",
} as const;

export const LIMITS = {
  MIN_VALIDATORS: 4,
  MAX_VALIDATORS: 128,
  MAX_VALIDATORS_CHANGE: 10,
  MAX_TX_VALIDATORS: 29, // Solana transaction size limit
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
  address: web3.PublicKey;
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
  constructor(private programId: web3.PublicKey) {}

  validatorSet(): web3.PublicKey {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from(SEEDS.VALIDATOR_SET)],
      this.programId,
    )[0];
  }

  vault(): web3.PublicKey {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from(SEEDS.VAULT)],
      this.programId,
    )[0];
  }

  bridgingTransaction(batchId: number | BN): web3.PublicKey {
    const batchBN = typeof batchId === "number" ? new BN(batchId) : batchId;
    const batchLe = batchBN.toArrayLike(Buffer, "le", 8);
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from(SEEDS.BRIDGING_TRANSACTION), batchLe],
      this.programId,
    )[0];
  }

  validatorSetChange(batchId: number | BN): web3.PublicKey {
    const batchBN = typeof batchId === "number" ? new BN(batchId) : batchId;
    const batchLe = batchBN.toArrayLike(Buffer, "le", 8);
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from(SEEDS.VALIDATOR_SET_CHANGE), batchLe],
      this.programId,
    )[0];
  }
}

// ============================================================================
// ACCOUNT FETCHERS
// ============================================================================

export class AccountFetchers {
  constructor(private program: Program<SkylineProgram>) {}

  async getValidatorSet(pda: web3.PublicKey): Promise<ValidatorSetData> {
    return await this.program.account.validatorSet.fetch(pda);
  }

  async getValidatorSetNullable(
    pda: web3.PublicKey,
  ): Promise<ValidatorSetData | null> {
    return await this.program.account.validatorSet.fetchNullable(pda);
  }

  async getVault(pda: web3.PublicKey): Promise<VaultData> {
    return await this.program.account.vault.fetch(pda);
  }

  async getVaultNullable(pda: web3.PublicKey): Promise<VaultData | null> {
    return await this.program.account.vault.fetchNullable(pda);
  }
  async getBridgingTransaction(
    pda: web3.PublicKey,
  ): Promise<BridgingTransactionData> {
    return await this.program.account.bridgingTransaction.fetch(pda);
  }

  async getBridgingTransactionNullable(
    pda: web3.PublicKey,
  ): Promise<BridgingTransactionData | null> {
    return await this.program.account.bridgingTransaction.fetchNullable(pda);
  }
}

// ============================================================================
// BATCH ID MANAGEMENT
// ============================================================================

export class BatchIdManager {
  private batchCursor: number = 0;

  constructor(
    private accounts: AccountFetchers,
    private vsPDA: web3.PublicKey,
  ) {}

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
  constructor(private connection: web3.Connection) {}

  /**
   * Get token balance or 0 if account doesn't exist
   */
  async getBalance(tokenAccount: web3.PublicKey): Promise<bigint> {
    try {
      const response = await this.connection.getTokenAccountBalance(
        tokenAccount,
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
    beforeBalance: bigint,
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
  },
) {
  // Sort both arrays for comparison
  const actualSigners = actual.signers.map((pk) => pk.toBase58()).sort();
  const expectedSigners = expected.validators.map((pk) => pk.toBase58()).sort();

  expect(actualSigners, "validator signers mismatch").to.deep.equal(
    expectedSigners,
  );
  expect(actual.threshold, "threshold mismatch").to.equal(expected.threshold);

  const expectedBatchId =
    typeof expected.lastBatchId === "number"
      ? new BN(expected.lastBatchId)
      : expected.lastBatchId;
  expect(actual.lastBatchId.toString(), "lastBatchId mismatch").to.equal(
    expectedBatchId.toString(),
  );

  const expectedRequestCount =
    typeof expected.bridgeRequestCount === "number"
      ? new BN(expected.bridgeRequestCount)
      : expected.bridgeRequestCount;
  expect(
    actual.bridgeRequestCount.toString(),
    "bridgeRequestCount mismatch",
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
 * Assert vault state is correct
 */
export function assertVaultState(
  actual: VaultData,
  expected: { address: web3.PublicKey },
) {
  expect(
    actual.address.equals(expected.address),
    "vault address mismatch",
  ).to.equal(true);
  assertValidBump(actual.bump);
}

/**
 * Assert bridging transaction does not exist
 */
export async function assertNoBridgingTransaction(
  accounts: AccountFetchers,
  batchId: number | BN,
): Promise<void> {
  const pda = new PDAs(accounts["program"].programId).bridgingTransaction(
    batchId,
  );
  const bt = await accounts.getBridgingTransactionNullable(pda);
  expect(
    bt,
    `expected no bridging transaction for batchId=${batchId}`,
  ).to.equal(null);
}

/**
 * Assert bridging transaction exists with expected signers
 */
export async function assertBridgingTransactionSigners(
  accounts: AccountFetchers,
  programId: web3.PublicKey,
  batchId: number | BN,
  expectedSigners: web3.PublicKey[],
): Promise<void> {
  const pda = new PDAs(programId).bridgingTransaction(batchId);
  const bt = await accounts.getBridgingTransactionNullable(pda);

  expect(
    bt,
    `expected pending bridging transaction for batchId=${batchId}`,
  ).to.not.equal(null);

  const actualSigners = bt!.signers.map((pk) => pk.toBase58());
  const actualSet = new Set(actualSigners);

  expect(actualSet.size, "signers should be unique").to.equal(
    expectedSigners.length,
  );

  for (const pk of expectedSigners) {
    expect(
      actualSet.has(pk.toBase58()),
      `expected signer ${pk.toBase58()} to be in approval list`,
    ).to.equal(true);
  }
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
  },
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
    expectedAmount.toString(),
  );
  expect(
    actual.receiver.equals(expected.receiver),
    "receiver mismatch",
  ).to.equal(true);
  expect(
    actual.mintToken.equals(expected.mintToken),
    "mintToken mismatch",
  ).to.equal(true);
  expect(actual.batchId.toString(), "batchId mismatch").to.equal(
    expectedBatchId.toString(),
  );
  expect(
    actual.id.equals(expected.expectedPDA),
    "id should match PDA",
  ).to.equal(true);
  assertValidBump(actual.bump);
}

// ============================================================================
// INSTRUCTION HELPERS - INITIALIZE
// ============================================================================

export class InitializeHelper {
  constructor(
    private program: Program<SkylineProgram>,
    private owner: anchor.Wallet,
  ) {}

  /**
   * Call initialize instruction
   */
  async call(
    validators: web3.PublicKey[],
    lastId: number | BN = 0,
  ): Promise<string> {
    const lastIdBN = typeof lastId === "number" ? new BN(lastId) : lastId;

    return await this.program.methods
      .initialize(validators, lastIdBN)
      .accounts({
        signer: this.owner.publicKey,
      })
      .rpc();
  }

  /**
   * Call initialize and expect it to fail with specific error
   */
  async expectError(
    validators: web3.PublicKey[],
    expectedErrorCode: string,
    lastId: number | BN = 0,
  ): Promise<void> {
    const lastIdBN = typeof lastId === "number" ? new BN(lastId) : lastId;

    let thrown = false;
    try {
      await this.program.methods
        .initialize(validators, lastIdBN)
        .accounts({
          signer: this.owner.publicKey,
        })
        .rpc();
    } catch (e: any) {
      thrown = true;
      expect(e.error?.errorCode?.code).to.equal(expectedErrorCode);
    }

    if (!thrown) {
      throw new Error(
        `Expected initialize to fail with ${expectedErrorCode}, but it succeeded`,
      );
    }
  }

  /**
   * Call initialize and expect it to fail (for any reason)
   */
  async expectFailure(
    validators: web3.PublicKey[],
    lastId: number | BN = 0,
  ): Promise<void> {
    const lastIdBN = typeof lastId === "number" ? new BN(lastId) : lastId;

    let thrown = false;
    try {
      await this.program.methods
        .initialize(validators, lastIdBN)
        .accounts({
          signer: this.owner.publicKey,
        })
        .rpc();
    } catch (e: any) {
      thrown = true;
    }

    if (!thrown) {
      throw new Error("Expected initialize to fail, but it succeeded");
    }
  }
}

// ============================================================================
// INSTRUCTION HELPERS - BRIDGE TRANSACTION
// ============================================================================

export interface BridgeTransactionParams {
  amount: number | BN;
  batchId: number | BN;
  recipient: web3.PublicKey;
  mint: web3.PublicKey;
  validators: web3.Keypair[];
  vaultPDA: web3.PublicKey;
}

export class BridgeTransactionHelper {
  constructor(
    private program: Program<SkylineProgram>,
    private owner: anchor.Wallet,
  ) {}

  /**
   * Call bridgeTransaction instruction
   */
  async call(params: BridgeTransactionParams): Promise<string> {
    const amountBN =
      typeof params.amount === "number" ? new BN(params.amount) : params.amount;
    const batchIdBN =
      typeof params.batchId === "number"
        ? new BN(params.batchId)
        : params.batchId;

    const remainingAccounts = params.validators.map((v) => ({
      pubkey: v.publicKey,
      isSigner: true,
      isWritable: false,
    }));

    return await this.program.methods
      .bridgeTransaction(amountBN, batchIdBN)
      .accounts({
        payer: this.owner.publicKey,
        recipient: params.recipient,
        mintToken: params.mint,
        recipientAta: getAssociatedTokenAddressSync(
          params.mint,
          params.recipient,
        ),
        vaultAta: getAssociatedTokenAddressSync(
          params.mint,
          params.vaultPDA,
          true,
        ),
      })
      .signers(params.validators)
      .remainingAccounts(remainingAccounts)
      .rpc();
  }

  /**
   * Call bridgeTransaction with custom accounts (for error testing)
   */
  async callWithCustomAccounts(
    amount: number | BN,
    batchId: number | BN,
    accounts: {
      recipient: web3.PublicKey;
      mintToken: web3.PublicKey;
      recipientAta: web3.PublicKey;
      vaultAta: web3.PublicKey;
    },
    validators: web3.Keypair[],
  ): Promise<string> {
    const amountBN = typeof amount === "number" ? new BN(amount) : amount;
    const batchIdBN = typeof batchId === "number" ? new BN(batchId) : batchId;

    const remainingAccounts = validators.map((v) => ({
      pubkey: v.publicKey,
      isSigner: true,
      isWritable: false,
    }));

    return await this.program.methods
      .bridgeTransaction(amountBN, batchIdBN)
      .accounts({
        payer: this.owner.publicKey,
        ...accounts,
      })
      .signers(validators)
      .remainingAccounts(remainingAccounts)
      .rpc();
  }

  /**
   * Call bridgeTransaction and expect it to fail with specific error
   */
  async expectError(
    params: BridgeTransactionParams,
    expectedErrorCode: string,
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
        `Expected bridgeTransaction to fail with ${expectedErrorCode}, but it succeeded`,
      );
    }
  }

  /**
   * Call bridgeTransaction with no remaining accounts (for NoSignersProvided test)
   */
  async callWithNoSigners(
    amount: number | BN,
    batchId: number | BN,
    recipient: web3.PublicKey,
    mint: web3.PublicKey,
    vaultPDA: web3.PublicKey,
  ): Promise<string> {
    const amountBN = typeof amount === "number" ? new BN(amount) : amount;
    const batchIdBN = typeof batchId === "number" ? new BN(batchId) : batchId;

    return await this.program.methods
      .bridgeTransaction(amountBN, batchIdBN)
      .accounts({
        payer: this.owner.publicKey,
        recipient: recipient,
        mintToken: mint,
        recipientAta: getAssociatedTokenAddressSync(mint, recipient),
        vaultAta: getAssociatedTokenAddressSync(mint, vaultPDA, true),
      })
      .remainingAccounts([])
      .rpc();
  }
}

// ============================================================================
// TOKEN/MINT HELPERS
// ============================================================================

export class MintHelper {
  constructor(
    private connection: web3.Connection,
    private payer: web3.Keypair,
  ) {}

  /**
   * Create a new mint
   */
  async create(
    authority: web3.PublicKey,
    decimals: number = 9,
  ): Promise<web3.PublicKey> {
    return await createMint(
      this.connection,
      this.payer,
      authority,
      null,
      decimals,
    );
  }

  /**
   * Mint tokens to an account
   */
  async mintTo(
    mint: web3.PublicKey,
    destination: web3.PublicKey,
    amount: number,
    allowPDA: boolean = false,
  ): Promise<void> {
    const ata = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.payer,
      mint,
      destination,
      allowPDA,
    );

    await mintTo(
      this.connection,
      this.payer,
      mint,
      ata.address,
      this.payer,
      amount,
    );
  }
  /**
   * Freeze a token account (requires freeze authority)
   */
  async freezeTokenAccount(
    mint: web3.PublicKey,
    tokenAccount: web3.PublicKey,
    freezeAuthority: web3.Keypair,
  ): Promise<void> {
    const { freezeAccount } = await import("@solana/spl-token");

    await freezeAccount(
      this.connection,
      this.payer,
      tokenAccount,
      mint,
      freezeAuthority,
    );
  }

  /**
   * Create a mint with freeze authority
   */
  async createWithFreezeAuthority(
    mintAuthority: web3.PublicKey,
    freezeAuthority: web3.PublicKey,
    decimals: number = 9,
  ): Promise<web3.PublicKey> {
    return await createMint(
      this.connection,
      this.payer,
      mintAuthority,
      freezeAuthority, // Set freeze authority
      decimals,
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
    newAuthority: web3.PublicKey,
  ): Promise<void> {
    const { setAuthority, AuthorityType } = await import("@solana/spl-token");

    await setAuthority(
      this.connection,
      this.payer, // Current authority (must sign)
      mint,
      this.payer.publicKey, // Current authority
      AuthorityType.MintTokens,
      newAuthority, // New authority (can be PDA)
    );
  }
}

// ============================================================================
// BRIDGE REQUEST HELPERS
// ============================================================================

export interface BridgeRequestParams {
  amount: number | BN;
  receiver: Buffer | Uint8Array;
  destinationChain: number;
  mint: web3.PublicKey;
  signer?: web3.Keypair; // Optional, defaults to owner
}

export class BridgeRequestHelper {
  constructor(
    private program: Program<SkylineProgram>,
    private owner: anchor.Wallet,
    private vaultPDA: web3.PublicKey,
  ) {}

  /**
   * Call bridgeRequest instruction
   */
  async call(params: BridgeRequestParams): Promise<string> {
    const amountBN =
      typeof params.amount === "number" ? new BN(params.amount) : params.amount;
    const signer = params.signer ?? this.owner.payer;

    const signerAta = getAssociatedTokenAddressSync(
      params.mint,
      signer.publicKey,
    );
    const vaultAta = getAssociatedTokenAddressSync(
      params.mint,
      this.vaultPDA,
      true,
    );

    return await this.program.methods
      .bridgeRequest(
        amountBN,
        Buffer.from(params.receiver),
        params.destinationChain,
      )
      .accounts({
        signer: signer.publicKey,
        signersAta: signerAta,
        vaultAta: vaultAta,
        mint: params.mint,
      })
      .signers(signer === this.owner.payer ? [] : [signer])
      .rpc();
  }

  /**
   * Call with custom accounts (for error testing)
   */
  async callWithCustomAccounts(
    amount: number | BN,
    receiver: Buffer | Uint8Array,
    destinationChain: number,
    accounts: {
      signer: web3.PublicKey;
      signersAta: web3.PublicKey;
      vaultAta: web3.PublicKey;
      mint: web3.PublicKey;
    },
    signers: web3.Keypair[],
  ): Promise<string> {
    const amountBN = typeof amount === "number" ? new BN(amount) : amount;

    return await this.program.methods
      .bridgeRequest(amountBN, Buffer.from(receiver), destinationChain)
      .accounts(accounts)
      .signers(signers)
      .rpc();
  }

  /**
   * Call and expect specific error
   */
  async expectError(
    params: BridgeRequestParams,
    expectedErrorCode: string,
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
        `Expected bridgeRequest to fail with ${expectedErrorCode}, but it succeeded`,
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
    162, 122, 193, 76, 126, 59, 162, 143,
  ]);

  constructor(
    private program: Program<SkylineProgram>,
    private connection: web3.Connection,
  ) {}

  /**
   * Parse BridgeRequestEvent from transaction signature
   */
  async parseBridgeRequestEvent(
    signature: string,
  ): Promise<BridgeRequestEventData | null> {
    // Wait for confirmation
    await new Promise((resolve) => setTimeout(resolve, 500));

    const tx = await this.connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
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

    return {
      sender,
      amount,
      receiver,
      destinationChain,
      mintToken,
      batchRequestId,
    };
  }

  // Event discriminator for ValidatorSetUpdatedEvent
  private static readonly VALIDATOR_SET_UPDATED_DISCRIMINATOR = Buffer.from([
    92, 126, 111, 2, 195, 25, 244, 136,
  ]);

  /**
   * Parse ValidatorSetUpdatedEvent from transaction signature
   */
  async parseValidatorSetUpdatedEvent(
    signature: string,
  ): Promise<ValidatorSetUpdatedEventData | null> {
    await new Promise((resolve) => setTimeout(resolve, 500));

    const tx = await this.connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
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
          "Event discriminator does not match ValidatorSetUpdatedEvent",
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
    data: Buffer,
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
      batchId,
    };
  }
}

// ============================================================================
// VALIDATOR SET UPDATE HELPERS
// ============================================================================

/**
 * Fixture for validator set update operations
 */
export class BridgeVSUFixture {
  constructor(
    private program: Program<SkylineProgram>,
    private connection: web3.Connection,
    private validatorSetPDA: web3.PublicKey,
    private defaultPayer: web3.Keypair
  ) {}

  /**
   * Get the ValidatorSetChange PDA for a given batch_id
   */
  getValidatorSetChangePDA(batchId: number): [web3.PublicKey, number] {
    return web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("validator_set_change"),
        new BN(batchId).toArrayLike(Buffer, "le", 8),
      ],
      this.program.programId,
    );
  }

  /**
   * Call bridge_vsu instruction
   */
  async call(params: {
    added: web3.PublicKey[];
    removed: BN[]; // indices of validators to remove;
    batchId: number;
    payer?: web3.Keypair;
    signers: web3.Keypair[];
  }): Promise<string> {
    const { added, removed, batchId, signers } = params;
    const payer = params.payer || this.defaultPayer;
    const [validatorSetChangePDA] = this.getValidatorSetChangePDA(batchId);

    const remainingAccounts = signers.map((signer) => ({
      pubkey: signer.publicKey,
      isWritable: false,
      isSigner: true,
    }));

    const tx = await this.program.methods
      .bridgeVsu(added, removed, new BN(batchId))
      .accountsPartial({
        payer: payer.publicKey,
        validatorSet: this.validatorSetPDA,
        validatorSetChange: validatorSetChangePDA,
        systemProgram: web3.SystemProgram.programId,
      })
      .remainingAccounts(remainingAccounts)
      .signers([payer, ...signers])
      .rpc();

    return tx;
  }

  /**
   * Fetch ValidatorSetChange account
   */
  async fetchValidatorSetChange(batchId: number): Promise<any | null> {
    try {
      const [pda] = this.getValidatorSetChangePDA(batchId);
      const account = await this.program.account.validatorDelta.fetch(pda);
      return account;
    } catch {
      return null;
    }
  }

  /**
   * Check if ValidatorSetChange account exists
   */
  async validatorSetChangeExists(batchId: number): Promise<boolean> {
    const account = await this.fetchValidatorSetChange(batchId);
    return account !== null;
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
  public bridgeVSU: BridgeVSUFixture;

  constructor(public ctx: TestContext) {
    this.pdas = new PDAs(ctx.program.programId);
    this.accounts = new AccountFetchers(ctx.program);
    this.initialize = new InitializeHelper(ctx.program, ctx.owner);
    this.bridgeTransaction = new BridgeTransactionHelper(
      ctx.program,
      ctx.owner,
    );
    this.bridgeRequest = new BridgeRequestHelper(
      ctx.program,
      ctx.owner,
      this.pdas.vault(),
    );
    this.mints = new MintHelper(ctx.connection, ctx.owner.payer);
    this.batchIds = new BatchIdManager(this.accounts, this.pdas.validatorSet());
    this.tokenBalances = new TokenBalanceHelper(ctx.connection);
    this.events = new EventParser(ctx.program, ctx.connection);

    this.bridgeVSU = new BridgeVSUFixture(
      ctx.program,
      ctx.connection,
      this.pdas.validatorSet(),
      ctx.owner.payer
    );
  }

  /**
   * Check if validator set is already initialized
   */
  async isInitialized(): Promise<boolean> {
    const vsPDA = this.pdas.validatorSet();
    const vs = await this.accounts.getValidatorSetNullable(vsPDA);
    return vs !== null;
  }

  /**
   * Get current validator set or throw if not initialized
   */
  async getValidatorSet(): Promise<ValidatorSetData> {
    const vsPDA = this.pdas.validatorSet();
    return await this.accounts.getValidatorSet(vsPDA);
  }

  /**
   * Get next batch ID
   */
  async nextBatchId(): Promise<number> {
    const vs = await this.getValidatorSet();
    return vs.lastBatchId.toNumber() + 1;
  }
}
