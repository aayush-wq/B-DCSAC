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
  const bob = await provider.getSigner(accounts[2]);
  const eve = await provider.getSigner(accounts[3]);

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

  const h = ethers.keccak256(ethers.toUtf8Bytes("edge-case"));
  await (await withGas(contract.registerObject, [h, h, h, h])).wait();
  const objectId = 1;

  console.log("=== A. Owner bypass ===");
  assert(await contract.hasAccess(objectId, accounts[0], 1) === true, "Owner always has access");

  console.log("\n=== B. Grant then access ===");
  await (await withGas(contract.grantAccess, [objectId, accounts[1], 1, 0])).wait();
  assert(await contract.hasAccess(objectId, accounts[1], 1) === true, "Alice has READ after grant");

  console.log("\n=== C. Revoke then deny ===");
  await (await withGas(contract.revokeAccess, [objectId, accounts[1]])).wait();
  assert(await contract.hasAccess(objectId, accounts[1], 1) === false, "Alice denied after revoke");

  console.log("\n=== D. Non-owner cannot grant ===");
  await expectRevert(
    withGas(contract.connect(alice).grantAccess, [objectId, accounts[2], 1, 0]),
    "Non-owner grant reverts"
  );

  console.log("\n=== E. Non-owner cannot revoke ===");
  await (await withGas(contract.grantAccess, [objectId, accounts[2], 1, 0])).wait();
  await expectRevert(
    withGas(contract.connect(alice).revokeAccess, [objectId, accounts[2]]),
    "Non-owner revoke reverts"
  );

  console.log("\n=== F. Expired grant ===");
  const past = Math.floor(Date.now() / 1000) - 10;
  await (await withGas(contract.grantAccess, [objectId, accounts[1], 1, past])).wait();
  assert(await contract.hasAccess(objectId, accounts[1], 1) === false, "Expired grant denied");

  console.log("\n=== G. checkAccess emits events ===");
  await (await withGas(contract.grantAccess, [objectId, accounts[1], 1, 0])).wait();
  const tx = await withGas(contract.connect(alice).checkAccess, [objectId, 1]);
  const receipt = await tx.wait();
  const validated = receipt.logs.find((l) => {
    try { return contract.interface.parseLog(l).name === "AccessValidated"; } catch { return false; }
  });
  assert(!!validated, "checkAccess emits AccessValidated");

  console.log("\n=== H. Permission hierarchy ===");
  assert(await contract.hasAccess(objectId, accounts[1], 2) === false, "READ cannot satisfy WRITE");
  await (await withGas(contract.grantAccess, [objectId, accounts[1], 2, 0])).wait();
  assert(await contract.hasAccess(objectId, accounts[1], 1) === true, "WRITE satisfies READ");

  console.log("\n=== FINAL RESULT ===");
  console.log(`${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exitCode = 1;

  await ganacheProvider.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
