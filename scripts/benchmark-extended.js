const fs = require("fs");
const path = require("path");
const ethers = require("ethers");
const Ganache = require("ganache");

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

  const results = [];
  const h = ethers.keccak256(ethers.toUtf8Bytes("extended-bench"));

  // registerUser
  let tx = await withGas(contract.registerUser, [accounts[1], h, h]);
  let receipt = await tx.wait();
  results.push({ Function: "registerUser", "Gas Used": receipt.gasUsed.toString() });

  // assignRole
  tx = await withGas(contract.assignRole, [accounts[1], 2]);
  receipt = await tx.wait();
  results.push({ Function: "assignRole", "Gas Used": receipt.gasUsed.toString() });

  // registerObject
  tx = await withGas(contract.registerObject, [h, h, h, h]);
  receipt = await tx.wait();
  results.push({ Function: "registerObject", "Gas Used": receipt.gasUsed.toString() });
  const objectId = 1;

  // updatePolicy
  const newPolicy = ethers.keccak256(ethers.toUtf8Bytes("new-policy"));
  tx = await withGas(contract.updatePolicy, [objectId, newPolicy]);
  receipt = await tx.wait();
  results.push({ Function: "updatePolicy", "Gas Used": receipt.gasUsed.toString() });

  // logAccess
  tx = await withGas(contract.connect(alice).logAccess, [objectId, true]);
  receipt = await tx.wait();
  results.push({ Function: "logAccess", "Gas Used": receipt.gasUsed.toString() });

  // getAuditEntry (view)
  const entry = await contract.getAuditEntry(0);
  results.push({ Function: "getAuditEntry (view)", "Gas Used": "0", "Note": `decision=${entry[2]}` });

  // auditLogLength (view)
  const len = await contract.auditLogLength();
  results.push({ Function: "auditLogLength (view)", "Gas Used": "0", "Note": `length=${len}` });

  console.log("=== Extended Functions Gas Costs ===\n");
  console.table(results);

  const outPath = path.join(__dirname, "..", "benchmark-results.json");
  let existing = {};
  if (fs.existsSync(outPath)) {
    existing = JSON.parse(fs.readFileSync(outPath, "utf8"));
  }
  existing.extended = results;
  fs.writeFileSync(outPath, JSON.stringify(existing, null, 2));
  console.log("\nAppended to benchmark-results.json");

  await ganacheProvider.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
