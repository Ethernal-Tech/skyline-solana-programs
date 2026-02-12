import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SkylineProgram } from "../target/types/skyline_program";
import { PublicKey, Keypair } from "@solana/web3.js";
import { saveValidatorsToFile, updateNetworkConfig, logSection } from "./config";

describe("Initialize Skyline Bridge", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SkylineProgram as Program<SkylineProgram>;

  it("Initializes validator set and vault", async () => {
    logSection("BRIDGE INITIALIZATION");

    // Create test validators
    const validator1 = Keypair.generate();
    const validator2 = Keypair.generate();
    const validator3 = Keypair.generate();
    const validator4 = Keypair.generate();

    const validators = [
      validator1.publicKey,
      validator2.publicKey,
      validator3.publicKey,
      validator4.publicKey,
    ];

    console.log("Generated Validators:");
    validators.forEach((v, i) => {
      console.log(`   [${i + 1}] ${v.toBase58()}`);
    });

    // Derive PDAs
    const [validatorSet] = PublicKey.findProgramAddressSync(
      [Buffer.from("validator-set")],
      program.programId
    );

    const [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault")],
      program.programId
    );

    console.log("\n Program Accounts:");
    console.log(`   Program ID: ${program.programId.toBase58()}`);
    console.log(`   Validator Set PDA: ${validatorSet.toBase58()}`);
    console.log(`   Vault PDA: ${vault.toBase58()}`);

    // Initialize
    const tx = await program.methods
      .initialize(validators, new anchor.BN(0))
      .accounts({
        signer: provider.wallet.publicKey,
        validatorSet,
        vault,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log(`\nInitialize tx: ${tx}`);

    // **AUTO-SAVE VALIDATORS**
    console.log("\nSaving validator keypairs...");
    saveValidatorsToFile([validator1, validator2, validator3, validator4]);

    // **AUTO-UPDATE NETWORK CONFIG**
    console.log("\nUpdating network configuration...");
    updateNetworkConfig({
      programId: program.programId.toBase58(),
      validatorSetPda: validatorSet.toBase58(),
      vaultPda: vault.toBase58(),
    });

    console.log("\nINITIALIZATION COMPLETE!");
  });
});
