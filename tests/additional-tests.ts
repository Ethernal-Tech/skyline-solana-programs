/**
 * High-priority coverage for recent program changes:
 * - update_fee_config
 * - mint/burn registration + bridge_request burn + bridge_transaction mint
 * - bridge_transaction native SOL (token_id 0) + vault fee payout
 * - bridge_request token_registry mint mismatch
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, web3 } from "@coral-xyz/anchor";
import { SkylineProgram } from "../target/types/skyline_program";
import { expect } from "chai";
import { BN } from "bn.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  SkylineTestFixture,
  TestContext,
  airdrop,
  generateValidators
} from "./fixtures";
import {
  buildBridgeTransactionIx,
  buildEd25519BatchIx,
  makeSignedPayload,
  NATIVE_SOL_MINT,
  sendBridgeTransaction
} from "./bridge-tx-ed25519-utils";

describe("additional program coverage", () => {
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

  let vaultPDA: web3.PublicKey;
  let threshold = 0;
  let validatorSigners: web3.Keypair[] = [];
  const MIN_OPERATIONAL_FEE = 1_000;
  const BRIDGE_FEE = 500;

  before("ensure initialized and load validators", async function () {
    const isInitialized = await fixture.isInitialized();
    if (!isInitialized) {
      const initValidators = generateValidators(5).map((v) => v.publicKey);
      const treasury = web3.Keypair.generate();
      await airdrop(provider.connection, treasury.publicKey, web3.LAMPORTS_PER_SOL);
      await fixture.initialize.call(initValidators, 0, {
        minOperationalFee: MIN_OPERATIONAL_FEE,
        bridgeFee: BRIDGE_FEE,
        treasury: treasury.publicKey
      });
    }

    const vs = await fixture.getValidatorSet();
    threshold = vs.threshold;
    vaultPDA = fixture.pdas.vault();

    const pool = generateValidators(200);
    const byPk = new Map(pool.map((kp) => [kp.publicKey.toBase58(), kp]));
    validatorSigners = vs.signers
      .map((pk) => byPk.get(pk.toBase58())!)
      .filter(Boolean);

    if (validatorSigners.length !== vs.signers.length) {
      this.skip();
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // update_fee_config
  // ═══════════════════════════════════════════════════════════════════
  describe("update_fee_config", () => {
    it("authority updates operational and bridge fees", async () => {
      const newMinOp = new BN(2_000);
      const newBridge = new BN(800);

      await fixture.updateFeeConfig.call({
        minOperationalFee: newMinOp,
        bridgeFee: newBridge
      });

      const fc = await fixture.getFeeConfig();
      expect(fc.minOperationalFee.toNumber()).to.equal(2_000);
      expect(fc.bridgeFee.toNumber()).to.equal(800);
    });

    it("authority updates treasury address", async () => {
      const newTreasury = web3.Keypair.generate();
      await airdrop(
        provider.connection,
        newTreasury.publicKey,
        web3.LAMPORTS_PER_SOL
      );

      await fixture.updateFeeConfig.call({
        updateTreasury: true,
        newTreasury: newTreasury.publicKey
      });

      const fc = await fixture.getFeeConfig();
      expect(fc.treasury.toBase58()).to.equal(newTreasury.publicKey.toBase58());
    });

    it("fails when combined fees overflow u64", async () => {
      const MAX_U64 = new BN("18446744073709551615");

      await fixture.updateFeeConfig.expectError(
        {
          minOperationalFee: MAX_U64,
          bridgeFee: new BN(1)
        },
        "FeeConfigOverflow"
      );
    });

    it("fails when treasury update uses default pubkey", async () => {
      await fixture.updateFeeConfig.expectError(
        {
          updateTreasury: true,
          newTreasury: web3.PublicKey.default
        },
        "InvalidTreasury"
      );
    });

    it("fails when signer is not fee_config authority", async () => {
      const outsider = web3.Keypair.generate();
      await airdrop(
        provider.connection,
        outsider.publicKey,
        web3.LAMPORTS_PER_SOL
      );

      await fixture.updateFeeConfig.expectError(
        { authority: outsider, minOperationalFee: new BN(1) },
        "Unauthorized"
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // bridge_request — token_registry mint mismatch
  // ═══════════════════════════════════════════════════════════════════
  describe("bridge_request token registry validation", () => {
    // Avoid 300/302 used by skyline-program bridge-request setup.
    const TOKEN_A = 501;
    const TOKEN_B = 502;
    let mintA: web3.PublicKey;
    let mintB: web3.PublicKey;
    let user: web3.Keypair;

    before(async () => {
      user = web3.Keypair.generate();
      await airdrop(
        provider.connection,
        user.publicKey,
        10 * web3.LAMPORTS_PER_SOL
      );

      mintA = await fixture.mints.create(owner.publicKey, 9);
      mintB = await fixture.mints.create(owner.publicKey, 9);

      await fixture.tokenRegistry.registerLockUnlock({
        mint: mintA,
        tokenId: TOKEN_A,
        minBridgingAmount: 1
      });
      await fixture.tokenRegistry.registerLockUnlock({
        mint: mintB,
        tokenId: TOKEN_B,
        minBridgingAmount: 1
      });

      await fixture.mints.mintTo(mintA, user.publicKey, 1_000_000);
    });

    it("fails when token_registry PDA does not match mint", async () => {
      const amount = new BN(10_000);
      const requiredFee = await fixture.requiredFee();
      const wrongRegistry = fixture.pdas.tokenRegistry(TOKEN_B);
      const signerAta = getAssociatedTokenAddressSync(mintA, user.publicKey);
      const vaultAta = getAssociatedTokenAddressSync(mintA, vaultPDA, true);

      let threw = false;
      try {
        await fixture.bridgeRequest.callWithCustomAccounts(
          amount,
          "0xabc",
          "1",
          {
            signer: user.publicKey,
            signersAta: signerAta,
            vaultAta,
            mint: mintA,
            fees: requiredFee,
            tokenRegistry: wrongRegistry
          },
          [user]
        );
      } catch (e: any) {
        threw = true;
        const code = e.error?.errorCode?.code ?? e.errorCode?.code;
        expect(code).to.equal("TokenNotRegistered");
      }
      expect(threw).to.equal(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // mint/burn: register → bridge_request burn → bridge_transaction mint
  // ═══════════════════════════════════════════════════════════════════
  describe("mint/burn full flow", () => {
    const MINT_BURN_TOKEN_ID = 542;
    let burnMint: web3.PublicKey;
    let bridger: web3.Keypair;
    let recipient: web3.PublicKey;

    before(async () => {
      bridger = web3.Keypair.generate();
      recipient = web3.Keypair.generate().publicKey;
      await airdrop(
        provider.connection,
        bridger.publicKey,
        10 * web3.LAMPORTS_PER_SOL
      );

      const { mint } = await fixture.tokenRegistry.registerMintBurn({
        tokenId: MINT_BURN_TOKEN_ID,
        decimals: 6,
        minBridgingAmount: 1,
        name: "Test Burn",
        symbol: "TBURN",
        uri: "https://example.com/tburn.json"
      });
      burnMint = mint;

      const registry = await fixture.accounts.getTokenRegistry(
        fixture.pdas.tokenRegistry(MINT_BURN_TOKEN_ID)
      );
      expect(registry.isLockUnlock).to.equal(false);

      // Seed bridger balance via bridge_transaction mint_to (vault is mint authority).
      const seedBatchId = new BN(await fixture.nextBatchId());
      const seedAmount = new BN(1_000_000);
      const seedTransfers = [
        { recipient: bridger.publicKey, mintIndex: 0, amount: seedAmount }
      ];
      const seedMsg = makeSignedPayload(
        seedBatchId,
        seedTransfers,
        [MINT_BURN_TOKEN_ID]
      );
      const seedEdIx = buildEd25519BatchIx(
        validatorSigners.slice(0, threshold),
        seedMsg
      );
      const seedBridgeIx = await buildBridgeTransactionIx(
        program,
        fixture,
        owner.publicKey,
        seedTransfers,
        [burnMint],
        [MINT_BURN_TOKEN_ID]
      );
      await sendBridgeTransaction(provider, seedBridgeIx, seedEdIx);
    });

    it("bridge_request burns tokens from user (no vault ATA deposit)", async () => {
      const amount = new BN(400_000);
      const requiredFee = await fixture.requiredFee();
      const signerAta = getAssociatedTokenAddressSync(
        burnMint,
        bridger.publicKey
      );
      const vaultAta = getAssociatedTokenAddressSync(burnMint, vaultPDA, true);

      const before = await fixture.tokenBalances.snapshot(signerAta);
      const vaultAtaBefore = await provider.connection.getAccountInfo(vaultAta);

      await fixture.bridgeRequest.call({
        amount,
        receiver: "0xdead",
        destinationChain: "1",
        mint: burnMint,
        fees: requiredFee,
        signer: bridger
      });

      const after = await fixture.tokenBalances.getBalance(signerAta);
      expect((before - after).toString()).to.equal(amount.toString());

      // Burn path must not create a vault ATA for this mint.
      const vaultAtaAfter = await provider.connection.getAccountInfo(vaultAta);
      expect(vaultAtaBefore).to.equal(null);
      expect(vaultAtaAfter).to.equal(null);
    });

    it("bridge_transaction mints to recipient after validator signatures", async () => {
      const amount = new BN(250_000);
      const batchId = new BN(await fixture.nextBatchId());
      const transfers = [{ recipient, mintIndex: 0, amount }];
      const tokenIds = [MINT_BURN_TOKEN_ID];
      const msg = makeSignedPayload(batchId, transfers, tokenIds);
      const signers = validatorSigners.slice(0, threshold);
      const edIx = buildEd25519BatchIx(signers, msg);

      const recipientAta = getAssociatedTokenAddressSync(burnMint, recipient);
      const before = await fixture.tokenBalances.getBalance(recipientAta);

      const bridgeIx = await buildBridgeTransactionIx(
        program,
        fixture,
        owner.publicKey,
        transfers,
        [burnMint],
        tokenIds
      );
      await sendBridgeTransaction(provider, bridgeIx, edIx);

      const after = await fixture.tokenBalances.getBalance(recipientAta);
      expect((after - before).toString()).to.equal(amount.toString());
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // bridge_transaction — native SOL + relayer fee from vault escrow
  // ═══════════════════════════════════════════════════════════════════
  describe("bridge_transaction native SOL and fee payout", () => {
    let solRecipient: web3.PublicKey;

    before(async () => {
      solRecipient = web3.Keypair.generate().publicKey;

      // Credit vault PDA with native lamports (hot-wallet native-SOL branch).
      const depositor = web3.Keypair.generate();
      await airdrop(
        provider.connection,
        depositor.publicKey,
        5 * web3.LAMPORTS_PER_SOL
      );
      // Native-SOL branch: placeholder ATAs must be writable (not System Program).
      await fixture.hotWalletIncrement.call({
        amount: new BN(2 * web3.LAMPORTS_PER_SOL),
        mint: NATIVE_SOL_MINT,
        signer: depositor,
        signersAtaOverride: depositor.publicKey,
        vaultAtaOverride: depositor.publicKey
      });
    });

    it("pays lamports to recipient when token_id is 0", async () => {
      const amount = new BN(1_500_000);
      const batchId = new BN(await fixture.nextBatchId());
      const transfers = [{ recipient: solRecipient, mintIndex: 0, amount }];
      const tokenIds = [0];
      const msg = makeSignedPayload(batchId, transfers, tokenIds);
      const signers = validatorSigners.slice(0, threshold);
      const edIx = buildEd25519BatchIx(signers, msg);

      const before = await provider.connection.getBalance(solRecipient);

      const bridgeIx = await buildBridgeTransactionIx(
        program,
        fixture,
        owner.publicKey,
        transfers,
        [NATIVE_SOL_MINT],
        tokenIds
      );
      await sendBridgeTransaction(provider, bridgeIx, edIx);

      const after = await provider.connection.getBalance(solRecipient);
      expect(after - before).to.equal(amount.toNumber());
    });

    it("pays relayer fee from vault escrow to payer", async () => {
      const fc = await fixture.getFeeConfig();
      const feeLamports = fc.bridgeFee.toNumber();

      // Escrow bridge_fee on the vault via bridge_request.
      const bridger = web3.Keypair.generate();
      await airdrop(
        provider.connection,
        bridger.publicKey,
        2 * web3.LAMPORTS_PER_SOL
      );

      const escrowMint = await fixture.mints.create(owner.publicKey, 9);
      const ESCROW_TOKEN_ID = 503;
      await fixture.tokenRegistry.registerLockUnlock({
        mint: escrowMint,
        tokenId: ESCROW_TOKEN_ID,
        minBridgingAmount: 1
      });
      await fixture.mints.mintTo(escrowMint, bridger.publicKey, 10_000);
      const requiredFee = fc.minOperationalFee.add(fc.bridgeFee);

      const vaultBefore = await provider.connection.getBalance(vaultPDA);
      await fixture.bridgeRequest.call({
        amount: new BN(1_000),
        receiver: "0xfee",
        destinationChain: "1",
        mint: escrowMint,
        fees: requiredFee,
        signer: bridger
      });
      const vaultAfterEscrow = await provider.connection.getBalance(vaultPDA);
      expect(vaultAfterEscrow - vaultBefore).to.be.at.least(feeLamports);

      const batchId = new BN(await fixture.nextBatchId());
      const transferLamports = 100_000;
      const transfers = [
        {
          recipient: solRecipient,
          mintIndex: 0,
          amount: new BN(transferLamports)
        }
      ];
      const tokenIds = [0];
      const msg = makeSignedPayload(
        batchId,
        transfers,
        tokenIds,
        BigInt(feeLamports)
      );
      const edIx = buildEd25519BatchIx(
        validatorSigners.slice(0, threshold),
        msg
      );

      // Use a dedicated relayer as `payer` so balance delta is not mixed with
      // unrelated txs from the shared provider wallet.
      const relayer = web3.Keypair.generate();
      await airdrop(
        provider.connection,
        relayer.publicKey,
        2 * web3.LAMPORTS_PER_SOL
      );
      const relayerBefore = await provider.connection.getBalance(
        relayer.publicKey
      );
      const vaultBeforeTx = await provider.connection.getBalance(vaultPDA);

      const bridgeIx = await buildBridgeTransactionIx(
        program,
        fixture,
        relayer.publicKey,
        transfers,
        [NATIVE_SOL_MINT],
        tokenIds
      );
      const sig = await sendBridgeTransaction(provider, bridgeIx, edIx, {
        feePayer: relayer
      });

      const relayerAfter = await provider.connection.getBalance(relayer.publicKey);
      const vaultAfterTx = await provider.connection.getBalance(vaultPDA);

      const tx = await provider.connection.getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0
      });
      const txFee = tx?.meta?.fee ?? 0;

      // Relayer receives fee_amount from vault and pays the network tx fee.
      expect(relayerAfter - relayerBefore).to.equal(feeLamports - txFee);

      // Vault funds both the native transfer and the relayer payout.
      expect(vaultBeforeTx - vaultAfterTx).to.be.at.least(
        transferLamports + feeLamports
      );
    });
  });
});
