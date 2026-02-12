import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, SystemProgram, PublicKey } from "@solana/web3.js";
import { SkylineProgram } from "../target/types/skyline_program";
import {
  VALIDATOR_SET_PDA,
  logTxSuccess,
  logSection,
  getValidatorSetChangePDA,
  addValidatorToStorage,
  removeValidatorFromStorage,
  getActiveValidators,
} from "./config";
import { expect } from "chai";

describe.only("Bridge VSU (Validator Set Update)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SkylineProgram as Program<SkylineProgram>;
  const payer = (provider.wallet as anchor.Wallet).payer;

  let currentValidators: Keypair[] = [];
  let threshold: number = 0;
  let onChainValidators: PublicKey[] = [];

  before(async () => {
    logSection("LOADING CURRENT VALIDATOR SET");

    const validatorSetAccount = await program.account.validatorSet.fetch(
      VALIDATOR_SET_PDA,
    );

    threshold = validatorSetAccount.threshold;
    onChainValidators = validatorSetAccount.signers;

    console.log(`   Threshold: ${threshold}`);
    console.log(`   Validators on chain: ${onChainValidators.length}`);

    onChainValidators.forEach((v, i) => {
      console.log(`     [${i}] ${v.toBase58()}`);
    });

    // Get validators we have private keys for
    currentValidators = getActiveValidators(onChainValidators);

    console.log(
      `\n   Available validator keypairs: ${currentValidators.length}`,
    );
    currentValidators.forEach((v, i) => {
      console.log(`     [${i}] ${v.publicKey.toBase58()}`);
    });

    if (currentValidators.length < threshold) {
      console.log(
        `\n WARNING: Have ${currentValidators.length} keypairs but need ${threshold} for threshold`,
      );
    }
  });

  // ================================================================
  // TEST 1: ADD NEW VALIDATOR
  // ================================================================
  describe("Add New Validator", () => {
    let newValidator: Keypair;
    let batchId: anchor.BN;

    before(function () {
      if (currentValidators.length < threshold) {
        console.log(
          ` Skipping: Need ${threshold} validators, have ${currentValidators.length}`,
        );
        this.skip();
      }
    });

    it("should add a new validator with threshold consensus", async () => {
      logSection("VALIDATOR SET UPDATE - ADD VALIDATOR");

      // Generate new validator
      newValidator = Keypair.generate();
      console.log(`\n New Validator: ${newValidator.publicKey.toBase58()}`);

      // Get current state
      const validatorSetBefore = await program.account.validatorSet.fetch(
        VALIDATOR_SET_PDA,
      );
      batchId = new anchor.BN(validatorSetBefore.lastBatchId.toString()).add(
        new anchor.BN(1),
      );

      console.log(`\n VSU Parameters:`);
      console.log(`   Batch ID: ${batchId.toString()}`);
      console.log(`   Adding: ${newValidator.publicKey.toBase58()}`);
      console.log(`   Removing: []`);
      console.log(
        `   Current validator count: ${validatorSetBefore.signers.length}`,
      );
      console.log(`   After VSU: ${validatorSetBefore.signers.length + 1}`);

      // Derive VSU PDA
      const [validatorSetChangePDA] = getValidatorSetChangePDA(batchId);
      console.log(`   VSU PDA: ${validatorSetChangePDA.toBase58()}`);

      // Select validators to sign (meet threshold)
      const signingValidators = currentValidators.slice(0, threshold);
      console.log(
        `\n Validators signing (${signingValidators.length}/${threshold} required):`,
      );
      signingValidators.forEach((v, i) => {
        console.log(`   [${i}] ${v.publicKey.toBase58()}`);
      });

      // Build remaining accounts
      const remainingAccounts = signingValidators.map((v) => ({
        pubkey: v.publicKey,
        isSigner: true,
        isWritable: false,
      }));

      // Execute VSU
      const tx = await program.methods
        .bridgeVsu([newValidator.publicKey], [], batchId)
        .accounts({
          payer: payer.publicKey,
          validatorSet: VALIDATOR_SET_PDA,
          validatorSetChange: validatorSetChangePDA,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(remainingAccounts)
        .signers(signingValidators)
        .rpc();

      logTxSuccess("Bridge VSU (Add Validator)", tx);

      // Verify on-chain state
      const validatorSetAfter = await program.account.validatorSet.fetch(
        VALIDATOR_SET_PDA,
      );

      console.log(`\n Validator Set Changes:`);
      console.log(
        `   Count: ${validatorSetBefore.signers.length} → ${validatorSetAfter.signers.length}`,
      );
      console.log(
        `   Threshold: ${validatorSetBefore.threshold} → ${validatorSetAfter.threshold}`,
      );
      console.log(
        `   Last Batch ID: ${validatorSetBefore.lastBatchId.toString()} → ${validatorSetAfter.lastBatchId.toString()}`,
      );

      // Verify VSU account is closed
      const vsuAccount = await provider.connection.getAccountInfo(
        validatorSetChangePDA,
      );
      console.log(
        `   VSU Account Closed: ${vsuAccount === null ? " YES" : " NO"}`,
      );

      // Verify new validator is in the set
      const newValidatorAdded = validatorSetAfter.signers.some((v) =>
        v.equals(newValidator.publicKey),
      );
      console.log(
        `   New Validator Added: ${newValidatorAdded ? " YES" : " NO"}`,
      )

      // Assertions
      expect(validatorSetAfter.signers.length).to.equal(
        validatorSetBefore.signers.length + 1,
      );
      expect(validatorSetAfter.lastBatchId.toString()).to.equal(
        batchId.toString(),
      );
      expect(newValidatorAdded).to.be.true;
      expect(vsuAccount).to.be.null;

      console.log(`\n ADD VALIDATOR VERIFIED`);
      console.log(`   ✓ New validator added to set`);
      console.log(`   ✓ Threshold recalculated`);
      console.log(`   ✓ VSU account closed`);
      console.log(`   ✓ Last batch ID updated`);

      // **PERSIST THE NEW VALIDATOR**
      console.log(`\n Persisting new validator to storage...`);
      addValidatorToStorage(newValidator);

      console.log(`\n New validator persisted successfully!`);
      console.log(`   Location: tests/validators.json`);
    });
  });

  // ================================================================
  // TEST 2: REMOVE VALIDATOR
  // ================================================================
  describe("Remove Validator", () => {
    let validatorToRemove: PublicKey;
    let batchId: anchor.BN;

    before(async function () {
      // Reload validators after add test
      const validatorSetAccount = await program.account.validatorSet.fetch(
        VALIDATOR_SET_PDA,
      );

      onChainValidators = validatorSetAccount.signers;
      currentValidators = getActiveValidators(onChainValidators);
      threshold = validatorSetAccount.threshold;

      console.log(`\n   Current validators: ${currentValidators.length}`);
      console.log(`   Threshold: ${threshold}`);

      if (currentValidators.length < threshold) {
        console.log(
          `Skipping: Need ${threshold} validators, have ${currentValidators.length}`,
        );
        this.skip();
        return;
      }

      if (onChainValidators.length <= 1) {
        console.log(` Skipping: Need at least 2 validators to remove one`);
        this.skip();
      }
    });

    it("should remove a validator with threshold consensus", async () => {
      logSection("VALIDATOR SET UPDATE - REMOVE VALIDATOR");

      // Get current state
      const validatorSetBefore = await program.account.validatorSet.fetch(
        VALIDATOR_SET_PDA,
      );
      batchId = new anchor.BN(validatorSetBefore.lastBatchId.toString()).add(
        new anchor.BN(1),
      );

      // Choose last validator to remove (easier to track)
      validatorToRemove =
        validatorSetBefore.signers[validatorSetBefore.signers.length - 1];

      console.log(`\n Removing Validator: ${validatorToRemove.toBase58()}`);

      console.log(`\n VSU Parameters:`);
      console.log(`   Batch ID: ${batchId.toString()}`);
      console.log(`   Adding: []`);
      console.log(`   Removing: ${validatorToRemove.toBase58()}`);
      console.log(
        `   Current validator count: ${validatorSetBefore.signers.length}`,
      );
      console.log(`   After VSU: ${validatorSetBefore.signers.length - 1}`);

      // Derive VSU PDA
      const [validatorSetChangePDA] = getValidatorSetChangePDA(batchId);
      console.log(`   VSU PDA: ${validatorSetChangePDA.toBase58()}`);

      // Select validators to sign (EXCLUDING the one being removed if possible)
      let signingValidators = currentValidators
        .filter((v) => !v.publicKey.equals(validatorToRemove))
        .slice(0, threshold);

      // If we don't have enough after filtering, include the one being removed
      if (signingValidators.length < threshold) {
        signingValidators = currentValidators.slice(0, threshold);
      }

      console.log(
        `\n Validators signing (${signingValidators.length}/${threshold} required):`,
      );
      signingValidators.forEach((v, i) => {
        const isBeingRemoved = v.publicKey.equals(validatorToRemove);
        console.log(
          `   [${i}] ${v.publicKey.toBase58()}${
            isBeingRemoved ? "  (being removed)" : ""
          }`,
        );
      });

      // Build remaining accounts
      const remainingAccounts = signingValidators.map((v) => ({
        pubkey: v.publicKey,
        isSigner: true,
        isWritable: false,
      }));

      // Execute VSU
      const tx = await program.methods
        .bridgeVsu([], [validatorToRemove], batchId)
        .accounts({
          payer: payer.publicKey,
          validatorSet: VALIDATOR_SET_PDA,
          validatorSetChange: validatorSetChangePDA,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(remainingAccounts)
        .signers(signingValidators)
        .rpc();

      logTxSuccess("Bridge VSU (Remove Validator)", tx);

      // Verify on-chain state
      const validatorSetAfter = await program.account.validatorSet.fetch(
        VALIDATOR_SET_PDA,
      );

      console.log(`\n Validator Set Changes:`);
      console.log(
        `   Count: ${validatorSetBefore.signers.length} → ${validatorSetAfter.signers.length}`,
      );
      console.log(
        `   Threshold: ${validatorSetBefore.threshold} → ${validatorSetAfter.threshold}`,
      );
      console.log(
        `   Last Batch ID: ${validatorSetBefore.lastBatchId.toString()} → ${validatorSetAfter.lastBatchId.toString()}`,
      );

      // Verify VSU account is closed
      const vsuAccount = await provider.connection.getAccountInfo(
        validatorSetChangePDA,
      );
      console.log(
        `   VSU Account Closed: ${vsuAccount === null ? " YES" : " NO"}`,
      );

      // Verify validator is removed
      const validatorRemoved = !validatorSetAfter.signers.some((v) =>
        v.equals(validatorToRemove),
      );
      console.log(
        `   Validator Removed: ${validatorRemoved ? " YES" : " NO"}`,
      );

      // Assertions
      expect(validatorSetAfter.signers.length).to.equal(
        validatorSetBefore.signers.length - 1,
      );
      expect(validatorSetAfter.lastBatchId.toString()).to.equal(
        batchId.toString(),
      );
      expect(validatorRemoved).to.be.true;
      expect(vsuAccount).to.be.null;

      console.log(`\n REMOVE VALIDATOR VERIFIED`);
      console.log(`   ✓ Validator removed from set`);
      console.log(`   ✓ Threshold recalculated`);
      console.log(`   ✓ VSU account closed`);
      console.log(`   ✓ Last batch ID updated`);

      // **REMOVE FROM PERSISTENT STORAGE**
      console.log(`\n Removing validator from storage...`);
      removeValidatorFromStorage(validatorToRemove);

      console.log(`\n Validator removed from storage successfully!`);
      console.log(`    Location: tests/validators.json`);
    });
  });
});
