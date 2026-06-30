/**
 * End-to-end verification of the BDCSAC gateway pipeline.
 *
 * Scenario:
 *  1. Owner encrypts+stores a file off-chain, registers it on-chain.
 *  2. Owner grants Alice READ access.
 *  3. Alice requests the object through the gateway -> should SUCCEED,
 *     and the decrypted bytes returned must exactly match the original file.
 *  4. Bob (no grant at all) requests the object -> should be DENIED,
 *     no data returned.
 *  5. Owner grants Bob READ access, Bob requests again -> should SUCCEED.
 *  6. Owner revokes Bob's access.
 *  7. Bob requests again -> should be DENIED.
 *
 * Every assertion is checked explicitly and printed PASS/FAIL — this is the
 * "verify everything first" step before any of this goes near the paper.
 */
const fs = require("fs");
const path = require("path");
const ethers = require("ethers");
const Ganache = require("ganache");
const { BDCSACGateway, Permission } = require("./gateway");

let passCount = 0;
let failCount = 0;
function assert(condition, label) {
  if (condition) {
    console.log(`  PASS - ${label}`);
    passCount++;
  } else {
    console.log(`  FAIL - ${label}`);
    failCount++;
  }
}

async function main() {
  const ganacheProvider = Ganache.provider({
    wallet: { totalAccounts: 5, defaultBalance: 100 },
    logging: { quiet: true },
  });
  const provider = new ethers.BrowserProvider(ganacheProvider);
  const accounts = await provider.send("eth_accounts", []);
  const owner = await provider.getSigner(accounts[0]);
  const alice = await provider.getSigner(accounts[1]);
  const bob = await provider.getSigner(accounts[2]);

  console.log("=== Setup ===");
  console.log("Owner:", accounts[0]);
  console.log("Alice:", accounts[1]);
  console.log("Bob:  ", accounts[2]);

  const artifact = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "build", "BDCSAC_AccessControl.json"), "utf8")
  );
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, owner);
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  console.log("Contract deployed at:", await contract.getAddress(), "\n");

  const keyRegistry = new Map();
  const gateway = new BDCSACGateway(contract, keyRegistry);

  // --- Step 1: store + register ---
  console.log("=== Step 1: Owner stores and registers an object ===");
  const originalFile = Buffer.from("This is the confidential B-DCSAC test payload. Do not leak.");
  const { objectId, gasUsed: registerGas } = await gateway.storeAndRegisterObject(owner, originalFile);
  console.log(`Object registered with objectId=${objectId} (gasUsed=${registerGas})\n`);

  // --- Step 2: grant Alice READ ---
  console.log("=== Step 2: Owner grants Alice READ access ===");
  await gateway.grantAccess(owner, objectId, accounts[1], Permission.READ);
  console.log("Granted.\n");

  // --- Step 3: Alice requests -> should succeed and match original bytes ---
  console.log("=== Step 3: Alice requests the object ===");
  const aliceResult = await gateway.requestObject(alice, objectId, Permission.READ);
  assert(aliceResult.granted === true, "Alice's request was granted on-chain");
  assert(aliceResult.data !== null && aliceResult.data.equals(originalFile), "Decrypted data exactly matches original file");
  console.log(`  (gasUsed for checkAccess: ${aliceResult.gasUsed})\n`);

  // --- Step 4: Bob requests with no grant -> should be denied ---
  console.log("=== Step 4: Bob requests the object (no grant exists) ===");
  const bobResult1 = await gateway.requestObject(bob, objectId, Permission.READ);
  assert(bobResult1.granted === false, "Bob's request was denied on-chain");
  assert(bobResult1.data === null, "No data was returned to Bob");
  console.log(`  reason: ${bobResult1.reason}\n`);

  // --- Step 5: grant Bob READ, request again -> should succeed ---
  console.log("=== Step 5: Owner grants Bob READ, Bob requests again ===");
  await gateway.grantAccess(owner, objectId, accounts[2], Permission.READ);
  const bobResult2 = await gateway.requestObject(bob, objectId, Permission.READ);
  assert(bobResult2.granted === true, "Bob's request was granted after being given access");
  assert(bobResult2.data.equals(originalFile), "Bob received correct decrypted data");
  console.log();

  // --- Step 6: revoke Bob ---
  console.log("=== Step 6: Owner revokes Bob's access ===");
  await gateway.revokeAccess(owner, objectId, accounts[2]);
  console.log("Revoked.\n");

  // --- Step 7: Bob requests again -> should be denied ---
  console.log("=== Step 7: Bob requests the object again (post-revocation) ===");
  const bobResult3 = await gateway.requestObject(bob, objectId, Permission.READ);
  assert(bobResult3.granted === false, "Bob's request was denied after revocation");
  assert(bobResult3.data === null, "No data was returned to Bob after revocation");
  console.log();

  // --- Step 8: sanity check Alice STILL has access (revocation was scoped to Bob only) ---
  console.log("=== Step 8: Sanity check - Alice still has access after Bob's revocation ===");
  const aliceResult2 = await gateway.requestObject(alice, objectId, Permission.READ);
  assert(aliceResult2.granted === true, "Alice's access is unaffected by Bob's revocation");

  console.log("\n=== RESULT ===");
  console.log(`${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exitCode = 1;

  await ganacheProvider.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
