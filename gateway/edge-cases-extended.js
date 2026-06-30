/**
 * Edge-case checks for the 4 functions added to back the remaining Table 5
 * rows: registerUser, assignRole, updatePolicy, logAccess.
 *
 * Run: node gateway/edge-cases-extended.js
 */
const fs = require("fs");
const path = require("path");
const ethers = require("ethers");
const Ganache = require("ganache");

let passCount = 0;
let failCount = 0;
function assert(condition, label) {
  if (condition) { console.log(`  PASS - ${label}`); passCount++; }
  else { console.log(`  FAIL - ${label}`); failCount++; }
}
async function expectRevert(promise, label) {
  try {
    const tx = await promise;
    await tx.wait();
    console.log(`  FAIL - ${label} (expected revert, but succeeded)`);
    failCount++;
  } catch {
    console.log(`  PASS - ${label}`);
    passCount++;
  }
}

async function main() {
  const ganacheProvider = Ganache.provider({ wallet: { totalAccounts: 5, defaultBalance: 100 }, logging: { quiet: true } });
  const provider = new ethers.BrowserProvider(ganacheProvider);
  const accounts = await provider.send("eth_accounts", []);
  const owner = await provider.getSigner(accounts[0]); // = admin (deployer)
  const alice = await provider.getSigner(accounts[1]);
  const eve = await provider.getSigner(accounts[3]);

  const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "build", "BDCSAC_AccessControl.json"), "utf8"));
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, owner);
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  console.log("Contract deployed at:", await contract.getAddress(), "\n");

  async function withGas(call, args) {
    const est = await call.estimateGas(...args);
    return call(...args, { gasLimit: (est * 130n) / 100n });
  }

  console.log("=== Non-admin cannot assign a role ===");
  await (await withGas(contract.registerUser, [accounts[1], ethers.keccak256(ethers.toUtf8Bytes("did")), ethers.keccak256(ethers.toUtf8Bytes("pk"))])).wait();
  await expectRevert(
    withGas(contract.connect(eve).assignRole, [accounts[1], 2]),
    "Eve (not admin) cannot assign Alice a role"
  );
  console.log();

  console.log("=== Admin cannot assign a role to an unregistered user ===");
  await expectRevert(
    withGas(contract.assignRole, [accounts[4], 1]), // account never called registerUser
    "assignRole reverts for an address that never called registerUser"
  );
  console.log();

  console.log("=== Admin CAN assign a role to a registered user ===");
  const tx = await withGas(contract.assignRole, [accounts[1], 2]);
  await tx.wait();
  const role = await contract.roles(accounts[1]);
  assert(Number(role) === 2, "Alice's role is correctly set to 2 after admin assigns it");
  console.log();

  console.log("=== Non-owner cannot update an object's policy ===");
  await (await withGas(contract.registerObject, [ethers.keccak256(ethers.toUtf8Bytes("obj"))])).wait();
  await expectRevert(
    withGas(contract.connect(eve).updatePolicy, [1, ethers.keccak256(ethers.toUtf8Bytes("evil-policy"))]),
    "Eve (not the object owner) cannot update its policy"
  );
  console.log();

  console.log("=== Owner CAN update policy, version increments correctly ===");
  await (await withGas(contract.updatePolicy, [1, ethers.keccak256(ethers.toUtf8Bytes("policy-v2"))])).wait();
  await (await withGas(contract.updatePolicy, [1, ethers.keccak256(ethers.toUtf8Bytes("policy-v3"))])).wait();
  const version = await contract.policyVersion(1);
  assert(Number(version) === 2, `Policy version incremented twice as expected (got ${version})`);
  console.log();

  console.log("=== logAccess writes append-only entries with correct data ===");
  const before = await contract.auditLogLength();
  const logTx = await withGas(contract.connect(alice).logAccess, [1, true]);
  await logTx.wait();
  const after = await contract.auditLogLength();
  assert(Number(after) === Number(before) + 1, "Audit log length increments by exactly 1");
  const entry = await contract.getAuditEntry(Number(before));
  assert(entry.requester.toLowerCase() === accounts[1].toLowerCase(), "Logged entry records the correct requester address");
  assert(entry.decision === true, "Logged entry records the correct decision");
  console.log();

  console.log("=== FINAL RESULT ===");
  console.log(`${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exitCode = 1;

  await ganacheProvider.disconnect();
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
