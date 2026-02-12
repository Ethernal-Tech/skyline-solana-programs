import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  getMint,
} from "@solana/spl-token";
import { SkylineProgram } from "../target/types/skyline_program";
import {
  VALIDATOR_SET_PDA,
  VAULT_PDA,
  MINT_TRANSFER,
  MINT_BURN,
  toRawAmount,
  toHumanAmount,
  logTxSuccess,
  logSection,
  getBridgingTransactionPDA,
  VALIDATORS,
} from "./config";
import { expect } from "chai";

describe("Bridge Transaction", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SkylineProgram as Program<SkylineProgram>;
  const payer = (provider.wallet as anchor.Wallet).payer;

  // Load validators from on-chain validator set
  let validators: Keypair[] = [];
  let threshold: number = 0;
  let lastBatchId: anchor.BN;

  // Generate a random recipient for testing
  const recipient = Keypair.generate();

  before(async () => {
    logSection("LOADING VALIDATOR SET");

    // Fetch validator set from chain
    const validatorSetAccount = await program.account.validatorSet.fetch(
      VALIDATOR_SET_PDA,
    );
    threshold = validatorSetAccount.threshold;
    lastBatchId = new anchor.BN(validatorSetAccount.lastBatchId.toString());

    console.log(`   Threshold: ${threshold}`);
    console.log(`   Last Batch ID: ${lastBatchId.toString()}`);
    console.log(
      `   Validators on chain: ${validatorSetAccount.signers.length}`,
    );

    validatorSetAccount.signers.forEach((v, i) => {
      console.log(`     [${i}] ${v.toBase58()}`);
    });

    validators = VALIDATORS.filter((v) =>
      validatorSetAccount.signers.some((pub) => pub.equals(v.publicKey)),
    );

    console.log(`\n   Loaded ${validators.length} validator keypair(s):`);
    validators.forEach((v, i) => {
      const isInSet = validatorSetAccount.signers.some((pub) =>
        pub.equals(v.publicKey),
      );
      console.log(
        `     [${i}] ${v.publicKey.toBase58()} ${
          isInSet ? "IN SET" : "NOT IN SET"
        }`,
      );
    });
  });

  // ================================================================
  // TRANSFER BRANCH TEST (Vault transfers tokens to recipient)
  // ================================================================
  describe("Transfer Branch (Vault is NOT mint authority)", () => {
    const mint = MINT_TRANSFER;

    before(function () {
      if (validators.length < threshold) {
        console.log(
          ` Skipping: Need ${threshold} validators, have ${validators.length}`,
        );
        this.skip();
      }
    });

    it("transfers tokens from vault to recipient when vault is not mint authority", async () => {
      logSection("BRIDGE TRANSACTION - TRANSFER BRANCH");

      // Verify this mint is for transfer branch
      const mintInfo = await getMint(provider.connection, mint);
      const isVaultMintAuthority =
        mintInfo.mintAuthority?.equals(VAULT_PDA) ?? false;

      expect(isVaultMintAuthority).to.be.false;
      console.log(`   Branch:  TRANSFER (vault is NOT mint authority)`);
      console.log(`   Mint: ${mint.toBase58()}`);

      // Get current batch ID and increment
      const validatorSetBefore = await program.account.validatorSet.fetch(
        VALIDATOR_SET_PDA,
      );
      const batchId = new anchor.BN(
        validatorSetBefore.lastBatchId.toString(),
      ).add(new anchor.BN(1));

      console.log(`\n Transaction Parameters:`);
      console.log(`   Batch ID: ${batchId.toString()}`);
      console.log(`   Recipient: ${recipient.publicKey.toBase58()}`);

      // Derive PDAs and ATAs
      const [bridgingTransactionPDA] = getBridgingTransactionPDA(batchId);
      const recipientAta = await getAssociatedTokenAddress(
        mint,
        recipient.publicKey,
      );
      const vaultAta = await getAssociatedTokenAddress(mint, VAULT_PDA, true);

      console.log(
        `   Bridging Transaction PDA: ${bridgingTransactionPDA.toBase58()}`,
      );
      console.log(`   Recipient ATA: ${recipientAta.toBase58()}`);
      console.log(`   Vault ATA: ${vaultAta.toBase58()}`);

      // Get vault balance before
      let vaultBalanceBeforeNum = 0;
      try {
        const vaultBalanceBefore =
          await provider.connection.getTokenAccountBalance(vaultAta);
        vaultBalanceBeforeNum = Number(vaultBalanceBefore.value.amount);
      } catch {
        console.log("    Vault ATA doesn't exist or has no balance");
      }

      // Get recipient balance before (probably doesn't exist)
      let recipientBalanceBeforeNum = 0;
      try {
        const recipientBalanceBefore =
          await provider.connection.getTokenAccountBalance(recipientAta);
        recipientBalanceBeforeNum = Number(recipientBalanceBefore.value.amount);
      } catch {
        // Expected - ATA doesn't exist yet
      }

      const amount = toRawAmount(0.5); // Transfer 0.5 tokens

      console.log(`\n Balances Before:`);
      console.log(`   Vault: ${toHumanAmount(vaultBalanceBeforeNum)} tokens`);
      console.log(
        `   Recipient: ${toHumanAmount(recipientBalanceBeforeNum)} tokens`,
      );
      console.log(`   Amount to transfer: ${toHumanAmount(amount)} tokens`);

      // Ensure vault has enough tokens
      if (vaultBalanceBeforeNum < amount.toNumber()) {
        console.log(`\n Vault doesn't have enough tokens!`);
        console.log(`   Required: ${toHumanAmount(amount)}`);
        console.log(`   Available: ${toHumanAmount(vaultBalanceBeforeNum)}`);
        console.log(`   Run bridge_request first to deposit tokens to vault.`);
        return;
      }

      // Select validators to sign (up to threshold)
      const signingValidators = validators.slice(0, threshold);
      console.log(
        `\n Validators signing (${signingValidators.length}/${threshold} required):`,
      );
      signingValidators.forEach((v, i) => {
        console.log(`   [${i}] ${v.publicKey.toBase58()}`);
      });

      // Build remaining accounts for validator signers
      const remainingAccounts = signingValidators.map((v) => ({
        pubkey: v.publicKey,
        isSigner: true,
        isWritable: false,
      }));

      // Execute transaction
      const tx = await program.methods
        .bridgeTransaction(amount, batchId)
        .accounts({
          payer: payer.publicKey,
          validatorSet: VALIDATOR_SET_PDA,
          bridgingTransaction: bridgingTransactionPDA,
          mintToken: mint,
          recipient: recipient.publicKey,
          recipientAta: recipientAta,
          vault: VAULT_PDA,
          vaultAta: vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        })
        .remainingAccounts(remainingAccounts)
        .signers(signingValidators)
        .rpc();

      logTxSuccess("Bridge Transaction (Transfer)", tx);

      // Verify balances after
      const vaultBalanceAfter =
        await provider.connection.getTokenAccountBalance(vaultAta);
      const vaultBalanceAfterNum = Number(vaultBalanceAfter.value.amount);

      const recipientBalanceAfter =
        await provider.connection.getTokenAccountBalance(recipientAta);
      const recipientBalanceAfterNum = Number(
        recipientBalanceAfter.value.amount,
      );

      const vaultDecrease = vaultBalanceBeforeNum - vaultBalanceAfterNum;
      const recipientIncrease =
        recipientBalanceAfterNum - recipientBalanceBeforeNum;

      console.log(`\n Balance Changes:`);
      console.log(
        `   Vault: ${toHumanAmount(vaultBalanceBeforeNum)} → ${toHumanAmount(
          vaultBalanceAfterNum,
        )} (-${toHumanAmount(vaultDecrease)})`,
      );
      console.log(
        `   Recipient: ${toHumanAmount(
          recipientBalanceBeforeNum,
        )} → ${toHumanAmount(recipientBalanceAfterNum)} (+${toHumanAmount(
          recipientIncrease,
        )})`,
      );

      // Verify last_batch_id updated
      const validatorSetAfter = await program.account.validatorSet.fetch(
        VALIDATOR_SET_PDA,
      );
      console.log(
        `   Last Batch ID: ${validatorSetBefore.lastBatchId.toString()} → ${validatorSetAfter.lastBatchId.toString()}`,
      );

      // Verify bridging transaction account is closed
      const bridgingTxAccount = await provider.connection.getAccountInfo(
        bridgingTransactionPDA,
      );
      console.log(
        `   Bridging TX Account Closed: ${
          bridgingTxAccount === null ? " YES" : " NO"
        }`,
      );

      // Assertions
      expect(vaultDecrease).to.equal(amount.toNumber());
      expect(recipientIncrease).to.equal(amount.toNumber());
      expect(validatorSetAfter.lastBatchId.toString()).to.equal(
        batchId.toString(),
      );
      expect(bridgingTxAccount).to.be.null;

      console.log(`\n TRANSFER BRANCH VERIFIED`);
      console.log(`   ✓ Tokens transferred from vault to recipient`);
      console.log(`   ✓ Bridging transaction account closed`);
      console.log(`   ✓ Last batch ID updated`);
    });
  });

  // ================================================================
  // MINT BRANCH TEST (Vault mints tokens to recipient)
  // ================================================================
  describe("Mint Branch (Vault IS mint authority)", () => {
    const mint = MINT_BURN; // Same mint, but this time we're minting (reverse of burn)

    before(function () {
      if (!mint) {
        console.log(" Skipping mint tests: MINT_BURN not configured");
        this.skip();
        return;
      }
      if (validators.length < threshold) {
        console.log(
          ` Skipping: Need ${threshold} validators, have ${validators.length}`,
        );
        this.skip();
      }
    });

    it("mints tokens to recipient when vault is mint authority", async () => {
      logSection("BRIDGE TRANSACTION - MINT BRANCH");

      // Verify this mint is for mint branch
      const mintInfo = await getMint(provider.connection, mint);
      const isVaultMintAuthority =
        mintInfo.mintAuthority?.equals(VAULT_PDA) ?? false;

      expect(isVaultMintAuthority).to.be.true;
      console.log(` Branch:  MINT (vault IS mint authority)`);
      console.log(`   Mint: ${mint.toBase58()}`);
      console.log(`   Mint Authority: ${mintInfo.mintAuthority?.toBase58()}`);

      // Get current batch ID and increment
      const validatorSetBefore = await program.account.validatorSet.fetch(
        VALIDATOR_SET_PDA,
      );
      const batchId = new anchor.BN(
        validatorSetBefore.lastBatchId.toString(),
      ).add(new anchor.BN(1));

      // Generate a new recipient for this test
      const mintRecipient = Keypair.generate();

      console.log(`\n Transaction Parameters:`);
      console.log(`   Batch ID: ${batchId.toString()}`);
      console.log(`   Recipient: ${mintRecipient.publicKey.toBase58()}`);

      // Derive PDAs and ATAs
      const [bridgingTransactionPDA] = getBridgingTransactionPDA(batchId);
      const recipientAta = await getAssociatedTokenAddress(
        mint,
        mintRecipient.publicKey,
      );
      const vaultAta = await getAssociatedTokenAddress(mint, VAULT_PDA, true);

      console.log(
        `   Bridging Transaction PDA: ${bridgingTransactionPDA.toBase58()}`,
      );
      console.log(`   Recipient ATA: ${recipientAta.toBase58()}`);

      // Get total supply before
      const totalSupplyBefore = mintInfo.supply;

      // Get recipient balance before (doesn't exist)
      let recipientBalanceBeforeNum = 0;

      const amount = toRawAmount(5); // Mint 5 tokens

      console.log(`\n State Before:`);
      console.log(
        `   Total Supply: ${toHumanAmount(totalSupplyBefore)} tokens`,
      );
      console.log(
        `   Recipient Balance: ${toHumanAmount(
          recipientBalanceBeforeNum,
        )} tokens`,
      );
      console.log(`   Amount to mint: ${toHumanAmount(amount)} tokens`);

      // Select validators to sign (up to threshold)
      const signingValidators = validators.slice(0, threshold);
      console.log(
        `\n Validators signing (${signingValidators.length}/${threshold} required):`,
      );
      signingValidators.forEach((v, i) => {
        console.log(`   [${i}] ${v.publicKey.toBase58()}`);
      });

      // Build remaining accounts for validator signers
      const remainingAccounts = signingValidators.map((v) => ({
        pubkey: v.publicKey,
        isSigner: true,
        isWritable: false,
      }));

      // Execute transaction
      const tx = await program.methods
        .bridgeTransaction(amount, batchId)
        .accounts({
          payer: payer.publicKey,
          validatorSet: VALIDATOR_SET_PDA,
          bridgingTransaction: bridgingTransactionPDA,
          mintToken: mint,
          recipient: mintRecipient.publicKey,
          recipientAta: recipientAta,
          vault: VAULT_PDA,
          vaultAta: vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        })
        .remainingAccounts(remainingAccounts)
        .signers(signingValidators)
        .rpc();

      logTxSuccess("Bridge Transaction (Mint)", tx);

      // Verify state after
      const mintInfoAfter = await getMint(provider.connection, mint);
      const totalSupplyAfter = mintInfoAfter.supply;

      const recipientBalanceAfter =
        await provider.connection.getTokenAccountBalance(recipientAta);
      const recipientBalanceAfterNum = Number(
        recipientBalanceAfter.value.amount,
      );

      const supplyIncrease =
        Number(totalSupplyAfter) - Number(totalSupplyBefore);
      const recipientIncrease =
        recipientBalanceAfterNum - recipientBalanceBeforeNum;

      console.log(`\n State Changes:`);
      console.log(
        `   Total Supply: ${toHumanAmount(totalSupplyBefore)} → ${toHumanAmount(
          totalSupplyAfter,
        )} (+${toHumanAmount(supplyIncrease)})`,
      );
      console.log(
        `   Recipient: ${toHumanAmount(
          recipientBalanceBeforeNum,
        )} → ${toHumanAmount(recipientBalanceAfterNum)} (+${toHumanAmount(
          recipientIncrease,
        )})`,
      );

      // Verify last_batch_id updated
      const validatorSetAfter = await program.account.validatorSet.fetch(
        VALIDATOR_SET_PDA,
      );
      console.log(
        `   Last Batch ID: ${validatorSetBefore.lastBatchId.toString()} → ${validatorSetAfter.lastBatchId.toString()}`,
      );

      // Verify bridging transaction account is closed
      const bridgingTxAccount = await provider.connection.getAccountInfo(
        bridgingTransactionPDA,
      );
      console.log(
        `   Bridging TX Account Closed: ${
          bridgingTxAccount === null ? " YES" : " NO"
        }`,
      );

      // Assertions
      expect(supplyIncrease).to.equal(amount.toNumber());
      expect(recipientIncrease).to.equal(amount.toNumber());
      expect(validatorSetAfter.lastBatchId.toString()).to.equal(
        batchId.toString(),
      );
      expect(bridgingTxAccount).to.be.null;

      console.log(`\n MINT BRANCH VERIFIED`);
      console.log(`   ✓ Tokens minted to recipient (increased total supply)`);
      console.log(`   ✓ Recipient ATA created automatically`);
      console.log(`   ✓ Bridging transaction account closed`);
      console.log(`   ✓ Last batch ID updated`);
    });
  });

  // ================================================================
  // MULTI-SIGNATURE TEST (threshold > 1, multiple calls)
  // ================================================================
  describe("Multi-Signature Flow (incremental approvals)", () => {
    const mint = MINT_BURN;

    before(function () {
      if (!mint) {
        console.log(" Skipping: MINT_BURN not configured");
        this.skip();
        return;
      }
      if (threshold <= 1) {
        console.log("   Skipping: Threshold is 1, no multi-sig needed");
        this.skip();
        return;
      }
      if (validators.length < threshold) {
        console.log(
          ` Skipping: Need ${threshold} validators, have ${validators.length}`,
        );
        this.skip();
      }
    });

    it("collects signatures across multiple transactions before executing", async () => {
      logSection("BRIDGE TRANSACTION - MULTI-SIG FLOW");

      // Get current batch ID and increment
      const validatorSetBefore = await program.account.validatorSet.fetch(
        VALIDATOR_SET_PDA,
      );
      const batchId = new anchor.BN(
        validatorSetBefore.lastBatchId.toString(),
      ).add(new anchor.BN(1));

      const multiSigRecipient = Keypair.generate();
      const amount = toRawAmount(2);

      console.log(`   Transaction Parameters:`);
      console.log(`   Batch ID: ${batchId.toString()}`);
      console.log(`   Amount: ${toHumanAmount(amount)} tokens`);
      console.log(`   Recipient: ${multiSigRecipient.publicKey.toBase58()}`);
      console.log(`   Threshold: ${threshold}`);

      const [bridgingTransactionPDA] = getBridgingTransactionPDA(batchId);
      const recipientAta = await getAssociatedTokenAddress(
        mint,
        multiSigRecipient.publicKey,
      );
      const vaultAta = await getAssociatedTokenAddress(mint, VAULT_PDA, true);

      // Sign with validators one at a time
      for (let i = 0; i < threshold; i++) {
        const validator = validators[i];
        const isLastSigner = i === threshold - 1;

        console.log(
          `\nApproval ${i + 1}/${threshold}: ${validator.publicKey
            .toBase58()
            .slice(0, 8)}...`,
        );

        const remainingAccounts = [
          {
            pubkey: validator.publicKey,
            isSigner: true,
            isWritable: false,
          },
        ];

        const tx = await program.methods
          .bridgeTransaction(amount, batchId)
          .accounts({
            payer: payer.publicKey,
            validatorSet: VALIDATOR_SET_PDA,
            bridgingTransaction: bridgingTransactionPDA,
            mintToken: mint,
            recipient: multiSigRecipient.publicKey,
            recipientAta: recipientAta,
            vault: VAULT_PDA,
            vaultAta: vaultAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          })
          .remainingAccounts(remainingAccounts)
          .signers([validator])
          .rpc();

        console.log(`   Tx: ${tx.slice(0, 20)}...`);

        // Check bridging transaction state (unless it's the last one which closes it)
        if (!isLastSigner) {
          const bridgingTx = await program.account.bridgingTransaction.fetch(
            bridgingTransactionPDA,
          );
          console.log(
            `   Signers so far: ${bridgingTx.signers.length}/${threshold}`,
          );
          expect(bridgingTx.signers.length).to.equal(i + 1);
        } else {
          // Last signer - account should be closed
          const bridgingTxAccount = await provider.connection.getAccountInfo(
            bridgingTransactionPDA,
          );
          console.log(
            `   Transaction executed and account closed: ${
              bridgingTxAccount === null ? "✅" : "❌"
            }`,
          );
          expect(bridgingTxAccount).to.be.null;
        }
      }

      // Verify recipient received tokens
      const recipientBalance = await provider.connection.getTokenAccountBalance(
        recipientAta,
      );
      console.log(
        `\n📊 Final recipient balance: ${toHumanAmount(
          Number(recipientBalance.value.amount),
        )} tokens`,
      );

      expect(Number(recipientBalance.value.amount)).to.equal(amount.toNumber());

      console.log(`\n✅ MULTI-SIG FLOW VERIFIED`);
      console.log(`   ✓ Collected ${threshold} signatures incrementally`);
      console.log(`   ✓ Transaction executed on final signature`);
    });
  });
});
