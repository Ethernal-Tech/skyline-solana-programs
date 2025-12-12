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
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { publicKey } from "@coral-xyz/anchor/dist/cjs/utils";

describe("skyline-program", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider();
  const program = anchor.workspace.skylineProgram as Program<SkylineProgram>;
  const owner = provider.wallet;

  const validators: web3.Keypair[] = [];
  for (let i = 0; i < 50; i++) {
    validators.push(anchor.web3.Keypair.generate());
  }

  const vsPDA = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("validator-set")],
    program.programId
  )[0];

  const vaultPDA = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault")],
    program.programId
  )[0];

  const recipient = anchor.web3.Keypair.generate();

  let mint: web3.PublicKey;
  createMint(provider.connection, owner.payer, owner.publicKey, null, 9).then(
    (m) => (mint = m)
  );

  const mintToVault = async (amount: number) => {
    const ata = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      owner.payer,
      mint,
      vaultPDA,
      true
    );

    await mintTo(
      provider.connection,
      owner.payer,
      mint,
      ata.address,
      owner.payer,
      amount
    );
  };

  describe("Initialize - Bad Cases", () => {
    it("provided less (3) than MIN_VALIDATORS (4) validators", async () => {
      try {
        await program.methods
          .initialize(
            validators.slice(0, 3).map((v) => v.publicKey),
            new anchor.BN(0)
          )
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

    it("provided more validators (30) than can be accommodated within tx size (29)", async () => {
      try {
        await program.methods
          .initialize(
            validators.slice(0, 30).map((v) => v.publicKey),
            new anchor.BN(0)
          )
          .accounts({
            signer: owner.publicKey,
          })
          .rpc();

        assert.fail("Transaction should have failed");
      } catch (e) {}
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
          .initialize(duplicateValidators, new anchor.BN(0))
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
          .initialize([], new anchor.BN(0))
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
    it("correct number of validators (7)", async () => {
      await program.methods
        .initialize(
          validators.slice(0, 7).map((v) => v.publicKey),
          new anchor.BN(0)
        )
        .accounts({
          signer: owner.publicKey,
        })
        .rpc();

      const vs = await program.account.validatorSet.fetch(vsPDA);

      vs.signers.forEach((v) => {
        assert(validators.slice(0, 7).find((val) => val.publicKey.equals(v)));
      });

      assert.equal(vs.threshold, 5);
      assert.isNumber(vs.bump);
    });
  });

  const bridgeToSolana = async (signers: web3.Keypair[], batchId: number) => {
    const remainingAccounts = signers.map((v) => ({
      pubkey: v.publicKey,
      isSigner: true,
      isWritable: false,
    }));

    await program.methods
      .bridgeTransaction(new anchor.BN(100), new anchor.BN(batchId))
      .accounts({
        payer: owner.publicKey,
        recipient: recipient.publicKey,
        mintToken: mint,
        recipientAta: getAssociatedTokenAddressSync(mint, recipient.publicKey),
        vaultAta: getAssociatedTokenAddressSync(mint, vaultPDA, true),
      })
      .signers(signers)
      .remainingAccounts(remainingAccounts)
      .rpc();
  };

  describe("Bridge to Solana using 2 txs (quorum is 5)", () => {
    it("send a tx with 3 sigs, one of which is from a non-validator -> tx fails", async () => {
      try {
        await bridgeToSolana([validators[0], validators[1], validators[15]], 1);

        assert.fail("Transaction should have failed with InvalidSigner error");
      } catch (e) {
        expect(e.error.errorCode.code).to.equal("InvalidSigner");
      }

      assert.lengthOf(await program.account.bridgingTransaction.all(), 0);
    });

    it("send a tx with 3 sigs, two of which are duplicates -> tx fails", async () => {
      try {
        await bridgeToSolana([validators[0], validators[1], validators[1]], 1);

        assert.fail(
          "Transaction should have failed with DuplicateSignersProvided error"
        );
      } catch (e) {
        expect(e.error.errorCode.code).to.equal("DuplicateSignersProvided");
      }

      assert.lengthOf(await program.account.bridgingTransaction.all(), 0);
    });

    it("send a tx with 3 sigs -> tx succeeds", async () => {
      await bridgeToSolana([validators[0], validators[1], validators[2]], 1);

      for (let i = 0; i < 3; i++) {
        assert.isTrue(
          (
            await program.account.bridgingTransaction.all()
          )[0].account.signers.find(
            (x) => x.toBase58() === validators[i].publicKey.toBase58()
          ) != null
        );
      }
    });

    it("send a tx with 3 sigs, one of which is from a non-validator -> tx fails", async () => {
      try {
        await bridgeToSolana([validators[3], validators[4], validators[15]], 1);

        assert.fail("Transaction should have failed with InvalidSigner error");
      } catch (e) {
        expect(e.error.errorCode.code).to.equal("InvalidSigner");
      }

      assert.lengthOf(await program.account.bridgingTransaction.all(), 1);

      assert.lengthOf(
        (await program.account.bridgingTransaction.all())[0].account.signers,
        3
      );

      for (let i = 0; i < 3; i++) {
        assert.isTrue(
          (
            await program.account.bridgingTransaction.all()
          )[0].account.signers.find(
            (x) => x.toBase58() === validators[i].publicKey.toBase58()
          ) != null
        );
      }
    });

    it("send a tx with 3 sigs, two of which are duplicates -> tx fails", async () => {
      try {
        await bridgeToSolana([validators[3], validators[4], validators[4]], 1);

        assert.fail(
          "Transaction should have failed with DuplicateSignersProvided error"
        );
      } catch (e) {
        expect(e.error.errorCode.code).to.equal("DuplicateSignersProvided");
      }

      assert.lengthOf(await program.account.bridgingTransaction.all(), 1);

      assert.lengthOf(
        (await program.account.bridgingTransaction.all())[0].account.signers,
        3
      );

      for (let i = 0; i < 3; i++) {
        assert.isTrue(
          (
            await program.account.bridgingTransaction.all()
          )[0].account.signers.find(
            (x) => x.toBase58() === validators[i].publicKey.toBase58()
          ) != null
        );
      }
    });

    it("send a tx with 3 sigs, one of which is from a validator that already voted in step 3 -> tx fails", async () => {
      try {
        await bridgeToSolana([validators[3], validators[4], validators[1]], 1);

        assert.fail(
          "Transaction should have failed with SignerAlreadyApproved error"
        );
      } catch (e) {
        expect(e.error.errorCode.code).to.equal("SignerAlreadyApproved");
      }

      assert.lengthOf(await program.account.bridgingTransaction.all(), 1);

      assert.lengthOf(
        (await program.account.bridgingTransaction.all())[0].account.signers,
        3
      );

      for (let i = 0; i < 3; i++) {
        assert.isTrue(
          (
            await program.account.bridgingTransaction.all()
          )[0].account.signers.find(
            (x) => x.toBase58() === validators[i].publicKey.toBase58()
          ) != null
        );
      }
    });

    it("send a tx with 3 sigs -> tx succeeds", async () => {
      await mintToVault(1000);

      assert.equal(
        (
          await program.account.validatorSet.all()
        )[0].account.lastBatchId.toNumber(),
        0
      );

      await bridgeToSolana([validators[3], validators[4], validators[5]], 1);

      assert.equal(
        (
          await program.account.validatorSet.all()
        )[0].account.lastBatchId.toNumber(),
        1
      );

      const tokenBalance = await provider.connection.getTokenAccountBalance(
        getAssociatedTokenAddressSync(mint, recipient.publicKey)
      );

      assert.equal(tokenBalance.value.amount, "100");
      assert.lengthOf(await program.account.bridgingTransaction.all(), 0);
    });
  });

  describe("Bridge to Solana using 1 txs", () => {
    it("successful", async () => {
      assert.equal(
        (
          await program.account.validatorSet.all()
        )[0].account.lastBatchId.toNumber(),
        1
      );

      await bridgeToSolana(validators.slice(0, 5), 8);

      assert.equal(
        (
          await program.account.validatorSet.all()
        )[0].account.lastBatchId.toNumber(),
        8
      );

      const tokenBalance = await provider.connection.getTokenAccountBalance(
        getAssociatedTokenAddressSync(mint, recipient.publicKey)
      );

      assert.equal(tokenBalance.value.amount, "200");
      assert.lengthOf(await program.account.bridgingTransaction.all(), 0);
    });
  });

  describe("Replay attack attempt: Bridge to Solana using 1 tx with a batch ID that is too low", () => {
    it("unsuccessful", async () => {
      assert.equal(
        (
          await program.account.validatorSet.all()
        )[0].account.lastBatchId.toNumber(),
        8
      );

      try {
        await bridgeToSolana(validators.slice(0, 5), 8);

        assert.fail("Transaction should have failed with InvalidBatchId error");
      } catch (e) {
        expect(e.error.errorCode.code).to.equal("InvalidBatchId");
      }

      assert.equal(
        (
          await program.account.validatorSet.all()
        )[0].account.lastBatchId.toNumber(),
        8
      );

      const tokenBalance = await provider.connection.getTokenAccountBalance(
        getAssociatedTokenAddressSync(mint, recipient.publicKey)
      );

      assert.equal(tokenBalance.value.amount, "200");
      assert.lengthOf(await program.account.bridgingTransaction.all(), 0);
    });
  });

  const changeValidatorSet = async (
    signers: web3.Keypair[],
    added: web3.PublicKey[],
    removed: anchor.BN[],
    batchId: number
  ) => {
    const remainingAccounts = signers.map((v) => ({
      pubkey: v.publicKey,
      isSigner: true,
      isWritable: false,
    }));

    await program.methods
      .bridgeVsu(added, removed, new anchor.BN(batchId))
      .accounts({
        payer: owner.publicKey,
      })
      .signers(signers)
      .remainingAccounts(remainingAccounts)
      .rpc();
  };

  describe("Validator set update using 2 tx - add", () => {
    it("send a tx with 3 sigs, one of which is from a non-validator -> tx fails", async () => {
      try {
        await changeValidatorSet(
          [validators[0], validators[1], validators[15]],
          [validators[7].publicKey, validators[8].publicKey],
          [],
          9
        );

        assert.fail("Transaction should have failed with InvalidSigner error");
      } catch (e) {
        expect(e.error.errorCode.code).to.equal("InvalidSigner");
      }

      assert.lengthOf(await program.account.validatorDelta.all(), 0);
    });

    it("send a tx with 3 sigs, two of which are duplicates -> tx fails", async () => {
      try {
        await changeValidatorSet(
          [validators[0], validators[1], validators[1]],
          [validators[7].publicKey, validators[8].publicKey],
          [],
          9
        );

        assert.fail(
          "Transaction should have failed with DuplicateSignersProvided error"
        );
      } catch (e) {
        expect(e.error.errorCode.code).to.equal("DuplicateSignersProvided");
      }

      assert.lengthOf(await program.account.validatorDelta.all(), 0);
    });

    it("send a tx with 3 sigs -> tx succeeds", async () => {
      await changeValidatorSet(
        [validators[0], validators[1], validators[2]],
        [validators[7].publicKey, validators[8].publicKey],
        [],
        9
      );

      for (let i = 0; i < 3; i++) {
        assert.isTrue(
          (await program.account.validatorDelta.all())[0].account.signers.find(
            (x) => x.toBase58() === validators[i].publicKey.toBase58()
          ) != null
        );
      }
    });

    it("send a tx with 3 sigs, one of which is from a non-validator -> tx fails", async () => {
      try {
        await changeValidatorSet(
          [validators[3], validators[4], validators[15]],
          [validators[7].publicKey, validators[8].publicKey],
          [],
          9
        );

        assert.fail("Transaction should have failed with InvalidSigner error");
      } catch (e) {
        expect(e.error.errorCode.code).to.equal("InvalidSigner");
      }

      assert.lengthOf(await program.account.validatorDelta.all(), 1);

      assert.lengthOf(
        (await program.account.validatorDelta.all())[0].account.signers,
        3
      );

      for (let i = 0; i < 3; i++) {
        assert.isTrue(
          (await program.account.validatorDelta.all())[0].account.signers.find(
            (x) => x.toBase58() === validators[i].publicKey.toBase58()
          ) != null
        );
      }
    });

    it("send a tx with 3 sigs, two of which are duplicates -> tx fails", async () => {
      try {
        await changeValidatorSet(
          [validators[3], validators[4], validators[4]],
          [validators[7].publicKey, validators[8].publicKey],
          [],
          9
        );

        assert.fail(
          "Transaction should have failed with DuplicateSignersProvided error"
        );
      } catch (e) {
        expect(e.error.errorCode.code).to.equal("DuplicateSignersProvided");
      }

      assert.lengthOf(await program.account.validatorDelta.all(), 1);

      assert.lengthOf(
        (await program.account.validatorDelta.all())[0].account.signers,
        3
      );

      for (let i = 0; i < 3; i++) {
        assert.isTrue(
          (await program.account.validatorDelta.all())[0].account.signers.find(
            (x) => x.toBase58() === validators[i].publicKey.toBase58()
          ) != null
        );
      }
    });

    it("send a tx with 3 sigs, one of which is from a validator that already voted in step 3 -> tx fails", async () => {
      try {
        await changeValidatorSet(
          [validators[3], validators[4], validators[1]],
          [validators[7].publicKey, validators[8].publicKey],
          [],
          9
        );

        assert.fail(
          "Transaction should have failed with SignerAlreadyApproved error"
        );
      } catch (e) {
        expect(e.error.errorCode.code).to.equal("SignerAlreadyApproved");
      }

      assert.lengthOf(await program.account.validatorDelta.all(), 1);

      assert.lengthOf(
        (await program.account.validatorDelta.all())[0].account.signers,
        3
      );

      for (let i = 0; i < 3; i++) {
        assert.isTrue(
          (await program.account.validatorDelta.all())[0].account.signers.find(
            (x) => x.toBase58() === validators[i].publicKey.toBase58()
          ) != null
        );
      }
    });

    it("send a tx with 3 sigs -> tx succeeds", async () => {
      assert.equal(
        (
          await program.account.validatorSet.all()
        )[0].account.lastBatchId.toNumber(),
        8
      );

      await changeValidatorSet(
        [validators[3], validators[4], validators[5]],
        [validators[7].publicKey, validators[8].publicKey],
        [],
        9
      );

      assert.equal(
        (
          await program.account.validatorSet.all()
        )[0].account.lastBatchId.toNumber(),
        9
      );

      assert.lengthOf(await program.account.validatorDelta.all(), 0);

      assert.lengthOf(
        (await program.account.validatorSet.all())[0].account.signers,
        9
      );

      assert.isTrue(
        (await program.account.validatorSet.all())[0].account.threshold === 7
      );

      for (let i = 0; i < 9; i++) {
        assert.isTrue(
          (await program.account.validatorSet.all())[0].account.signers.find(
            (x) => x.toBase58() === validators[i].publicKey.toBase58()
          ) != null
        );
      }
    });
  });

  describe("Validator set update using 1 tx - add", () => {
    it("successful", async () => {
      assert.equal(
        (
          await program.account.validatorSet.all()
        )[0].account.lastBatchId.toNumber(),
        9
      );

      await changeValidatorSet(
        validators.slice(0, 7),
        [validators[9].publicKey],
        [],
        10
      );

      assert.equal(
        (
          await program.account.validatorSet.all()
        )[0].account.lastBatchId.toNumber(),
        10
      );

      assert.lengthOf(await program.account.validatorDelta.all(), 0);

      assert.lengthOf(
        (await program.account.validatorSet.all())[0].account.signers,
        10
      );

      assert.isTrue(
        (await program.account.validatorSet.all())[0].account.threshold === 7
      );

      for (let i = 0; i < 10; i++) {
        assert.isTrue(
          (await program.account.validatorSet.all())[0].account.signers.find(
            (x) => x.toBase58() === validators[i].publicKey.toBase58()
          ) != null
        );
      }
    });
  });

  describe("Validator set update using 1 tx - mix", () => {
    it("successful", async () => {
      assert.equal(
        (
          await program.account.validatorSet.all()
        )[0].account.lastBatchId.toNumber(),
        10
      );

      await changeValidatorSet(
        validators.slice(0, 7),
        [validators[10].publicKey],
        [new anchor.BN(0), new anchor.BN(1), new anchor.BN(2)],
        11
      );

      assert.equal(
        (
          await program.account.validatorSet.all()
        )[0].account.lastBatchId.toNumber(),
        11
      );

      assert.lengthOf(await program.account.validatorDelta.all(), 0);

      assert.lengthOf(
        (await program.account.validatorSet.all())[0].account.signers,
        8
      );

      assert.isTrue(
        (await program.account.validatorSet.all())[0].account.threshold === 6
      );

      for (let i = 3; i < 11; i++) {
        assert.isTrue(
          (await program.account.validatorSet.all())[0].account.signers.find(
            (x) => x.toBase58() === validators[i].publicKey.toBase58()
          ) != null
        );
      }
    });
  });

  describe("Attempt to remove too many validators, causing it to fall below 4", () => {
    it("unsuccessful", async () => {
      assert.equal(
        (
          await program.account.validatorSet.all()
        )[0].account.lastBatchId.toNumber(),
        11
      );

      try {
        await changeValidatorSet(
          validators.slice(0, 7),
          [],
          [
            new anchor.BN(0),
            new anchor.BN(1),
            new anchor.BN(2),
            new anchor.BN(3),
            new anchor.BN(4),
          ],
          12
        );

        assert.fail(
          "Transaction should have failed with MinValidatorsNotMet error"
        );
      } catch (e) {
        expect(e.error.errorCode.code).to.equal("MinValidatorsNotMet");
      }

      assert.equal(
        (
          await program.account.validatorSet.all()
        )[0].account.lastBatchId.toNumber(),
        11
      );

      assert.lengthOf(await program.account.validatorDelta.all(), 0);

      assert.lengthOf(
        (await program.account.validatorSet.all())[0].account.signers,
        8
      );

      assert.isTrue(
        (await program.account.validatorSet.all())[0].account.threshold === 6
      );

      for (let i = 3; i < 11; i++) {
        assert.isTrue(
          (await program.account.validatorSet.all())[0].account.signers.find(
            (x) => x.toBase58() === validators[i].publicKey.toBase58()
          ) != null
        );
      }
    });
  });

  describe("Initialize - After Account Already Exists", () => {
    it("PDA account already exists", async () => {
      try {
        await program.methods
          .initialize(
            validators.slice(10, 14).map((v) => v.publicKey),
            new anchor.BN(0)
          )
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

  const mintToAnyone = async (pubKey: web3.PublicKey, amount: number) => {
    const ata = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      owner.payer,
      mint,
      pubKey,
      true
    );

    await mintTo(
      provider.connection,
      owner.payer,
      mint,
      ata.address,
      owner.payer,
      amount
    );
  };

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

      await mintToAnyone(owner.publicKey, 1_000_000_000_000);

      const destination_chain = 1;

      const ownerAta = getAssociatedTokenAddressSync(mint, owner.publicKey);

      await program.methods
        .bridgeRequest(amount, receiver, destination_chain)
        .accounts({
          signer: owner.publicKey,
          signersAta: ownerAta,
          vaultAta: getAssociatedTokenAddressSync(mint, vaultPDA, true),
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
      assert.equal(br.amount.toString(), amount.toString());
      assert.equal(br.destinationChain, destination_chain);
    });
  });

  describe("Bridge Request - Bad Cases", () => {
    it("bridging an amount greater than the available balance", async () => {
      let receiver: number[];
      receiver = Array.from(
        Buffer.from(
          "0x1234567890123456789012345678901234567890123456789012345678901234567890123",
          "hex"
        )
      );
      const destination_chain = 1;

      const newOwner = anchor.web3.Keypair.generate();

      const airdropSig = await provider.connection.requestAirdrop(
        newOwner.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdropSig);

      const ownerAtaInfo = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        owner.payer,
        mint,
        newOwner.publicKey
      );
      const ownerAta = ownerAtaInfo.address;

      const bridgeAmount = new anchor.BN(10_000);

      try {
        await program.methods
          .bridgeRequest(bridgeAmount, receiver, destination_chain)
          .accounts({
            signer: newOwner.publicKey,
            signersAta: ownerAta,
            vaultAta: getAssociatedTokenAddressSync(mint, vaultPDA, true),
            mint: mint,
          })
          .signers([newOwner])
          .rpc();

        assert.fail(
          "Transaction should have failed with InsufficientFunds error"
        );
      } catch (e) {
        expect(e.error.errorCode.code).to.equal("InsufficientFunds");
      }
    });

    it("ATA is not initialized", async () => {
      const amount = new anchor.BN(10_000);
      let receiver: number[];
      receiver = Array.from(
        Buffer.from(
          "0x1234567890123456789012345678901234567890123456789012345678901234567890123",
          "hex"
        )
      );
      const destination_chain = 1;

      const newOwner = anchor.web3.Keypair.generate();
      const airdropSig = await provider.connection.requestAirdrop(
        newOwner.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdropSig);

      const ownerAta = await getAssociatedTokenAddress(
        mint,
        newOwner.publicKey
      );

      try {
        await program.methods
          .bridgeRequest(amount, receiver, destination_chain)
          .accounts({
            signer: newOwner.publicKey,
            signersAta: ownerAta,
            vaultAta: getAssociatedTokenAddressSync(mint, vaultPDA, true),
            mint: mint,
          })
          .signers([newOwner])
          .rpc();

        assert.fail(
          "Transaction should have failed with AccountNotInitialized error"
        );
      } catch (e: any) {
        expect(e.error.errorCode.code).to.equal("AccountNotInitialized");
      }
    });

    it("invalid length for the receiver field", async () => {
      const amount = new anchor.BN(10_000);
      let receiver: number[] = [1, 2, 3, 4, 5];
      const destination_chain = 1;

      const newOwner = anchor.web3.Keypair.generate();
      const airdropSig = await provider.connection.requestAirdrop(
        newOwner.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdropSig);

      const ownerAtaInfo = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        owner.payer,
        mint,
        newOwner.publicKey
      );
      const ownerAta = ownerAtaInfo.address;

      try {
        await program.methods
          .bridgeRequest(amount, receiver, destination_chain)
          .accounts({
            signer: newOwner.publicKey,
            signersAta: ownerAta,
            vaultAta: getAssociatedTokenAddressSync(mint, vaultPDA, true),
            mint: mint,
          })
          .signers([newOwner])
          .rpc();

        assert.fail("Transaction should have failed");
      } catch (e: any) {
        assert.ok(e, "Expected error for invalid receiver length");
      }
    });

    it("bridge request already exists for the sender", async () => {
      const amount = new anchor.BN(10_000);
      let receiver: number[];
      receiver = Array.from(
        Buffer.from(
          "0x1234567890123456789012345678901234567890123456789012345678901234567890123",
          "hex"
        )
      );
      const destination_chain = 1;

      const newOwner = anchor.web3.Keypair.generate();
      const airdropSig = await provider.connection.requestAirdrop(
        newOwner.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdropSig);

      await mintToAnyone(newOwner.publicKey, 1_000_000_000_000);

      const ownerAtaInfo = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        owner.payer,
        mint,
        newOwner.publicKey
      );
      const ownerAta = ownerAtaInfo.address;

      // First bridge request should succeed
      await program.methods
        .bridgeRequest(amount, receiver, destination_chain)
        .accounts({
          signer: newOwner.publicKey,
          signersAta: ownerAta,
          vaultAta: getAssociatedTokenAddressSync(mint, vaultPDA, true),
          mint: mint,
        })
        .signers([newOwner])
        .rpc();

      // Second bridge request with same signer should fail
      try {
        await program.methods
          .bridgeRequest(amount, receiver, destination_chain)
          .accounts({
            signer: newOwner.publicKey,
            signersAta: ownerAta,
            vaultAta: getAssociatedTokenAddressSync(mint, vaultPDA, true),
            mint: mint,
          })
          .signers([newOwner])
          .rpc();

        assert.fail("Expected transaction to fail");
      } catch (e: any) {
        assert.ok(e, "Expected error");
      }
    });
  });

  describe("Close Request - Success Case", () => {
    it("successful", async () => {
      const bridgingRequestPDA = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("bridging_request"), owner.publicKey.toBuffer()],
        program.programId
      )[0];

      const remainingAccounts = validators.slice(3, 9).map((v) => ({
        pubkey: v.publicKey,
        isSigner: true,
        isWritable: false,
      }));

      await program.methods
        .closeRequest()
        .accounts({
          signer: owner.publicKey,
          bridgingRequest: bridgingRequestPDA,
        })
        .remainingAccounts(remainingAccounts)
        .signers(validators.slice(3, 9))
        .rpc();

      try {
        await program.account.bridgingRequest.fetch(bridgingRequestPDA);
        assert.fail("Expected fetching closed account to fail");
      } catch (e: any) {
        assert.ok(e, "Expected error when fetching closed account");
      }
    });
  });
});
