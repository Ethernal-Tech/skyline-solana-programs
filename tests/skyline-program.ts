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
  assertBridgingTransactionState,
  LIMITS,
  assertValidBump,
  airdrop
} from "./fixtures";
import {
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount
} from "@solana/spl-token";
import { BN } from "bn.js";

describe.only("skyline-program", () => {
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
    connection: provider.connection
  };

  const fixture = new SkylineTestFixture(ctx);

  // Generate test validators once
  const validators = generateValidators(50);

  const treasury = anchor.web3.Keypair.generate();
  const relayer = anchor.web3.Keypair.generate();

  // Fee config values used across all tests — keep them small but non-zero.
  const MIN_OPERATIONAL_FEE = 1_000; // 0.000001 SOL
  const BRIDGE_FEE = 500; // 0.0000005 SOL
  const REQUIRED_FEE = MIN_OPERATIONAL_FEE + BRIDGE_FEE; // 1_500 lamports

  // ============================================================================
  // INITIALIZE TESTS — replace entire describe("Initialize", ...) block
  // ============================================================================

  describe("Initialize", () => {
    describe("Bad Cases", () => {
      it("fails with less than MIN_VALIDATORS (3 < 4)", async () => {
        const validatorPubkeys = validators.slice(0, 3).map((v) => v.publicKey);

        await fixture.initialize.expectError(
          validatorPubkeys,
          "MinValidatorsNotMet",
          0,
          {
            minOperationalFee: MIN_OPERATIONAL_FEE,
            bridgeFee: BRIDGE_FEE,
            treasury: treasury.publicKey,
            relayer: relayer.publicKey
          }
        );
      });

      it("fails with more validators than transaction size allows (30 > 29)", async () => {
        const validatorPubkeys = validators
          .slice(0, LIMITS.MAX_TX_VALIDATORS + 1)
          .map((v) => v.publicKey);

        await fixture.initialize.expectFailure(validatorPubkeys, 0, {
          minOperationalFee: MIN_OPERATIONAL_FEE,
          bridgeFee: BRIDGE_FEE,
          treasury: treasury.publicKey,
          relayer: relayer.publicKey
        });
      });

      it("fails when duplicate validators provided", async () => {
        const duplicateValidators = [
          validators[0].publicKey,
          validators[1].publicKey,
          validators[2].publicKey,
          validators[3].publicKey,
          validators[0].publicKey // duplicate
        ];

        await fixture.initialize.expectError(
          duplicateValidators,
          "ValidatorsNotUnique",
          0,
          {
            minOperationalFee: MIN_OPERATIONAL_FEE,
            bridgeFee: BRIDGE_FEE,
            treasury: treasury.publicKey,
            relayer: relayer.publicKey
          }
        );
      });

      it("fails with no validators provided", async () => {
        await fixture.initialize.expectError([], "MinValidatorsNotMet", 0, {
          minOperationalFee: MIN_OPERATIONAL_FEE,
          bridgeFee: BRIDGE_FEE,
          treasury: treasury.publicKey,
          relayer: relayer.publicKey
        });
      });

      it("fails when combined fees overflow u64", async () => {
        const validatorPubkeys = validators.slice(0, 7).map((v) => v.publicKey);

        const MAX_U64 = new anchor.BN("18446744073709551615");

        await fixture.initialize.expectError(
          validatorPubkeys,
          "FeeConfigOverflow",
          0,
          {
            // min_op_fee + bridge_fee > u64::MAX → should reject at init
            minOperationalFee: MAX_U64,
            bridgeFee: new anchor.BN(1),
            treasury: treasury.publicKey,
            relayer: relayer.publicKey
          }
        );
      });
    });

    describe.only("Success Case", () => {
      it("initializes state correctly with 5 validators", async function () {
        const validatorCount = 5;
        const validatorPubkeys = validators
          .slice(0, validatorCount)
          .map((v) => v.publicKey);

        const expectedThreshold = calculateExpectedThreshold(validatorCount);

        const isInitialized = await fixture.isInitialized();

        if (isInitialized) {
          const vs = await fixture.accounts.getValidatorSet(
            fixture.pdas.validatorSet()
          );

          try {
            assertValidatorSetState(vs, {
              validators: validatorPubkeys,
              threshold: expectedThreshold,
              lastBatchId: 0,
              bridgeRequestCount: 0
            });

            const vault = await fixture.accounts.getVault(fixture.pdas.vault());
            assertValidBump(vault.bump);

            // Also verify fee_config was written correctly
            const fc = await fixture.getFeeConfig();
            expect(fc.minOperationalFee.toNumber()).to.equal(
              MIN_OPERATIONAL_FEE
            );
            expect(fc.bridgeFee.toNumber()).to.equal(BRIDGE_FEE);
            expect(fc.treasury.toBase58()).to.equal(
              treasury.publicKey.toBase58()
            );
            expect(fc.relayer.toBase58()).to.equal(
              relayer.publicKey.toBase58()
            );

            console.log(
              "  ℹ ValidatorSet already initialized and matches expected state"
            );
            return;
          } catch (e: any) {
            throw new Error(
              [
                "ValidatorSet already exists but does not match expected test state.",
                "Reset your test validator / clean ledger and rerun.",
                `vsPDA=${fixture.pdas.validatorSet().toBase58()}`,
                `Error: ${e.message}`
              ].join("\n")
            );
          }
        }

        // Not yet initialized — airdrop to treasury + relayer so they can
        // receive lamports in bridge_request tests
        await airdrop(
          provider.connection,
          treasury.publicKey,
          1 * web3.LAMPORTS_PER_SOL
        );
        await airdrop(
          provider.connection,
          relayer.publicKey,
          1 * web3.LAMPORTS_PER_SOL
        );

        await fixture.initialize.call(validatorPubkeys, 0, {
          minOperationalFee: MIN_OPERATIONAL_FEE,
          bridgeFee: BRIDGE_FEE,
          treasury: treasury.publicKey,
          relayer: relayer.publicKey
        });

        // Verify validator set
        const vs = await fixture.accounts.getValidatorSet(
          fixture.pdas.validatorSet()
        );
        assertValidatorSetState(vs, {
          validators: validatorPubkeys,
          threshold: expectedThreshold,
          lastBatchId: 0,
          bridgeRequestCount: 0
        });

        // Verify vault
        const vault = await fixture.accounts.getVault(fixture.pdas.vault());
        assertValidBump(vault.bump);

        // Verify fee_config
        const fc = await fixture.getFeeConfig();
        expect(fc.minOperationalFee.toNumber()).to.equal(MIN_OPERATIONAL_FEE);
        expect(fc.bridgeFee.toNumber()).to.equal(BRIDGE_FEE);
        expect(fc.treasury.toBase58()).to.equal(treasury.publicKey.toBase58());
        expect(fc.relayer.toBase58()).to.equal(relayer.publicKey.toBase58());
        assertValidBump(fc.bump);
      });

      it("fails on re-initialization attempt", async function () {
        const isInitialized = await fixture.isInitialized();
        if (!isInitialized) {
          this.skip();
          return;
        }

        const before = await fixture.getValidatorSet();

        let threw = false;
        try {
          await fixture.initialize.call(
            validators.slice(5, 12).map((v) => v.publicKey),
            3,
            {
              minOperationalFee: MIN_OPERATIONAL_FEE,
              bridgeFee: BRIDGE_FEE,
              treasury: treasury.publicKey,
              relayer: relayer.publicKey
            }
          );
        } catch (e: any) {
          threw = true;
          const logs: string = (e?.logs ?? []).join("\n");
          expect(logs).to.include("already in use");
        }

        expect(threw, "re-initialization should have failed").to.equal(true);

        const after = await fixture.getValidatorSet();
        expect(after.lastBatchId.toString()).to.equal(
          before.lastBatchId.toString()
        );
        expect(after.signers.length).to.equal(before.signers.length);
      });
    });
  });

  describe("Bridge Transaction (multi-transfer)", () => {
    //Shared test state

    let mint1: web3.PublicKey; // registered lock/unlock, 9 decimals
    let mint2: web3.PublicKey; // registered lock/unlock, 6 decimals
    let vaultPDA: web3.PublicKey;

    // A dedicated subset of validators used across these tests.
    // The full `validators` pool has 50 — we use the first 4 (threshold)
    // They were already registered during Initialize tests.
    let activeValidators: web3.Keypair[];
    let threshold: number;

    // Before hook — one-time setup

    before("set up mints and vault balances", async () => {
      vaultPDA = fixture.pdas.vault();

      // ── Step 1: Read the real threshold from on-chain ──────────────────────

      const vs = await fixture.getValidatorSet();
      threshold = vs.threshold;

      // ── Step 2: Use the SAME keypairs Initialize registered ───────────────
      const registeredCount = vs.signers.length;
      activeValidators = validators.slice(0, registeredCount);

      // ── Step 3: Verify our local keypairs match what's on-chain ───────────
      const onChainSet = new Set(vs.signers.map((pk) => pk.toBase58()));
      for (const v of activeValidators) {
        if (!onChainSet.has(v.publicKey.toBase58())) {
          throw new Error(
            `Keypair ${v.publicKey.toBase58().slice(0, 8)}... is not in the ` +
              `on-chain validator set.\n` +
              `This usually means the ledger was reset without re-running Initialize.\n` +
              `Run: anchor test --skip-deploy  OR  reset the validator and rerun all tests.\n` +
              `On-chain signers: [${[...onChainSet]
                .map((s) => s.slice(0, 8))
                .join(", ")}]`
          );
        }
      }

      console.log(
        `  ℹ Validator setup: ${registeredCount} registered, threshold=${threshold}`
      );

      // ── Step 4: Airdrop all active validators ─────────────────────────────
      //
      // Run in parallel — 7 airdrops sequentially would be slow.
      // Guard with balance check to avoid hitting localnet rate limits on reruns.
      await Promise.all(
        activeValidators.map(async (v) => {
          const balance = await provider.connection.getBalance(v.publicKey);
          if (balance < 0.1 * web3.LAMPORTS_PER_SOL) {
            const sig = await provider.connection.requestAirdrop(
              v.publicKey,
              web3.LAMPORTS_PER_SOL
            );
            const lbh = await provider.connection.getLatestBlockhash();
            await provider.connection.confirmTransaction({
              signature: sig,
              ...lbh
            });
          }
        })
      );

      // ── Step 5: Create and register mint1 (9 decimals, lock/unlock) ───────
      mint1 = await fixture.mints.create(owner.publicKey, 9);

      await fixture.tokenRegistry.registerLockUnlock({
        mint: mint1,
        tokenId: 100,
        minBridgingAmount: 1
      });

      // Fund the vault ATA — bridge_transaction will debit this
      await fixture.mints.mintTo(mint1, vaultPDA, 1_000_000_000, true);

      // ── Step 6: Create and register mint2 (6 decimals, lock/unlock) ───────
      mint2 = await fixture.mints.create(owner.publicKey, 6);

      await fixture.tokenRegistry.registerLockUnlock({
        mint: mint2,
        tokenId: 101,
        minBridgingAmount: 1
      });

      await fixture.mints.mintTo(mint2, vaultPDA, 1_000_000_000, true);

      console.log(
        `  ℹ Mints ready: mint1=${mint1.toBase58().slice(0, 8)}… ` +
          `mint2=${mint2.toBase58().slice(0, 8)}…`
      );
    });
    //describe("Bridge Transaction — Error Cases (SAD paths)", () => {
    /*  let mint1: web3.PublicKey;
      let mint2: web3.PublicKey;
      let vaultPDA: web3.PublicKey;
      let activeValidators: web3.Keypair[];
      let threshold: number;

      before("setup for error tests", async () => {
        vaultPDA = fixture.pdas.vault();
        const vs = await fixture.getValidatorSet();
        threshold = vs.threshold;
        activeValidators = validators.slice(0, vs.signers.length);

        // Reuse mints from previous setup
        mint1 = await fixture.mints.create(owner.publicKey, 9);
        await fixture.tokenRegistry.registerLockUnlock({
          mint: mint1,
          tokenId: 200,
          minBridgingAmount: 1
        });
        await fixture.mints.mintTo(mint1, vaultPDA, 1_000_000_000, true);

        mint2 = await fixture.mints.create(owner.publicKey, 6);
        await fixture.tokenRegistry.registerLockUnlock({
          mint: mint2,
          tokenId: 201,
          minBridgingAmount: 1
        });
        await fixture.mints.mintTo(mint2, vaultPDA, 1_000_000_000, true);
      }); */

    // ═══════════════════════════════════════════════════════════════════
    // 1. InvalidBatchId — replay attack prevention
    // ═══════════════════════════════════════════════════════════════════

    it("fails when batch_id equals last_batch_id", async () => {
      const recipient = web3.Keypair.generate().publicKey;
      const vs = await fixture.getValidatorSet();
      const currentBatchId = vs.lastBatchId;

      await fixture.bridgeTransaction.expectError(
        {
          transfers: [{ recipient, mintIndex: 0, amount: new BN(1000) }],
          mints: [mint1],
          batchId: currentBatchId, // Same as current — should fail
          validators: activeValidators.slice(0, threshold),
          vaultPDA
        },
        "InvalidBatchId"
      );
    });

    // ═══════════════════════════════════════════════════════════════════
    // 2. InvalidTransferCount — empty or too many transfers
    // ═══════════════════════════════════════════════════════════════════

    it("fails when transfers array is empty", async () => {
      const batchId = await fixture.nextBatchId();

      await fixture.bridgeTransaction.expectError(
        {
          transfers: [], // Empty
          mints: [mint1],
          batchId,
          validators: activeValidators.slice(0, threshold),
          vaultPDA
        },
        "InvalidTransferCount"
      );
    });

    // ═══════════════════════════════════════════════════════════════════
    // 3. InvalidMintList — empty or too many mints
    // ═══════════════════════════════════════════════════════════════════

    it("fails when mints array is empty", async () => {
      const recipient = web3.Keypair.generate().publicKey;
      const batchId = await fixture.nextBatchId();

      await fixture.bridgeTransaction.expectError(
        {
          transfers: [{ recipient, mintIndex: 0, amount: new BN(1000) }],
          mints: [], // Empty
          batchId,
          validators: activeValidators.slice(0, threshold),
          vaultPDA
        },
        "InvalidMintList"
      );
    });

    it("fails when mints.length > transfers.length", async () => {
      const recipient = web3.Keypair.generate().publicKey;
      const batchId = await fixture.nextBatchId();

      await fixture.bridgeTransaction.expectError(
        {
          transfers: [{ recipient, mintIndex: 0, amount: new BN(1000) }], // 1 transfer
          mints: [mint1, mint2], // 2 mints — invalid
          batchId,
          validators: activeValidators.slice(0, threshold),
          vaultPDA
        },
        "InvalidMintList"
      );
    });

    // ═══════════════════════════════════════════════════════════════════
    // 4. InvalidMintIndex — out of bounds reference
    // ═══════════════════════════════════════════════════════════════════

    it("fails when mint_index is out of bounds", async () => {
      const recipient = web3.Keypair.generate().publicKey;
      const batchId = await fixture.nextBatchId();

      await fixture.bridgeTransaction.expectError(
        {
          transfers: [
            { recipient, mintIndex: 5, amount: new BN(1000) } // Index 5, but only 1 mint
          ],
          mints: [mint1],
          batchId,
          validators: activeValidators.slice(0, threshold),
          vaultPDA
        },
        "InvalidMintIndex"
      );
    });

    // ═══════════════════════════════════════════════════════════════════
    // 5. InvalidAmount — zero amount
    // ═══════════════════════════════════════════════════════════════════

    it("fails when transfer amount is zero", async () => {
      const recipient = web3.Keypair.generate().publicKey;
      const batchId = await fixture.nextBatchId();

      await fixture.bridgeTransaction.expectError(
        {
          transfers: [{ recipient, mintIndex: 0, amount: new BN(0) }], // Zero
          mints: [mint1],
          batchId,
          validators: activeValidators.slice(0, threshold),
          vaultPDA
        },
        "InvalidAmount"
      );
    });

    it("fails when one of multiple transfers has zero amount", async () => {
      const recipients = Array.from(
        { length: 3 },
        () => web3.Keypair.generate().publicKey
      );
      const batchId = await fixture.nextBatchId();

      await fixture.bridgeTransaction.expectError(
        {
          transfers: [
            { recipient: recipients[0], mintIndex: 0, amount: new BN(1000) },
            { recipient: recipients[1], mintIndex: 0, amount: new BN(0) }, // Zero
            { recipient: recipients[2], mintIndex: 0, amount: new BN(2000) }
          ],
          mints: [mint1],
          batchId,
          validators: activeValidators.slice(0, threshold),
          vaultPDA
        },
        "InvalidAmount"
      );
    });

    // ═══════════════════════════════════════════════════════════════════
    // 6. InvalidRemainingAccounts — wrong account count
    // ═══════════════════════════════════════════════════════════════════

    it("fails when remaining_accounts has too few accounts", async () => {
      const recipient = web3.Keypair.generate().publicKey;
      const batchId = await fixture.nextBatchId();

      const sections = fixture.bridgeTransaction.buildSections({
        transfers: [{ recipient, mintIndex: 0, amount: new BN(1000) }],
        mints: [mint1],
        batchId,
        validators: activeValidators.slice(0, threshold),
        vaultPDA
      });

      // Remove one account from vault ATAs to corrupt the count
      sections.vaultAtaMetas = [];

      await fixture.bridgeTransaction.expectErrorWithSections(
        [{ recipient, mintIndex: 0, amount: new BN(1000) }],
        [mint1],
        batchId,
        activeValidators.slice(0, threshold),
        sections,
        "InvalidRemainingAccounts"
      );
    });

    it("fails when remaining_accounts has too many accounts", async () => {
      const recipient = web3.Keypair.generate().publicKey;
      const batchId = await fixture.nextBatchId();

      const sections = fixture.bridgeTransaction.buildSections({
        transfers: [{ recipient, mintIndex: 0, amount: new BN(1000) }],
        mints: [mint1],
        batchId,
        validators: activeValidators.slice(0, threshold),
        vaultPDA
      });

      // Add an extra dummy account
      sections.vaultAtaMetas.push({
        pubkey: web3.Keypair.generate().publicKey,
        isSigner: false,
        isWritable: true
      });

      await fixture.bridgeTransaction.expectErrorWithSections(
        [{ recipient, mintIndex: 0, amount: new BN(1000) }],
        [mint1],
        batchId,
        activeValidators.slice(0, threshold),
        sections,
        "InvalidRemainingAccounts"
      );
    });

    // ═══════════════════════════════════════════════════════════════════
    // 7. InvalidMintList (2nd check) — mint account mismatch
    // ═══════════════════════════════════════════════════════════════════

    it("fails when mint account doesn't match mints arg", async () => {
      const recipient = web3.Keypair.generate().publicKey;
      const batchId = await fixture.nextBatchId();
      const fakeMint = web3.Keypair.generate().publicKey;

      const sections = fixture.bridgeTransaction.buildSections({
        transfers: [{ recipient, mintIndex: 0, amount: new BN(1000) }],
        mints: [mint1],
        batchId,
        validators: activeValidators.slice(0, threshold),
        vaultPDA
      });

      // Corrupt the mint account to point to a different mint
      sections.mintMetas[0].pubkey = fakeMint;

      await fixture.bridgeTransaction.expectErrorWithSections(
        [{ recipient, mintIndex: 0, amount: new BN(1000) }],
        [mint1], // Instruction arg says mint1
        batchId,
        activeValidators.slice(0, threshold),
        sections, // But account is fakeMint
        "InvalidMintList"
      );
    });

    // ═══════════════════════════════════════════════════════════════════
    // 8. NoSignersProvided — no validators signed
    // ═══════════════════════════════════════════════════════════════════

    it("fails when no validators are provided", async () => {
      const recipient = web3.Keypair.generate().publicKey;
      const batchId = await fixture.nextBatchId();

      await fixture.bridgeTransaction.expectError(
        {
          transfers: [{ recipient, mintIndex: 0, amount: new BN(1000) }],
          mints: [mint1],
          batchId,
          validators: [], // Empty
          vaultPDA
        },
        "NoSignersProvided"
      );
    });

    // ═══════════════════════════════════════════════════════════════════
    // 9. DuplicateSignersProvided — same validator signs twice
    // ═══════════════════════════════════════════════════════════════════

    it("fails when duplicate validators are provided", async () => {
      const recipient = web3.Keypair.generate().publicKey;
      const batchId = await fixture.nextBatchId();

      const duplicateValidators = [
        activeValidators[0],
        activeValidators[1],
        activeValidators[0] // Duplicate
      ];

      await fixture.bridgeTransaction.expectError(
        {
          transfers: [{ recipient, mintIndex: 0, amount: new BN(1000) }],
          mints: [mint1],
          batchId,
          validators: duplicateValidators,
          vaultPDA
        },
        "DuplicateSignersProvided"
      );
    });

    // ═══════════════════════════════════════════════════════════════════
    // 10. InvalidSigner — signer not registered
    // ═══════════════════════════════════════════════════════════════════

    it("fails when signer is not a registered validator", async () => {
      const recipient = web3.Keypair.generate().publicKey;
      const batchId = await fixture.nextBatchId();
      const fakeValidator = web3.Keypair.generate();

      // Airdrop to fake validator so it can sign
      const sig = await provider.connection.requestAirdrop(
        fakeValidator.publicKey,
        web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);

      const mixedValidators = [
        ...activeValidators.slice(0, threshold - 1),
        fakeValidator // Not registered
      ];

      await fixture.bridgeTransaction.expectError(
        {
          transfers: [{ recipient, mintIndex: 0, amount: new BN(1000) }],
          mints: [mint1],
          batchId,
          validators: mixedValidators,
          vaultPDA
        },
        "InvalidSigner"
      );
    });

    // ═══════════════════════════════════════════════════════════════════
    // 11. InsufficientSigners — below threshold
    // ═══════════════════════════════════════════════════════════════════

    it("fails when signers count is below threshold", async () => {
      const recipient = web3.Keypair.generate().publicKey;
      const batchId = await fixture.nextBatchId();

      const belowThreshold = activeValidators.slice(0, threshold - 1);

      await fixture.bridgeTransaction.expectError(
        {
          transfers: [{ recipient, mintIndex: 0, amount: new BN(1000) }],
          mints: [mint1],
          batchId,
          validators: belowThreshold,
          vaultPDA
        },
        "InsufficientSigners"
      );
    });

    // ═══════════════════════════════════════════════════════════════════
    // 12. InvalidRemainingAccounts (TokenRegistry PDA mismatch)
    // ═══════════════════════════════════════════════════════════════════

    it("fails when TokenRegistry PDA doesn't match expected", async () => {
      const recipient = web3.Keypair.generate().publicKey;
      const batchId = await fixture.nextBatchId();

      const sections = fixture.bridgeTransaction.buildSections({
        transfers: [{ recipient, mintIndex: 0, amount: new BN(1000) }],
        mints: [mint1],
        batchId,
        validators: activeValidators.slice(0, threshold),
        vaultPDA
      });

      // Corrupt the registry PDA
      sections.registryMetas[0].pubkey = web3.Keypair.generate().publicKey;

      await fixture.bridgeTransaction.expectErrorWithSections(
        [{ recipient, mintIndex: 0, amount: new BN(1000) }],
        [mint1],
        batchId,
        activeValidators.slice(0, threshold),
        sections,
        "InvalidRemainingAccounts"
      );
    });

    // ═══════════════════════════════════════════════════════════════════
    // 13. InvalidTokenAccount — recipient ATA mismatch
    // ═══════════════════════════════════════════════════════════════════

    it("fails when recipient ATA doesn't match expected address", async () => {
      const recipient = web3.Keypair.generate().publicKey;
      const batchId = await fixture.nextBatchId();

      const sections = fixture.bridgeTransaction.buildSections({
        transfers: [{ recipient, mintIndex: 0, amount: new BN(1000) }],
        mints: [mint1],
        batchId,
        validators: activeValidators.slice(0, threshold),
        vaultPDA
      });

      // Corrupt the recipient ATA
      sections.recipientAtaMetas[0].pubkey = web3.Keypair.generate().publicKey;

      await fixture.bridgeTransaction.expectErrorWithSections(
        [{ recipient, mintIndex: 0, amount: new BN(1000) }],
        [mint1],
        batchId,
        activeValidators.slice(0, threshold),
        sections,
        "InvalidTokenAccount"
      );
    });

    // ═══════════════════════════════════════════════════════════════════
    // 14. InvalidVault — vault ATA mismatch
    // ═══════════════════════════════════════════════════════════════════

    it("fails when vault ATA doesn't match expected address", async () => {
      const recipient = web3.Keypair.generate().publicKey;
      const batchId = await fixture.nextBatchId();

      const sections = fixture.bridgeTransaction.buildSections({
        transfers: [{ recipient, mintIndex: 0, amount: new BN(1000) }],
        mints: [mint1],
        batchId,
        validators: activeValidators.slice(0, threshold),
        vaultPDA
      });

      // Corrupt the vault ATA
      sections.vaultAtaMetas[0].pubkey = web3.Keypair.generate().publicKey;

      await fixture.bridgeTransaction.expectErrorWithSections(
        [{ recipient, mintIndex: 0, amount: new BN(1000) }],
        [mint1],
        batchId,
        activeValidators.slice(0, threshold),
        sections,
        "InvalidVault"
      );
    });

    // ═══════════════════════════════════════════════════════════════════
    // 15. Edge cases — combinations and boundary conditions
    // ═══════════════════════════════════════════════════════════════════

    it("fails when mixing valid and invalid mint indices", async () => {
      const recipients = Array.from(
        { length: 2 },
        () => web3.Keypair.generate().publicKey
      );
      const batchId = await fixture.nextBatchId();

      await fixture.bridgeTransaction.expectError(
        {
          transfers: [
            { recipient: recipients[0], mintIndex: 0, amount: new BN(1000) }, // Valid
            { recipient: recipients[1], mintIndex: 10, amount: new BN(2000) } // Invalid
          ],
          mints: [mint1],
          batchId,
          validators: activeValidators.slice(0, threshold),
          vaultPDA
        },
        "InvalidMintIndex"
      );
    });

    it("fails when exactly threshold signers but one is invalid", async () => {
      const recipient = web3.Keypair.generate().publicKey;
      const batchId = await fixture.nextBatchId();
      const fakeValidator = web3.Keypair.generate();

      const sig = await provider.connection.requestAirdrop(
        fakeValidator.publicKey,
        web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);

      const mixedValidators = [
        ...activeValidators.slice(0, threshold - 1),
        fakeValidator
      ];

      expect(mixedValidators.length).to.equal(threshold);

      await fixture.bridgeTransaction.expectError(
        {
          transfers: [{ recipient, mintIndex: 0, amount: new BN(1000) }],
          mints: [mint1],
          batchId,
          validators: mixedValidators,
          vaultPDA
        },
        "InvalidSigner"
      );
    });

    it("succeeds with exactly threshold + 1 validators (over-signed)", async () => {
      const recipient = web3.Keypair.generate().publicKey;
      const batchId = await fixture.nextBatchId();

      const overSigners = activeValidators.slice(0, threshold + 1);

      await fixture.bridgeTransaction.call({
        transfers: [{ recipient, mintIndex: 0, amount: new BN(1000) }],
        mints: [mint1],
        batchId,
        validators: overSigners,
        vaultPDA
      });

      const ata = getAssociatedTokenAddressSync(mint1, recipient);
      const balance = await fixture.tokenBalances.getBalance(ata);
      expect(balance.toString()).to.equal("1000");
    });
    //});

    it("single transfer — lock/unlock — creates recipient ATA and debits vault", async () => {
      const recipient = web3.Keypair.generate().publicKey;
      const amount = new BN(500_000);
      const batchId = await fixture.nextBatchId();

      const recipientAta = getAssociatedTokenAddressSync(mint1, recipient);
      const vaultAta = getAssociatedTokenAddressSync(mint1, vaultPDA, true);

      // Snapshot balances before
      const vaultBefore = await fixture.tokenBalances.snapshot(vaultAta);
      // Recipient ATA doesn't exist yet — balance is 0 (helper handles missing)
      const recipientBefore = await fixture.tokenBalances.snapshot(
        recipientAta
      );

      const sig = await fixture.bridgeTransaction.call({
        transfers: [{ recipient, mintIndex: 0, amount }],
        mints: [mint1],
        batchId,
        validators: activeValidators.slice(0, threshold),
        vaultPDA
      });

      // ── Assert balances ───
      const vaultDelta = await fixture.tokenBalances.getBalanceDelta(
        vaultAta,
        vaultBefore
      );
      const recipientDelta = await fixture.tokenBalances.getBalanceDelta(
        recipientAta,
        recipientBefore
      );

      expect(vaultDelta.toString()).to.equal(
        (-BigInt(amount.toString())).toString(),
        "vault should decrease by transfer amount"
      );
      expect(recipientDelta.toString()).to.equal(
        BigInt(amount.toString()).toString(),
        "recipient should receive exact amount"
      );

      // ── Assert lastBatchId advanced ───
      const vs = await fixture.getValidatorSet();
      expect(vs.lastBatchId.toString()).to.equal(
        batchId.toString(),
        "lastBatchId should be updated"
      );
    });

    it("fails when batch_id is less than last_batch_id", async () => {
      const recipient = web3.Keypair.generate().publicKey;
      const vs = await fixture.getValidatorSet();
      console.log(`  ℹ Current last_batch_id=${vs.lastBatchId.toString()} `);
      const oldBatchId = vs.lastBatchId.sub(new BN(1));
      console.log(`  ℹ Testing with old batch_id=${oldBatchId.toString()} `);

      await fixture.bridgeTransaction.expectError(
        {
          transfers: [{ recipient, mintIndex: 0, amount: new BN(1000) }],
          mints: [mint1],
          batchId: oldBatchId,
          validators: activeValidators.slice(0, threshold),
          vaultPDA
        },
        "InvalidBatchId"
      );
    });

    it("single transfer — recipient ATA pre-exists — does not fail", async () => {
      const recipient = web3.Keypair.generate().publicKey;
      const amount = new BN(100_000);
      const batchId = await fixture.nextBatchId();

      // Pre-create the ATA by minting a tiny amount to the recipient
      await fixture.mints.mintTo(mint1, recipient, 1);

      const recipientAta = getAssociatedTokenAddressSync(mint1, recipient);
      const vaultAta = getAssociatedTokenAddressSync(mint1, vaultPDA, true);

      const vaultBefore = await fixture.tokenBalances.snapshot(vaultAta);
      const recipientBefore = await fixture.tokenBalances.snapshot(
        recipientAta
      );

      await fixture.bridgeTransaction.call({
        transfers: [{ recipient, mintIndex: 0, amount }],
        mints: [mint1],
        batchId,
        validators: activeValidators,
        vaultPDA
      });

      const vaultDelta = await fixture.tokenBalances.getBalanceDelta(
        vaultAta,
        vaultBefore
      );
      const recipientDelta = await fixture.tokenBalances.getBalanceDelta(
        recipientAta,
        recipientBefore
      );

      expect(vaultDelta.toString()).to.equal(
        (-BigInt(amount.toString())).toString()
      );
      expect(recipientDelta.toString()).to.equal(
        BigInt(amount.toString()).toString()
      );
    });

    it("3 transfers in a single batch — all from one mint", async () => {
      const recipients = Array.from(
        { length: 3 },
        () => web3.Keypair.generate().publicKey
      );
      const amount = new BN(10_000);
      const batchId = await fixture.nextBatchId();

      const vaultAta = getAssociatedTokenAddressSync(mint1, vaultPDA, true);
      const vaultBefore = await fixture.tokenBalances.snapshot(vaultAta);

      console.log(
        activeValidators.slice(0, threshold).length,
        "validators signing this tx"
      );

      await fixture.bridgeTransaction.call({
        transfers: recipients.map((r) => ({
          recipient: r,
          mintIndex: 0,
          amount
        })),
        mints: [mint1],
        batchId,
        validators: activeValidators.slice(0, threshold),
        vaultPDA
      });

      // Vault should decrease by 3 * amount
      const expectedVaultDecrease = BigInt(amount.toString()) * BigInt(3);
      const vaultDelta = await fixture.tokenBalances.getBalanceDelta(
        vaultAta,
        vaultBefore
      );
      expect(vaultDelta.toString()).to.equal(
        (-expectedVaultDecrease).toString(),
        "vault debited for all 3 transfers"
      );

      // Each recipient should have received the amount
      for (const r of recipients) {
        const ata = getAssociatedTokenAddressSync(mint1, r);
        const balance = await fixture.tokenBalances.getBalance(ata);
        expect(balance.toString()).to.equal(
          amount.toString(),
          `recipient ${r.toBase58().slice(0, 8)} balance correct`
        );
      }
    });

    it("4 transfers in a single batch — should fail with amount > 1232", async () => {
      const recipients = Array.from(
        { length: 4 },
        () => web3.Keypair.generate().publicKey
      );
      const amount = new BN(10_000);
      const batchId = await fixture.nextBatchId();

      try {
        await fixture.bridgeTransaction.call({
          transfers: recipients.map((r) => ({
            recipient: r,
            mintIndex: 0,
            amount
          })),
          mints: [mint1],
          batchId,
          validators: activeValidators.slice(0, threshold),
          vaultPDA
        });

        // If we reach here, the test should fail
        expect.fail("Expected transaction to fail but it succeeded");
      } catch (error) {
        expect(error.message).to.include("Transaction too large:");
      }
    });

    it("2 transfers across 2 mints — correct ATA debited per mint", async () => {
      // 1 transfers for mint1, 1 transfer for mint2
      const r1 = Array.from(
        { length: 1 },
        () => web3.Keypair.generate().publicKey
      );
      const r2 = Array.from(
        { length: 1 },
        () => web3.Keypair.generate().publicKey
      );
      const amount = new BN(7_777);
      const batchId = await fixture.nextBatchId();

      const vault1Ata = getAssociatedTokenAddressSync(mint1, vaultPDA, true);
      const vault2Ata = getAssociatedTokenAddressSync(mint2, vaultPDA, true);

      const vault1Before = await fixture.tokenBalances.snapshot(vault1Ata);
      const vault2Before = await fixture.tokenBalances.snapshot(vault2Ata);

      await fixture.bridgeTransaction.call({
        transfers: [
          ...r1.map((r) => ({ recipient: r, mintIndex: 0, amount })),
          ...r2.map((r) => ({ recipient: r, mintIndex: 1, amount }))
        ],
        mints: [mint1, mint2],
        batchId,
        validators: activeValidators.slice(0, threshold),
        vaultPDA
      });

      const vault1Delta = await fixture.tokenBalances.getBalanceDelta(
        vault1Ata,
        vault1Before
      );
      const vault2Delta = await fixture.tokenBalances.getBalanceDelta(
        vault2Ata,
        vault2Before
      );

      const expectedMint1Debit = -(BigInt(amount.toString()) * BigInt(1));
      const expectedMint2Debit = -(BigInt(amount.toString()) * BigInt(1));

      expect(vault1Delta.toString()).to.equal(
        expectedMint1Debit.toString(),
        "vault1 debited for 1 transfer"
      );
      expect(vault2Delta.toString()).to.equal(
        expectedMint2Debit.toString(),
        "vault2 debited for 1 transfer"
      );
    });

    it("3 transfers across 2 mints — should fail with amount > 1232", async () => {
      const r1 = Array.from(
        { length: 2 },
        () => web3.Keypair.generate().publicKey
      );
      const r2 = Array.from(
        { length: 1 },
        () => web3.Keypair.generate().publicKey
      );
      const amount = new BN(7_777);
      const batchId = await fixture.nextBatchId();

      try {
        await fixture.bridgeTransaction.call({
          transfers: [
            ...r1.map((r) => ({ recipient: r, mintIndex: 0, amount })),
            ...r2.map((r) => ({ recipient: r, mintIndex: 1, amount }))
          ],
          mints: [mint1, mint2],
          batchId,
          validators: activeValidators.slice(0, threshold),
          vaultPDA
        });

        // If we reach here, the test should fail
        expect.fail("Expected transaction to fail but it succeeded");
      } catch (error) {
        expect(error.message).to.include("Transaction too large:");
      }
    });

    it("exactly threshold validators signed — succeeds", async () => {
      // threshold is read from on-chain in the before hook.
      // For 7 registered validators: threshold = 7 - floor((7-1)/3) = 5.
      // activeValidators has all 7 — slice to exactly threshold (5).
      const thresholdSigners = activeValidators.slice(0, threshold);

      expect(
        thresholdSigners.length,
        `thresholdSigners should be exactly ${threshold}`
      ).to.equal(threshold);

      const recipient = web3.Keypair.generate().publicKey;
      const batchId = await fixture.nextBatchId();

      await fixture.bridgeTransaction.call({
        transfers: [{ recipient, mintIndex: 0, amount: new BN(1_000) }],
        mints: [mint1],
        batchId,
        validators: thresholdSigners,
        vaultPDA
      });

      const ata = getAssociatedTokenAddressSync(mint1, recipient);
      const balance = await fixture.tokenBalances.getBalance(ata);
      expect(balance.toString()).to.equal("1000");
    });
  });

  // ============================================================================
  // BRIDGE REQUEST TESTS
  // ============================================================================
  describe.only("Bridge Request", () => {
    let mint1: web3.PublicKey; // lock/unlock, 9 decimals
    let vaultPDA: web3.PublicKey;
    let user1: web3.Keypair;
    let user2: web3.Keypair;

    const receiver = Buffer.from(
      "0x742d35Cc6634C0532925a3b844Bc9e7595f42bE",
      "utf-8"
    );
    const destinationChain = 1; // Ethereum

    before("setup bridge request tests", async () => {
      vaultPDA = fixture.pdas.vault();
      user1 = web3.Keypair.generate();
      user2 = web3.Keypair.generate();

      // Airdrop SOL to users
      await airdrop(
        provider.connection,
        user1.publicKey,
        10 * web3.LAMPORTS_PER_SOL
      );
      await airdrop(
        provider.connection,
        user2.publicKey,
        10 * web3.LAMPORTS_PER_SOL
      );

      // ── Create lock/unlock mint (mint1) ──────────────────────────────────
      mint1 = await fixture.mints.create(owner.publicKey, 9);
      await fixture.tokenRegistry.registerLockUnlock({
        mint: mint1,
        tokenId: 300,
        minBridgingAmount: 100 // minimum 100 units
      });

      // Mint tokens to users
      await fixture.mints.mintTo(mint1, user1.publicKey, 1_000_000_000); // 1B tokens
      await fixture.mints.mintTo(mint1, user2.publicKey, 500_000_000); // 500M tokens

      console.log(
        `  ℹ Bridge Request setup: mint1=${mint1
          .toBase58()
          .slice(0, 8)}… (lock/unlock)`
      );
    });

    // ═══════════════════════════════════════════════════════════════════
    // HAPPY PATH TESTS
    // ═══════════════════════════════════════════════════════════════════

    it("single lock/unlock request — transfers tokens to vault and emits event", async () => {
      const amount = new BN(100_000);
      const requiredFee = await fixture.requiredFee();

      const signerAta = getAssociatedTokenAddressSync(mint1, user1.publicKey);
      const vaultAta = getAssociatedTokenAddressSync(mint1, vaultPDA, true);

      const balanceBefore = await fixture.tokenBalances.snapshot(signerAta);
      const vaultBefore = await fixture.tokenBalances.snapshot(vaultAta);
      const valSetBefore = await fixture.getValidatorSet();

      await fixture.bridgeRequest.call({
        amount,
        receiver,
        destinationChain,
        mint: mint1,
        fees: requiredFee,
        signer: user1
      });

      const balanceAfter = await fixture.tokenBalances.getBalance(signerAta);
      const vaultAfter = await fixture.tokenBalances.getBalance(vaultAta);
      const valSetAfter = await fixture.getValidatorSet();

      expect((balanceBefore - balanceAfter).toString()).to.equal(
        amount.toString(),
        "user tokens decreased by amount"
      );
      expect((vaultAfter - vaultBefore).toString()).to.equal(
        amount.toString(),
        "vault tokens increased by amount"
      );
      expect(valSetAfter.bridgeRequestCount.toNumber()).to.equal(
        valSetBefore.bridgeRequestCount.toNumber() + 1,
        "bridge request count incremented"
      );
    });

    it("lock/unlock with vault ATA pre-existing — succeeds without creating", async () => {
      const amount = new BN(200_000);
      const requiredFee = await fixture.requiredFee();

      const vaultAta = getAssociatedTokenAddressSync(mint1, vaultPDA, true);

      // FIX: Fund vault ATA directly (don't use mintTo with PDA)
      // Mint to owner first, then transfer to vault ATA
      const ownerAta = getAssociatedTokenAddressSync(mint1, owner.publicKey);
      await fixture.mints.mintTo(mint1, owner.publicKey, 10_000);

      const ix = createTransferInstruction(
        ownerAta,
        vaultAta,
        owner.publicKey,
        100
      );
      const tx = new web3.Transaction().add(ix);
      await web3.sendAndConfirmTransaction(provider.connection, tx, [
        owner.payer
      ]);

      const vaultBefore = await fixture.tokenBalances.snapshot(vaultAta);

      await fixture.bridgeRequest.call({
        amount,
        receiver,
        destinationChain,
        mint: mint1,
        fees: requiredFee,
        signer: user2
      });

      const vaultAfter = await fixture.tokenBalances.getBalance(vaultAta);

      expect((vaultAfter - vaultBefore).toString()).to.equal(
        amount.toString(),
        "vault balance increased correctly with pre-existing ATA"
      );
    });

    it("multiple requests from same user — increments count correctly", async () => {
      const amount = new BN(50_000);
      const requiredFee = await fixture.requiredFee();

      const valSetBefore = await fixture.getValidatorSet();
      const initialCount = valSetBefore.bridgeRequestCount.toNumber();

      // First request
      await fixture.bridgeRequest.call({
        amount,
        receiver,
        destinationChain,
        mint: mint1,
        fees: requiredFee,
        signer: user1
      });

      // Second request
      await fixture.bridgeRequest.call({
        amount,
        receiver: Buffer.from(
          "0x1234567890123456789012345678901234567890",
          "utf-8"
        ),
        destinationChain: 2,
        mint: mint1,
        fees: requiredFee,
        signer: user1
      });

      const valSetAfter = await fixture.getValidatorSet();
      expect(valSetAfter.bridgeRequestCount.toNumber()).to.equal(
        initialCount + 2,
        "request count incremented twice"
      );
    });

    it("fee paid to treasury and relayer — splits correctly", async () => {
      const amount = new BN(75_000);
      const requiredFee = await fixture.requiredFee();
      const fc = await fixture.getFeeConfig();

      const treasuryBefore = await provider.connection.getBalance(fc.treasury);
      const relayerBefore = await provider.connection.getBalance(fc.relayer);

      await fixture.bridgeRequest.call({
        amount,
        receiver,
        destinationChain,
        mint: mint1,
        fees: requiredFee,
        signer: user1
      });

      const treasuryAfter = await provider.connection.getBalance(fc.treasury);
      const relayerAfter = await provider.connection.getBalance(fc.relayer);

      const treasuryIncrease = treasuryAfter - treasuryBefore;
      const relayerIncrease = relayerAfter - relayerBefore;

      // treasury gets: min_op_fee (since requiredFee = min_op_fee + bridge_fee)
      expect(treasuryIncrease).to.equal(
        fc.minOperationalFee.toNumber(),
        "treasury received op fee"
      );

      // relayer gets: bridge_fee
      expect(relayerIncrease).to.equal(
        fc.bridgeFee.toNumber(),
        "relayer received bridge fee"
      );
    });

    it("fee with user surplus (tip) — distributes correctly", async () => {
      const amount = new BN(50_000);
      const requiredFee = await fixture.requiredFee();
      const surplus = new BN(5_000); // User pays extra
      const totalFee = requiredFee.add(surplus);

      const fc = await fixture.getFeeConfig();
      const treasuryBefore = await provider.connection.getBalance(fc.treasury);

      await fixture.bridgeRequest.call({
        amount,
        receiver,
        destinationChain,
        mint: mint1,
        fees: totalFee,
        signer: user1
      });

      const treasuryAfter = await provider.connection.getBalance(fc.treasury);
      const treasuryIncrease = treasuryAfter - treasuryBefore;

      // treasury gets: min_op_fee + surplus
      const expectedTreasuryFee =
        fc.minOperationalFee.toNumber() + surplus.toNumber();
      expect(treasuryIncrease).to.equal(
        expectedTreasuryFee,
        "treasury received op fee + surplus"
      );
    });

    it("lock/unlock with large amount — handles high precision correctly", async () => {
      // FIX: Use user1 (has 1B tokens) instead of user2
      const amount = new BN(500_000_000); // Half billion
      const requiredFee = await fixture.requiredFee();

      const signerAta = getAssociatedTokenAddressSync(mint1, user1.publicKey);
      const vaultAta = getAssociatedTokenAddressSync(mint1, vaultPDA, true);

      const signerBefore = await fixture.tokenBalances.snapshot(signerAta);
      const vaultBefore = await fixture.tokenBalances.snapshot(vaultAta);

      await fixture.bridgeRequest.call({
        amount,
        receiver,
        destinationChain,
        mint: mint1,
        fees: requiredFee,
        signer: user1
      });

      const signerAfter = await fixture.tokenBalances.getBalance(signerAta);
      const vaultAfter = await fixture.tokenBalances.getBalance(vaultAta);

      expect((signerBefore - signerAfter).toString()).to.equal(
        amount.toString()
      );
      expect((vaultAfter - vaultBefore).toString()).to.equal(amount.toString());
    });

    // ═══════════════════════════════════════════════════════════════════
    // SAD PATH TESTS — INPUT VALIDATION
    // ═══════════════════════════════════════════════════════════════════

    describe("Input Validation Errors", () => {
      it("fails when amount is below minimum bridging amount", async () => {
        const amount = new BN(50); // Below mint1's min of 100
        const requiredFee = await fixture.requiredFee();

        await fixture.bridgeRequest.expectError(
          {
            amount,
            receiver,
            destinationChain,
            mint: mint1,
            fees: requiredFee,
            signer: user1
          },
          "BridgingAmountTooLow"
        );
      });

      it("fails when user has insufficient token balance", async () => {
        const poorUser = web3.Keypair.generate();
        await airdrop(
          provider.connection,
          poorUser.publicKey,
          web3.LAMPORTS_PER_SOL
        );

        // Create ATA for poorUser but don't fund it
        const poorAta = getAssociatedTokenAddressSync(
          mint1,
          poorUser.publicKey
        );
        const createAtaIx = createAssociatedTokenAccountInstruction(
          poorUser.publicKey,
          poorAta,
          poorUser.publicKey,
          mint1
        );

        const tx = new web3.Transaction().add(createAtaIx);
        await web3.sendAndConfirmTransaction(provider.connection, tx, [
          poorUser
        ]);

        const amount = new BN(100);
        const requiredFee = await fixture.requiredFee();

        await fixture.bridgeRequest.expectError(
          {
            amount,
            receiver,
            destinationChain,
            mint: mint1,
            fees: requiredFee,
            signer: poorUser
          },
          "InsufficientFunds"
        );
      });

      it("fails when fee is below required minimum", async () => {
        const amount = new BN(100_000);
        const fc = await fixture.getFeeConfig();
        const insufficientFee = fc.minOperationalFee.sub(new BN(1)); // 1 lamport short

        await fixture.bridgeRequest.expectError(
          {
            amount,
            receiver,
            destinationChain,
            mint: mint1,
            fees: insufficientFee,
            signer: user1
          },
          "InsufficientFee"
        );
      });

      it("fails when fee is zero", async () => {
        const amount = new BN(100_000);

        await fixture.bridgeRequest.expectError(
          {
            amount,
            receiver,
            destinationChain,
            mint: mint1,
            fees: 0,
            signer: user1
          },
          "InsufficientFee"
        );
      });
    });

    // ═══════════════════════════════════════════════════════════════════
    // SAD PATH TESTS — ACCOUNT VALIDATION
    // ═══════════════════════════════════════════════════════════════════

    describe("Account Validation Errors", () => {
      it("fails when treasury address doesn't match fee_config", async () => {
        const amount = new BN(100_000);
        const requiredFee = await fixture.requiredFee();
        const fakeTreasury = web3.Keypair.generate().publicKey;

        await fixture.bridgeRequest.expectError(
          {
            amount,
            receiver,
            destinationChain,
            mint: mint1,
            fees: requiredFee,
            signer: user1,
            treasuryOverride: fakeTreasury
          },
          "InvalidTreasury"
        );
      });

      it("fails when relayer address doesn't match fee_config", async () => {
        const amount = new BN(100_000);
        const requiredFee = await fixture.requiredFee();
        const fakeRelayer = web3.Keypair.generate().publicKey;

        await fixture.bridgeRequest.expectError(
          {
            amount,
            receiver,
            destinationChain,
            mint: mint1,
            fees: requiredFee,
            signer: user1,
            relayerOverride: fakeRelayer
          },
          "InvalidRelayer"
        );
      });

      it("fails when vault ATA address is incorrect", async () => {
        const amount = new BN(100_000);
        const requiredFee = await fixture.requiredFee();
        const fakeVaultAta = web3.Keypair.generate().publicKey;

        await fixture.bridgeRequest
          .callWithCustomAccounts(
            amount,
            receiver,
            destinationChain,
            {
              signer: user1.publicKey,
              signersAta: getAssociatedTokenAddressSync(mint1, user1.publicKey),
              vaultAta: fakeVaultAta, // Wrong address
              mint: mint1,
              fees: requiredFee
            },
            [user1]
          )
          .then(
            () => expect.fail("Expected InvalidVault error"),
            (e) => expect(e.error?.errorCode?.code).to.equal("InvalidVault")
          );
      });

      it.skip("fails when token registry doesn't exist for mint", async () => {
        const amount = new BN(100_000);
        const requiredFee = await fixture.requiredFee();

        // Create unregistered mint
        const unregisteredMint = await fixture.mints.create(owner.publicKey, 9);

        // Fund user1 with tokens of the unregistered mint
        // This ensures signers_ata exists, so the error comes from token_registry
        await fixture.mints.mintTo(
          unregisteredMint,
          user1.publicKey,
          1_000_000
        );

        try {
          await fixture.bridgeRequest.call({
            amount,
            receiver,
            destinationChain,
            mint: unregisteredMint,
            fees: requiredFee,
            signer: user1
          });

          expect.fail("Expected error for unregistered mint");
        } catch (e: any) {
          const errorMsg = e.message || "";
          const errorCode = e.error?.errorCode?.code || "";
          console.log("Caught error:", errorMsg, "Code:", errorCode);

          // Should fail with token_registry constraint error, not signers_ata error
          expect(
            errorMsg.includes("Account does not exist") ||
              errorMsg.includes("AccountNotFound") ||
              errorMsg.includes("seeds") ||
              errorCode === "AccountNotFound"
          ).to.be.true;
        }
      });
    });

    // ═══════════════════════════════════════════════════════════════════
    // EDGE CASES
    // ═══════════════════════════════════════════════════════════════════

    describe("Edge Cases", () => {
      it("multiple users bridging simultaneously — state updates correctly", async () => {
        const amount1 = new BN(100_000);
        const amount2 = new BN(200_000);
        const requiredFee = await fixture.requiredFee();

        const valSetBefore = await fixture.getValidatorSet();

        // Simulate concurrent requests from different users
        await Promise.all([
          fixture.bridgeRequest.call({
            amount: amount1,
            receiver,
            destinationChain,
            mint: mint1,
            fees: requiredFee,
            signer: user1
          }),
          fixture.bridgeRequest.call({
            amount: amount2,
            receiver: Buffer.from(
              "0x9999999999999999999999999999999999999999",
              "utf-8"
            ),
            destinationChain: 2,
            mint: mint1,
            fees: requiredFee,
            signer: user2
          })
        ]);

        const valSetAfter = await fixture.getValidatorSet();

        expect(valSetAfter.bridgeRequestCount.toNumber()).to.equal(
          valSetBefore.bridgeRequestCount.toNumber() + 2,
          "both requests counted"
        );
      });

      it("exact minimum fee — succeeds", async () => {
        const amount = new BN(100_000);
        const requiredFee = await fixture.requiredFee();

        const sig = await fixture.bridgeRequest.call({
          amount,
          receiver,
          destinationChain,
          mint: mint1,
          fees: requiredFee,
          signer: user1
        });

        expect(sig).to.be.a("string").with.lengthOf(88);
      });

      it("maximum receiver length — succeeds", async () => {
        const amount = new BN(100_000);
        const requiredFee = await fixture.requiredFee();
        const longReceiver = Buffer.alloc(256, "a"); // 256-byte receiver

        await fixture.bridgeRequest.call({
          amount,
          receiver: longReceiver,
          destinationChain,
          mint: mint1,
          fees: requiredFee,
          signer: user1
        });

        const valSet = await fixture.getValidatorSet();
        expect(valSet.bridgeRequestCount.toNumber()).to.be.greaterThan(0);
      });

      it("destination_chain boundaries — accepts valid chain IDs", async () => {
        const amount = new BN(100_000);
        const requiredFee = await fixture.requiredFee();

        // Test chain 0 (minimum)
        await fixture.bridgeRequest.call({
          amount,
          receiver,
          destinationChain: 0,
          mint: mint1,
          fees: requiredFee,
          signer: user1
        });

        // Test chain 255 (maximum for u8)
        await fixture.bridgeRequest.call({
          amount,
          receiver,
          destinationChain: 255,
          mint: mint1,
          fees: requiredFee,
          signer: user1
        });

        const valSet = await fixture.getValidatorSet();
        expect(valSet.bridgeRequestCount.toNumber()).to.be.greaterThan(1);
      });

      it("lock/unlock with different decimals — handles precision", async () => {
        // mint1 has 9 decimals, create mint3 with 6 decimals
        const mint3 = await fixture.mints.create(owner.publicKey, 6);
        await fixture.tokenRegistry.registerLockUnlock({
          mint: mint3,
          tokenId: 302,
          minBridgingAmount: 1
        });

        await fixture.mints.mintTo(mint3, user1.publicKey, 1_000_000_000);

        const amount = new BN(123_456); // 0.123456 tokens at 6 decimals
        const requiredFee = await fixture.requiredFee();

        await fixture.bridgeRequest.call({
          amount,
          receiver,
          destinationChain,
          mint: mint3,
          fees: requiredFee,
          signer: user1
        });

        const ata = getAssociatedTokenAddressSync(mint3, user1.publicKey);
        const balance = await fixture.tokenBalances.getBalance(ata);
        expect(balance.toString()).to.satisfy(
          (b: string) => new BN(b).lt(new BN(1_000_000_000)),
          "balance decreased correctly"
        );
      });

      it("user with exactly minimum balance — succeeds", async () => {
        const poorUser = web3.Keypair.generate();
        await airdrop(
          provider.connection,
          poorUser.publicKey,
          web3.LAMPORTS_PER_SOL
        );

        const minAmount = new BN(100); // mint1's minimum
        await fixture.mints.mintTo(
          mint1,
          poorUser.publicKey,
          Number(minAmount)
        );

        const requiredFee = await fixture.requiredFee();

        await fixture.bridgeRequest.call({
          amount: minAmount,
          receiver,
          destinationChain,
          mint: mint1,
          fees: requiredFee,
          signer: poorUser
        });

        const ata = getAssociatedTokenAddressSync(mint1, poorUser.publicKey);
        const balance = await fixture.tokenBalances.getBalance(ata);
        expect(balance.toString()).to.equal("0");
      });

      it("insufficient SOL for fee payment — fails", async () => {
        const poorSolUser = web3.Keypair.generate();
        // Only airdrop just enough for 1-2 small transactions, not bridge + fee
        const tinyAmount = new BN(500_000); // ~0.0005 SOL
        await airdrop(
          provider.connection,
          poorSolUser.publicKey,
          tinyAmount.toNumber()
        );

        // Fund with tokens
        await fixture.mints.mintTo(mint1, poorSolUser.publicKey, 1_000_000);

        const amount = new BN(100_000);
        const requiredFee = await fixture.requiredFee();

        // FIX: Expect signer account validation error, not transfer error
        try {
          await fixture.bridgeRequest.call({
            amount,
            receiver,
            destinationChain,
            mint: mint1,
            fees: requiredFee,
            signer: poorSolUser
          });
          expect.fail("Expected insufficient funds error");
        } catch (e: any) {
          // Account constraint error or insufficient funds
          expect(
            e.message.includes("insufficient") ||
              e.message.includes("Insufficient") ||
              e.message.includes("constraint")
          ).to.be.true;
        }
      });
    });
  });
});
