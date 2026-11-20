import * as anchor from "@coral-xyz/anchor";
import { web3 } from "@coral-xyz/anchor";
import { strict as assert } from "assert";
import { SkylineProgram } from "../target/types/skyline_program";
import {
  anchorErrorCode,
  deriveMetadataPDA,
  generateValidators,
  SkylineTestFixture
} from "./fixtures";

describe("rename_mint_burn_token", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace
    .skylineProgram as anchor.Program<SkylineProgram>;
  const owner = provider.wallet as anchor.Wallet;
  const fixture = new SkylineTestFixture({
    provider,
    program,
    owner,
    connection: provider.connection
  });
  const tokenId = 611;
  const lockId = 612;
  const otherId = 613;
  const uri = "https://example.com/original.json";
  let mint: web3.PublicKey;
  let otherMint: web3.PublicKey;

  before(async () => {
    if (!(await fixture.isInitialized())) {
      await fixture.initialize.call(
        generateValidators(5).map((v) => v.publicKey)
      );
    }
    const params = { decimals: 6, name: "Original", symbol: "OLD", uri };
    mint = (
      await fixture.tokenRegistry.registerMintBurn({ tokenId, ...params })
    ).mint;
    otherMint = (
      await fixture.tokenRegistry.registerMintBurn({
        tokenId: otherId,
        ...params
      })
    ).mint;
    await fixture.tokenRegistry.registerLockUnlock({ tokenId: lockId, mint });
  });

  function rename(
    id = tokenId,
    targetMint = mint,
    metadata = deriveMetadataPDA(targetMint),
    signer = owner.payer
  ) {
    return program.methods
      .renameMintBurnToken(id, "Renamed Token", "NEW")
      .accountsPartial({
        authority: signer.publicKey,
        tokenRegistry: fixture.pdas.tokenRegistry(id),
        mint: targetMint,
        metadata
      })
      .signers(signer === owner.payer ? [] : [signer])
      .rpc();
  }

  async function readMetadata() {
    const account = await provider.connection.getAccountInfo(
      deriveMetadataPDA(mint)
    );
    assert.ok(account);
    // Metaplex stores a key byte and two public keys, then Borsh strings.
    const header = account.data.subarray(0, 1 + 32 + 32);
    let offset = header.length;
    function readString() {
      const length = account.data.readUInt32LE(offset);
      offset += 4;
      const value = account.data.toString("utf8", offset, offset + length);
      offset += length;
      return value.replace(/\0+$/, "");
    }
    const name = readString();
    const symbol = readString();
    const uri = readString();
    return {
      header,
      name,
      symbol,
      uri,
      remainingFields: account.data.subarray(offset)
    };
  }

  it("updates only the name and symbol of an existing mint", async () => {
    const before = await readMetadata();
    assert.equal(before.name, "Original");
    assert.equal(before.symbol, "OLD");
    assert.equal(before.uri, uri);
    await rename();
    assert.deepEqual(await readMetadata(), {
      ...before,
      name: "Renamed Token",
      symbol: "NEW"
    });
  });

  it("requires the current bridge authority", async () => {
    const outsider = web3.Keypair.generate();
    await assert.rejects(
      rename(tokenId, mint, deriveMetadataPDA(mint), outsider),
      (error) => anchorErrorCode(error) === "Unauthorized"
    );
  });

  it("rejects a lock/unlock registration for the same mint", async () => {
    await assert.rejects(
      rename(lockId),
      (error) => anchorErrorCode(error) === "NotMintBurn"
    );
  });

  it("rejects a different mint for the registered token ID", async () => {
    await assert.rejects(
      rename(tokenId, otherMint),
      (error) => anchorErrorCode(error) === "InvalidMintToken"
    );
  });

  it("rejects another mint's valid Metaplex metadata account", async () => {
    await assert.rejects(
      rename(tokenId, mint, deriveMetadataPDA(otherMint)),
      (error) => anchorErrorCode(error) === "ConstraintSeeds"
    );
  });
});
