/**
 * Simulated off-chain decentralized storage.
 *
 * In the real B-DCSAC deployment this would be IPFS (or similar) — content
 * is addressed by its hash/CID, and the chain only ever stores that hash,
 * never the payload. Here we simulate it with a local folder keyed by the
 * same hash, so the verification logic (gateway -> chain -> storage) can be
 * tested end-to-end without standing up an IPFS node.
 *
 * Swapping this for real IPFS later only changes putObject/getObject's
 * internals — the gateway and contract logic stay identical.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const STORE_DIR = path.join(__dirname, "off-chain-store");
fs.mkdirSync(STORE_DIR, { recursive: true });

/**
 * Encrypts a plaintext buffer with AES-256-GCM and stores the ciphertext
 * under its content hash.
 *
 * NOTE: This symmetric encryption step is a stand-in for the CP-ABE layer
 * described in the paper, which is disclosed as interface-only (key
 * derivation/policy enforcement is not implemented in this prototype).
 * The contract's grantAccess/checkAccess logic is what this gateway
 * actually enforces; the symmetric key here plays the same conceptual
 * role a CP-ABE-derived key would play.
 */
function putObject(plaintextBuffer) {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const payload = Buffer.concat([iv, authTag, ciphertext]);
  const contentHashHex = crypto.createHash("sha256").update(payload).digest("hex");

  fs.writeFileSync(path.join(STORE_DIR, contentHashHex), payload);

  return {
    contentHashHex,                  // becomes the on-chain bytes32 (after 0x + this, or re-hashed to fit bytes32)
    decryptionKey: key.toString("hex"), // owner manages this off-chain (CP-ABE key in production)
  };
}

function getObject(contentHashHex, decryptionKeyHex) {
  const filePath = path.join(STORE_DIR, contentHashHex);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Storage: no object found for hash ${contentHashHex}`);
  }
  const payload = fs.readFileSync(filePath);
  const iv = payload.subarray(0, 12);
  const authTag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);

  const key = Buffer.from(decryptionKeyHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext;
}

module.exports = { putObject, getObject };
