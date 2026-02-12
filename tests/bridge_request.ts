import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SystemProgram } from "@solana/web3.js";
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
} from "./config";
import { expect } from "chai";

describe("Bridge Request", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SkylineProgram as Program<SkylineProgram>;
  const payer = provider.wallet;

  // Shared bridge parameters
  const receiver = Buffer.from("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "hex");
  const destinationChain = 1;

  // ================================================================
  // TRANSFER BRANCH TEST
  // ================================================================
  describe("Transfer Branch (Vault is NOT mint authority)", () => {
    const mint = MINT_TRANSFER;

    it("transfers tokens to vault when vault is not mint authority", async () => {
      logSection("BRIDGE REQUEST - TRANSFER BRANCH");

      // Verify this mint is for transfer branch
      const mintInfo = await getMint(provider.connection, mint);
      const isVaultMintAuthority = mintInfo.mintAuthority?.equals(VAULT_PDA) ?? false;

      expect(isVaultMintAuthority).to.be.false;
      console.log(`   Branch: TRANSFER (vault is NOT mint authority)`);
      console.log(`   Mint: ${mint.toBase58()}`);

      // Get token accounts
      const signerAta = await getAssociatedTokenAddress(mint, payer.publicKey);
      const vaultAta = await getAssociatedTokenAddress(mint, VAULT_PDA, true);

      // Get balances before
      const signerBalanceBefore = await provider.connection.getTokenAccountBalance(signerAta);
      const signerBalanceBeforeNum = Number(signerBalanceBefore.value.amount);

      let vaultBalanceBeforeNum = 0;
      try {
        const vaultBalanceBefore = await provider.connection.getTokenAccountBalance(vaultAta);
        vaultBalanceBeforeNum = Number(vaultBalanceBefore.value.amount);
      } catch {
        // Vault ATA might not exist
      }

      console.log(`\n Balances Before:`);
      console.log(`   Signer: ${toHumanAmount(signerBalanceBeforeNum)} tokens`);
      console.log(`   Vault: ${toHumanAmount(vaultBalanceBeforeNum)} tokens`);

      // Bridge parameters
      const amount = toRawAmount(1);

      console.log(`\n Bridge Parameters:`);
      console.log(`   Amount: ${toHumanAmount(amount)} tokens`);
      console.log(`   Receiver: 0x${receiver.toString("hex")}`);

      // Execute
      const tx = await program.methods
        .bridgeRequest(amount, receiver, destinationChain)
        .accounts({
          signer: payer.publicKey,
          validatorSet: VALIDATOR_SET_PDA,
          signersAta: signerAta,
          vault: VAULT_PDA,
          vaultAta: vaultAta,
          mint: mint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        })
        .rpc();

      logTxSuccess("Bridge Request (Transfer)", tx);

      // Verify balances
      const signerBalanceAfter = await provider.connection.getTokenAccountBalance(signerAta);
      const signerBalanceAfterNum = Number(signerBalanceAfter.value.amount);
      const vaultBalanceAfter = await provider.connection.getTokenAccountBalance(vaultAta);
      const vaultBalanceAfterNum = Number(vaultBalanceAfter.value.amount);

      const signerDecrease = signerBalanceBeforeNum - signerBalanceAfterNum;
      const vaultIncrease = vaultBalanceAfterNum - vaultBalanceBeforeNum;

      console.log(`\n Balance Changes:`);
      console.log(`   Signer: ${toHumanAmount(signerBalanceBeforeNum)} → ${toHumanAmount(signerBalanceAfterNum)} (-${toHumanAmount(signerDecrease)})`);
      console.log(`   Vault: ${toHumanAmount(vaultBalanceBeforeNum)} → ${toHumanAmount(vaultBalanceAfterNum)} (+${toHumanAmount(vaultIncrease)})`);

      // Assertions
      expect(signerDecrease).to.equal(amount.toNumber());
      expect(vaultIncrease).to.equal(amount.toNumber());

      console.log(`\n TRANSFER BRANCH VERIFIED`);
      console.log(`   ✓ Tokens transferred to vault (NOT burned)`);
    });
  });

  // ================================================================
  // BURN BRANCH TEST
  // ================================================================
  describe("Burn Branch (Vault IS mint authority)", () => {
    before(function () {
      if (!MINT_BURN) {
        console.log("   Skipping burn tests: MINT_BURN not configured");
        console.log("   Run: yarn test tests/0_setup_burn_mint.ts");
        this.skip();
      }
    });

    it("burns tokens when vault is mint authority", async () => {
      logSection("BRIDGE REQUEST - BURN BRANCH");

      const mint = MINT_BURN!;

      // Verify this mint is for burn branch
      const mintInfo = await getMint(provider.connection, mint);
      const isVaultMintAuthority = mintInfo.mintAuthority?.equals(VAULT_PDA) ?? false;

      expect(isVaultMintAuthority).to.be.true;
      console.log(`   Branch: 🔥 BURN (vault IS mint authority)`);
      console.log(`   Mint: ${mint.toBase58()}`);
      console.log(`   Mint Authority: ${mintInfo.mintAuthority?.toBase58()}`);

      // Get token accounts
      const signerAta = await getAssociatedTokenAddress(mint, payer.publicKey);
      const vaultAta = await getAssociatedTokenAddress(mint, VAULT_PDA, true);

      // Get balances before
      const signerBalanceBefore = await provider.connection.getTokenAccountBalance(signerAta);
      const signerBalanceBeforeNum = Number(signerBalanceBefore.value.amount);
      const totalSupplyBefore = mintInfo.supply;

      console.log(`\n Balances Before:`);
      console.log(`   Signer: ${toHumanAmount(signerBalanceBeforeNum)} tokens`);
      console.log(`   Total Supply: ${toHumanAmount(totalSupplyBefore)} tokens`);

      // Bridge parameters
      const amount = toRawAmount(10); // Burn 10 tokens

      console.log(`\n Bridge Parameters:`);
      console.log(`   Amount: ${toHumanAmount(amount)} tokens`);
      console.log(`   Receiver: 0x${receiver.toString("hex")}`);

      // Execute
      const tx = await program.methods
        .bridgeRequest(amount, receiver, destinationChain)
        .accounts({
          signer: payer.publicKey,
          validatorSet: VALIDATOR_SET_PDA,
          signersAta: signerAta,
          vault: VAULT_PDA,
          vaultAta: vaultAta,
          mint: mint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        })
        .rpc();

      logTxSuccess("Bridge Request (Burn)", tx);

      // Verify balances
      const signerBalanceAfter = await provider.connection.getTokenAccountBalance(signerAta);
      const signerBalanceAfterNum = Number(signerBalanceAfter.value.amount);
      
      const mintInfoAfter = await getMint(provider.connection, mint);
      const totalSupplyAfter = mintInfoAfter.supply;

      const signerDecrease = signerBalanceBeforeNum - signerBalanceAfterNum;
      const supplyDecrease = Number(totalSupplyBefore) - Number(totalSupplyAfter);

      console.log(`\n Balance Changes:`);
      console.log(`   Signer: ${toHumanAmount(signerBalanceBeforeNum)} → ${toHumanAmount(signerBalanceAfterNum)} (-${toHumanAmount(signerDecrease)})`);
      console.log(`   Total Supply: ${toHumanAmount(totalSupplyBefore)} → ${toHumanAmount(totalSupplyAfter)} (-${toHumanAmount(supplyDecrease)})`);

      // Assertions
      expect(signerDecrease).to.equal(amount.toNumber());
      expect(supplyDecrease).to.equal(amount.toNumber());

      console.log(`\n BURN BRANCH VERIFIED`);
      console.log(`   ✓ Tokens burned (removed from total supply)`);
    });
  });
});
