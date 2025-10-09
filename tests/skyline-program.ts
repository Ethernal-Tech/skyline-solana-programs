import * as anchor from "@coral-xyz/anchor";
import { Program, web3 } from "@coral-xyz/anchor";
import { SkylineProgram } from "../target/types/skyline_program";
import { assert, expect } from "chai";

describe("skyline-program", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider();
  const program = anchor.workspace.skylineProgram as Program<SkylineProgram>;
  const owner = provider.wallet;

  const validators: web3.Keypair[] = [];
  for (let i = 0; i < 25; i++) {
    validators.push(anchor.web3.Keypair.generate());
  }

  const vsPDA = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("validator-set")],
    program.programId
  )[0];

  describe("Initialize - Bad Cases", () => {
    it("provided less (3) than MIN_VALIDATORS (4) validators", async () => {
      try {
        await program.methods
          .initialize(validators.slice(0, 3).map((v) => v.publicKey))
          .accounts({
            signer: owner.publicKey,
          })
          .rpc();
        
        assert.fail("Transaction should have failed with MinValidatorsNotMet error");
      } catch (e) {
        expect(e.error.errorCode.code).to.equal("MinValidatorsNotMet");
      }
    });

    it("provided more (20) than MAX_VALIDATORS (19) validators", async () => {
      try {
        await program.methods
          .initialize(validators.slice(0, 20).map((v) => v.publicKey))
          .accounts({
            signer: owner.publicKey,
          })
          .rpc();
        
        assert.fail("Transaction should have failed with MaxValidatorsExceeded error");
      } catch (e) {
        expect(e.error.errorCode.code).to.equal("MaxValidatorsExceeded");
      }
    });

    it("duplicate validator provided", async () => {
      const duplicateValidators = [
        validators[0].publicKey,
        validators[1].publicKey,
        validators[2].publicKey,
        validators[3].publicKey,
        validators[0].publicKey,
      ];

      try {
        await program.methods
          .initialize(duplicateValidators)
          .accounts({
            signer: owner.publicKey,
          })
          .rpc();
        
        assert.fail("Transaction should have failed with ValidatorsNotUnique error");
      } catch (e) {
        expect(e.error.errorCode.code).to.equal("ValidatorsNotUnique");
      }
    });

    it("no validators provided", async () => {
      try {
        await program.methods
          .initialize([])
          .accounts({
            signer: owner.publicKey,
          })
          .rpc();
        
        assert.fail("Transaction should have failed with MinValidatorsNotMet error");
      } catch (e) {
        expect(e.error.errorCode.code).to.equal("MinValidatorsNotMet");
      }
    });
  });

  describe("Initialize - Success Case", () => {
    it("correct number of validators (10)", async () => {
      await program.methods
        .initialize(validators.slice(0, 10).map((v) => v.publicKey))
        .accounts({
          signer: owner.publicKey,
        })
        .rpc();

      const vs = await program.account.validatorSet.fetch(vsPDA);
      
      vs.signers.forEach((v) => {
        assert(validators.slice(0, 10).find((val) => val.publicKey.equals(v)));
      });

      assert.equal(vs.threshold, 7);
      assert.isNumber(vs.bump);
    });
  });

  describe("Initialize - After Account Already Exists", () => {
    it("PDA account already exists", async () => {
      try {
        await program.methods
          .initialize(validators.slice(10, 14).map((v) => v.publicKey))
          .accounts({
            signer: owner.publicKey,
          })
          .rpc();
        
        assert.fail("Transaction should have failed because account already exists");
      } catch (error) {
        const errorString = error.toString();
        
        const accountExistsError = 
          errorString.includes("already in use") || 
          errorString.includes("custom program error: 0x0") ||
          errorString.includes("AccountAlreadyInitialized");
        
        expect(accountExistsError).to.be.true;
      }
    });
  });
});