import * as anchor from "@coral-xyz/anchor";
import { Program, web3 } from "@coral-xyz/anchor";
import { SkylineProgram } from "../target/types/skyline_program";
import { assert, expect } from "chai";
import {
  CpiGuardLayout,
  createAssociatedTokenAccount,
  createMint,
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";
import { publicKey } from "@coral-xyz/anchor/dist/cjs/utils";

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

  const recipient = anchor.web3.Keypair.generate();

  let mint: web3.PublicKey;
  createMint(provider.connection, owner.payer, vsPDA, null, 9).then(
    (m) => (mint = m)
  );

  describe("Initialize - Bad Cases", () => {
    it("provided less (3) than MIN_VALIDATORS (4) validators", async () => {
      try {
        await program.methods
          .initialize(validators.slice(0, 3).map((v) => v.publicKey))
          .accounts({
            signer: owner.publicKey,
          })
          .rpc();

        assert.fail(
          "Transaction should have failed with MinValidatorsNotMet error"
        );
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

        assert.fail(
          "Transaction should have failed with MaxValidatorsExceeded error"
        );
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

        assert.fail(
          "Transaction should have failed with ValidatorsNotUnique error"
        );
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

        assert.fail(
          "Transaction should have failed with MinValidatorsNotMet error"
        );
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

        assert.fail(
          "Transaction should have failed because account already exists"
        );
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

  describe("Bridge Tokens - Success Case", () => {
    it("successful", async () => {
      const amount = new anchor.BN(1_000_000_000);
      const recipientAta = getAssociatedTokenAddressSync(
        mint,
        recipient.publicKey
      );

      const remainingAccounts = validators.slice(0, 7).map((v) => ({
        pubkey: v.publicKey,
        isSigner: true,
        isWritable: false,
      }));

      await program.methods
        .bridgeTokens(amount)
        .accounts({
          payer: owner.publicKey,
          mint: mint,
          recipient: recipient.publicKey,
          recipientAta: recipientAta,
        })
        .remainingAccounts(remainingAccounts)
        .signers(validators.slice(0, 7))
        .rpc();

      const recipientBalance = await provider.connection.getTokenAccountBalance(
        recipientAta
      );

      assert.equal(recipientBalance.value.amount, "1000000000");
    });
  });

  describe("Bridge Tokens - Bad Cases", () => {
    it("one of the signers is not part of the validator set", async () => {
      const amount = new anchor.BN(1_000_000_000);
      const recipientAta = getAssociatedTokenAddressSync(
        mint,
        recipient.publicKey
      );

      const fakeSigner = anchor.web3.Keypair.generate();

      const remainingAccounts = [
        ...validators.slice(0, 6).map((v) => ({
          pubkey: v.publicKey,
          isSigner: true,
          isWritable: false,
        })),
        {
          pubkey: fakeSigner.publicKey,
          isSigner: true,
          isWritable: false,
        },
      ];

      try {
        await program.methods
          .bridgeTokens(amount)
          .accounts({
            payer: owner.publicKey,
            mint: mint,
            recipient: recipient.publicKey,
            recipientAta: recipientAta,
          })
          .remainingAccounts(remainingAccounts)
          .signers([...validators.slice(0, 6), fakeSigner])
          .rpc();

        assert.fail("Transaction should have failed with InvalidSigner error");
      } catch (e) {
        expect(e.error.errorCode.code).to.equal("InvalidSigner");
      }
    });

    it("quorum of signers not reached for the transaction", async () => {
      const amount = new anchor.BN(1_000_000_000);
      const recipientAta = getAssociatedTokenAddressSync(
        mint,
        recipient.publicKey
      );

      const remainingAccounts = validators.slice(0, 2).map((v) => ({
        pubkey: v.publicKey,
        isSigner: true,
        isWritable: false,
      }));

      try {
        await program.methods
          .bridgeTokens(amount)
          .accounts({
            payer: owner.publicKey,
            mint: mint,
            recipient: recipient.publicKey,
            recipientAta: recipientAta,
          })
          .remainingAccounts(remainingAccounts)
          .signers(validators.slice(0, 2))
          .rpc();

        assert.fail(
          "Transaction should have failed with NotEnoughSigners error"
        );
      } catch (e) {
        expect(e.error.errorCode.code).to.equal("NotEnoughSigners");
      }
    });

    it("provided token has a mint authority different from the PDA account", async () => {
      const amount = new anchor.BN(1_000_000_000);
      const recipientAta = getAssociatedTokenAddressSync(
        mint,
        recipient.publicKey
      );

      const wrongMint = await createMint(
        provider.connection,
        owner.payer,
        anchor.web3.Keypair.generate().publicKey,
        null,
        9
      );

      const remainingAccounts = validators.slice(0, 7).map((v) => ({
        pubkey: v.publicKey,
        isSigner: true,
        isWritable: false,
      }));

      let failed = false;

      try {
        await program.methods
          .bridgeTokens(amount)
          .accounts({
            payer: owner.publicKey,
            mint: wrongMint,
            recipient: recipient.publicKey,
            recipientAta: getAssociatedTokenAddressSync(
              wrongMint,
              recipient.publicKey
            ),
          })
          .remainingAccounts(remainingAccounts)
          .signers(validators.slice(0, 7))
          .rpc();

        assert.fail(
          "Transaction should have failed because validator set is not mint authority"
        );
      } catch (e) {
        failed = true;
      }

      assert.isTrue(failed, "Expected transaction to fail but it succeeded");
    });
  });

  describe("Bridge Request - Success Case", () => {
    it("successful", async () => {
      const amount = new anchor.BN(1_000_000_000);
      let receiver: number[];
      receiver = Array.from(
        Buffer.from(
          "0x1234567890123456789012345678901234567890123456789012345678901234567890123",
          "hex"
        )
      );

      const destination_chain = 1; // Example chain ID

      const ownerAta = await createAssociatedTokenAccount(
        provider.connection,
        owner.payer,
        mint,
        owner.publicKey
      );

      // Mint some tokens to the owner's associated token account for testing
      const remainingAccounts = validators.slice(0, 7).map((v) => ({
        pubkey: v.publicKey,
        isSigner: true,
        isWritable: false,
      }));

      await program.methods
        .bridgeTokens(amount)
        .accounts({
          payer: owner.publicKey,
          mint: mint,
          recipient: recipient.publicKey,
          recipientAta: ownerAta,
        })
        .remainingAccounts(remainingAccounts)
        .signers(validators.slice(0, 7))
        .rpc();

      await program.methods
        .bridgeRequest(amount, receiver, destination_chain)
        .accounts({
          signer: owner.publicKey,
          signersAta: ownerAta,
          mint: mint,
        })
        .rpc();

      const bridgingRequestPDA = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("bridging_request"), owner.publicKey.toBuffer()],
        program.programId
      )[0];

      const br = await program.account.bridgingRequest.fetch(
        bridgingRequestPDA
      );

      assert.equal(br.sender.toBase58(), owner.publicKey.toBase58());
    });
  });
});
