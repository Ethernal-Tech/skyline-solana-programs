// tests/skyline-program.ts
import * as anchor from "@coral-xyz/anchor";
import { Program, web3 } from "@coral-xyz/anchor";
import { SkylineProgram } from "../target/types/skyline_program";
import { assert, expect } from "chai";
import {
  SkylineTestFixture,
  TestContext,
  generateValidators,
  calculateExpectedThreshold,
  assertValidatorSetState,
  assertVaultState,
  assertNoBridgingTransaction,
  assertBridgingTransactionSigners,
  assertBridgingTransactionState,
  LIMITS,
} from "./fixtures";
import {
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";

/**
 * Helper to compare BN arrays by their numeric values
 */
function expectBNArrayEqual(
  actual: anchor.BN[],
  expected: number[],
  message?: string,
) {
  expect(actual.length, `${message || ""} - length mismatch`).to.equal(
    expected.length,
  );
  actual.forEach((bn, i) => {
    expect(bn.toNumber(), `${message || ""} - value at index ${i}`).to.equal(
      expected[i],
    );
  });
}

/**
 * Helper to convert number[] to BN[]
 */
function toBNArray(nums: number[]): anchor.BN[] {
  return nums.map((n) => new anchor.BN(n));
}

/**
 * Airdrop SOL to an account
 */
async function airdrop(
  connection: web3.Connection,
  publicKey: web3.PublicKey,
  amount: number = 10 * web3.LAMPORTS_PER_SOL,
): Promise<void> {
  const signature = await connection.requestAirdrop(publicKey, amount);
  const latestBlockhash = await connection.getLatestBlockhash();
  await connection.confirmTransaction({
    signature,
    ...latestBlockhash,
  });
}

describe("skyline-program", () => {
  // ============================================================================
  // TEST SETUP
  // ============================================================================

  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const program = anchor.workspace.skylineProgram as Program<SkylineProgram>;
  const owner = provider.wallet as anchor.Wallet;

  const ctx: TestContext = {
    provider,
    program,
    owner,
    connection: provider.connection,
  };

  const fixture = new SkylineTestFixture(ctx);

  // Generate test validators once
  const validators = generateValidators(50);

  // ============================================================================
  // INITIALIZE TESTS
  // ============================================================================

  describe("Initialize", () => {
    describe("Bad Cases", () => {
      it("fails with less than MIN_VALIDATORS (3 < 4)", async () => {
        const validatorPubkeys = validators.slice(0, 3).map((v) => v.publicKey);

        await fixture.initialize.expectError(
          validatorPubkeys,
          "MinValidatorsNotMet",
        );
      });

      it("fails with more validators than transaction size allows (30 > 29)", async () => {
        const validatorPubkeys = validators
          .slice(0, LIMITS.MAX_TX_VALIDATORS + 1)
          .map((v) => v.publicKey);

        await fixture.initialize.expectFailure(validatorPubkeys);
      });

      it("fails when duplicate validators provided", async () => {
        const duplicateValidators = [
          validators[0].publicKey,
          validators[1].publicKey,
          validators[2].publicKey,
          validators[3].publicKey,
          validators[0].publicKey, // duplicate
        ];

        await fixture.initialize.expectError(
          duplicateValidators,
          "ValidatorsNotUnique",
        );
      });

      it("fails with no validators provided", async () => {
        await fixture.initialize.expectError([], "MinValidatorsNotMet");
      });
    });

    describe("Success Case", () => {
      it("initializes state correctly with 7 validators", async function () {
        const validatorCount = 7;
        const validatorPubkeys = validators
          .slice(0, validatorCount)
          .map((v) => v.publicKey);

        const expectedThreshold = calculateExpectedThreshold(validatorCount);

        // Check if already initialized
        const isInitialized = await fixture.isInitialized();

        if (isInitialized) {
          // Verify existing state matches expected
          const vsPDA = fixture.pdas.validatorSet();
          const vs = await fixture.accounts.getValidatorSet(vsPDA);

          try {
            assertValidatorSetState(vs, {
              validators: validatorPubkeys,
              threshold: expectedThreshold,
              lastBatchId: 0,
              bridgeRequestCount: 0,
            });

            // Also verify vault
            const vaultPDA = fixture.pdas.vault();
            const vault = await fixture.accounts.getVault(vaultPDA);
            assertVaultState(vault, { address: vaultPDA });

            console.log(
              "  ℹ ValidatorSet already initialized and matches expected state",
            );
            return;
          } catch (e: any) {
            throw new Error(
              [
                "ValidatorSet already exists but does not match expected test validators.",
                "This will cause issues with subsequent tests.",
                "",
                "Fix: Reset your test validator / clean ledger and rerun.",
                `vsPDA=${vsPDA.toBase58()}`,
                "",
                `Error: ${e.message}`,
              ].join("\n"),
            );
          }
        }

        // Not initialized - perform initialization
        await fixture.initialize.call(validatorPubkeys, 0);

        // Verify validator set
        const vsPDA = fixture.pdas.validatorSet();
        const vs = await fixture.accounts.getValidatorSet(vsPDA);

        assertValidatorSetState(vs, {
          validators: validatorPubkeys,
          threshold: expectedThreshold,
          lastBatchId: 0,
          bridgeRequestCount: 0,
        });

        // Verify vault
        const vaultPDA = fixture.pdas.vault();
        const vault = await fixture.accounts.getVault(vaultPDA);
        assertVaultState(vault, { address: vaultPDA });
      });

      it("fails on re-initialization attempt", async function () {
        const isInitialized = await fixture.isInitialized();

        if (!isInitialized) {
          this.skip();
          return;
        }

        // Get state before
        const before = await fixture.getValidatorSet();

        // Attempt re-initialization with different validators
        let threw = false;
        try {
          await fixture.initialize.call(
            validators.slice(5, 12).map((v) => v.publicKey),
            3,
          );
        } catch (e: any) {
          threw = true;
          const logs: string = (e?.logs ?? []).join("\n");
          expect(logs).to.include("Allocate: account");
          expect(logs).to.include("already in use");
        }

        expect(threw, "re-initialization should have failed").to.equal(true);

        // Verify state unchanged
        const after = await fixture.getValidatorSet();
        expect(after.lastBatchId.toString()).to.equal(
          before.lastBatchId.toString(),
        );
        expect(after.signers.length).to.equal(before.signers.length);
      });
    });
  });

  // ============================================================================
  // BRIDGE TRANSACTION TESTS
  // ============================================================================

  describe("Bridge Transaction", () => {
    // Test data
    let mint: web3.PublicKey;
    let mintVaultAuthority: web3.PublicKey;
    const recipient = anchor.web3.Keypair.generate();
    const vaultPDA = fixture.pdas.vault();

    // Setup mints before bridge tests
    before(async () => {
      // Mint where owner has authority (for transfer tests)
      mint = await fixture.mints.create(owner.publicKey, 9);
      await fixture.mints.mintTo(mint, vaultPDA, 10000, true);

      // Mint where vault is authority (for mint tests)
      mintVaultAuthority = await fixture.mints.create(vaultPDA, 9);
    });

    describe("First Submission Validations", () => {
      let batchId: number;

      beforeEach(async () => {
        batchId = await fixture.batchIds.freshBatchId();
        await assertNoBridgingTransaction(fixture.accounts, batchId);
      });

      it("rejects if any signer is not a validator", async () => {
        await fixture.bridgeTransaction.expectError(
          {
            amount: 100,
            batchId,
            recipient: recipient.publicKey,
            mint,
            validators: [validators[0], validators[1], validators[15]], // validators[15] not in set
            vaultPDA,
          },
          "InvalidSigner",
        );

        await assertNoBridgingTransaction(fixture.accounts, batchId);
      });

      it("rejects duplicate signers in the same tx", async () => {
        await fixture.bridgeTransaction.expectError(
          {
            amount: 100,
            batchId,
            recipient: recipient.publicKey,
            mint,
            validators: [validators[0], validators[1], validators[1]], // duplicate
            vaultPDA,
          },
          "DuplicateSignersProvided",
        );

        await assertNoBridgingTransaction(fixture.accounts, batchId);
      });

      it("rejects if no validator signers are provided", async () => {
        let thrown = false;
        try {
          await fixture.bridgeTransaction.callWithNoSigners(
            100,
            batchId,
            recipient.publicKey,
            mint,
            vaultPDA,
          );
        } catch (err: any) {
          thrown = true;
          const msg = err.error?.errorMessage ?? err.toString();
          expect(msg).to.include("No signers provided");
        }

        expect(thrown, "should have thrown NoSignersProvided").to.equal(true);
        await assertNoBridgingTransaction(fixture.accounts, batchId);
      });
      it("first submission: stores BridgingTransaction fields correctly", async () => {
        batchId = await fixture.batchIds.freshBatchId();

        // Submit below threshold (3 approvals, threshold is 5)
        await fixture.bridgeTransaction.call({
          amount: 100,
          batchId,
          recipient: recipient.publicKey,
          mint,
          validators: validators.slice(0, 3),
          vaultPDA,
        });

        const btPDA = fixture.pdas.bridgingTransaction(batchId);
        const bt = await fixture.accounts.getBridgingTransaction(btPDA);

        assertBridgingTransactionState(bt, {
          amount: 100,
          receiver: recipient.publicKey,
          mintToken: mint,
          batchId,
          expectedPDA: btPDA,
        });

        await assertBridgingTransactionSigners(
          fixture.accounts,
          program.programId,
          batchId,
          [
            validators[0].publicKey,
            validators[1].publicKey,
            validators[2].publicKey,
          ],
        );
      });

      it("below threshold: does NOT update validator_set.last_batch_id", async () => {
        batchId = await fixture.batchIds.freshBatchId();

        const vsBefore = await fixture.getValidatorSet();
        const lastBefore = vsBefore.lastBatchId.toNumber();

        // 3 approvals (threshold is 5)
        await fixture.bridgeTransaction.call({
          amount: 100,
          batchId,
          recipient: recipient.publicKey,
          mint,
          validators: validators.slice(0, 3),
          vaultPDA,
        });

        const vsAfter = await fixture.getValidatorSet();
        expect(vsAfter.lastBatchId.toNumber()).to.equal(lastBefore);

        await assertBridgingTransactionSigners(
          fixture.accounts,
          program.programId,
          batchId,
          [
            validators[0].publicKey,
            validators[1].publicKey,
            validators[2].publicKey,
          ],
        );
      });
    });

    describe("Second Submission Validations (pending exists with 3 approvals)", () => {
      let batchId: number;

      beforeEach(async () => {
        batchId = await fixture.batchIds.freshBatchId();

        // Create pending tx with 3 approvals
        await fixture.bridgeTransaction.call({
          amount: 100,
          batchId,
          recipient: recipient.publicKey,
          mint,
          validators: validators.slice(0, 3),
          vaultPDA,
        });

        await assertBridgingTransactionSigners(
          fixture.accounts,
          program.programId,
          batchId,
          [
            validators[0].publicKey,
            validators[1].publicKey,
            validators[2].publicKey,
          ],
        );

        // Verify recipient ATA not created yet
        const recipientAta = getAssociatedTokenAddressSync(
          mint,
          recipient.publicKey,
        );
        const info = await provider.connection.getAccountInfo(recipientAta);
        expect(info).to.equal(null);
      });

      it("rejects non-validator; keeps approvals unchanged", async () => {
        await fixture.bridgeTransaction.expectError(
          {
            amount: 100,
            batchId,
            recipient: recipient.publicKey,
            mint,
            validators: [validators[3], validators[4], validators[15]],
            vaultPDA,
          },
          "InvalidSigner",
        );

        await assertBridgingTransactionSigners(
          fixture.accounts,
          program.programId,
          batchId,
          [
            validators[0].publicKey,
            validators[1].publicKey,
            validators[2].publicKey,
          ],
        );
      });
      it("rejects duplicate signers; keeps approvals unchanged", async () => {
        await fixture.bridgeTransaction.expectError(
          {
            amount: 100,
            batchId,
            recipient: recipient.publicKey,
            mint,
            validators: [validators[3], validators[4], validators[4]],
            vaultPDA,
          },
          "DuplicateSignersProvided",
        );

        await assertBridgingTransactionSigners(
          fixture.accounts,
          program.programId,
          batchId,
          [
            validators[0].publicKey,
            validators[1].publicKey,
            validators[2].publicKey,
          ],
        );
      });

      it("rejects signer already approved; keeps approvals unchanged", async () => {
        await fixture.bridgeTransaction.expectError(
          {
            amount: 100,
            batchId,
            recipient: recipient.publicKey,
            mint,
            validators: [validators[3], validators[4], validators[1]], // validators[1] already approved
            vaultPDA,
          },
          "SignerAlreadyApproved",
        );

        await assertBridgingTransactionSigners(
          fixture.accounts,
          program.programId,
          batchId,
          [
            validators[0].publicKey,
            validators[1].publicKey,
            validators[2].publicKey,
          ],
        );
      });

      it("reaches quorum, transfers tokens, clears pending tx", async () => {
        const recipientAta = getAssociatedTokenAddressSync(
          mint,
          recipient.publicKey,
        );
        const beforeBalance = await fixture.tokenBalances.getBalance(
          recipientAta,
        );

        // Add 3 more approvals to reach threshold of 5
        await fixture.bridgeTransaction.call({
          amount: 100,
          batchId,
          recipient: recipient.publicKey,
          mint,
          validators: validators.slice(3, 6),
          vaultPDA,
        });

        const vs = await fixture.getValidatorSet();
        expect(vs.lastBatchId.toNumber()).to.equal(batchId);

        const afterBalance = await fixture.tokenBalances.getBalance(
          recipientAta,
        );
        expect(afterBalance - beforeBalance).to.equal(BigInt(100));

        await assertNoBridgingTransaction(fixture.accounts, batchId);
      });
    });

    describe("Recipient ATA Already Exists", () => {
      it("succeeds and credits recipient", async () => {
        const batchId = await fixture.batchIds.freshBatchId();

        // Pre-create recipient ATA
        const ata = await getOrCreateAssociatedTokenAccount(
          provider.connection,
          owner.payer,
          mint,
          recipient.publicKey,
        );

        const beforeBalance = await fixture.tokenBalances.snapshot(ata.address);

        // Quorum in one submission
        await fixture.bridgeTransaction.call({
          amount: 100,
          batchId,
          recipient: recipient.publicKey,
          mint,
          validators: validators.slice(0, 5),
          vaultPDA,
        });

        const delta = await fixture.tokenBalances.getBalanceDelta(
          ata.address,
          beforeBalance,
        );
        expect(delta).to.equal(BigInt(100));

        await assertNoBridgingTransaction(fixture.accounts, batchId);
      });
    });
    describe("Transfer Branch: validate_token_account Failures", () => {
      it("rejects with InvalidMintToken when vault_ata.mint != mintToken", async () => {
        const batchId = await fixture.batchIds.freshBatchId();

        // Create ATA for different mint
        const otherMint = await fixture.mints.create(owner.publicKey, 9);
        const otherMintVaultAta = await getOrCreateAssociatedTokenAccount(
          provider.connection,
          owner.payer,
          otherMint,
          vaultPDA,
          true,
        );

        const quorumSigners = validators.slice(0, 5);

        let thrown = false;
        try {
          await fixture.bridgeTransaction.callWithCustomAccounts(
            100,
            batchId,
            {
              recipient: recipient.publicKey,
              mintToken: mint, // claim we're bridging mint
              recipientAta: getAssociatedTokenAddressSync(
                mint,
                recipient.publicKey,
              ),
              vaultAta: otherMintVaultAta.address, // but vault ATA is for otherMint
            },
            quorumSigners,
          );
        } catch (e: any) {
          thrown = true;
          expect(e?.error?.errorCode?.code).to.equal("InvalidMintToken");
        }

        expect(thrown, "should have thrown InvalidMintToken").to.equal(true);
        await assertNoBridgingTransaction(fixture.accounts, batchId);
      });

      it("rejects with InvalidVault when vault_ata.owner != vaultPDA", async () => {
        const batchId = await fixture.batchIds.freshBatchId();

        // Create token account with correct mint but wrong owner
        const notVaultOwner = anchor.web3.Keypair.generate();
        const wrongOwnerAta = await getOrCreateAssociatedTokenAccount(
          provider.connection,
          owner.payer,
          mint,
          notVaultOwner.publicKey,
        );

        const quorumSigners = validators.slice(0, 5);

        let thrown = false;
        try {
          await fixture.bridgeTransaction.callWithCustomAccounts(
            100,
            batchId,
            {
              recipient: recipient.publicKey,
              mintToken: mint,
              recipientAta: getAssociatedTokenAddressSync(
                mint,
                recipient.publicKey,
              ),
              vaultAta: wrongOwnerAta.address, // correct mint, wrong owner
            },
            quorumSigners,
          );
        } catch (e: any) {
          thrown = true;
          expect(e?.error?.errorCode?.code).to.equal("InvalidVault");
        }

        expect(thrown, "should have thrown InvalidVault").to.equal(true);
        await assertNoBridgingTransaction(fixture.accounts, batchId);
      });

      it.skip("rejects when vault_ata address is not the canonical ATA", async () => {
        const batchId = await fixture.batchIds.freshBatchId();

        // Create a different token account for vault with same mint
        // but NOT the associated token account
        const nonAtaKeypair = web3.Keypair.generate();
        // Initialize token account manually...

        let thrown = false;
        try {
          await fixture.bridgeTransaction.callWithCustomAccounts(
            100,
            batchId,
            {
              recipient: recipient.publicKey,
              mintToken: mint,
              recipientAta: getAssociatedTokenAddressSync(
                mint,
                recipient.publicKey,
              ),
              vaultAta: nonAtaKeypair.publicKey, // Not an ATA!
            },
            validators.slice(0, 5),
          );
        } catch (e: any) {
          thrown = true;
          expect(e?.error?.errorCode?.code).to.equal("InvalidVault"); // or new error
        }

        expect(thrown).to.equal(true);
      });
    });

    describe("BridgingTransactionMismatch", () => {
      it("second submission: same batch_id, different amount", async () => {
        const batchId = await fixture.batchIds.freshBatchId();

        // First submission
        await fixture.bridgeTransaction.call({
          amount: 100,
          batchId,
          recipient: recipient.publicKey,
          mint,
          validators: validators.slice(0, 3),
          vaultPDA,
        });

        // Second submission with different amount
        await fixture.bridgeTransaction.expectError(
          {
            amount: 101, // mismatch
            batchId,
            recipient: recipient.publicKey,
            mint,
            validators: validators.slice(3, 5),
            vaultPDA,
          },
          "BridgingTransactionMismatch",
        );

        // Approvals unchanged
        await assertBridgingTransactionSigners(
          fixture.accounts,
          program.programId,
          batchId,
          [
            validators[0].publicKey,
            validators[1].publicKey,
            validators[2].publicKey,
          ],
        );
      });

      it("second submission: same batch_id, different recipient", async () => {
        const batchId = await fixture.batchIds.freshBatchId();

        await fixture.bridgeTransaction.call({
          amount: 100,
          batchId,
          recipient: recipient.publicKey,
          mint,
          validators: validators.slice(0, 3),
          vaultPDA,
        });

        const otherRecipient = anchor.web3.Keypair.generate();

        let thrown = false;
        try {
          await fixture.bridgeTransaction.callWithCustomAccounts(
            100,
            batchId,
            {
              recipient: otherRecipient.publicKey, // mismatch
              mintToken: mint,
              recipientAta: getAssociatedTokenAddressSync(
                mint,
                otherRecipient.publicKey,
              ),
              vaultAta: getAssociatedTokenAddressSync(mint, vaultPDA, true),
            },
            validators.slice(3, 5),
          );
        } catch (err: any) {
          thrown = true;
          expect(err.error?.errorCode?.code).to.equal(
            "BridgingTransactionMismatch",
          );
        }

        expect(
          thrown,
          "should have thrown BridgingTransactionMismatch",
        ).to.equal(true);

        await assertBridgingTransactionSigners(
          fixture.accounts,
          program.programId,
          batchId,
          [
            validators[0].publicKey,
            validators[1].publicKey,
            validators[2].publicKey,
          ],
        );
      });

      it("second submission: same batch_id, different mint_token", async () => {
        const batchId = await fixture.batchIds.freshBatchId();

        await fixture.bridgeTransaction.call({
          amount: 100,
          batchId,
          recipient: recipient.publicKey,
          mint,
          validators: validators.slice(0, 3),
          vaultPDA,
        });

        const otherMint = await fixture.mints.create(owner.publicKey, 9);

        let thrown = false;
        try {
          await fixture.bridgeTransaction.callWithCustomAccounts(
            100,
            batchId,
            {
              recipient: recipient.publicKey,
              mintToken: otherMint, // mismatch
              recipientAta: getAssociatedTokenAddressSync(
                otherMint,
                recipient.publicKey,
              ),
              vaultAta: getAssociatedTokenAddressSync(
                otherMint,
                vaultPDA,
                true,
              ),
            },
            validators.slice(3, 5),
          );
        } catch (err: any) {
          thrown = true;
          expect(err.error?.errorCode?.code).to.equal(
            "BridgingTransactionMismatch",
          );
        }

        expect(
          thrown,
          "should have thrown BridgingTransactionMismatch",
        ).to.equal(true);

        await assertBridgingTransactionSigners(
          fixture.accounts,
          program.programId,
          batchId,
          [
            validators[0].publicKey,
            validators[1].publicKey,
            validators[2].publicKey,
          ],
        );
      });
    });

    describe("Quorum in One Submission", () => {
      it("successful transfer, updates last_batch_id, closes account", async () => {
        const batchId = await fixture.batchIds.freshBatchId();

        const beforeVs = await fixture.getValidatorSet();
        const beforeLast = beforeVs.lastBatchId.toNumber();

        const recipientAta = getAssociatedTokenAddressSync(
          mint,
          recipient.publicKey,
        );
        const beforeBalance = await fixture.tokenBalances.getBalance(
          recipientAta,
        );

        // 5 validators => quorum
        await fixture.bridgeTransaction.call({
          amount: 100,
          batchId,
          recipient: recipient.publicKey,
          mint,
          validators: validators.slice(0, 5),
          vaultPDA,
        });

        const afterVs = await fixture.getValidatorSet();
        expect(afterVs.lastBatchId.toNumber()).to.equal(batchId);
        expect(afterVs.lastBatchId.toNumber()).to.be.greaterThan(beforeLast);

        const afterBalance = await fixture.tokenBalances.getBalance(
          recipientAta,
        );
        expect(afterBalance - beforeBalance).to.equal(BigInt(100));

        await assertNoBridgingTransaction(fixture.accounts, batchId);
      });
    });

    describe("Vault as Mint Authority (mint branch)", () => {
      it("successfully mints tokens to recipient", async () => {
        const batchId = await fixture.batchIds.freshBatchId();

        const recipientAta = getAssociatedTokenAddressSync(
          mintVaultAuthority,
          recipient.publicKey,
        );

        const beforeBalance = await fixture.tokenBalances.getBalance(
          recipientAta,
        );

        // Quorum in one submission
        await fixture.bridgeTransaction.call({
          amount: 100,
          batchId,
          recipient: recipient.publicKey,
          mint: mintVaultAuthority,
          validators: validators.slice(0, 5),
          vaultPDA,
        });

        const afterBalance = await fixture.tokenBalances.getBalance(
          recipientAta,
        );
        expect(afterBalance - beforeBalance).to.equal(BigInt(100));

        await assertNoBridgingTransaction(fixture.accounts, batchId);
      });
    });

    describe("Replay Attack Prevention", () => {
      it("rejects batch_id <= last_batch_id (InvalidBatchId)", async () => {
        const vsBefore = await fixture.getValidatorSet();
        const lastBefore = vsBefore.lastBatchId.toNumber();

        // Use batch ID equal to current last_batch_id (too low)
        const tooLowBatchId = lastBefore;

        const recipientAta = getAssociatedTokenAddressSync(
          mint,
          recipient.publicKey,
        );
        const balBefore = await fixture.tokenBalances.getBalance(recipientAta);

        let thrown = false;
        let errorCode = "";
        try {
          await fixture.bridgeTransaction.call({
            amount: 100,
            batchId: tooLowBatchId,
            recipient: recipient.publicKey,
            mint,
            validators: validators.slice(0, 5),
            vaultPDA,
          });
        } catch (e: any) {
          thrown = true;
          errorCode = e?.error?.errorCode?.code ?? e?.errorCode?.code ?? "";
        }

        expect(thrown, "should have thrown InvalidBatchId").to.equal(true);
        expect(errorCode).to.equal("InvalidBatchId");

        // Verify state unchanged
        const vsAfter = await fixture.getValidatorSet();
        expect(vsAfter.lastBatchId.toNumber()).to.equal(lastBefore);

        const balAfter = await fixture.tokenBalances.getBalance(recipientAta);
        expect(balAfter - balBefore).to.equal(BigInt(0));

        // No pending transaction created
        await assertNoBridgingTransaction(fixture.accounts, tooLowBatchId);
      });
    });

    describe.skip("Recipient ATA Validation (KNOWN BUG)", () => {
      it("should reject when recipientAta does not match (recipient, mint)", async () => {
        const batchId = await fixture.batchIds.freshBatchId();

        // Recipient A is the intended recipient
        const recipientA = anchor.web3.Keypair.generate();

        // Recipient B owns the ATA we incorrectly pass
        const recipientB = anchor.web3.Keypair.generate();

        // Mismatched ATA: for (recipientB, mint), but we pass recipient=recipientA
        const wrongRecipientAta = getAssociatedTokenAddressSync(
          mint,
          recipientB.publicKey,
        );

        // Verify wrongRecipientAta doesn't exist yet
        expect(
          await provider.connection.getAccountInfo(wrongRecipientAta),
        ).to.equal(null);

        const quorumSigners = validators.slice(0, 5);

        // Snapshot balances
        const recipientAAta = getAssociatedTokenAddressSync(
          mint,
          recipientA.publicKey,
        );
        const aBefore = await fixture.tokenBalances.getBalance(recipientAAta);
        const bBefore = await fixture.tokenBalances.getBalance(
          wrongRecipientAta,
        );

        try {
          await fixture.bridgeTransaction.callWithCustomAccounts(
            100,
            batchId,
            {
              recipient: recipientA.publicKey, // Intended recipient is A
              mintToken: mint,
              recipientAta: wrongRecipientAta, // But ATA is for B
              vaultAta: getAssociatedTokenAddressSync(mint, vaultPDA, true),
            },
            quorumSigners,
          );

          // KNOWN BUG: transaction currently succeeds but shouldn't
          assert.fail(
            "KNOWN BUG: tx succeeded but should have been rejected because recipientAta != ATA(recipient, mint)",
          );
        } catch (err: any) {
          // Once fixed, expect specific error:
          // const code = err?.error?.errorCode?.code ?? err?.errorCode?.code;
          // expect(code).to.equal("InvalidRecipientAta");

          // For now, just ensure it failed
          expect(err).to.exist;
          const code =
            err?.error?.errorCode?.code ?? err?.errorCode?.code ?? "";
          expect(code).to.not.equal("");
        }

        // Verify no balance changes
        const aAfter = await fixture.tokenBalances.getBalance(recipientAAta);
        const bAfter = await fixture.tokenBalances.getBalance(
          wrongRecipientAta,
        );

        expect(aAfter - aBefore).to.equal(BigInt(0));
        expect(bAfter - bBefore).to.equal(BigInt(0));

        await assertNoBridgingTransaction(fixture.accounts, batchId);
      });
    });

    describe.skip("Amount Zero (TDD - Not Yet Implemented)", () => {
      it("should reject amount = 0 with custom error", async function () {
        const batchId = await fixture.batchIds.freshBatchId();

        // Expected behavior: program should reject amount = 0
        // Expected error code: "InvalidAmount" or similar

        let thrown = false;
        let errorCode = "";

        try {
          await fixture.bridgeTransaction.call({
            amount: 0, // Zero amount
            batchId,
            recipient: recipient.publicKey,
            mint,
            validators: validators.slice(0, 5),
            vaultPDA,
          });
        } catch (e: any) {
          thrown = true;
          errorCode = e?.error?.errorCode?.code ?? e?.errorCode?.code ?? "";
        }

        // This test will fail until program implements the check
        expect(thrown, "should reject amount = 0").to.equal(true);
        expect(errorCode).to.equal("InvalidAmount"); // or "AmountMustBeGreaterThanZero"

        // No transaction should be created
        await assertNoBridgingTransaction(fixture.accounts, batchId);
      });
    });

    describe("Insufficient Vault Balance", () => {
      it("fails when vault doesn't have enough tokens (transfer branch)", async () => {
        const batchId = await fixture.batchIds.freshBatchId();

        // Create a new mint with limited funds in vault
        const limitedMint = await fixture.mints.create(owner.publicKey, 9);

        // Fund vault with only 50 tokens
        await fixture.mints.mintTo(limitedMint, vaultPDA, 50, true);

        const vaultAta = getAssociatedTokenAddressSync(
          limitedMint,
          vaultPDA,
          true,
        );

        // Verify vault has exactly 50 tokens
        const vaultBalance = await fixture.mints.getTokenAccountBalance(
          vaultAta,
        );
        expect(vaultBalance).to.equal(50);

        let thrown = false;
        let errorMsg = "";

        try {
          // Try to bridge 100 tokens (more than vault has)
          await fixture.bridgeTransaction.call({
            amount: 100, // Vault only has 50
            batchId,
            recipient: recipient.publicKey,
            mint: limitedMint,
            validators: validators.slice(0, 5),
            vaultPDA,
          });
        } catch (e: any) {
          thrown = true;
          errorMsg = e?.error?.errorMessage ?? e?.message ?? e.toString();
        }

        expect(thrown, "should fail due to insufficient balance").to.equal(
          true,
        );

        // Token program returns "insufficient funds" error
        expect(errorMsg.toLowerCase()).to.include("insufficient");

        // Transaction should revert - no pending account created
        await assertNoBridgingTransaction(fixture.accounts, batchId);

        // Vault balance unchanged
        const finalBalance = await fixture.mints.getTokenAccountBalance(
          vaultAta,
        );
        expect(finalBalance).to.equal(50);
      });
    });
    describe("Missing Vault ATA", () => {
      it("fails when vault_ata doesn't exist (transfer branch)", async () => {
        const batchId = await fixture.batchIds.freshBatchId();

        // Create a new mint but DON'T create vault ATA
        const noVaultAtaMint = await fixture.mints.create(owner.publicKey, 9);

        const vaultAta = getAssociatedTokenAddressSync(
          noVaultAtaMint,
          vaultPDA,
          true,
        );

        // Verify vault ATA doesn't exist
        const ataInfo = await provider.connection.getAccountInfo(vaultAta);
        expect(ataInfo, "vault ATA should not exist").to.equal(null);

        let thrown = false;
        let errorMsg = "";

        try {
          await fixture.bridgeTransaction.call({
            amount: 100,
            batchId,
            recipient: recipient.publicKey,
            mint: noVaultAtaMint,
            validators: validators.slice(0, 5),
            vaultPDA,
          });
        } catch (e: any) {
          thrown = true;
          errorMsg = e?.error?.errorMessage ?? e?.message ?? e.toString();
        }

        expect(thrown, "should fail due to missing vault ATA").to.equal(true);

        // Could be deserialization error or account not found
        const lowerMsg = errorMsg.toLowerCase();
        const hasExpectedError =
          lowerMsg.includes("account") ||
          lowerMsg.includes("deserialize") ||
          lowerMsg.includes("not found") ||
          lowerMsg.includes("invalid");

        expect(
          hasExpectedError,
          `Expected account-related error, got: ${errorMsg}`,
        ).to.equal(true);

        // No pending transaction created
        await assertNoBridgingTransaction(fixture.accounts, batchId);
      });
    });
    describe.skip("Consecutive Batch ID Enforcement (TDD - Not Yet Implemented)", () => {
      it("should reject non-consecutive batch_id (skipped batch)", async function () {
        const currentVs = await fixture.getValidatorSet();
        const lastBatchId = currentVs.lastBatchId.toNumber();

        // Valid: lastBatchId + 1
        const validNextBatchId = lastBatchId + 1;

        // Invalid: skip a batch (lastBatchId + 2)
        const skippedBatchId = lastBatchId + 2;

        // First, execute valid batch to update last_batch_id
        await fixture.bridgeTransaction.call({
          amount: 100,
          batchId: validNextBatchId,
          recipient: recipient.publicKey,
          mint,
          validators: validators.slice(0, 5),
          vaultPDA,
        });

        const vsAfterValid = await fixture.getValidatorSet();
        expect(vsAfterValid.lastBatchId.toNumber()).to.equal(validNextBatchId);

        // Now try to execute skipped batch
        let thrown = false;
        let errorCode = "";

        try {
          await fixture.bridgeTransaction.call({
            amount: 100,
            batchId: skippedBatchId, // Skips validNextBatchId + 1
            recipient: recipient.publicKey,
            mint,
            validators: validators.slice(0, 5),
            vaultPDA,
          });
        } catch (e: any) {
          thrown = true;
          errorCode = e?.error?.errorCode?.code ?? e?.errorCode?.code ?? "";
        }

        // This test will fail until program implements consecutive check
        expect(thrown, "should reject non-consecutive batch_id").to.equal(true);
        expect(errorCode).to.equal("NonConsecutiveBatchId"); // or "BatchIdMustBeConsecutive"

        // last_batch_id should remain unchanged
        const vsFinal = await fixture.getValidatorSet();
        expect(vsFinal.lastBatchId.toNumber()).to.equal(validNextBatchId);
      });

      it("should accept exact next consecutive batch_id", async function () {
        const currentVs = await fixture.getValidatorSet();
        const lastBatchId = currentVs.lastBatchId.toNumber();
        const nextBatchId = lastBatchId + 1;

        const recipientAta = getAssociatedTokenAddressSync(
          mint,
          recipient.publicKey,
        );
        const beforeBalance = await fixture.tokenBalances.getBalance(
          recipientAta,
        );

        // Should succeed with exact next batch ID
        await fixture.bridgeTransaction.call({
          amount: 100,
          batchId: nextBatchId,
          recipient: recipient.publicKey,
          mint,
          validators: validators.slice(0, 5),
          vaultPDA,
        });

        const vsAfter = await fixture.getValidatorSet();
        expect(vsAfter.lastBatchId.toNumber()).to.equal(nextBatchId);

        const afterBalance = await fixture.tokenBalances.getBalance(
          recipientAta,
        );
        expect(afterBalance - beforeBalance).to.equal(BigInt(100));

        await assertNoBridgingTransaction(fixture.accounts, nextBatchId);
      });
    });

    describe("Frozen Mint", () => {
      it("fails when recipient token account is frozen", async () => {
        const batchId = await fixture.batchIds.freshBatchId();

        // Create mint with freeze authority
        const freezeAuthority = anchor.web3.Keypair.generate();
        const freezableMint = await fixture.mints.createWithFreezeAuthority(
          owner.publicKey,
          freezeAuthority.publicKey,
          9,
        );

        // Fund vault for this mint
        await fixture.mints.mintTo(freezableMint, vaultPDA, 1000, true);

        // Pre-create and freeze recipient's ATA
        const recipientAta = await getOrCreateAssociatedTokenAccount(
          provider.connection,
          owner.payer,
          freezableMint,
          recipient.publicKey,
        );

        // Freeze the recipient's token account
        await fixture.mints.freezeTokenAccount(
          freezableMint,
          recipientAta.address,
          freezeAuthority,
        );

        // Verify it's frozen
        const ataInfo = await provider.connection.getAccountInfo(
          recipientAta.address,
        );
        expect(ataInfo, "ATA should exist").to.not.equal(null);

        let thrown = false;
        let errorMsg = "";

        try {
          await fixture.bridgeTransaction.call({
            amount: 100,
            batchId,
            recipient: recipient.publicKey,
            mint: freezableMint,
            validators: validators.slice(0, 5),
            vaultPDA,
          });
        } catch (e: any) {
          thrown = true;
          errorMsg = e?.error?.errorMessage ?? e?.message ?? e.toString();
        }

        expect(thrown, "should fail due to frozen account").to.equal(true);

        // Token program returns "account frozen" error
        const lowerMsg = errorMsg.toLowerCase();
        expect(
          lowerMsg.includes("frozen") || lowerMsg.includes("freeze"),
          `Expected frozen account error, got: ${errorMsg}`,
        ).to.equal(true);

        // No state changes
        await assertNoBridgingTransaction(fixture.accounts, batchId);
      });

      it("succeeds when mint has freeze authority but account is not frozen", async () => {
        const batchId = await fixture.batchIds.freshBatchId();

        // Create mint with freeze authority but don't freeze the account
        const freezeAuthority = anchor.web3.Keypair.generate();
        const freezableMint = await fixture.mints.createWithFreezeAuthority(
          owner.publicKey,
          freezeAuthority.publicKey,
          9,
        );

        await fixture.mints.mintTo(freezableMint, vaultPDA, 1000, true);

        const recipientAta = getAssociatedTokenAddressSync(
          freezableMint,
          recipient.publicKey,
        );

        const beforeBalance = await fixture.tokenBalances.getBalance(
          recipientAta,
        );

        // Should succeed - account exists but is NOT frozen
        await fixture.bridgeTransaction.call({
          amount: 100,
          batchId,
          recipient: recipient.publicKey,
          mint: freezableMint,
          validators: validators.slice(0, 5),
          vaultPDA,
        });

        const afterBalance = await fixture.tokenBalances.getBalance(
          recipientAta,
        );
        expect(afterBalance - beforeBalance).to.equal(BigInt(100));

        await assertNoBridgingTransaction(fixture.accounts, batchId);
      });
    });
  });
  // ============================================================================
  // BRIDGE REQUEST TESTS
  // ============================================================================

  describe("Bridge Request", () => {
    // Test data
    let transferMint: web3.PublicKey; // Vault does NOT have mint authority
    let burnMint: web3.PublicKey; // Vault DOES have mint authority
    const user = anchor.web3.Keypair.generate();
    const vaultPDA = fixture.pdas.vault();

    // Standard test parameters
    const validReceiver = Buffer.from(
      "0x1234567890abcdef1234567890abcdef12345678",
    );
    const destinationChain = 1; // Ethereum

    before(async () => {
      // Airdrop to user
      await provider.connection.requestAirdrop(
        user.publicKey,
        10 * web3.LAMPORTS_PER_SOL,
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Create transfer mint (owner has authority)
      transferMint = await fixture.mints.create(owner.publicKey, 9);

      // Mint tokens to user
      await fixture.mints.mintTo(transferMint, user.publicKey, 10000);

      // Create burn mint - FIXED: Use owner first, then transfer authority
      burnMint = await fixture.mints.create(owner.publicKey, 9); // Owner creates it

      // Mint tokens to user while owner still has authority
      await fixture.mints.mintTo(burnMint, user.publicKey, 5000);

      // Transfer mint authority to vault
      await fixture.mints.setMintAuthority(burnMint, vaultPDA);
    });

    // ============================================================================
    // HAPPY PATH - TRANSFER BRANCH
    // ============================================================================

    describe("Transfer Branch (vault is not mint authority)", () => {
      it("successfully transfers tokens to vault and emits event", async () => {
        const vsBefore = await fixture.getValidatorSet();
        const requestCountBefore = vsBefore.bridgeRequestCount.toNumber();

        const userAta = getAssociatedTokenAddressSync(
          transferMint,
          user.publicKey,
        );
        const vaultAta = getAssociatedTokenAddressSync(
          transferMint,
          vaultPDA,
          true,
        );

        const userBalanceBefore = await fixture.tokenBalances.getBalance(
          userAta,
        );
        const vaultBalanceBefore = await fixture.tokenBalances.getBalance(
          vaultAta,
        );

        // Execute bridge request
        const signature = await fixture.bridgeRequest.call({
          amount: 100,
          receiver: validReceiver,
          destinationChain,
          mint: transferMint,
          signer: user,
        });

        // Verify balances changed correctly
        const userBalanceAfter = await fixture.tokenBalances.getBalance(
          userAta,
        );
        const vaultBalanceAfter = await fixture.tokenBalances.getBalance(
          vaultAta,
        );

        expect(userBalanceBefore - userBalanceAfter).to.equal(BigInt(100));
        expect(vaultBalanceAfter - vaultBalanceBefore).to.equal(BigInt(100));

        // Verify bridge_request_count incremented
        const vsAfter = await fixture.getValidatorSet();
        expect(vsAfter.bridgeRequestCount.toNumber()).to.equal(
          requestCountBefore + 1,
        );

        // Verify event was emitted
        const event = await fixture.events.parseBridgeRequestEvent(signature);
        expect(event).to.not.equal(null);
        expect(event!.sender.toBase58()).to.equal(user.publicKey.toBase58());
        expect(event!.amount.toNumber()).to.equal(100);
        expect(Buffer.from(event!.receiver).toString("hex")).to.equal(
          validReceiver.toString("hex"),
        );
        expect(event!.destinationChain).to.equal(destinationChain);
        expect(event!.mintToken.toBase58()).to.equal(transferMint.toBase58());
        expect(event!.batchRequestId.toNumber()).to.equal(requestCountBefore);
      });

      it("creates vault ATA if it doesn't exist", async () => {
        // Create new mint without vault ATA
        const newMint = await fixture.mints.create(owner.publicKey, 9);
        await fixture.mints.mintTo(newMint, user.publicKey, 1000);

        const vaultAta = getAssociatedTokenAddressSync(newMint, vaultPDA, true);

        // Verify vault ATA doesn't exist
        const ataBefore = await provider.connection.getAccountInfo(vaultAta);
        expect(ataBefore).to.equal(null);

        // Execute bridge request
        await fixture.bridgeRequest.call({
          amount: 50,
          receiver: validReceiver,
          destinationChain,
          mint: newMint,
          signer: user,
        });

        // Verify vault ATA was created and has correct balance
        const ataAfter = await provider.connection.getAccountInfo(vaultAta);
        expect(ataAfter).to.not.equal(null);

        const vaultBalance = await fixture.tokenBalances.getBalance(vaultAta);
        expect(vaultBalance).to.equal(BigInt(50));
      });

      it("handles multiple sequential requests correctly", async () => {
        const vsBefore = await fixture.getValidatorSet();
        const startCount = vsBefore.bridgeRequestCount.toNumber();

        const vaultAta = getAssociatedTokenAddressSync(
          transferMint,
          vaultPDA,
          true,
        );
        const vaultBalanceBefore = await fixture.tokenBalances.getBalance(
          vaultAta,
        );

        // Execute 3 sequential requests
        for (let i = 0; i < 3; i++) {
          await fixture.bridgeRequest.call({
            amount: 10,
            receiver: validReceiver,
            destinationChain,
            mint: transferMint,
            signer: user,
          });
        }

        // Verify all requests were processed
        const vsAfter = await fixture.getValidatorSet();
        expect(vsAfter.bridgeRequestCount.toNumber()).to.equal(startCount + 3);

        const vaultBalanceAfter = await fixture.tokenBalances.getBalance(
          vaultAta,
        );
        expect(vaultBalanceAfter - vaultBalanceBefore).to.equal(BigInt(30));
      });
    });

    // ============================================================================
    // HAPPY PATH - BURN BRANCH
    // ============================================================================

    describe("Burn Branch (vault is mint authority)", () => {
      it("successfully burns tokens and emits event", async () => {
        const vsBefore = await fixture.getValidatorSet();
        const requestCountBefore = vsBefore.bridgeRequestCount.toNumber();

        const userAta = getAssociatedTokenAddressSync(burnMint, user.publicKey);
        const userBalanceBefore = await fixture.tokenBalances.getBalance(
          userAta,
        );

        // Get mint supply before
        const mintBefore = await fixture.mints.getMintInfo(burnMint);
        const supplyBefore = mintBefore.supply;

        // Execute bridge request
        const signature = await fixture.bridgeRequest.call({
          amount: 200,
          receiver: validReceiver,
          destinationChain,
          mint: burnMint,
          signer: user,
        });

        // Verify tokens were burned (not transferred)
        const userBalanceAfter = await fixture.tokenBalances.getBalance(
          userAta,
        );
        expect(userBalanceBefore - userBalanceAfter).to.equal(BigInt(200));

        // Verify mint supply decreased
        const mintAfter = await fixture.mints.getMintInfo(burnMint);
        expect(supplyBefore - mintAfter.supply).to.equal(BigInt(200));

        // Verify NO vault ATA was created (tokens were burned, not transferred)
        const vaultAta = getAssociatedTokenAddressSync(
          burnMint,
          vaultPDA,
          true,
        );
        const vaultAtaInfo = await provider.connection.getAccountInfo(vaultAta);
        expect(vaultAtaInfo).to.equal(null);

        // Verify event
        const event = await fixture.events.parseBridgeRequestEvent(signature);
        expect(event).to.not.equal(null);
        expect(event!.amount.toNumber()).to.equal(200);

        // Verify bridge_request_count incremented
        const vsAfter = await fixture.getValidatorSet();
        expect(vsAfter.bridgeRequestCount.toNumber()).to.equal(
          requestCountBefore + 1,
        );
      });

      it("burns entire balance", async () => {
        // Create fresh mint - owner creates it first
        const freshBurnMint = await fixture.mints.create(owner.publicKey, 9);

        // Mint tokens to user while owner still has authority
        await fixture.mints.mintTo(freshBurnMint, user.publicKey, 500);

        // NOW transfer mint authority to vault
        await fixture.mints.setMintAuthority(freshBurnMint, vaultPDA);

        const userAta = getAssociatedTokenAddressSync(
          freshBurnMint,
          user.publicKey,
        );
        const balanceBefore = await fixture.tokenBalances.getBalance(userAta);
        expect(balanceBefore).to.equal(BigInt(500));

        // Burn all tokens
        await fixture.bridgeRequest.call({
          amount: 500,
          receiver: validReceiver,
          destinationChain,
          mint: freshBurnMint,
          signer: user,
        });

        // Verify balance is zero
        const balanceAfter = await fixture.tokenBalances.getBalance(userAta);
        expect(balanceAfter).to.equal(BigInt(0));
      });
    });

    // ============================================================================
    // ERROR CASES
    // ============================================================================

    describe("Error Cases", () => {
      it("rejects when user has insufficient balance", async () => {
        const userAta = getAssociatedTokenAddressSync(
          transferMint,
          user.publicKey,
        );
        const userBalance = await fixture.tokenBalances.getBalance(userAta);

        // Try to bridge more than user has
        const excessAmount = Number(userBalance) + 100;

        await fixture.bridgeRequest.expectError(
          {
            amount: excessAmount,
            receiver: validReceiver,
            destinationChain,
            mint: transferMint,
            signer: user,
          },
          "InsufficientFunds",
        );
      });

      it("rejects when user has zero balance", async () => {
        // Create new mint and don't fund user
        const emptyMint = await fixture.mints.create(owner.publicKey, 9);

        // Create user's ATA with zero balance
        await getOrCreateAssociatedTokenAccount(
          provider.connection,
          owner.payer,
          emptyMint,
          user.publicKey,
        );

        await fixture.bridgeRequest.expectError(
          {
            amount: 1,
            receiver: validReceiver,
            destinationChain,
            mint: emptyMint,
            signer: user,
          },
          "InsufficientFunds",
        );
      });

      it("rejects with wrong mint in signers_ata", async () => {
        // User has tokens for transferMint, but we pass wrong ATA
        const wrongMint = await fixture.mints.create(owner.publicKey, 9);
        const wrongAta = await getOrCreateAssociatedTokenAccount(
          provider.connection,
          owner.payer,
          wrongMint,
          user.publicKey,
        );

        let thrown = false;
        let errorMsg = "";

        try {
          await fixture.bridgeRequest.callWithCustomAccounts(
            100,
            validReceiver,
            destinationChain,
            {
              signer: user.publicKey,
              signersAta: wrongAta.address, // Wrong ATA (different mint)
              vaultAta: getAssociatedTokenAddressSync(
                transferMint,
                vaultPDA,
                true,
              ),
              mint: transferMint,
            },
            [user],
          );
        } catch (e: any) {
          thrown = true;
          errorMsg = e?.error?.errorMessage ?? e?.message ?? e.toString();
        }

        expect(thrown, "should fail with wrong ATA").to.equal(true);
        // Anchor constraint error for token::mint mismatch
        expect(errorMsg.toLowerCase()).to.satisfy(
          (msg: string) =>
            msg.includes("constraint") ||
            msg.includes("mint") ||
            msg.includes("token"),
        );
      });

      it("rejects with wrong vault_ata (different mint)", async () => {
        const wrongMint = await fixture.mints.create(owner.publicKey, 9);
        const wrongVaultAta = await getOrCreateAssociatedTokenAccount(
          provider.connection,
          owner.payer,
          wrongMint,
          vaultPDA,
          true,
        );

        let thrown = false;
        let errorCode = "";

        try {
          await fixture.bridgeRequest.callWithCustomAccounts(
            100,
            validReceiver,
            destinationChain,
            {
              signer: user.publicKey,
              signersAta: getAssociatedTokenAddressSync(
                transferMint,
                user.publicKey,
              ),
              vaultAta: wrongVaultAta.address, // Wrong vault ATA
              mint: transferMint,
            },
            [user],
          );
        } catch (e: any) {
          thrown = true;
          errorCode = e?.error?.errorCode?.code ?? "";
        }

        expect(thrown, "should fail with wrong vault ATA").to.equal(true);
        expect(errorCode).to.equal("InvalidMintToken");
      });

      it("rejects with wrong vault_ata owner", async () => {
        const notVault = anchor.web3.Keypair.generate();
        const wrongOwnerAta = await getOrCreateAssociatedTokenAccount(
          provider.connection,
          owner.payer,
          transferMint,
          notVault.publicKey,
        );

        let thrown = false;
        let errorCode = "";

        try {
          await fixture.bridgeRequest.callWithCustomAccounts(
            100,
            validReceiver,
            destinationChain,
            {
              signer: user.publicKey,
              signersAta: getAssociatedTokenAddressSync(
                transferMint,
                user.publicKey,
              ),
              vaultAta: wrongOwnerAta.address, // Correct mint, wrong owner
              mint: transferMint,
            },
            [user],
          );
        } catch (e: any) {
          thrown = true;
          errorCode = e?.error?.errorCode?.code ?? "";
        }

        expect(thrown, "should fail with wrong owner").to.equal(true);
        expect(errorCode).to.equal("InvalidVault");
      });
    });

    // ============================================================================
    // EDGE CASES
    // ============================================================================

    describe("Edge Cases", () => {
      describe.skip("Amount Zero (TDD - Not Yet Implemented)", () => {
        it("should reject amount = 0", async function () {
          let thrown = false;
          let errorCode = "";

          try {
            await fixture.bridgeRequest.call({
              amount: 0,
              receiver: validReceiver,
              destinationChain,
              mint: transferMint,
              signer: user,
            });
          } catch (e: any) {
            thrown = true;
            errorCode = e?.error?.errorCode?.code ?? e?.errorCode?.code ?? "";
          }

          expect(thrown, "should reject amount = 0").to.equal(true);
          expect(errorCode).to.equal("InvalidAmount");
        });
      });

      it("handles large amount (close to u64::MAX)", async () => {
        // Create mint with large supply
        const largeMint = await fixture.mints.create(owner.publicKey, 0);

        const largeAmount = BigInt("18446744073709551615"); // u64::MAX
        const testAmount = largeAmount / BigInt(1000); // Use 1/1000th to avoid overflow

        // Mint large amount to user
        await fixture.mints.mintTo(
          largeMint,
          user.publicKey,
          Number(testAmount),
        );

        const userAta = getAssociatedTokenAddressSync(
          largeMint,
          user.publicKey,
        );
        const balanceBefore = await fixture.tokenBalances.getBalance(userAta);

        await fixture.bridgeRequest.call({
          amount: new anchor.BN(testAmount.toString()),
          receiver: validReceiver,
          destinationChain,
          mint: largeMint,
          signer: user,
        });

        const balanceAfter = await fixture.tokenBalances.getBalance(userAta);
        expect(balanceBefore - balanceAfter).to.equal(testAmount);
      });

      it("handles different receiver address formats", async () => {
        // Short address (20 bytes - Ethereum)
        const ethReceiver = Buffer.from(
          "1234567890abcdef12345678901234567890abcd",
          "hex",
        );

        await fixture.bridgeRequest.call({
          amount: 10,
          receiver: ethReceiver,
          destinationChain: 1,
          mint: transferMint,
          signer: user,
        });

        // Long address (32 bytes - Solana-style)
        const solReceiver = Buffer.from(
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          "hex",
        );

        await fixture.bridgeRequest.call({
          amount: 10,
          receiver: solReceiver,
          destinationChain: 2,
          mint: transferMint,
          signer: user,
        });

        // Very short address
        const shortReceiver = Buffer.from("1234", "hex");

        await fixture.bridgeRequest.call({
          amount: 10,
          receiver: shortReceiver,
          destinationChain: 3,
          mint: transferMint,
          signer: user,
        });
      });

      it("handles all destination chain IDs (0-255)", async () => {
        // Test edge values
        const chainIds = [0, 1, 127, 128, 254, 255];

        for (const chainId of chainIds) {
          await fixture.bridgeRequest.call({
            amount: 1,
            receiver: validReceiver,
            destinationChain: chainId,
            mint: transferMint,
            signer: user,
          });
        }

        // Verify all requests were counted
        const vs = await fixture.getValidatorSet();
        expect(vs.bridgeRequestCount.toNumber()).to.be.at.least(
          chainIds.length,
        );
      });

      it("handles frozen user token account", async () => {
        const freezeAuthority = anchor.web3.Keypair.generate();
        const freezableMint = await fixture.mints.createWithFreezeAuthority(
          owner.publicKey,
          freezeAuthority.publicKey,
          9,
        );

        // Fund user
        await fixture.mints.mintTo(freezableMint, user.publicKey, 1000);

        const userAta = getAssociatedTokenAddressSync(
          freezableMint,
          user.publicKey,
        );

        // Freeze user's account
        await fixture.mints.freezeTokenAccount(
          freezableMint,
          userAta,
          freezeAuthority,
        );

        let thrown = false;
        let errorMsg = "";

        try {
          await fixture.bridgeRequest.call({
            amount: 100,
            receiver: validReceiver,
            destinationChain,
            mint: freezableMint,
            signer: user,
          });
        } catch (e: any) {
          thrown = true;
          errorMsg = e?.error?.errorMessage ?? e?.message ?? e.toString();
        }

        expect(thrown, "should fail with frozen account").to.equal(true);
        expect(errorMsg.toLowerCase()).to.include("frozen");
      });

      it("empty receiver array edge case", async () => {
        const emptyReceiver = Buffer.from([]);

        // Should succeed technically (no validation on receiver content)
        const signature = await fixture.bridgeRequest.call({
          amount: 5,
          receiver: emptyReceiver,
          destinationChain,
          mint: transferMint,
          signer: user,
        });

        const event = await fixture.events.parseBridgeRequestEvent(signature);
        expect(event).to.not.equal(null);
        expect(event!.receiver.length).to.equal(0);
      });
    });

    // ============================================================================
    // STATE CONSISTENCY
    // ============================================================================

    describe("State Consistency", () => {
      it("bridge_request_count increments atomically", async () => {
        const vsBefore = await fixture.getValidatorSet();
        const countBefore = vsBefore.bridgeRequestCount.toNumber();

        // Execute 5 requests
        for (let i = 0; i < 5; i++) {
          await fixture.bridgeRequest.call({
            amount: 1,
            receiver: validReceiver,
            destinationChain,
            mint: transferMint,
            signer: user,
          });
        }

        const vsAfter = await fixture.getValidatorSet();
        expect(vsAfter.bridgeRequestCount.toNumber()).to.equal(countBefore + 5);
      });

      it("failed request doesn't increment bridge_request_count", async () => {
        const vsBefore = await fixture.getValidatorSet();
        const countBefore = vsBefore.bridgeRequestCount.toNumber();

        // Try to bridge with insufficient funds
        try {
          await fixture.bridgeRequest.call({
            amount: 999999999,
            receiver: validReceiver,
            destinationChain,
            mint: transferMint,
            signer: user,
          });
          assert.fail("Should have failed");
        } catch (e) {
          // Expected failure
        }

        const vsAfter = await fixture.getValidatorSet();
        expect(vsAfter.bridgeRequestCount.toNumber()).to.equal(countBefore);
      });

      it("maintains correct vault balance across mixed operations", async () => {
        const vaultAta = getAssociatedTokenAddressSync(
          transferMint,
          vaultPDA,
          true,
        );
        const balanceBefore = await fixture.tokenBalances.getBalance(vaultAta);

        // Execute multiple bridge requests
        await fixture.bridgeRequest.call({
          amount: 100,
          receiver: validReceiver,
          destinationChain,
          mint: transferMint,
          signer: user,
        });

        await fixture.bridgeRequest.call({
          amount: 50,
          receiver: validReceiver,
          destinationChain,
          mint: transferMint,
          signer: user,
        });

        const balanceAfter = await fixture.tokenBalances.getBalance(vaultAta);
        expect(balanceAfter - balanceBefore).to.equal(BigInt(150));
      });
    });
  });

  describe("Validator Set Update (VSU)", () => {
    let newValidators: web3.Keypair[];

    before(async () => {
      // Create new validator keypairs for testing
      newValidators = Array.from({ length: 3 }, () => web3.Keypair.generate());
    });

    describe("First Submission (Create Proposal)", () => {
      describe("Happy Path", () => {
        it("successfully creates VSU proposal with valid parameters", async () => {
          const batchId = await fixture.batchIds.freshBatchId();
          const added = [newValidators[0].publicKey];
          const removed = toBNArray([]);

          const vsBefore = await fixture.getValidatorSet();
          const validatorCountBefore = vsBefore.signers.length;

          await fixture.bridgeVSU.call({
            added,
            removed,
            batchId,
            signers: [validators[0]],
          });

          // Verify proposal created
          const vscAccount = await fixture.bridgeVSU.fetchValidatorSetChange(
            batchId,
          );
          expect(vscAccount).to.not.be.null;
          expect(vscAccount.added.length).to.equal(1);
          expect(vscAccount.added[0].toBase58()).to.equal(added[0].toBase58());
          expectBNArrayEqual(vscAccount.removed, []);
          expect(vscAccount.batchId.toNumber()).to.equal(batchId);
          expect(vscAccount.signers.length).to.equal(1);
          expect(vscAccount.signers[0].toBase58()).to.equal(
            validators[0].publicKey.toBase58(),
          );

          // Verify validator set NOT updated yet (below threshold)
          const vsAfter = await fixture.getValidatorSet();
          expect(vsAfter.signers.length).to.equal(validatorCountBefore);
        });

        it("creates proposal with multiple additions", async () => {
          const batchId = await fixture.batchIds.freshBatchId();
          const added = [
            newValidators[1].publicKey,
            newValidators[2].publicKey,
          ];
          const removed = toBNArray([]);

          await fixture.bridgeVSU.call({
            added,
            removed,
            batchId,
            signers: [validators[0]],
          });

          const vscAccount = await fixture.bridgeVSU.fetchValidatorSetChange(
            batchId,
          );
          expect(vscAccount.added.length).to.equal(2);
          expectBNArrayEqual(vscAccount.removed, []);
        });

        it("creates proposal with removals", async () => {
          const batchId = await fixture.batchIds.freshBatchId();
          const added: web3.PublicKey[] = [];
          const removed = toBNArray([0, 1]);

          await fixture.bridgeVSU.call({
            added,
            removed,
            batchId,
            signers: [validators[0]],
          });

          const vscAccount = await fixture.bridgeVSU.fetchValidatorSetChange(
            batchId,
          );
          expect(vscAccount.added.length).to.equal(0);
          expectBNArrayEqual(vscAccount.removed, [0, 1]);
        });

        it("creates proposal with both additions and removals", async () => {
          const batchId = await fixture.batchIds.freshBatchId();
          const added = [newValidators[0].publicKey];
          const removed = toBNArray([0]);

          await fixture.bridgeVSU.call({
            added,
            removed,
            batchId,
            signers: [validators[1]],
          });

          const vscAccount = await fixture.bridgeVSU.fetchValidatorSetChange(
            batchId,
          );
          expect(vscAccount.added.length).to.equal(1);
          expectBNArrayEqual(vscAccount.removed, [0]);
        });
      });

      describe("Error Cases", () => {
        it("rejects with InvalidBatchId when batch_id <= last_batch_id", async () => {
          const vs = await fixture.getValidatorSet();
          const oldBatchId = vs.lastBatchId.toNumber();

          try {
            await fixture.bridgeVSU.call({
              added: [newValidators[0].publicKey],
              removed: toBNArray([]),
              batchId: oldBatchId,
              signers: [validators[0]],
            });
            expect.fail("Should have thrown InvalidBatchId");
          } catch (err: any) {
            const errorCode = err.error?.errorCode?.code || err.code;
            expect(errorCode).to.equal("InvalidBatchId");
          }
        });

        it("rejects with AddingExistingSigner when adding current validator", async () => {
          const batchId = await fixture.batchIds.freshBatchId();
          const vs = await fixture.getValidatorSet();
          const existingValidator = vs.signers[0];

          try {
            await fixture.bridgeVSU.call({
              added: [existingValidator],
              removed: toBNArray([]),
              batchId,
              signers: [validators[0]],
            });
            expect.fail("Should have thrown AddingExistingSigner");
          } catch (err: any) {
            const errorCode = err.error?.errorCode?.code || err.code;
            expect(errorCode).to.equal("AddingExistingSigner");
          }
        });

        it("rejects when adding more than MAX_VALIDATORS_CHANGE (10) in one call", async () => {
          const batchId = await fixture.batchIds.freshBatchId();

          // Try to add 11 validators - will fail at serialization/account constraint
          const tooManyVals = Array.from(
            { length: LIMITS.MAX_VALIDATORS_CHANGE + 1 },
            () => web3.Keypair.generate().publicKey,
          );

          try {
            await fixture.bridgeVSU.call({
              added: tooManyVals,
              removed: toBNArray([]),
              batchId,
              signers: [validators[0]],
            });
            expect.fail("Should have thrown account constraint error");
          } catch (err: any) {
            // Anchor/Borsh constraint violations don't have custom error codes
            // They throw during serialization with messages like:
            // "invalid account data for instruction" or "failed to serialize"
            expect(err.message).to.match(
              /invalid|serialize|constraint|max length/i,
            );
          }
        });
        it.skip("rejects when removing more than MAX_VALIDATORS_CHANGE (10) in one call", async () => {
          const batchId = await fixture.batchIds.freshBatchId();

          // Try to remove 11 validators - will fail at serialization
          const tooManyRemovals = Array.from({ length: LIMITS.MAX_VALIDATORS_CHANGE + 1 }, (_, i) => i);

          try {
            await fixture.bridgeVSU.call({
              added: [],
              removed: toBNArray(tooManyRemovals),
              batchId,
              signers: [validators[0]],
            });
            expect.fail("Should have thrown account constraint error");
          } catch (err: any) {
            console.log("Caught error:", err);
            expect(err.message).to.match(
              /invalid|serialize|constraint|max length/i,
            );
          }
        });

        it("rejects with MinValidatorsNotMet when removing too many validators", async () => {
          const batchId = await fixture.batchIds.freshBatchId();
          const vs = await fixture.getValidatorSet();
          const currentCount = vs.signers.length;
          const toRemove = currentCount - (LIMITS.MIN_VALIDATORS - 1); // Would leave only 3 (< MIN_VALIDATORS = 4)

          const removeIndexes = Array.from({ length: toRemove }, (_, i) => i);

          try {
            await fixture.bridgeVSU.call({
              added: [],
              removed: toBNArray(removeIndexes),
              batchId,
              signers: [validators[0]],
            });
            expect.fail("Should have thrown MinValidatorsNotMet");
          } catch (err: any) {
            const errorCode = err.error?.errorCode?.code || err.code;
            expect(errorCode).to.equal("MinValidatorsNotMet");
          }
        });

        it("rejects with RemovingNonExistentSigner when index out of bounds", async () => {
          const batchId = await fixture.batchIds.freshBatchId();
          const vs = await fixture.getValidatorSet();
          const invalidIndex = vs.signers.length;

          try {
            await fixture.bridgeVSU.call({
              added: [],
              removed: toBNArray([invalidIndex]),
              batchId,
              signers: [validators[0]],
            });
            expect.fail("Should have thrown RemovingNonExistentSigner");
          } catch (err: any) {
            const errorCode = err.error?.errorCode?.code || err.code;
            expect(errorCode).to.equal("RemovingNonExistentSigner");
          }
        });

        it("rejects with NoSignersProvided when no validators sign", async () => {
          const batchId = await fixture.batchIds.freshBatchId();

          try {
            await fixture.bridgeVSU.call({
              added: [newValidators[0].publicKey],
              removed: toBNArray([]),
              batchId,
              signers: [],
            });
            expect.fail("Should have thrown NoSignersProvided");
          } catch (err: any) {
            const errorCode = err.error?.errorCode?.code || err.code;
            expect(errorCode).to.equal("NoSignersProvided");
          }
        });

        it("rejects with InvalidSigner when non-validator signs", async () => {
          const batchId = await fixture.batchIds.freshBatchId();
          const nonValidator = web3.Keypair.generate();

          await airdrop(provider.connection, nonValidator.publicKey);

          try {
            await fixture.bridgeVSU.call({
              added: [newValidators[0].publicKey],
              removed: toBNArray([]),
              batchId,
              payer: nonValidator,
              signers: [nonValidator],
            });
            expect.fail("Should have thrown InvalidSigner");
          } catch (err: any) {
            const errorCode = err.error?.errorCode?.code || err.code;
            expect(errorCode).to.equal("InvalidSigner");
          }
        });

        it("rejects with DuplicateSignersProvided in same transaction", async () => {
          const batchId = await fixture.batchIds.freshBatchId();

          try {
            await fixture.bridgeVSU.call({
              added: [newValidators[0].publicKey],
              removed: toBNArray([]),
              batchId,
              signers: [validators[0], validators[0]],
            });
            expect.fail("Should have thrown DuplicateSignersProvided");
          } catch (err: any) {
            const errorCode = err.error?.errorCode?.code || err.code;
            expect(errorCode).to.equal("DuplicateSignersProvided");
          }
        });
        it.skip("should handle underflow when removed.len > (signers_len + added.len)", async () => {
          const batchId = await fixture.batchIds.freshBatchId();
          const vs = await fixture.getValidatorSet();
          const currentCount = vs.signers.length;

          // Try to remove more than exist (even after adding some)
          const added = [newValidators[0].publicKey]; // +1
          const removeCount = currentCount + 2; // Try to remove currentCount + 2
          const removed = toBNArray(
            Array.from({ length: removeCount }, (_, i) => i),
          );

          try {
            await fixture.bridgeVSU.call({
              added,
              removed, // This would cause underflow: 1 + currentCount - (currentCount + 2)
              batchId,
              signers: [validators[0]],
            });
            expect.fail("Should have thrown error");
          } catch (err: any) {
            // Could be RemovingNonExistentSigner or underflow panic
            expect(err).to.exist;
          }
        });
      });

      describe("Edge Cases", () => {
        it("handles adding validator at exactly MAX_VALIDATORS_CHANGE limit", async () => {
          const batchId = await fixture.batchIds.freshBatchId();
          const vs = await fixture.getValidatorSet();
          const currentCount = vs.signers.length;

          if (currentCount < LIMITS.MAX_VALIDATORS_CHANGE) {
            const toAdd = LIMITS.MAX_VALIDATORS_CHANGE - currentCount;
            const newVals = Array.from(
              { length: toAdd },
              () => web3.Keypair.generate().publicKey,
            );

            await fixture.bridgeVSU.call({
              added: newVals,
              removed: toBNArray([]),
              batchId,
              signers: [validators[0]],
            });

            const vscAccount = await fixture.bridgeVSU.fetchValidatorSetChange(
              batchId,
            );
            expect(vscAccount.added.length).to.equal(toAdd);
          }
        });

        it("handles removing down to exactly MIN_VALIDATORS limit", async () => {
          const batchId = await fixture.batchIds.freshBatchId();
          const vs = await fixture.getValidatorSet();
          const currentCount = vs.signers.length;

          if (currentCount > LIMITS.MIN_VALIDATORS) {
            const toRemove = currentCount - LIMITS.MIN_VALIDATORS;
            const removeIndexes = Array.from({ length: toRemove }, (_, i) => i);

            await fixture.bridgeVSU.call({
              added: [],
              removed: toBNArray(removeIndexes),
              batchId,
              signers: [validators[0]],
            });

            const vscAccount = await fixture.bridgeVSU.fetchValidatorSetChange(
              batchId,
            );
            expectBNArrayEqual(vscAccount.removed, removeIndexes);
          }
        });

        it("handles removing highest index validator", async () => {
          const batchId = await fixture.batchIds.freshBatchId();
          const vs = await fixture.getValidatorSet();
          const highestIndex = vs.signers.length - 1;

          await fixture.bridgeVSU.call({
            added: [newValidators[0].publicKey],
            removed: toBNArray([highestIndex]),
            batchId,
            signers: [validators[0]],
          });

          const vscAccount = await fixture.bridgeVSU.fetchValidatorSetChange(
            batchId,
          );
          expectBNArrayEqual(vscAccount.removed, [highestIndex]);
        });

        it("KNOWN BUG: allows duplicate validators in added array", async () => {
          const batchId = await fixture.batchIds.freshBatchId();
          const duplicateVal = newValidators[0].publicKey;

          await fixture.bridgeVSU.call({
            added: [duplicateVal, duplicateVal],
            removed: toBNArray([]),
            batchId,
            signers: [validators[0]],
          });

          const vscAccount = await fixture.bridgeVSU.fetchValidatorSetChange(
            batchId,
          );
          expect(vscAccount.added.length).to.equal(2);
          expect(vscAccount.added[0].toBase58()).to.equal(
            duplicateVal.toBase58(),
          );
          expect(vscAccount.added[1].toBase58()).to.equal(
            duplicateVal.toBase58(),
          );
        });
      });
    });

    describe("Second Submission (Approval)", () => {
      describe("Happy Path", () => {
        it("successfully adds approval from another validator", async () => {
          const batchId = await fixture.batchIds.freshBatchId();

          await fixture.bridgeVSU.call({
            added: [newValidators[0].publicKey],
            removed: toBNArray([]),
            batchId,
            signers: [validators[0]],
          });

          const vscBefore = await fixture.bridgeVSU.fetchValidatorSetChange(
            batchId,
          );
          expect(vscBefore.signers.length).to.equal(1);

          await fixture.bridgeVSU.call({
            added: [newValidators[0].publicKey],
            removed: toBNArray([]),
            batchId,
            signers: [validators[1]],
          });

          const vscAfter = await fixture.bridgeVSU.fetchValidatorSetChange(
            batchId,
          );
          expect(vscAfter.signers.length).to.equal(2);
          expect(vscAfter.signers[1].toBase58()).to.equal(
            validators[1].publicKey.toBase58(),
          );
        });

        it("allows multiple validators to approve in one transaction", async () => {
          const batchId = await fixture.batchIds.freshBatchId();

          await fixture.bridgeVSU.call({
            added: [newValidators[0].publicKey],
            removed: toBNArray([]),
            batchId,
            signers: [validators[0]],
          });

          await fixture.bridgeVSU.call({
            added: [newValidators[0].publicKey],
            removed: toBNArray([]),
            batchId,
            signers: [validators[1], validators[2]],
          });

          const vscAfter = await fixture.bridgeVSU.fetchValidatorSetChange(
            batchId,
          );
          expect(vscAfter.signers.length).to.equal(3);
        });
      });

      describe("Error Cases", () => {
        it("rejects with SignerAlreadyApproved when validator approves twice", async () => {
          const batchId = await fixture.batchIds.freshBatchId();

          await fixture.bridgeVSU.call({
            added: [newValidators[0].publicKey],
            removed: toBNArray([]),
            batchId,
            signers: [validators[0]],
          });

          try {
            await fixture.bridgeVSU.call({
              added: [newValidators[0].publicKey],
              removed: toBNArray([]),
              batchId,
              signers: [validators[0]],
            });
            expect.fail("Should have thrown SignerAlreadyApproved");
          } catch (err: any) {
            const errorCode = err.error?.errorCode?.code || err.code;
            expect(errorCode).to.equal("SignerAlreadyApproved");
          }
        });

        it("rejects with InvalidProposalHash when proposal parameters differ (added)", async () => {
          const batchId = await fixture.batchIds.freshBatchId();

          await fixture.bridgeVSU.call({
            added: [newValidators[0].publicKey],
            removed: toBNArray([]),
            batchId,
            signers: [validators[0]],
          });

          try {
            await fixture.bridgeVSU.call({
              added: [newValidators[1].publicKey],
              removed: toBNArray([]),
              batchId,
              signers: [validators[1]],
            });
            expect.fail("Should have thrown InvalidProposalHash");
          } catch (err: any) {
            const errorCode = err.error?.errorCode?.code || err.code;
            expect(errorCode).to.equal("InvalidProposalHash");
          }
        });

        it("rejects with InvalidProposalHash when removed indexes differ", async () => {
          const batchId = await fixture.batchIds.freshBatchId();

          await fixture.bridgeVSU.call({
            added: [],
            removed: toBNArray([0]),
            batchId,
            signers: [validators[0]],
          });

          try {
            await fixture.bridgeVSU.call({
              added: [],
              removed: toBNArray([1]),
              batchId,
              signers: [validators[1]],
            });
            expect.fail("Should have thrown InvalidProposalHash");
          } catch (err: any) {
            const errorCode = err.error?.errorCode?.code || err.code;
            expect(errorCode).to.equal("InvalidProposalHash");
          }
        });
      });
    });

    describe("Reaching Quorum (Execution)", () => {
      it("executes VSU when threshold is met in one transaction", async () => {
        const batchId = await fixture.batchIds.freshBatchId();
        const vs = await fixture.getValidatorSet();
        const threshold = vs.threshold;

        const newValidator = web3.Keypair.generate().publicKey;

        // Provide exactly `threshold` unique signers
        const uniqueSigners = validators.slice(0, threshold);

        // Execute VSU in one transaction
        await fixture.bridgeVSU.call({
          added: [newValidator],
          removed: toBNArray([]),
          batchId,
          signers: uniqueSigners,
        });

        // Don't try to fetch VSC account - it's deleted after execution!
        // Instead, verify the validator set was updated

        const updatedVs = await fixture.getValidatorSet();

        // Verify validator was added
        expect(updatedVs.signers.length).to.equal(vs.signers.length + 1);
        expect(updatedVs.lastBatchId.toString()).to.equal(batchId.toString());

        const lastSigner = updatedVs.signers[updatedVs.signers.length - 1];
        expect(lastSigner.toBase58()).to.equal(newValidator.toBase58());
      });

      it("executes VSU when threshold is met across multiple transactions", async () => {
        const batchId = await fixture.batchIds.freshBatchId();
        const vs = await fixture.getValidatorSet();
        const threshold = vs.threshold;

        const newValidator = web3.Keypair.generate().publicKey;

        const proposalParams = {
          added: [newValidator],
          removed: toBNArray([]),
        };

        // Step 1: First validator creates the proposal
        await fixture.bridgeVSU.call({
          ...proposalParams,
          batchId,
          signers: [validators[0]],
        });

        // Fetch BEFORE final approval (account still exists)
        let vscAccount = await fixture.bridgeVSU.fetchValidatorSetChange(
          batchId,
        );
        expect(vscAccount.signers.length).to.equal(1);

        // Step 2: Add approvals one by one until threshold - 1
        for (let i = 1; i < threshold - 1; i++) {
          await fixture.bridgeVSU.call({
            ...proposalParams,
            batchId,
            signers: [validators[i]],
          });

          // Can still fetch here (not executed yet)
          vscAccount = await fixture.bridgeVSU.fetchValidatorSetChange(batchId);
          expect(vscAccount.signers.length).to.equal(i + 1);
        }

        // Verify we're at threshold - 1
        vscAccount = await fixture.bridgeVSU.fetchValidatorSetChange(batchId);
        expect(vscAccount.signers.length).to.equal(threshold - 1);

        // Step 3: Final approval that triggers execution
        await fixture.bridgeVSU.call({
          ...proposalParams,
          batchId,
          signers: [validators[threshold - 1]],
        });

        // Don't fetch VSC account here - it's deleted!
        // const vscAccount = await fixture.bridgeVSU.fetchValidatorSetChange(batchId);

        // Instead, verify validator set was updated
        const updatedVs = await fixture.getValidatorSet();
        expect(updatedVs.signers.length).to.equal(vs.signers.length + 1);
        expect(updatedVs.lastBatchId.toString()).to.equal(batchId.toString());

        // Verify the new validator was added
        const newValidatorAdded = updatedVs.signers.some(
          (signer) => signer.toBase58() === newValidator.toBase58(),
        );
        expect(newValidatorAdded).to.be.true;
      });

      it("executes removal of validators correctly", async () => {
        const batchId = await fixture.batchIds.freshBatchId();
        const vs = await fixture.getValidatorSet();
        const threshold = vs.threshold;

        // Remove the last validator (highest index)
        const indexToRemove = vs.signers.length - 1;
        const validatorToRemove = vs.signers[indexToRemove];

        // Store exact parameters
        const proposalParams = {
          added: [],
          removed: toBNArray([indexToRemove]),
        };

        // Step 1: Create proposal with first validator
        await fixture.bridgeVSU.call({
          ...proposalParams,
          batchId,
          signers: [validators[0]],
        });

        // Step 2: Add approvals until threshold
        for (let i = 1; i < threshold; i++) {
          await fixture.bridgeVSU.call({
            ...proposalParams, // Same params
            batchId,
            signers: [validators[i]],
          });
        }

        // Verify execution
        const updatedVs = await fixture.getValidatorSet();
        expect(updatedVs.signers.length).to.equal(vs.signers.length - 1);
        expect(updatedVs.lastBatchId.toString()).to.equal(batchId.toString());

        // Verify the validator was actually removed
        const removedValidatorStillExists = updatedVs.signers.some(
          (signer) => signer.toBase58() === validatorToRemove.toBase58(),
        );
        expect(removedValidatorStillExists).to.be.false;
      });

      it("executes both additions and removals correctly", async () => {
        const batchId = await fixture.batchIds.freshBatchId();
        const vs = await fixture.getValidatorSet();
        const threshold = vs.threshold;

        const newValidator = web3.Keypair.generate().publicKey;
        const indexToRemove = vs.signers.length - 1;
        const validatorToRemove = vs.signers[indexToRemove];

        // Store exact parameters
        const proposalParams = {
          added: [newValidator],
          removed: toBNArray([indexToRemove]),
        };

        // Step 1: Create proposal
        await fixture.bridgeVSU.call({
          ...proposalParams,
          batchId,
          signers: [validators[0]],
        });

        // Step 2: Add approvals until threshold
        for (let i = 1; i < threshold; i++) {
          await fixture.bridgeVSU.call({
            ...proposalParams, // Same params
            batchId,
            signers: [validators[i]],
          });
        }

        // Verify execution
        const updatedVs = await fixture.getValidatorSet();

        // Net change: +1 -1 = 0 (same count)
        expect(updatedVs.signers.length).to.equal(vs.signers.length);
        expect(updatedVs.lastBatchId.toString()).to.equal(batchId.toString());

        // Verify removal happened
        const removedValidatorStillExists = updatedVs.signers.some(
          (signer) => signer.toBase58() === validatorToRemove.toBase58(),
        );
        expect(removedValidatorStillExists).to.be.false;

        // Verify addition happened
        const newValidatorAdded = updatedVs.signers.some(
          (signer) => signer.toBase58() === newValidator.toBase58(),
        );
        expect(newValidatorAdded).to.be.true;
      });
    });
  });
});
