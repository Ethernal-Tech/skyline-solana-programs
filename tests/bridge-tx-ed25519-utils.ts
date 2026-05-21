import * as anchor from "@coral-xyz/anchor";
import { Program, web3 } from "@coral-xyz/anchor";
import { BN } from "bn.js";
import { expect } from "chai";
import nacl from "tweetnacl";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import { SkylineProgram } from "../target/types/skyline_program";
import { SkylineTestFixture } from "./fixtures";

/** System Program ID — same as on-chain `NATIVE_SOL_MINT` sentinel. */
export const NATIVE_SOL_MINT = web3.SystemProgram.programId;

export type BridgeTransferItem = {
  recipient: web3.PublicKey;
  mintIndex: number;
  amount: BN;
};

export function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}

/** gagliardetto/binary slice length: uvarint. */
export function uvarint(n: number): Buffer {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return Buffer.from(out);
}

export function u64LE(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n, 0);
  return b;
}

export type SolanaPayloadInput = {
  blockhash: Uint8Array;
  receivers: { address: Uint8Array; tokenId: number; amount: bigint }[];
  feeAmount: bigint;
  batchId: bigint;
};

export function encodeSolanaPayload(payload: SolanaPayloadInput): Buffer {
  const receiverParts: Buffer[] = [];
  for (const r of payload.receivers) {
    receiverParts.push(Buffer.from(r.address), u16(r.tokenId), u64LE(r.amount));
  }
  return Buffer.concat([
    Buffer.from(payload.blockhash),
    uvarint(payload.receivers.length),
    ...receiverParts,
    u64LE(payload.feeAmount),
    u64LE(payload.batchId)
  ]);
}

export function buildEd25519BatchIx(signers: web3.Keypair[], message: Buffer) {
  const count = signers.length;
  const headerSize = 2 + count * 14;
  const chunks: Buffer[] = [];
  const offsets: Buffer[] = [];
  const perSignerPayloadSize = 64 + 32;
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

export function makeSignedPayload(
  batchId: BN,
  transfers: BridgeTransferItem[],
  tokenIds: number[],
  feeAmount = 0n
): Buffer {
  return encodeSolanaPayload({
    blockhash: Buffer.alloc(32, 7),
    receivers: transfers.map((t) => ({
      address: t.recipient.toBytes(),
      tokenId: tokenIds[t.mintIndex],
      amount: BigInt(t.amount.toString())
    })),
    feeAmount,
    batchId: BigInt(batchId.toString())
  });
}

export type BuildRemainingAccountsParams = {
  fixture: SkylineTestFixture;
  vaultPDA: web3.PublicKey;
  transfers: BridgeTransferItem[];
  mints: web3.PublicKey[];
  tokenIds: number[];
  /** Native SOL transfers require writable recipient wallets. Default: auto. */
  walletWritable?: boolean;
};

/**
 * Build `remaining_accounts` for `bridge_transaction` (mints → wallets → registries → recipient ATAs → vault ATAs).
 */
export function buildBridgeRemainingAccounts(
  params: BuildRemainingAccountsParams
): { pubkey: web3.PublicKey; isSigner: boolean; isWritable: boolean }[] {
  const { fixture, vaultPDA, transfers, mints, tokenIds } = params;

  const mintMetas = mints.map((m) => ({
    pubkey: m,
    isSigner: false,
    isWritable: true
  }));

  const walletMetas = transfers.map((t) => {
    const isNative = tokenIds[t.mintIndex] === 0;
    const writable =
      params.walletWritable !== undefined
        ? params.walletWritable
        : isNative;
    return {
      pubkey: t.recipient,
      isSigner: false,
      isWritable: writable
    };
  });

  const registryMetas = tokenIds.map((tokenId) => ({
    pubkey:
      tokenId === 0
        ? NATIVE_SOL_MINT
        : fixture.pdas.tokenRegistry(tokenId),
    isSigner: false,
    isWritable: false
  }));

  const recipientAtaMetas = transfers.map((t) => {
    const tokenId = tokenIds[t.mintIndex];
    if (tokenId === 0) {
      return { pubkey: NATIVE_SOL_MINT, isSigner: false, isWritable: false };
    }
    return {
      pubkey: getAssociatedTokenAddressSync(mints[t.mintIndex], t.recipient),
      isSigner: false,
      isWritable: true
    };
  });

  const vaultAtaMetas = mints.map((m, i) => {
    if (tokenIds[i] === 0) {
      return { pubkey: NATIVE_SOL_MINT, isSigner: false, isWritable: false };
    }
    return {
      pubkey: getAssociatedTokenAddressSync(m, vaultPDA, true),
      isSigner: false,
      isWritable: true
    };
  });

  return [
    ...mintMetas,
    ...walletMetas,
    ...registryMetas,
    ...recipientAtaMetas,
    ...vaultAtaMetas
  ];
}

export async function buildBridgeTransactionIx(
  program: Program<SkylineProgram>,
  fixture: SkylineTestFixture,
  payer: web3.PublicKey,
  transfers: BridgeTransferItem[],
  mints: web3.PublicKey[],
  tokenIds: number[],
  walletWritable?: boolean
): Promise<web3.TransactionInstruction> {
  return await program.methods
    .bridgeTransaction()
    .accountsPartial({
      payer,
      validatorSet: fixture.pdas.validatorSet(),
      vault: fixture.pdas.vault(),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: web3.SystemProgram.programId,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      instructions: web3.SYSVAR_INSTRUCTIONS_PUBKEY
    })
    .remainingAccounts(
      buildBridgeRemainingAccounts({
        fixture,
        vaultPDA: fixture.pdas.vault(),
        transfers,
        mints,
        tokenIds,
        walletWritable
      })
    )
    .instruction();
}

export type SendBridgeTransactionOpts = {
  /** Transaction fee payer + extra signers (defaults to provider wallet). */
  feePayer?: web3.Keypair;
};

export async function sendBridgeTransaction(
  provider: anchor.AnchorProvider,
  bridgeIx: web3.TransactionInstruction,
  ed25519Ix?: web3.TransactionInstruction,
  opts?: SendBridgeTransactionOpts
): Promise<string> {
  const tx = new web3.Transaction();
  tx.add(bridgeIx);
  if (ed25519Ix) {
    tx.add(ed25519Ix);
  }

  // Custom fee payer: sign only with that keypair. AnchorProvider.sendAndConfirm
  // always partialSigns with the provider wallet, which breaks foreign payers.
  if (opts?.feePayer) {
    const { blockhash, lastValidBlockHeight } =
      await provider.connection.getLatestBlockhash();
    tx.feePayer = opts.feePayer.publicKey;
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    return await web3.sendAndConfirmTransaction(
      provider.connection,
      tx,
      [opts.feePayer],
      { commitment: provider.opts?.commitment ?? "confirmed" }
    );
  }

  return await provider.sendAndConfirm(tx, []);
}

export function assertTxError(
  e: any,
  expectedCode: string,
  expectedLogFragment?: string
) {
  const code = e?.error?.errorCode?.code ?? e?.errorCode?.code;
  if (code) {
    expect(code).to.equal(expectedCode);
    return;
  }
  if (expectedLogFragment) {
    const logs = (e?.logs ?? e?.error?.logs ?? []).join("\n");
    const msg = e?.message ?? "";
    expect(`${msg}\n${logs}`).to.include(expectedLogFragment);
  }
}
