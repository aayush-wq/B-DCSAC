/**
 * Real measured gas costs for the 4 functions added to fully back every row
 * of the paper's Table 5 with empirical data (previously these had no
 * implementation at all): registerUser, assignRole, updatePolicy, logAccess.
 *
 * Run: node scripts/benchmark-extended.js
 */
const fs = require("fs");
const path = require("path");
const ethers = require("ethers");
const Ganache = require("ganache");

async function main() {
  const ganacheProvider = Ganache.provider({
    wallet: { totalAccounts: 5, defaultBalance: 100 },
    logging: { quiet: true },
  });
  const provider = new ethers.BrowserProvider(ganacheProvider);
  const accounts = await provider.send("eth_accounts", []);
  const owner = await provider.getSigner(accounts[0]); // also acts as admin (deployer)
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

  // --- registerUser ---
  const didHash = ethers.keccak256(ethers.toUtf8Bytes("did:bdcsac:alice"));
  const pubKeyHash = ethers.keccak256(ethers.toUtf8Bytes("alice-pubkey"));
  let tx = await withGas(contract.connect(alice).registerUser, [accounts[1], didHash, pubKeyHash]);
  let receipt = await tx.wait();
  results.push({ Function: "registerUser", "Gas Used": receipt.gasUsed.toString() });

  // --- assignRole (admin-only; owner == admin since owner deployed the contract) ---
  tx = await withGas(contract.assignRole, [accounts[1], 1]); // role 1 = "auditor", arbitrary app-defined ID
  receipt = await tx.wait();
  results.push({ Function: "assignRole", "Gas Used": receipt.gasUsed.toString() });

  // --- registerObject (needed before updatePolicy) ---
  const contentHash = ethers.keccak256(ethers.toUtf8Bytes("ext-bench-object"));
  tx = await withGas(contract.registerObject, [contentHash]);
  receipt = await tx.wait();
  const objectId = 1;

  // --- updatePolicy ---
  const newPolicyHash = ethers.keccak256(ethers.toUtf8Bytes("policy-v2"));
  tx = await withGas(contract.updatePolicy, [objectId, newPolicyHash]);
  receipt = await tx.wait();
  results.push({ Function: "updatePolicy", "Gas Used": receipt.gasUsed.toString() });

  // --- logAccess (standalone audit write, separate from checkAccess's event) ---
  tx = await withGas(contract.connect(alice).logAccess, [objectId, true]);
  receipt = await tx.wait();
  results.push({ Function: "logAccess", "Gas Used": receipt.gasUsed.toString() });

  console.log("=== B-DCSAC Extended Functions - Real Measured Gas Costs ===\n");
  console.table(results);

  // Merge with the core benchmark-results.json so one file has all 8 Table 5 rows
  const corePath = path.join(__dirname, "..", "benchmark-results.json");
  const core = JSON.parse(fs.readFileSync(corePath, "utf8"));
  const merged = {
    ...core,
    extendedFunctions: results,
    note: "Core results[] covers registerObject/grantAccess/revokeAccess/checkAccess (the original gateway-facing functions). extendedFunctions[] covers registerUser/assignRole/updatePolicy/logAccess, added specifically to give every row of the paper's Table 5 a real measured value instead of an analytical estimate.",
  };
  fs.writeFileSync(corePath, JSON.stringify(merged, null, 2));
  console.log("\nMerged into benchmark-results.json");

  await ganacheProvider.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
