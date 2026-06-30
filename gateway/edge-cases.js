/**
 * Edge-case verification suite for B-DCSAC.
 *
 * Complements gateway/demo.js (the happy-path lifecycle test) by checking
 * the boundary and adversarial conditions that matter for a security paper:
 *
 *  A. Permission-level enforcement (READ grant must NOT satisfy a WRITE/ADMIN requirement)
 *  B. Expiry enforcement (an expired grant must be treated as no access)
 *  C. Non-owner cannot grant access on an object they don't own
 *  D. Non-owner cannot revoke access on an object they don't own
 *  E. Granting/revoking on a non-existent object reverts cleanly
 *  F. Double-revoke (revoking an already-revoked/no grant) reverts cleanly
 *  G. Owner always has implicit full access, even with no explicit grant
 *  H. ADMIN grant satisfies READ and WRITE requirements too (permission ordering)
 *
 * Run: node gateway/edge-cases.js
 */
const fs = require("fs");
const path = require("path");
const ethers = require("ethers");
const Ganache = require("ganache");

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

async function expectRevert(promise, label) {
  try {
    const tx = await promise;
    await tx.wait();
    console.log(`  FAIL - ${label} (expected revert, but transaction succeeded)`);
    failCount++;
  } catch (err) {
    console.log(`  PASS - ${label}`);
    passCount++;
  }
}

const Permission = { NONE: 0, READ: 1, WRITE: 2, ADMIN: 3 };

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
  const eve = await provider.getSigner(accounts[3]); // unauthorized actor

  const artifact = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "build", "BDCSAC_AccessControl.json"), "utf8")
  );
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, owner);
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  console.log("Contract deployed at:", await contract.getAddress(), "\n");

  async function withGas(call, args) {
    const est = await call.estimateGas(...args);
    return call(...args, { gasLimit: (est * 130n) / 100n });
  }

  // Helper to register a fresh object owned by `owner`
  async function registerObject(label) {
    const hash = ethers.keccak256(ethers.toUtf8Bytes(label));
    const tx = await withGas(contract.registerObject, [hash]);
    const receipt = await tx.wait();
    const parsed = receipt.logs.map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } })
      .find((p) => p && p.name === "ObjectRegistered");
    return parsed.args.objectId;
  }

  // ===================== A. Permission-level enforcement =====================
  console.log("=== A. Permission-level enforcement (READ grant must not satisfy WRITE) ===");
  {
    const objId = await registerObject("objA");
    await (await withGas(contract.grantAccess, [objId, accounts[1], Permission.READ, 0])).wait();

    const hasRead = await contract.hasAccess(objId, accounts[1], Permission.READ);
    const hasWrite = await contract.hasAccess(objId, accounts[1], Permission.WRITE);
    assert(hasRead === true, "Alice (READ grant) passes a READ requirement");
    assert(hasWrite === false, "Alice (READ grant) FAILS a WRITE requirement");
  }
  console.log();

  // ===================== B. Expiry enforcement =====================
  console.log("=== B. Expiry enforcement ===");
  {
    const objId = await registerObject("objB");
    const pastExpiry = Math.floor(Date.now() / 1000) - 3600; // already expired
    await (await withGas(contract.grantAccess, [objId, accounts[1], Permission.READ, pastExpiry])).wait();

    const hasAccessNow = await contract.hasAccess(objId, accounts[1], Permission.READ);
    assert(hasAccessNow === false, "Already-expired grant correctly denies access");

    // Also check a future expiry still works
    const objId2 = await registerObject("objB2");
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
    await (await withGas(contract.grantAccess, [objId2, accounts[1], Permission.READ, futureExpiry])).wait();
    const hasAccessFuture = await contract.hasAccess(objId2, accounts[1], Permission.READ);
    assert(hasAccessFuture === true, "Grant with future expiry still grants access");
  }
  console.log();

  // ===================== C. Non-owner cannot grant =====================
  console.log("=== C. Non-owner cannot grant access on an object they don't own ===");
  {
    const objId = await registerObject("objC"); // owned by `owner`
    await expectRevert(
      withGas(contract.connect(eve).grantAccess, [objId, accounts[2], Permission.READ, 0]),
      "Eve (not the owner) cannot grant Bob access"
    );
  }
  console.log();

  // ===================== D. Non-owner cannot revoke =====================
  console.log("=== D. Non-owner cannot revoke access on an object they don't own ===");
  {
    const objId = await registerObject("objD");
    await (await withGas(contract.grantAccess, [objId, accounts[1], Permission.READ, 0])).wait();
    await expectRevert(
      withGas(contract.connect(eve).revokeAccess, [objId, accounts[1]]),
      "Eve (not the owner) cannot revoke Alice's access"
    );
    // confirm Alice's access is untouched after the failed attempt
    const stillHasAccess = await contract.hasAccess(objId, accounts[1], Permission.READ);
    assert(stillHasAccess === true, "Alice's access remains intact after Eve's failed revoke attempt");
  }
  console.log();

  // ===================== E. Operations on non-existent object =====================
  console.log("=== E. Grant/revoke on a non-existent object reverts cleanly ===");
  {
    const fakeObjId = 999999;
    await expectRevert(
      withGas(contract.grantAccess, [fakeObjId, accounts[1], Permission.READ, 0]),
      "grantAccess on non-existent object reverts"
    );
    await expectRevert(
      withGas(contract.revokeAccess, [fakeObjId, accounts[1]]),
      "revokeAccess on non-existent object reverts"
    );
    const result = await contract.hasAccess(fakeObjId, accounts[1], Permission.READ);
    assert(result === false, "hasAccess on non-existent object returns false (no revert, safe default)");
  }
  console.log();

  // ===================== F. Double revoke =====================
  console.log("=== F. Double-revoke reverts cleanly (no silent no-op) ===");
  {
    const objId = await registerObject("objF");
    await (await withGas(contract.grantAccess, [objId, accounts[1], Permission.READ, 0])).wait();
    await (await withGas(contract.revokeAccess, [objId, accounts[1]])).wait(); // first revoke - should succeed
    await expectRevert(
      withGas(contract.revokeAccess, [objId, accounts[1]]),
      "Second revoke on the same (already-revoked) grant reverts"
    );
  }
  console.log();

  // ===================== G. Owner implicit access =====================
  console.log("=== G. Owner always has full implicit access (no explicit grant needed) ===");
  {
    const objId = await registerObject("objG");
    const ownerHasAdmin = await contract.hasAccess(objId, accounts[0], Permission.ADMIN);
    assert(ownerHasAdmin === true, "Owner has implicit ADMIN-level access with zero grants made");
  }
  console.log();

  // ===================== H. ADMIN grant satisfies lower-tier requirements =====================
  console.log("=== H. ADMIN grant also satisfies READ and WRITE requirements ===");
  {
    const objId = await registerObject("objH");
    await (await withGas(contract.grantAccess, [objId, accounts[1], Permission.ADMIN, 0])).wait();
    const passesRead = await contract.hasAccess(objId, accounts[1], Permission.READ);
    const passesWrite = await contract.hasAccess(objId, accounts[1], Permission.WRITE);
    const passesAdmin = await contract.hasAccess(objId, accounts[1], Permission.ADMIN);
    assert(passesRead === true, "ADMIN grant satisfies a READ requirement");
    assert(passesWrite === true, "ADMIN grant satisfies a WRITE requirement");
    assert(passesAdmin === true, "ADMIN grant satisfies an ADMIN requirement");
  }
  console.log();

  console.log("=== FINAL RESULT ===");
  console.log(`${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exitCode = 1;

  await ganacheProvider.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
