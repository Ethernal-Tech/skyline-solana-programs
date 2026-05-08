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
  createSyncNativeInstruction,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  NATIVE_MINT
} from "@solana/spl-token";
import { BN } from "bn.js";

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
  // INITIALIZE TESTS
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

            const pc = await fixture.getProgramConfig();
            expect(pc.versionString).to.equal("0.1.0");
            expect(pc.authority.toBase58()).to.equal(owner.publicKey.toBase58());

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

        const pc = await fixture.getProgramConfig();
        expect(pc.versionString).to.equal("0.1.0");
        expect(pc.authority.toBase58()).to.equal(owner.publicKey.toBase58());
        expect(pc.deployedAt.toNumber()).to.be.greaterThan(0);
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

  // ============================================================================
  // BRIDGE TRANSACTION TESTS
  // ============================================================================
  // ============================================================================
  // BRIDGE REQUEST TESTS
  // ============================================================================
  describe("Bridge Request", () => {
    let mint1: web3.PublicKey; // lock/unlock, 9 decimals
    let vaultPDA: web3.PublicKey;
    let user1: web3.Keypair;
    let user2: web3.Keypair;

    const receiver = "0x742d35Cc6634C0532925a3b844Bc9e7595f42bE";

    const destinationChain = "1"; // Ethereum

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

      // ── Create lock/unlock mint (mint1)
      mint1 = await fixture.mints.create(owner.publicKey, 9);
      await fixture.tokenRegistry.registerLockUnlock({
        mint: mint1,
        tokenId: 300,
        minBridgingAmount: 100 // minimum 100 units
      });

      // Mint tokens to users
      await fixture.mints.mintTo(mint1, user1.publicKey, 1_000_000_000); // 1B tokens
      await fixture.mints.mintTo(mint1, user2.publicKey, 500_000_000); // 500M tokens

      /* console.log(
        `  ℹ Bridge Request setup: mint1=${mint1
          .toBase58()
          .slice(0, 8)}… (lock/unlock)`
      ); */
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
        const insufficientFee = fc.minOperationalFee
          .add(fc.bridgeFee)
          .sub(new BN(1)); // 1 lamport short

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

      it("fails when token registry doesn't exist for mint", async () => {
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

          // Should fail with token_registry constraint error, not signers_ata error
          expect(errorMsg).to.include("token_registry");
          expect(errorCode).to.equal("AccountNotInitialized");
        }
      });
    });

    // ═══════════════════════════════════════════════════════════════════
    // HAPPY PATH TESTS
    // ═══════════════════════════════════════════════════════════════════
    describe("Happy Paths", () => {
      it("single lock/unlock request — transfers tokens to vault", async () => {
        const amount = new BN(100_000);
        const requiredFee = await fixture.requiredFee();

        const signerAta = getAssociatedTokenAddressSync(mint1, user1.publicKey);
        const vaultAta = getAssociatedTokenAddressSync(mint1, vaultPDA, true);

        const balanceBefore = await fixture.tokenBalances.snapshot(signerAta);
        const vaultBefore = await fixture.tokenBalances.snapshot(vaultAta);
        const valSetBefore = await fixture.getValidatorSet();

        // tests before doesn't touch the vault, so it should start at 0
        expect(vaultBefore).to.equal(
          BigInt(0),
          "vault should start with 0 balance"
        );

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
          receiver: "0x1234567890123456789012345678901234567890",
          destinationChain: "2",
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

        const treasuryBefore = await provider.connection.getBalance(
          fc.treasury
        );
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
        const treasuryBefore = await provider.connection.getBalance(
          fc.treasury
        );

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
        expect((vaultAfter - vaultBefore).toString()).to.equal(
          amount.toString()
        );
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
            receiver: "0x9999999999999999999999999999999999",
            destinationChain: "2",
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

        expect(sig).to.be.a("string").and.not.empty;
      });

      it("destination_chain boundaries — accepts valid chain IDs", async () => {
        const amount = new BN(100_000);
        const requiredFee = await fixture.requiredFee();

        // Test chain 0 (minimum)
        await fixture.bridgeRequest.call({
          amount,
          receiver,
          destinationChain: "0",
          mint: mint1,
          fees: requiredFee,
          signer: user1
        });

        // Test chain 255 (maximum for u8)
        await fixture.bridgeRequest.call({
          amount,
          receiver,
          destinationChain: "255",
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

        // Expect signer account validation error, not transfer error
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

  // ============================================================================
  // HOT WALLET INCREMENT TESTS
  // ============================================================================
  describe("Hot Wallet Increment", () => {
    const wsolMint = NATIVE_MINT;
    let nonWsolMint: web3.PublicKey;
    let user: web3.Keypair;
    let vaultPDA: web3.PublicKey;

    async function wrapSol(
      signer: web3.Keypair,
      lamports: number
    ): Promise<web3.PublicKey> {
      const ata = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        owner.payer,
        wsolMint,
        signer.publicKey
      );

      const tx = new web3.Transaction().add(
        web3.SystemProgram.transfer({
          fromPubkey: signer.publicKey,
          toPubkey: ata.address,
          lamports
        }),
        createSyncNativeInstruction(ata.address)
      );
      await web3.sendAndConfirmTransaction(provider.connection, tx, [signer]);
      return ata.address;
    }

    before("setup hot wallet increment tests", async () => {
      vaultPDA = fixture.pdas.vault();

      user = web3.Keypair.generate();
      await airdrop(
        provider.connection,
        user.publicKey,
        10 * web3.LAMPORTS_PER_SOL
      );

      // Fund user with wSOL for deposit scenarios.
      await wrapSol(user, 10_000_000);

      // A non-wSOL mint for InvalidMintToken validation.
      nonWsolMint = await fixture.mints.create(owner.publicKey, 6);
      await fixture.mints.mintTo(nonWsolMint, user.publicKey, 1_000_000);
    });

    // ════════════════════════════════════════════════════════════════════
    // SAD PATHS
    // ════════════════════════════════════════════════════════════════════

    describe("Validation Errors", () => {
      it("fails when amount is zero", async () => {
        await fixture.hotWalletIncrement.expectError(
          {
            amount: 0,
            mint: wsolMint,
            signer: user
          },
          "InvalidAmount"
        );
      });

      it("fails when signer has insufficient balance", async () => {
        const poorUser = web3.Keypair.generate();
        await airdrop(
          provider.connection,
          poorUser.publicKey,
          web3.LAMPORTS_PER_SOL
        );

        // Wrap only 100 lamports of SOL, then attempt to lock 1_000_000.
        await wrapSol(poorUser, 100);

        await fixture.hotWalletIncrement.expectError(
          {
            amount: 1_000_000,
            mint: wsolMint,
            signer: poorUser
          },
          "InsufficientFunds"
        );
      });

      it("fails when mint is not canonical wSOL", async () => {
        const userAta = getAssociatedTokenAddressSync(nonWsolMint, user.publicKey);
        await fixture.hotWalletIncrement.expectError(
          {
            amount: 100,
            mint: nonWsolMint,
            signer: user,
            signersAtaOverride: userAta
          },
          "InvalidMintToken"
        );
      });

      it("fails when vault ATA address is incorrect", async () => {
        const fakeVaultAta = web3.Keypair.generate().publicKey;

        await fixture.hotWalletIncrement.expectError(
          {
            amount: 100,
            mint: wsolMint,
            signer: user,
            vaultAtaOverride: fakeVaultAta
          },
          "InvalidVault"
        );
      });
    });

    // ════════════════════════════════════════════════════════════════════
    // HAPPY PATHS
    // ════════════════════════════════════════════════════════════════════

    describe("Happy Paths", () => {
      it("locks wSOL, creates vault ATA on first deposit, emits event", async () => {
        const amount = new BN(250_000);
        const signerAta = getAssociatedTokenAddressSync(wsolMint, user.publicKey);
        const vaultAta = getAssociatedTokenAddressSync(wsolMint, vaultPDA, true);

        // Vault ATA for wSOL must not exist yet in this suite.
        const vaultAtaInfoBefore = await provider.connection.getAccountInfo(
          vaultAta
        );
        expect(
          vaultAtaInfoBefore,
          "vault ATA must not pre-exist for first deposit"
        ).to.equal(null);

        const signerBefore = await fixture.tokenBalances.snapshot(signerAta);
        const vaultBefore = await fixture.tokenBalances.snapshot(vaultAta);
        expect(vaultBefore.toString()).to.equal("0");

        const sig = await fixture.hotWalletIncrement.call({
          amount,
          mint: wsolMint,
          signer: user
        });
        expect(sig).to.be.a("string").and.not.empty;

        const signerAfter = await fixture.tokenBalances.getBalance(signerAta);
        const vaultAfter = await fixture.tokenBalances.getBalance(vaultAta);

        expect((signerBefore - signerAfter).toString()).to.equal(
          amount.toString(),
          "signer balance decreased by amount"
        );
        expect((vaultAfter - vaultBefore).toString()).to.equal(
          amount.toString(),
          "vault balance increased by amount"
        );

        // Event is emitted by the program — assert at least one
        // `Program data:` log appears, indicating an Anchor event
        // was emitted by this instruction.
        await new Promise((r) => setTimeout(r, 500));
        const tx = await provider.connection.getTransaction(sig, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0
        });
        const dataLogs = (tx?.meta?.logMessages ?? []).filter((l) =>
          l.includes("Program data:")
        );
        expect(dataLogs.length, "HotWalletIncrementEvent should be emitted")
          .to.be.greaterThan(0);
      });

      it("locks additional tokens into existing vault ATA", async () => {
        const amount = new BN(100_000);
        const signerAta = getAssociatedTokenAddressSync(wsolMint, user.publicKey);
        const vaultAta = getAssociatedTokenAddressSync(wsolMint, vaultPDA, true);

        const vaultBefore = await fixture.tokenBalances.snapshot(vaultAta);
        const signerBefore = await fixture.tokenBalances.snapshot(signerAta);
        // Vault ATA already created by the previous test
        expect(vaultBefore > BigInt(0)).to.equal(true);

        await fixture.hotWalletIncrement.call({
          amount,
          mint: wsolMint,
          signer: user
        });

        const vaultAfter = await fixture.tokenBalances.getBalance(vaultAta);
        const signerAfter = await fixture.tokenBalances.getBalance(signerAta);

        expect((vaultAfter - vaultBefore).toString()).to.equal(
          amount.toString()
        );
        expect((signerBefore - signerAfter).toString()).to.equal(
          amount.toString()
        );
      });

      it("supports multiple sequential deposits from the same user", async () => {
        const vaultAta = getAssociatedTokenAddressSync(wsolMint, vaultPDA, true);
        const before = await fixture.tokenBalances.snapshot(vaultAta);

        await fixture.hotWalletIncrement.call({
          amount: 1_000,
          mint: wsolMint,
          signer: user
        });
        await fixture.hotWalletIncrement.call({
          amount: 2_000,
          mint: wsolMint,
          signer: user
        });
        await fixture.hotWalletIncrement.call({
          amount: 3_000,
          mint: wsolMint,
          signer: user
        });

        const after = await fixture.tokenBalances.getBalance(vaultAta);
        expect((after - before).toString()).to.equal("6000");
      });
    });
  });

  // ============================================================================
  // VALIDATOR SET UPDATE TESTS
  // ============================================================================
  describe("Bridge Validator Set Update", function () {
    // ========================================================================
    // The test suite runs AFTER the "initializes state correctly with 5
    // validators" test which gives us:
    //   validators[0..4]  — current set (5 validators, threshold = 4)
    //   validators[5..]   — fresh keypairs available to be added
    // ========================================================================

    // Convenience: first 5 validators form the initial set
    const INITIAL_COUNT = 5;

    // Helper: pick the first `n` keypairs from validators[] as Keypair objects.
    // validators[] is declared in the outer describe scope.
    function currentValidators(n = INITIAL_COUNT): web3.Keypair[] {
      return validators.slice(0, n);
    }

    // ========================================================================
    // HAPPY PATH TESTS
    // ========================================================================

    describe("happy paths", function () {
      it("adds a single new validator with threshold signers", async function () {
        // State: 5 validators, threshold = 4
        const batchId = await fixture.nextBatchId();
        const vsBefore = await fixture.getValidatorSet();
        const currentSigners = currentValidators();
        const newValidator = validators[5]; // not yet in set

        // Sign with exactly threshold (4) validators
        const signers = currentSigners.slice(0, vsBefore.threshold);

        await fixture.bridgeVSU.call({
          added: [newValidator.publicKey],
          removed: [],
          batchId,
          signerKeypairs: signers
        });

        const vsAfter = await fixture.getValidatorSet();
        const expectedValidators = [
          ...currentSigners.map((v) => v.publicKey),
          newValidator.publicKey
        ];
        const expectedThreshold = calculateExpectedThreshold(
          expectedValidators.length
        );

        assertValidatorSetState(vsAfter, {
          validators: expectedValidators,
          threshold: expectedThreshold,
          lastBatchId: batchId,
          bridgeRequestCount: vsBefore.bridgeRequestCount
        });

        console.log(
          `  ✓ Added validator[5], set is now ${vsAfter.signers.length}, threshold=${vsAfter.threshold}`
        );
      });

      it("removes a validator with all current signers", async function () {
        // State: 6 validators (added validator[5] in previous test)
        const batchId = await fixture.nextBatchId();
        const vsBefore = await fixture.getValidatorSet();

        // Remove validator[5] that was just added
        const toRemove = validators[5].publicKey;

        // All 6 current signers sign (> threshold)
        const allCurrentSigners = validators
          .slice(0, 6)
          .filter((v) => !v.publicKey.equals(toRemove));

        await fixture.bridgeVSU.call({
          added: [],
          removed: [toRemove],
          batchId,
          signerKeypairs: allCurrentSigners
        });

        const vsAfter = await fixture.getValidatorSet();
        const expectedValidators = validators
          .slice(0, 5)
          .map((v) => v.publicKey);
        const expectedThreshold = calculateExpectedThreshold(
          expectedValidators.length
        );

        assertValidatorSetState(vsAfter, {
          validators: expectedValidators,
          threshold: expectedThreshold,
          lastBatchId: batchId,
          bridgeRequestCount: vsBefore.bridgeRequestCount
        });

        console.log(
          `  ✓ Removed validator[5], set is back to ${vsAfter.signers.length}`
        );
      });

      it("adds and removes in the same transaction (swap)", async function () {
        // State: 5 validators [0..4], threshold = 4
        const batchId = await fixture.nextBatchId();
        const vsBefore = await fixture.getValidatorSet();

        const toAdd = validators[6].publicKey; // fresh
        const toRemove = validators[4].publicKey; // last in current set

        // Sign with threshold (4) of the current validators
        // validator[4] is being removed but can still sign (it's still in the
        // set at validation time — removal happens at mutation phase)
        const signers = validators.slice(0, vsBefore.threshold);

        await fixture.bridgeVSU.call({
          added: [toAdd],
          removed: [toRemove],
          batchId,
          signerKeypairs: signers
        });

        const vsAfter = await fixture.getValidatorSet();
        const expectedValidators = [
          ...validators.slice(0, 4).map((v) => v.publicKey), // [0,1,2,3]
          toAdd // [6]
        ];
        const expectedThreshold = calculateExpectedThreshold(
          expectedValidators.length
        );

        assertValidatorSetState(vsAfter, {
          validators: expectedValidators,
          threshold: expectedThreshold,
          lastBatchId: batchId,
          bridgeRequestCount: vsBefore.bridgeRequestCount
        });

        console.log(
          `  ✓ Swap: removed validators[4], added validators[6]. New threshold=${vsAfter.threshold}`
        );
      });

      it("adds multiple validators at once", async function () {
        // State: 5 validators [0,1,2,3,6], threshold = 4
        const batchId = await fixture.nextBatchId();
        const vsBefore = await fixture.getValidatorSet();

        const toAdd = [validators[7].publicKey, validators[8].publicKey];
        const signers = validators.slice(0, vsBefore.threshold);

        await fixture.bridgeVSU.call({
          added: toAdd,
          removed: [],
          batchId,
          signerKeypairs: signers
        });

        const vsAfter = await fixture.getValidatorSet();

        // Verify both were added
        for (const pk of toAdd) {
          expect(
            vsAfter.signers.some((s) => s.equals(pk)),
            `expected ${pk.toBase58()} to be in set`
          ).to.be.true;
        }

        const expectedThreshold = calculateExpectedThreshold(
          vsAfter.signers.length
        );
        expect(vsAfter.threshold).to.equal(expectedThreshold);
        expect(vsAfter.lastBatchId.toNumber()).to.equal(batchId);

        console.log(
          `  ✓ Added 2 validators at once, set size=${vsAfter.signers.length}, threshold=${vsAfter.threshold}`
        );
      });

      it("removes multiple validators at once", async function () {
        // State: 7 validators [0,1,2,3,6,7,8]
        const batchId = await fixture.nextBatchId();
        const vsBefore = await fixture.getValidatorSet();

        const toRemove = [validators[7].publicKey, validators[8].publicKey];
        const signers = validators
          .filter((v) => vsBefore.signers.some((s) => s.equals(v.publicKey)))
          .slice(0, vsBefore.threshold);

        await fixture.bridgeVSU.call({
          added: [],
          removed: toRemove,
          batchId,
          signerKeypairs: signers
        });

        const vsAfter = await fixture.getValidatorSet();

        for (const pk of toRemove) {
          expect(
            vsAfter.signers.some((s) => s.equals(pk)),
            `expected ${pk.toBase58()} to NOT be in set`
          ).to.be.false;
        }

        console.log(
          `  ✓ Removed 2 validators, set size=${vsAfter.signers.length}`
        );
      });

      it("emits ValidatorSetUpdatedEvent with correct fields", async function () {
        // State: 5 validators [0,1,2,3,6], threshold = 4
        const batchId = await fixture.nextBatchId();
        const vsBefore = await fixture.getValidatorSet();

        const toAdd = validators[9].publicKey;
        const signers = validators
          .filter((v) => vsBefore.signers.some((s) => s.equals(v.publicKey)))
          .slice(0, vsBefore.threshold);

        const sig = await fixture.bridgeVSU.call({
          added: [toAdd],
          removed: [],
          batchId,
          signerKeypairs: signers
        });

        // Parse event
        const event = await fixture.events.parseValidatorSetUpdatedEvent(sig);

        expect(event, "event should not be null").to.not.be.null;
        expect(event!.batchId.toNumber()).to.equal(batchId);
        expect(event!.newSigners.some((s) => s.equals(toAdd))).to.be.true;

        const expectedThreshold = calculateExpectedThreshold(
          event!.newSigners.length
        );
        expect(event!.newThreshold).to.equal(expectedThreshold);

        console.log(
          `  ✓ Event emitted: batchId=${event!.batchId}, threshold=${
            event!.newThreshold
          }, signers=${event!.newSigners.length}`
        );

        // Cleanup: remove validators[9] to restore known state for later tests
        const cleanupBatchId = await fixture.nextBatchId();
        const vsAfterAdd = await fixture.getValidatorSet();
        const cleanupSigners = validators
          .filter((v) => vsAfterAdd.signers.some((s) => s.equals(v.publicKey)))
          .slice(0, vsAfterAdd.threshold);

        await fixture.bridgeVSU.call({
          added: [],
          removed: [toAdd],
          batchId: cleanupBatchId,
          signerKeypairs: cleanupSigners
        });
      });

      it("last_batch_id is updated to the submitted batch_id", async function () {
        const vsBefore = await fixture.getValidatorSet();
        // Jump batch_id forward by 100 (must be strictly greater)
        const jumpedBatchId = vsBefore.lastBatchId.toNumber() + 100;

        const toAdd = validators[10].publicKey;
        const signers = validators
          .filter((v) => vsBefore.signers.some((s) => s.equals(v.publicKey)))
          .slice(0, vsBefore.threshold);

        await fixture.bridgeVSU.call({
          added: [toAdd],
          removed: [],
          batchId: jumpedBatchId,
          signerKeypairs: signers
        });

        const vsAfter = await fixture.getValidatorSet();
        expect(vsAfter.lastBatchId.toNumber()).to.equal(jumpedBatchId);

        // Cleanup
        const cleanupBatchId = await fixture.nextBatchId();
        const cleanupSigners = validators
          .filter((v) => vsAfter.signers.some((s) => s.equals(v.publicKey)))
          .slice(0, vsAfter.threshold);
        await fixture.bridgeVSU.call({
          added: [],
          removed: [toAdd],
          batchId: cleanupBatchId,
          signerKeypairs: cleanupSigners
        });
      });

      it("threshold recalculates correctly after add", async function () {
        const vsBefore = await fixture.getValidatorSet();
        const sizeBefore = vsBefore.signers.length;
        const batchId = await fixture.nextBatchId();

        const toAdd = validators[11].publicKey;
        const signers = validators
          .filter((v) => vsBefore.signers.some((s) => s.equals(v.publicKey)))
          .slice(0, vsBefore.threshold);

        await fixture.bridgeVSU.call({
          added: [toAdd],
          removed: [],
          batchId,
          signerKeypairs: signers
        });

        const vsAfter = await fixture.getValidatorSet();
        const expectedThreshold = calculateExpectedThreshold(sizeBefore + 1);

        expect(vsAfter.threshold).to.equal(expectedThreshold);
        expect(vsAfter.signers.length).to.equal(sizeBefore + 1);

        // Cleanup
        const cleanupBatchId = await fixture.nextBatchId();
        const cleanupSigners = validators
          .filter((v) => vsAfter.signers.some((s) => s.equals(v.publicKey)))
          .slice(0, vsAfter.threshold);
        await fixture.bridgeVSU.call({
          added: [],
          removed: [toAdd],
          batchId: cleanupBatchId,
          signerKeypairs: cleanupSigners
        });
      });

      it("works with more than threshold signers (surplus signers OK)", async function () {
        const vsBefore = await fixture.getValidatorSet();
        const batchId = await fixture.nextBatchId();

        const toAdd = validators[12].publicKey;
        // Pass ALL current validators as signers (not just threshold)
        const allSigners = validators.filter((v) =>
          vsBefore.signers.some((s) => s.equals(v.publicKey))
        );

        expect(allSigners.length).to.be.greaterThan(vsBefore.threshold);

        await fixture.bridgeVSU.call({
          added: [toAdd],
          removed: [],
          batchId,
          signerKeypairs: allSigners
        });

        const vsAfter = await fixture.getValidatorSet();
        expect(vsAfter.signers.some((s) => s.equals(toAdd))).to.be.true;

        // Cleanup
        const cleanupBatchId = await fixture.nextBatchId();
        const vsClean = await fixture.getValidatorSet();
        const cleanupSigners = validators
          .filter((v) => vsClean.signers.some((s) => s.equals(v.publicKey)))
          .slice(0, vsClean.threshold);
        await fixture.bridgeVSU.call({
          added: [],
          removed: [toAdd],
          batchId: cleanupBatchId,
          signerKeypairs: cleanupSigners
        });
      });

      it("sequential VSUs advance batch_id monotonically", async function () {
        const vsStart = await fixture.getValidatorSet();
        let currentSet = vsStart.signers.map(
          (pk) => validators.find((v) => v.publicKey.equals(pk))!
        );

        for (let i = 0; i < 3; i++) {
          const batchId = await fixture.nextBatchId();
          const toAdd = validators[20 + i].publicKey;
          const signers = currentSet.slice(
            0,
            calculateExpectedThreshold(currentSet.length)
          );

          await fixture.bridgeVSU.call({
            added: [toAdd],
            removed: [],
            batchId,
            signerKeypairs: signers
          });

          const vs = await fixture.getValidatorSet();
          expect(vs.lastBatchId.toNumber()).to.equal(batchId);

          // Add new validator keypair to currentSet for next iteration
          currentSet = validators.filter((v) =>
            vs.signers.some((s) => s.equals(v.publicKey))
          );
        }

        // Cleanup: remove validators[20,21,22]
        for (let i = 2; i >= 0; i--) {
          const batchId = await fixture.nextBatchId();
          const vs = await fixture.getValidatorSet();
          const signers = validators
            .filter((v) => vs.signers.some((s) => s.equals(v.publicKey)))
            .slice(0, vs.threshold);
          await fixture.bridgeVSU.call({
            added: [],
            removed: [validators[20 + i].publicKey],
            batchId,
            signerKeypairs: signers
          });
        }
      });
    });

    // ========================================================================
    // ERROR PATH TESTS
    // ========================================================================

    describe("error: InvalidBatchId", function () {
      it("rejects batch_id equal to last_batch_id", async function () {
        const vs = await fixture.getValidatorSet();
        const staleBatchId = vs.lastBatchId.toNumber(); // not greater — equal

        const signers = validators
          .filter((v) => vs.signers.some((s) => s.equals(v.publicKey)))
          .slice(0, vs.threshold);

        await fixture.bridgeVSU.expectError(
          {
            added: [validators[30].publicKey],
            removed: [],
            batchId: staleBatchId,
            signerKeypairs: signers
          },
          "InvalidBatchId"
        );
      });

      it("rejects batch_id less than last_batch_id", async function () {
        const vs = await fixture.getValidatorSet();
        const staleBatchId = Math.max(0, vs.lastBatchId.toNumber() - 5);

        const signers = validators
          .filter((v) => vs.signers.some((s) => s.equals(v.publicKey)))
          .slice(0, vs.threshold);

        await fixture.bridgeVSU.expectError(
          {
            added: [validators[30].publicKey],
            removed: [],
            batchId: staleBatchId,
            signerKeypairs: signers
          },
          "InvalidBatchId"
        );
      });

      it("rejects batch_id = 0 when last_batch_id > 0", async function () {
        const vs = await fixture.getValidatorSet();
        // After all the happy path tests, last_batch_id > 0
        expect(vs.lastBatchId.toNumber()).to.be.greaterThan(0);

        const signers = validators
          .filter((v) => vs.signers.some((s) => s.equals(v.publicKey)))
          .slice(0, vs.threshold);

        await fixture.bridgeVSU.expectError(
          {
            added: [validators[30].publicKey],
            removed: [],
            batchId: 0,
            signerKeypairs: signers
          },
          "InvalidBatchId"
        );
      });
    });

    describe("error: DuplicateValidatorsInAdded", function () {
      it("rejects added list with duplicate pubkeys", async function () {
        const vs = await fixture.getValidatorSet();
        const batchId = await fixture.nextBatchId();
        const signers = validators
          .filter((v) => vs.signers.some((s) => s.equals(v.publicKey)))
          .slice(0, vs.threshold);

        const duplicate = validators[30].publicKey;

        await fixture.bridgeVSU.expectError(
          {
            added: [duplicate, duplicate], // same key twice
            removed: [],
            batchId,
            signerKeypairs: signers
          },
          "DuplicateValidatorsInAdded"
        );
      });
    });

    describe("error: DuplicateValidatorsInRemoved", function () {
      it("rejects removed list with duplicate pubkeys", async function () {
        const vs = await fixture.getValidatorSet();
        const batchId = await fixture.nextBatchId();
        const signers = validators
          .filter((v) => vs.signers.some((s) => s.equals(v.publicKey)))
          .slice(0, vs.threshold);

        // Pick a validator actually in the set
        const inSetValidator = vs.signers[0];

        await fixture.bridgeVSU.expectError(
          {
            added: [],
            removed: [inSetValidator, inSetValidator], // same key twice
            batchId,
            signerKeypairs: signers
          },
          "DuplicateValidatorsInRemoved"
        );
      });
    });

    describe("error: AddingAndRemovingSameSigner", function () {
      it("rejects when a pubkey appears in both added and removed", async function () {
        const vs = await fixture.getValidatorSet();
        const batchId = await fixture.nextBatchId();
        const signers = validators
          .filter((v) => vs.signers.some((s) => s.equals(v.publicKey)))
          .slice(0, vs.threshold);

        // Use a brand new key (not in set) — it can be in added,
        // and we put the same key in removed to trigger the conflict check.
        // Note: it won't pass RemovingNonExistentSigner — AddingAndRemovingSameSigner
        // is checked first.
        const conflictKey = validators[31].publicKey;

        await fixture.bridgeVSU.expectError(
          {
            added: [conflictKey],
            removed: [conflictKey],
            batchId,
            signerKeypairs: signers
          },
          "AddingAndRemovingSameSigner"
        );
      });

      it("rejects overlap when adding existing set members to both lists", async function () {
        const vs = await fixture.getValidatorSet();
        const batchId = await fixture.nextBatchId();
        const signers = validators
          .filter((v) => vs.signers.some((s) => s.equals(v.publicKey)))
          .slice(0, vs.threshold);

        // An existing validator appears in both added and removed
        const existingValidator = vs.signers[0];

        await fixture.bridgeVSU.expectError(
          {
            added: [existingValidator],
            removed: [existingValidator],
            batchId,
            signerKeypairs: signers
          },
          "AddingAndRemovingSameSigner"
        );
      });
    });

    describe("error: AddingExistingSigner", function () {
      it("rejects adding a validator already in the set", async function () {
        const vs = await fixture.getValidatorSet();
        const batchId = await fixture.nextBatchId();
        const signers = validators
          .filter((v) => vs.signers.some((s) => s.equals(v.publicKey)))
          .slice(0, vs.threshold);

        const alreadyInSet = vs.signers[0];

        await fixture.bridgeVSU.expectError(
          {
            added: [alreadyInSet],
            removed: [],
            batchId,
            signerKeypairs: signers
          },
          "AddingExistingSigner"
        );
      });

      it("rejects adding multiple validators when any one is already in set", async function () {
        const vs = await fixture.getValidatorSet();
        const batchId = await fixture.nextBatchId();
        const signers = validators
          .filter((v) => vs.signers.some((s) => s.equals(v.publicKey)))
          .slice(0, vs.threshold);

        const fresh = validators[32].publicKey; // not in set
        const existing = vs.signers[1]; // in set

        await fixture.bridgeVSU.expectError(
          {
            added: [fresh, existing],
            removed: [],
            batchId,
            signerKeypairs: signers
          },
          "AddingExistingSigner"
        );
      });
    });

    describe("error: RemovingNonExistentSigner", function () {
      it("rejects removing a validator not in the set", async function () {
        const vs = await fixture.getValidatorSet();
        const batchId = await fixture.nextBatchId();
        const signers = validators
          .filter((v) => vs.signers.some((s) => s.equals(v.publicKey)))
          .slice(0, vs.threshold);

        const notInSet = validators[33].publicKey;

        await fixture.bridgeVSU.expectError(
          {
            added: [],
            removed: [notInSet],
            batchId,
            signerKeypairs: signers
          },
          "RemovingNonExistentSigner"
        );
      });

      it("rejects when one valid + one invalid removal are combined", async function () {
        const vs = await fixture.getValidatorSet();
        const batchId = await fixture.nextBatchId();
        const signers = validators
          .filter((v) => vs.signers.some((s) => s.equals(v.publicKey)))
          .slice(0, vs.threshold);

        const inSet = vs.signers[0];
        const notInSet = validators[34].publicKey;

        await fixture.bridgeVSU.expectError(
          {
            added: [],
            removed: [inSet, notInSet],
            batchId,
            signerKeypairs: signers
          },
          "RemovingNonExistentSigner"
        );
      });
    });

    describe("error: MinValidatorsNotMet", function () {
      it("rejects update that would drop below MIN_VALIDATORS (4)", async function () {
        const vs = await fixture.getValidatorSet();
        // Current set should be exactly 5 — remove 2 to go to 3 (below MIN=4)
        expect(vs.signers.length).to.equal(
          5,
          "expected initial 5-validator set for this test"
        );

        const batchId = await fixture.nextBatchId();
        const signers = validators
          .filter((v) => vs.signers.some((s) => s.equals(v.publicKey)))
          .slice(0, vs.threshold);

        const toRemove = [vs.signers[0], vs.signers[1]]; // drops set to 3

        await fixture.bridgeVSU.expectError(
          {
            added: [],
            removed: toRemove,
            batchId,
            signerKeypairs: signers
          },
          "MinValidatorsNotMet"
        );
      });

      it("rejects removing all validators when set is at minimum", async function () {
        // This test works even if set is already at MIN (4 or 5 validators)
        const vs = await fixture.getValidatorSet();
        const batchId = await fixture.nextBatchId();
        const signers = validators
          .filter((v) => vs.signers.some((s) => s.equals(v.publicKey)))
          .slice(0, vs.threshold);

        // Remove enough to go below 4
        const removeCount = vs.signers.length - LIMITS.MIN_VALIDATORS + 1;
        const toRemove = vs.signers.slice(0, removeCount);

        await fixture.bridgeVSU.expectError(
          {
            added: [],
            removed: toRemove,
            batchId,
            signerKeypairs: signers
          },
          "MinValidatorsNotMet"
        );
      });
    });

    describe("error: NoSignersProvided", function () {
      it("rejects when no remaining_accounts are provided", async function () {
        const vs = await fixture.getValidatorSet();
        const batchId = await fixture.nextBatchId();

        // Pass empty remaining_accounts — no validator signers at all
        await fixture.bridgeVSU.expectErrorRaw(
          [validators[35].publicKey],
          [],
          batchId,
          [], // no signerKeypairs
          [], // empty remainingAccounts
          "NoSignersProvided"
        );
      });

      it("rejects when remaining_accounts are all non-signers", async function () {
        const vs = await fixture.getValidatorSet();
        const batchId = await fixture.nextBatchId();

        // Pass validator accounts but mark them as non-signers
        const nonSignerMetas = validators
          .filter((v) => vs.signers.some((s) => s.equals(v.publicKey)))
          .map((v) => ({
            pubkey: v.publicKey,
            isSigner: false, // ← NOT a signer
            isWritable: false
          }));

        await fixture.bridgeVSU.expectErrorRaw(
          [validators[35].publicKey],
          [],
          batchId,
          [],
          nonSignerMetas,
          "NoSignersProvided"
        );
      });
    });

    describe("error: DuplicateSignersProvided", function () {
      it("rejects when the same validator signs twice in remaining_accounts", async function () {
        const vs = await fixture.getValidatorSet();
        const batchId = await fixture.nextBatchId();

        // Take a valid signer from the current set
        const validSigner = validators.find((v) =>
          vs.signers.some((s) => s.equals(v.publicKey))
        )!;

        // List the same keypair twice — on-chain this will see
        // two entries with the same pubkey both marked isSigner=true
        const duplicateSignerMetas = [
          {
            pubkey: validSigner.publicKey,
            isSigner: true,
            isWritable: false
          },
          {
            pubkey: validSigner.publicKey,
            isSigner: true,
            isWritable: false
          }
        ];

        await fixture.bridgeVSU.expectErrorRaw(
          [validators[35].publicKey],
          [],
          batchId,
          [validSigner, validSigner], // sign twice
          duplicateSignerMetas,
          "DuplicateSignersProvided"
        );
      });
    });

    describe("error: InvalidSigner", function () {
      it("rejects when a signer is not in the current validator set", async function () {
        const vs = await fixture.getValidatorSet();
        const batchId = await fixture.nextBatchId();

        // A fresh keypair — not in the set
        const outsider = web3.Keypair.generate();
        await airdrop(provider.connection, outsider.publicKey);

        // Build remaining_accounts with one valid signer + the outsider
        const validSigner = validators.find((v) =>
          vs.signers.some((s) => s.equals(v.publicKey))
        )!;

        const remainingAccounts = [
          {
            pubkey: validSigner.publicKey,
            isSigner: true,
            isWritable: false
          },
          {
            pubkey: outsider.publicKey,
            isSigner: true,
            isWritable: false
          }
        ];

        await fixture.bridgeVSU.expectErrorRaw(
          [validators[35].publicKey],
          [],
          batchId,
          [validSigner, outsider],
          remainingAccounts,
          "InvalidSigner"
        );
      });

      it("rejects when ALL signers are outsiders", async function () {
        const vs = await fixture.getValidatorSet();
        const batchId = await fixture.nextBatchId();

        const outsiders = [
          web3.Keypair.generate(),
          web3.Keypair.generate(),
          web3.Keypair.generate(),
          web3.Keypair.generate()
        ];

        for (const o of outsiders) {
          await airdrop(provider.connection, o.publicKey);
        }

        const remainingAccounts = outsiders.map((o) => ({
          pubkey: o.publicKey,
          isSigner: true,
          isWritable: false
        }));

        await fixture.bridgeVSU.expectErrorRaw(
          [validators[35].publicKey],
          [],
          batchId,
          outsiders,
          remainingAccounts,
          "InvalidSigner"
        );
      });
    });

    describe("error: InsufficientSigners", function () {
      it("rejects when one fewer than threshold signers are provided", async function () {
        const vs = await fixture.getValidatorSet();
        const batchId = await fixture.nextBatchId();
        const threshold = vs.threshold;

        // Sign with (threshold - 1) validators
        const insufficientSigners = validators
          .filter((v) => vs.signers.some((s) => s.equals(v.publicKey)))
          .slice(0, threshold - 1);

        expect(insufficientSigners.length).to.equal(threshold - 1);

        await fixture.bridgeVSU.expectError(
          {
            added: [validators[36].publicKey],
            removed: [],
            batchId,
            signerKeypairs: insufficientSigners
          },
          "InsufficientSigners"
        );
      });

      it("rejects when only a single signer provided and threshold > 1", async function () {
        const vs = await fixture.getValidatorSet();
        const batchId = await fixture.nextBatchId();

        expect(vs.threshold).to.be.greaterThan(
          1,
          "this test requires threshold > 1"
        );

        const singleSigner = validators.find((v) =>
          vs.signers.some((s) => s.equals(v.publicKey))
        )!;

        await fixture.bridgeVSU.expectError(
          {
            added: [validators[37].publicKey],
            removed: [],
            batchId,
            signerKeypairs: [singleSigner]
          },
          "InsufficientSigners"
        );
      });

      it("rejects when exactly threshold-1 signers for a remove operation", async function () {
        const vs = await fixture.getValidatorSet();
        const batchId = await fixture.nextBatchId();
        const threshold = vs.threshold;

        const insufficientSigners = validators
          .filter((v) => vs.signers.some((s) => s.equals(v.publicKey)))
          .slice(0, threshold - 1);

        await fixture.bridgeVSU.expectError(
          {
            added: [],
            removed: [vs.signers[0]],
            batchId,
            signerKeypairs: insufficientSigners
          },
          "InsufficientSigners"
        );
      });
    });

    // ========================================================================
    // EDGE CASE / BOUNDARY TESTS
    // ========================================================================

    describe("edge cases", function () {
      it("threshold=4 for 5-validator set (formula verification)", function () {
        // Formula: n - floor((n-1)/3)
        // n=5: 5 - floor(4/3) = 5 - 1 = 4
        expect(calculateExpectedThreshold(5)).to.equal(4);
      });

      it("threshold=3 for 4-validator set (minimum)", function () {
        // n=4: 4 - floor(3/3) = 4 - 1 = 3
        expect(calculateExpectedThreshold(4)).to.equal(3);
      });

      it("threshold formula holds for various sizes", function () {
        const cases: [number, number][] = [
          [4, 3],
          [5, 4],
          [6, 5],
          [7, 5],
          [10, 7],
          [13, 9],
          [20, 14]
        ];
        for (const [n, expectedT] of cases) {
          expect(calculateExpectedThreshold(n), `threshold(${n})`).to.equal(
            expectedT
          );
        }
      });

      it("no-op update (empty added and removed) with sufficient signers succeeds", async function () {
        // The instruction doesn't explicitly block this.
        // min/max validator checks pass since size stays the same.
        // This is a valid "heartbeat" batch_id advance.
        const vs = await fixture.getValidatorSet();
        const batchId = await fixture.nextBatchId();
        const signers = validators
          .filter((v) => vs.signers.some((s) => s.equals(v.publicKey)))
          .slice(0, vs.threshold);

        await fixture.bridgeVSU.call({
          added: [],
          removed: [],
          batchId,
          signerKeypairs: signers
        });

        const vsAfter = await fixture.getValidatorSet();
        // Validator set unchanged, only batch_id advances
        assertValidatorSetState(vsAfter, {
          validators: vs.signers,
          threshold: vs.threshold,
          lastBatchId: batchId,
          bridgeRequestCount: vs.bridgeRequestCount
        });

        console.log("  ✓ No-op update advanced last_batch_id to", batchId);
      });

      it("bridgeRequestCount is not modified by bridge_vsu", async function () {
        const vsBefore = await fixture.getValidatorSet();
        const requestCountBefore = vsBefore.bridgeRequestCount;
        const batchId = await fixture.nextBatchId();

        const signers = validators
          .filter((v) => vsBefore.signers.some((s) => s.equals(v.publicKey)))
          .slice(0, vsBefore.threshold);

        await fixture.bridgeVSU.call({
          added: [],
          removed: [],
          batchId,
          signerKeypairs: signers
        });

        const vsAfter = await fixture.getValidatorSet();
        expect(vsAfter.bridgeRequestCount.toString()).to.equal(
          requestCountBefore.toString(),
          "bridgeRequestCount must not change"
        );
      });
    });
  });
});
