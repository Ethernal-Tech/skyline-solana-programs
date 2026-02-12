import * as anchor from "@coral-xyz/anchor";
import {
  createMint,
  mintTo,
  setAuthority,
  AuthorityType,
  getOrCreateAssociatedTokenAccount,
  getMint,
  getAccount,
} from "@solana/spl-token";
import {
  VAULT_PDA,
  MINT_DECIMALS,
  toRawAmount,
  toHumanAmount,
  logSection,
  updateNetworkConfig,
} from "./config";

describe("Setup: Create Burn Test Mint", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const payer = (provider.wallet as anchor.Wallet).payer;

  it("creates a mint with vault as authority and mints tokens to user", async () => {
    logSection("CREATING BURN TEST MINT");

    // ============ STEP 1: Create mint with temporary authority ============
    console.log(" Step 1: Creating new mint...");

    const tempAuthority = payer; // Use payer as temporary authority

    const burnMint = await createMint(
      provider.connection,
      payer,
      tempAuthority.publicKey, // Mint authority (temporary)
      null, // Freeze authority (none)
      MINT_DECIMALS, // Decimals
    );

    console.log(`    Mint created: ${burnMint.toBase58()}`);

    // ============ STEP 2: Create ATA for user ============
    console.log("\n Step 2: Creating user token account...");

    const userAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      burnMint,
      payer.publicKey,
    );

    console.log(`    User ATA: ${userAta.address.toBase58()}`);

    // ============ STEP 3: Mint tokens to user ============
    console.log("\n Step 3: Minting tokens to user...");

    const mintAmount = toRawAmount(1000); // Mint 1000 tokens

    await mintTo(
      provider.connection,
      payer,
      burnMint,
      userAta.address,
      tempAuthority,
      BigInt(mintAmount.toString()),
    );

    console.log(`    Minted ${toHumanAmount(mintAmount)} tokens to user`);

    // ============ STEP 4: Transfer mint authority to vault PDA ============
    console.log("\n Step 4: Transferring mint authority to vault...");

    await setAuthority(
      provider.connection,
      payer,
      burnMint,
      tempAuthority,
      AuthorityType.MintTokens,
      VAULT_PDA, // New authority = Vault PDA
    );

    console.log(
      `    Mint authority transferred to vault: ${VAULT_PDA.toBase58()}`,
    );

    // ============ VERIFY ============
    console.log("\n🔍 Verifying setup...");

    const mintInfo = await getMint(provider.connection, burnMint);
    const userTokenAccount = await getAccount(
      provider.connection,
      userAta.address,
    );
    const isVaultAuthority = mintInfo.mintAuthority?.equals(VAULT_PDA) ?? false;

    console.log(`   Mint: ${burnMint.toBase58()}`);
    console.log(`   Mint Authority: ${mintInfo.mintAuthority?.toBase58()}`);
    console.log(
      `   Vault is Authority: ${isVaultAuthority ? " YES" : " NO"}`,
    );
    console.log(
      `   User Balance: ${toHumanAmount(userTokenAccount.amount)} tokens`,
    );
    console.log(`   Total Supply: ${toHumanAmount(mintInfo.supply)} tokens`);

    // At the end of the test, after the console output:

    console.log("\n Updating network configuration...");
    updateNetworkConfig({
      mintBurn: burnMint.toBase58(),
    });
    console.log(" MINT_BURN automatically saved to config!");
  });
});
