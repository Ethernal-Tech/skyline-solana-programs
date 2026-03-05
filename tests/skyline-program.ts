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

    describe("Success Case", () => {
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
  /*
  describe("Bridge Request", () => {
    // Test data
    let transferMint: web3.PublicKey; // Vault does NOT have mint authority
    let burnMint: web3.PublicKey; // Vault DOES have mint authority
    const user = anchor.web3.Keypair.generate();
    const vaultPDA = fixture.pdas.vault();

    // Standard test parameters
    const validReceiver = Buffer.from(
      "0x1234567890abcdef1234567890abcdef12345678"
    );
    const destinationChain = 1; // Ethereum

    before(async () => {
      // Airdrop to user
      await provider.connection.requestAirdrop(
        user.publicKey,
        10 * web3.LAMPORTS_PER_SOL
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
          user.publicKey
        );
        const vaultAta = getAssociatedTokenAddressSync(
          transferMint,
          vaultPDA,
          true
        );

        const userBalanceBefore = await fixture.tokenBalances.getBalance(
          userAta
        );
        const vaultBalanceBefore = await fixture.tokenBalances.getBalance(
          vaultAta
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
          userAta
        );
        const vaultBalanceAfter = await fixture.tokenBalances.getBalance(
          vaultAta
        );

        expect(userBalanceBefore - userBalanceAfter).to.equal(BigInt(100));
        expect(vaultBalanceAfter - vaultBalanceBefore).to.equal(BigInt(100));

        // Verify bridge_request_count incremented
        const vsAfter = await fixture.getValidatorSet();
        expect(vsAfter.bridgeRequestCount.toNumber()).to.equal(
          requestCountBefore + 1
        );

        // Verify event was emitted
        const event = await fixture.events.parseBridgeRequestEvent(signature);
        expect(event).to.not.equal(null);
        expect(event!.sender.toBase58()).to.equal(user.publicKey.toBase58());
        expect(event!.amount.toNumber()).to.equal(100);
        expect(Buffer.from(event!.receiver).toString("hex")).to.equal(
          validReceiver.toString("hex")
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
          true
        );
        const vaultBalanceBefore = await fixture.tokenBalances.getBalance(
          vaultAta
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
          vaultAta
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
          userAta
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
          userAta
        );
        expect(userBalanceBefore - userBalanceAfter).to.equal(BigInt(200));

        // Verify mint supply decreased
        const mintAfter = await fixture.mints.getMintInfo(burnMint);
        expect(supplyBefore - mintAfter.supply).to.equal(BigInt(200));

        // Verify NO vault ATA was created (tokens were burned, not transferred)
        const vaultAta = getAssociatedTokenAddressSync(
          burnMint,
          vaultPDA,
          true
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
          requestCountBefore + 1
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
          user.publicKey
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
          user.publicKey
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
          "InsufficientFunds"
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
          user.publicKey
        );

        await fixture.bridgeRequest.expectError(
          {
            amount: 1,
            receiver: validReceiver,
            destinationChain,
            mint: emptyMint,
            signer: user,
          },
          "InsufficientFunds"
        );
      });

      it("rejects with wrong mint in signers_ata", async () => {
        // User has tokens for transferMint, but we pass wrong ATA
        const wrongMint = await fixture.mints.create(owner.publicKey, 9);
        const wrongAta = await getOrCreateAssociatedTokenAccount(
          provider.connection,
          owner.payer,
          wrongMint,
          user.publicKey
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
                true
              ),
              mint: transferMint,
            },
            [user]
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
            msg.includes("token")
        );
      });

      it("rejects when vault_ata is canonical ATA for wrong mint", async () => {
        // Create ATA for wrong mint
        const wrongMint = await fixture.mints.create(owner.publicKey, 9);
        const wrongVaultAta = await getOrCreateAssociatedTokenAccount(
          provider.connection,
          owner.payer,
          wrongMint,
          vaultPDA,
          true
        );

        try {
          await fixture.bridgeRequest.callWithCustomAccounts(
            100,
            validReceiver,
            destinationChain,
            {
              signer: user.publicKey,
              signersAta: getAssociatedTokenAddressSync(
                transferMint,
                user.publicKey
              ),
              vaultAta: wrongVaultAta.address, // ATA for (vault, wrongMint)
              mint: transferMint, // But claiming transferMint
            },
            [user]
          );
          expect.fail("Should have thrown InvalidVault");
        } catch (e: any) {
          // With UncheckedAccount + address constraint:
          // Expected: get_associated_token_address(vault, transferMint)
          // Actual:   wrongVaultAta (address for (vault, wrongMint))
          // These addresses don't match → InvalidVault
          expect(e?.error?.errorCode?.code).to.equal("InvalidVault");
        }
      });

      it("rejects with wrong vault_ata owner", async () => {
        const notVault = anchor.web3.Keypair.generate();
        const wrongOwnerAta = await getOrCreateAssociatedTokenAccount(
          provider.connection,
          owner.payer,
          transferMint,
          notVault.publicKey
        );

        try {
          await fixture.bridgeRequest.callWithCustomAccounts(
            100,
            validReceiver,
            destinationChain,
            {
              signer: user.publicKey,
              signersAta: getAssociatedTokenAddressSync(
                transferMint,
                user.publicKey
              ),
              vaultAta: wrongOwnerAta.address, // Correct mint, wrong owner
              mint: transferMint,
            },
            [user]
          );
          expect.fail("Should have thrown InvalidVault");
        } catch (e: any) {
          // With manual constraint, we check the derived address
          // wrongOwnerAta != get_associated_token_address(vault, mint)
          expect(e?.error?.errorCode?.code).to.equal("InvalidVault");
        }
      });

      it("rejects when vault_ata is not a valid ATA address", async () => {
        const randomAccount = web3.Keypair.generate();

        try {
          await fixture.bridgeRequest.callWithCustomAccounts(
            100,
            validReceiver,
            destinationChain,
            {
              signer: user.publicKey,
              signersAta: getAssociatedTokenAddressSync(
                transferMint,
                user.publicKey
              ),
              vaultAta: randomAccount.publicKey,
              mint: transferMint,
            },
            [user]
          );
          expect.fail("Should have thrown InvalidVault");
        } catch (e: any) {
          expect(e?.error?.errorCode?.code).to.equal("InvalidVault");
        }
      });
    });

    // ============================================================================
    // EDGE CASES
    // ============================================================================

    describe("Edge Cases", () => {
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

      it("handles large amount (close to u64::MAX)", async () => {
        // Create mint with large supply
        const largeMint = await fixture.mints.create(owner.publicKey, 0);

        const largeAmount = BigInt("18446744073709551615"); // u64::MAX
        const testAmount = largeAmount / BigInt(1000); // Use 1/1000th to avoid overflow

        // Mint large amount to user
        await fixture.mints.mintTo(
          largeMint,
          user.publicKey,
          Number(testAmount)
        );

        const userAta = getAssociatedTokenAddressSync(
          largeMint,
          user.publicKey
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
          "hex"
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
          "hex"
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
          chainIds.length
        );
      });

      it("handles frozen user token account", async () => {
        const freezeAuthority = anchor.web3.Keypair.generate();
        const freezableMint = await fixture.mints.createWithFreezeAuthority(
          owner.publicKey,
          freezeAuthority.publicKey,
          9
        );

        // Fund user
        await fixture.mints.mintTo(freezableMint, user.publicKey, 1000);

        const userAta = getAssociatedTokenAddressSync(
          freezableMint,
          user.publicKey
        );

        // Freeze user's account
        await fixture.mints.freezeTokenAccount(
          freezableMint,
          userAta,
          freezeAuthority
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
          true
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
  */
});
