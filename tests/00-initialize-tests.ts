/**
 * Initialize instruction tests — must run before other test files that call
 * initialize or advance validator_set.last_batch_id (additional-tests,
 * bridge-transaction.ed25519). ts-mocha loads all tests/*.ts in lexicographic order.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, web3 } from "@coral-xyz/anchor";
import { SkylineProgram } from "../target/types/skyline_program";
import { expect } from "chai";
import {
  SkylineTestFixture,
  TestContext,
  generateValidators,
  calculateExpectedThreshold,
  assertValidatorSetState,
  LIMITS,
  assertValidBump,
  airdrop
} from "./fixtures";

describe("skyline-program initialize", () => {
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
  const validators = generateValidators(50);
  const treasury = anchor.web3.Keypair.generate();
  const relayer = anchor.web3.Keypair.generate();

  const MIN_OPERATIONAL_FEE = 1_000;
  const BRIDGE_FEE = 500;

  describe("Bad Cases", () => {
    before(async function () {
      if (await fixture.isInitialized()) {
        throw new Error(
          [
            "Initialize bad-case tests require an uninitialized ledger.",
            "Run the full test suite so 00-skyline-initialize.ts runs first,",
            "or restart the local validator and rerun."
          ].join(" ")
        );
      }
    });

    it("fails with less than MIN_VALIDATORS (3 < 4)", async () => {
      const validatorPubkeys = validators.slice(0, 3).map((v) => v.publicKey);

      await fixture.initialize.expectError(
        validatorPubkeys,
        "MinValidatorsNotMet",
        0,
        {
          minOperationalFee: MIN_OPERATIONAL_FEE,
          bridgeFee: BRIDGE_FEE,
          treasury: treasury.publicKey,
          relayer: relayer.publicKey
        }
      );
    });

    it("fails with more validators than transaction size allows (30 > 29)", async () => {
      const validatorPubkeys = validators
        .slice(0, LIMITS.MAX_TX_VALIDATORS + 1)
        .map((v) => v.publicKey);

      await fixture.initialize.expectFailure(validatorPubkeys, 0, {
        minOperationalFee: MIN_OPERATIONAL_FEE,
        bridgeFee: BRIDGE_FEE,
        treasury: treasury.publicKey,
        relayer: relayer.publicKey
      });
    });

    it("fails when duplicate validators provided", async () => {
      const duplicateValidators = [
        validators[0].publicKey,
        validators[1].publicKey,
        validators[2].publicKey,
        validators[3].publicKey,
        validators[0].publicKey
      ];

      await fixture.initialize.expectError(
        duplicateValidators,
        "ValidatorsNotUnique",
        0,
        {
          minOperationalFee: MIN_OPERATIONAL_FEE,
          bridgeFee: BRIDGE_FEE,
          treasury: treasury.publicKey,
          relayer: relayer.publicKey
        }
      );
    });

    it("fails with no validators provided", async () => {
      await fixture.initialize.expectError([], "MinValidatorsNotMet", 0, {
        minOperationalFee: MIN_OPERATIONAL_FEE,
        bridgeFee: BRIDGE_FEE,
        treasury: treasury.publicKey,
        relayer: relayer.publicKey
      });
    });

    it("fails when combined fees overflow u64", async () => {
      const validatorPubkeys = validators.slice(0, 7).map((v) => v.publicKey);
      const MAX_U64 = new anchor.BN("18446744073709551615");

      await fixture.initialize.expectError(
        validatorPubkeys,
        "FeeConfigOverflow",
        0,
        {
          minOperationalFee: MAX_U64,
          bridgeFee: new anchor.BN(1),
          treasury: treasury.publicKey,
          relayer: relayer.publicKey
        }
      );
    });
  });

  describe("Success Case", () => {
    it("initializes state correctly with 5 validators", async function () {
      const validatorCount = 5;
      const validatorPubkeys = validators
        .slice(0, validatorCount)
        .map((v) => v.publicKey);
      const expectedThreshold = calculateExpectedThreshold(validatorCount);

      if (await fixture.isInitialized()) {
        this.skip();
        return;
      }

      await airdrop(
        provider.connection,
        treasury.publicKey,
        1 * web3.LAMPORTS_PER_SOL
      );

      await fixture.initialize.call(validatorPubkeys, 0, {
        minOperationalFee: MIN_OPERATIONAL_FEE,
        bridgeFee: BRIDGE_FEE,
        treasury: treasury.publicKey,
        relayer: relayer.publicKey
      });

      const vs = await fixture.accounts.getValidatorSet(
        fixture.pdas.validatorSet()
      );
      assertValidatorSetState(vs, {
        validators: validatorPubkeys,
        threshold: expectedThreshold,
        lastBatchId: 0,
        bridgeRequestCount: 0
      });

      const vault = await fixture.accounts.getVault(fixture.pdas.vault());
      assertValidBump(vault.bump);

      const fc = await fixture.getFeeConfig();
      expect(fc.minOperationalFee.toNumber()).to.equal(MIN_OPERATIONAL_FEE);
      expect(fc.bridgeFee.toNumber()).to.equal(BRIDGE_FEE);
      expect(fc.treasury.toBase58()).to.equal(treasury.publicKey.toBase58());
      assertValidBump(fc.bump);

      const pc = await fixture.getProgramConfig();
      expect(pc.versionString).to.equal("0.1.0");
      expect(pc.authority.toBase58()).to.equal(owner.publicKey.toBase58());
      expect(pc.deployedAt.toNumber()).to.be.greaterThan(0);
    });

    it("fails on re-initialization attempt", async function () {
      if (!(await fixture.isInitialized())) {
        this.skip();
        return;
      }

      const before = await fixture.getValidatorSet();

      let threw = false;
      try {
        await fixture.initialize.call(
          validators.slice(5, 12).map((v) => v.publicKey),
          3,
          {
            minOperationalFee: MIN_OPERATIONAL_FEE,
            bridgeFee: BRIDGE_FEE,
            treasury: treasury.publicKey,
            relayer: relayer.publicKey
          }
        );
      } catch (e: any) {
        threw = true;
        const logs: string = (e?.logs ?? []).join("\n");
        expect(logs).to.include("already in use");
      }

      expect(threw, "re-initialization should have failed").to.equal(true);

      const after = await fixture.getValidatorSet();
      expect(after.lastBatchId.toString()).to.equal(
        before.lastBatchId.toString()
      );
      expect(after.signers.length).to.equal(before.signers.length);
    });
  });
});
