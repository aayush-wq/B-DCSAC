const crypto = require("crypto");

const store = new Map();

function putObject(plaintextBuffer) {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([iv, authTag, encrypted]);
  const contentHashHex = crypto.createHash("sha256").update(ciphertext).digest("hex");
  store.set(contentHashHex, { ciphertext, key, iv });
  return { contentHashHex, decryptionKey: key.toString("hex") };
}

function getObject(contentHashHex, decryptionKeyHex) {
  const entry = store.get(contentHashHex);
  if (!entry) throw new Error("Object not found in storage");
  const key = Buffer.from(decryptionKeyHex, "hex");
  const iv = entry.ciphertext.slice(0, 16);
  const authTag = entry.ciphertext.slice(16, 32);
  const encrypted = entry.ciphertext.slice(32);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return plaintext;
}

module.exports = { putObject, getObject };
