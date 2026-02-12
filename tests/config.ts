import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

// ============ NETWORK DETECTION ============
export type Network = "devnet" | "testnet";

export const CURRENT_NETWORK: Network = 
  (process.env.SOLANA_NETWORK as Network) || "devnet";

console.log(`Active Network: ${CURRENT_NETWORK.toUpperCase()}`);

// ============ LOAD NETWORK CONFIG ============
interface NetworkConfig {
  network: string;
  programId: string;
  validatorSetPda: string;
  vaultPda: string;
  mintTransfer: string;
  mintBurn: string;
}

function loadNetworkConfig(): NetworkConfig {
  const configFile = path.join(
    process.cwd(),
    "tests",
    `config.${CURRENT_NETWORK}.json`
  );
  
  if (!fs.existsSync(configFile)) {
    throw new Error(` Config file not found: ${configFile}`);
  }
  
  const config: NetworkConfig = JSON.parse(fs.readFileSync(configFile, "utf-8"));
  return config;
}

const networkConfig = loadNetworkConfig();

// ============ PROGRAM & PDAs ============
export const PROGRAM_ID = networkConfig.programId 
  ? new PublicKey(networkConfig.programId)
  : PublicKey.default;

export const VALIDATOR_SET_PDA = networkConfig.validatorSetPda
  ? new PublicKey(networkConfig.validatorSetPda)
  : PublicKey.default;

export const VAULT_PDA = networkConfig.vaultPda
  ? new PublicKey(networkConfig.vaultPda)
  : PublicKey.default;

// ============ MINTS ============
export const MINT_TRANSFER = networkConfig.mintTransfer
  ? new PublicKey(networkConfig.mintTransfer)
  : PublicKey.default;

export const MINT_BURN = networkConfig.mintBurn
  ? new PublicKey(networkConfig.mintBurn)
  : PublicKey.default;

// ============ MINT DECIMALS ============
export const MINT_DECIMALS = 9;

// ============ SEEDS ============
export const VALIDATOR_SET_SEED = "validator-set";
export const VALIDATOR_SET_CHANGE_SEED = "validator_set_change";
export const BRIDGING_TRANSACTION_SEED = "bridging_transaction";
export const VAULT_SEED = "vault";

// ============ VALIDATORS PERSISTENCE ============
const VALIDATORS_FILE = path.join(
  process.cwd(),
  "tests",
  `validators_${CURRENT_NETWORK}.json`
);

// Backward compatibility: if devnet and old file exists, use it
const LEGACY_VALIDATORS_FILE = path.join(process.cwd(), "tests", "validators.json");
const EFFECTIVE_VALIDATORS_FILE = 
  CURRENT_NETWORK === "devnet" && fs.existsSync(LEGACY_VALIDATORS_FILE)
    ? LEGACY_VALIDATORS_FILE
    : VALIDATORS_FILE;

interface ValidatorsStorage {
  validators: string[];
}

/**
 * Load validators from persistent storage
 */
function loadValidatorsFromFile(): Keypair[] {
  try {
    if (fs.existsSync(EFFECTIVE_VALIDATORS_FILE)) {
      const data = fs.readFileSync(EFFECTIVE_VALIDATORS_FILE, "utf-8");
      const storage: ValidatorsStorage = JSON.parse(data);
      console.log(` Loaded ${storage.validators.length} validators from ${path.basename(EFFECTIVE_VALIDATORS_FILE)}`);
      return storage.validators.map((secretKey) =>
        Keypair.fromSecretKey(Buffer.from(secretKey, "base64"))
      );
    }
  } catch (error) {
    console.error(" Error loading validators from file:", error);
  }
  return [];
}

/**
 * Save validators to persistent storage
 */
export function saveValidatorsToFile(validators: Keypair[]): void {
  try {
    const storage: ValidatorsStorage = {
      validators: validators.map((kp) =>
        Buffer.from(kp.secretKey).toString("base64")
      ),
    };
    fs.writeFileSync(VALIDATORS_FILE, JSON.stringify(storage, null, 2));
    console.log(` Saved ${validators.length} validators to ${path.basename(VALIDATORS_FILE)}`);
  } catch (error) {
    console.error(" Error saving validators to file:", error);
    throw error;
  }
}

/**
 * Update network configuration file
 */
export function updateNetworkConfig(updates: Partial<NetworkConfig>): void {
  const configFile = path.join(
    process.cwd(),
    "tests",
    `config.${CURRENT_NETWORK}.json`
  );
  
  const current = loadNetworkConfig();
  const updated = { ...current, ...updates };
  
  fs.writeFileSync(configFile, JSON.stringify(updated, null, 2));
  console.log(` Updated ${path.basename(configFile)}`);
}

/**
 * Add new validators to persistent storage
 */
export function addValidatorToStorage(newValidator: Keypair): void {
  const current = loadValidatorsFromFile();
  
  const exists = current.some((v) => v.publicKey.equals(newValidator.publicKey));
  if (exists) {
    console.log(`ℹ Validator ${newValidator.publicKey.toBase58()} already in storage`);
    return;
  }
  
  current.push(newValidator);
  saveValidatorsToFile(current);
  
  VALIDATORS.length = 0;
  VALIDATORS.push(...loadValidatorsFromFile());
}

/**
 * Remove validator from persistent storage
 */
export function removeValidatorFromStorage(publicKey: PublicKey): void {
  const current = loadValidatorsFromFile();
  const filtered = current.filter((v) => !v.publicKey.equals(publicKey));
  
  if (current.length === filtered.length) {
    console.log(`ℹ Validator ${publicKey.toBase58()} not found in storage`);
    return;
  }
  
  saveValidatorsToFile(filtered);
  
  VALIDATORS.length = 0;
  VALIDATORS.push(...loadValidatorsFromFile());
}

/**
 * Get validators that match the on-chain validator set
 */
export function getActiveValidators(onChainValidators: PublicKey[]): Keypair[] {
  const allValidators = loadValidatorsFromFile();
  return allValidators.filter((v) =>
    onChainValidators.some((pub) => pub.equals(v.publicKey))
  );
}

// ============ VALIDATORS ============
export const VALIDATORS: Keypair[] = loadValidatorsFromFile();

// ============ HELPER FUNCTIONS ============
export function toRawAmount(amount: number): anchor.BN {
  return new anchor.BN(amount * 10 ** MINT_DECIMALS);
}

export function toHumanAmount(rawAmount: number | bigint | anchor.BN): number {
  const num =
    typeof rawAmount === "bigint"
      ? Number(rawAmount)
      : rawAmount instanceof anchor.BN
      ? rawAmount.toNumber()
      : rawAmount;
  return num / 10 ** MINT_DECIMALS;
}

export function logSection(title: string) {
  console.log("\n" + "=".repeat(50));
  console.log(`  ${title} [${CURRENT_NETWORK.toUpperCase()}]`);
  console.log("=".repeat(50));
}

export function logTxSuccess(name: string, tx: string) {
  const explorerUrl = CURRENT_NETWORK === "testnet"
    ? `https://explorer.solana.com/tx/${tx}?cluster=testnet`
    : `https://explorer.solana.com/tx/${tx}?cluster=devnet`;
    
  console.log(`\n ${name} successful!`);
  console.log(`   Tx: ${tx}`);
  console.log(`   Explorer: ${explorerUrl}`);
}

export function getBridgingTransactionPDA(
  batchId: anchor.BN,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(BRIDGING_TRANSACTION_SEED),
      batchId.toArrayLike(Buffer, "le", 8),
    ],
    PROGRAM_ID,
  );
}

export function getValidatorSetChangePDA(
  batchId: anchor.BN
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(VALIDATOR_SET_CHANGE_SEED),
      batchId.toArrayLike(Buffer, "le", 8),
    ],
    PROGRAM_ID
  );
}
