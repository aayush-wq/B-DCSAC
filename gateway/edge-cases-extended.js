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
    console.log(`  FAIL - ${label} (expected revert, tx succeeded)`);
    failCount++;
  } catch {
    console.log(`  PASS - ${label}`);
    passCount++;
  }
}

async function main() {
  const ganacheProvider = Ganache.provider({
    wallet: { totalAccounts: 5, defaultBalance: 100 },
    logging: { quiet: true },
    blockTime: 2,
  });
  const provider = new ethers.BrowserProvider(ganacheProvider);
  const accounts = await provider.send("eth_accounts", []);
  const owner = await provider.getSigner(accounts[0]);
  const alice = await provider.getSigner(accounts[1]);

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

  const h = ethers.keccak256(ethers.toUtf8Bytes("extended"));

  console.log("=== A. Only admin can assign roles ===");
  await expectRevert(
    withGas(contract.connect(alice).assignRole, [accounts[1], 1]),
    "Non-admin role assignment reverts"
  );

  console.log("\n=== B. Role assignment requires registered user ===");
  await expectRevert(
    withGas(contract.assignRole, [accounts[3], 1]),
    "Role for unregistered user reverts"
  );

  console.log("\n=== C. Register user then assign role ===");
  await (await withGas(contract.registerUser, [accounts[1], h, h])).wait();
  await (await withGas(contract.assignRole, [accounts[1], 2])).wait();
  const role = await contract.roles(accounts[1]);
  assert(role === 2n, "Role assigned correctly");

  console.log("\n=== D. Policy update increments version ===");
  await (await withGas(contract.registerObject, [h, h, h, h])).wait();
  const objectId = 1;
  const oldVersion = await contract.policyVersion(objectId);
  await (await withGas(contract.updatePolicy, [objectId, ethers.keccak256(ethers.toUtf8Bytes("policy-v2"))])).wait();
  const newVersion = await contract.policyVersion(objectId);
  assert(newVersion === oldVersion + 1n, "Policy version incremented");

  console.log("\n=== E. Non-owner cannot update policy ===");
  await expectRevert(
    withGas(contract.connect(alice).updatePolicy, [objectId, h]),
    "Non-owner policy update reverts"
  );

  console.log("\n=== F. Audit log append and retrieve ===");
  await (await withGas(contract.connect(alice).logAccess, [objectId, true])).wait();
  const len = await contract.auditLogLength();
  assert(len === 1n, "Audit log has one entry");
  const entry = await contract.getAuditEntry(0);
  assert(entry[0] === 1n && entry[2] === true, "Audit entry correct");

  console.log("\n=== G. Object does not exist ===");
  await expectRevert(
    withGas(contract.getObject, [999]),
    "getObject for non-existent ID reverts"
  );

  console.log("\n=== FINAL RESULT ===");
  console.log(`${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exitCode = 1;

  await ganacheProvider.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
