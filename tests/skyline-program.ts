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
  assertValidBump
} from "./fixtures";
import {
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount
} from "@solana/spl-token";

/**
 * Airdrop SOL to an account
 */
async function airdrop(
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
      it("initializes state correctly with 7 validators", async function () {
        const validatorCount = 7;
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
