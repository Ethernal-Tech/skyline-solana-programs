import * as anchor from "@coral-xyz/anchor";
import { Program, web3 } from "@coral-xyz/anchor";
import { SkylineProgram } from "../target/types/skyline_program";
import { expect } from "chai";
import { BN } from "bn.js";
import nacl from "tweetnacl";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import {
  SkylineTestFixture,
  TestContext,
  generateValidators
} from "./fixtures";

type TransferItem = {
  recipient: web3.PublicKey;
  mintIndex: number;
  amount: BN;
};

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}

function buildEd25519BatchIx(signers: web3.Keypair[], message: Buffer) {
  const count = signers.length;
  const headerSize = 2 + count * 14;
  const chunks: Buffer[] = [];
  const offsets: Buffer[] = [];
  const perSignerPayloadSize = 64 + 32; // signature + pubkey
  const sharedMessageOffset = headerSize + count * perSignerPayloadSize;
  let cursor = headerSize;

  for (const kp of signers) {
    const sig = Buffer.from(nacl.sign.detached(message, kp.secretKey));
    const pk = Buffer.from(kp.publicKey.toBytes());

    const sigOffset = cursor;
    cursor += sig.length;
    const pkOffset = cursor;
    cursor += pk.length;

    offsets.push(
      Buffer.concat([
        u16(sigOffset),
        u16(0xffff),
        u16(pkOffset),
        u16(0xffff),
        u16(sharedMessageOffset),
        u16(message.length),
        u16(0xffff)
      ])
    );
    chunks.push(sig, pk);
  }
  chunks.push(Buffer.from(message));

  const data = Buffer.concat([
    Buffer.from([count, 0]),
    Buffer.concat(offsets),
    Buffer.concat(chunks)
  ]);

  return new web3.TransactionInstruction({
    programId: new web3.PublicKey("Ed25519SigVerify111111111111111111111111111"),
    keys: [],
    data
  });
}

function buildEd25519BatchIxWithOneInvalid(
  signers: web3.Keypair[],
  message: Buffer,
  invalidIndex: number
) {
  const ix = buildEd25519BatchIx(signers, message);
  const data = Buffer.from(ix.data);
  const descriptorStart = 2 + invalidIndex * 14;
  const sigOffset = data.readUInt16LE(descriptorStart);
  data[sigOffset] ^= 0xff;
  return new web3.TransactionInstruction({
    programId: ix.programId,
    keys: ix.keys,
    data
  });
}

describe("bridge-transaction ed25519 flow", () => {
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

  const recipient = web3.Keypair.generate().publicKey;
  let mint: web3.PublicKey;
  let vaultPDA: web3.PublicKey;
  let threshold = 0;
  let validatorSigners: web3.Keypair[] = [];
  let outsideSigner: web3.Keypair;

  const makeBatchMessage = (batchId: BN) => {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(batchId.toString()), 0);
    return buf;
  };

  const buildRemainingAccounts = (transfers: TransferItem[], mints: web3.PublicKey[]) => {
    const mintMetas = mints.map((m) => ({
      pubkey: m,
      isSigner: false,
      isWritable: true
    }));
    const walletMetas = transfers.map((t) => ({
      pubkey: t.recipient,
      isSigner: false,
      isWritable: false
    }));
    const registryMetas = mints.map((m) => ({
      pubkey: fixture.pdas.tokenRegistry(m),
      isSigner: false,
      isWritable: false
    }));
    const recipientAtaMetas = transfers.map((t) => ({
      pubkey: getAssociatedTokenAddressSync(mints[t.mintIndex], t.recipient),
      isSigner: false,
      isWritable: true
    }));
    const vaultAtaMetas = mints.map((m) => ({
      pubkey: getAssociatedTokenAddressSync(m, vaultPDA, true),
      isSigner: false,
      isWritable: true
    }));
    return [
      ...mintMetas,
      ...walletMetas,
      ...registryMetas,
      ...recipientAtaMetas,
      ...vaultAtaMetas
    ];
  };

  const buildBridgeIx = async (
    transfers: TransferItem[],
    mints: web3.PublicKey[],
    batchId: BN
  ) => {
    return await program.methods
      .bridgeTransaction(
        transfers.map((t) => ({
          recipient: t.recipient,
          mintIndex: t.mintIndex,
          amount: t.amount
        })),
        mints,
        batchId
      )
      .accountsPartial({
        payer: owner.publicKey,
        validatorSet: fixture.pdas.validatorSet(),
        vault: fixture.pdas.vault(),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        instructions: web3.SYSVAR_INSTRUCTIONS_PUBKEY
      })
      .remainingAccounts(buildRemainingAccounts(transfers, mints))
      .instruction();
  };

  const sendTx = async (instructions: web3.TransactionInstruction[]) => {
    const tx = new web3.Transaction();
    instructions.forEach((ix) => tx.add(ix));
    return await provider.sendAndConfirm(tx, []);
  };

  const assertTxError = (
    e: any,
    expectedCode: string,
    expectedLogFragment: string
  ) => {
    const code = e?.error?.errorCode?.code ?? e?.errorCode?.code;
    if (code) {
      expect(code).to.equal(expectedCode);
      return;
    }

    const logs = (e?.logs ?? e?.error?.logs ?? []).join("\n");
    const msg = e?.message ?? "";
    const combined = `${msg}\n${logs}`;
    expect(combined).to.include(expectedLogFragment);
  };

  before("load validator keys and setup mint", async function () {
    const isInitialized = await fixture.isInitialized();
    if (!isInitialized) {
      const initValidators = generateValidators(5).map((v) => v.publicKey);
      const treasury = web3.Keypair.generate();
      const relayer = web3.Keypair.generate();
      await fixture.initialize.call(initValidators, 0, {
        minOperationalFee: 1_000,
        bridgeFee: 500,
        treasury: treasury.publicKey,
        relayer: relayer.publicKey
      });
    }

    const vs = await fixture.getValidatorSet();
    threshold = vs.threshold;
    vaultPDA = fixture.pdas.vault();

    const pool = generateValidators(200);
    const byPk = new Map(pool.map((kp) => [kp.publicKey.toBase58(), kp]));
    validatorSigners = vs.signers.map((pk) => byPk.get(pk.toBase58())!).filter(Boolean);

    if (validatorSigners.length !== vs.signers.length) {
      this.skip();
      return;
    }

    outsideSigner = generateValidators(201)[200];
    mint = await fixture.mints.create(owner.publicKey, 9);
    await fixture.tokenRegistry.registerLockUnlock({
      mint,
      tokenId: 177,
      minBridgingAmount: 1
    });
    await fixture.mints.mintTo(mint, vaultPDA, 1_000_000_000, true);
  });

  it("fails when ed25519 validation ix is missing", async () => {
    const batchId = new BN(await fixture.nextBatchId());
    const transfers: TransferItem[] = [{ recipient, mintIndex: 0, amount: new BN(1000) }];
    const bridgeIx = await buildBridgeIx(transfers, [mint], batchId);

    let threw = false;
    try {
      await sendTx([bridgeIx]);
    } catch (e: any) {
      threw = true;
      assertTxError(
        e,
        "InvalidRemainingAccounts",
        "remaining_accounts layout is inconsistent"
      );
    }
    expect(threw).to.equal(true);
  });

  it("fails when ed25519 signature is invalid", async () => {
    const batchId = new BN(await fixture.nextBatchId());
    const msg = makeBatchMessage(batchId);
    const signers = validatorSigners.slice(0, threshold);
    const edIx = buildEd25519BatchIxWithOneInvalid(signers, msg, 0);
    const bridgeIx = await buildBridgeIx(
      [{ recipient, mintIndex: 0, amount: new BN(1000) }],
      [mint],
      batchId
    );

    let threw = false;
    try {
      await sendTx([bridgeIx, edIx]);
    } catch {
      threw = true;
    }
    expect(threw).to.equal(true);
  });

  it("fails when batch contains one valid and one invalid signature", async () => {
    const batchId = new BN(await fixture.nextBatchId());
    const msg = makeBatchMessage(batchId);
    const two = validatorSigners.slice(0, 2);
    const edIx = buildEd25519BatchIxWithOneInvalid(two, msg, 1);
    const bridgeIx = await buildBridgeIx(
      [{ recipient, mintIndex: 0, amount: new BN(1000) }],
      [mint],
      batchId
    );

    let threw = false;
    try {
      await sendTx([bridgeIx, edIx]);
    } catch {
      threw = true;
    }
    expect(threw).to.equal(true);
  });

  it("fails when one signer is not in validator set", async () => {
    const batchId = new BN(await fixture.nextBatchId());
    const msg = makeBatchMessage(batchId);
    const signers = [...validatorSigners.slice(0, threshold - 1), outsideSigner];
    const edIx = buildEd25519BatchIx(signers, msg);
    const bridgeIx = await buildBridgeIx(
      [{ recipient, mintIndex: 0, amount: new BN(1000) }],
      [mint],
      batchId
    );

    let threw = false;
    try {
      await sendTx([bridgeIx, edIx]);
    } catch (e: any) {
      threw = true;
      assertTxError(e, "InvalidSigner", "Invalid signer provided");
    }
    expect(threw).to.equal(true);
  });

  it("fails when signatures are below threshold", async () => {
    const batchId = new BN(await fixture.nextBatchId());
    const msg = makeBatchMessage(batchId);
    const signers = validatorSigners.slice(0, Math.max(1, threshold - 1));
    const edIx = buildEd25519BatchIx(signers, msg);
    const bridgeIx = await buildBridgeIx(
      [{ recipient, mintIndex: 0, amount: new BN(1000) }],
      [mint],
      batchId
    );

    let threw = false;
    try {
      await sendTx([bridgeIx, edIx]);
    } catch (e: any) {
      threw = true;
      assertTxError(
        e,
        "InsufficientSigners",
        "Not enough validators signed this transaction"
      );
    }
    expect(threw).to.equal(true);
  });

  it("passes with threshold valid signatures", async () => {
    const batchId = new BN(await fixture.nextBatchId());
    const amount = new BN(7777);
    const msg = makeBatchMessage(batchId);
    const signers = validatorSigners.slice(0, threshold);
    const edIx = buildEd25519BatchIx(signers, msg);
    const recipientAta = getAssociatedTokenAddressSync(mint, recipient);
    const before = await fixture.tokenBalances.getBalance(recipientAta);

    const bridgeIx = await buildBridgeIx(
      [{ recipient, mintIndex: 0, amount }],
      [mint],
      batchId
    );
    await sendTx([bridgeIx, edIx]);

    const after = await fixture.tokenBalances.getBalance(recipientAta);
    expect((after - before).toString()).to.equal(amount.toString());

    const ata = await getAccount(provider.connection, recipientAta);
    expect(ata.owner.toBase58()).to.equal(recipient.toBase58());
  });
});

