/**
 * Real EVM gas benchmark for B-DCSAC core functions.
 *
 * Uses the `ganache` npm package — the same Ganache simulator engine
 * referenced in the paper — running as an in-process local EVM with
 * pre-funded test accounts (fake ETH, zero real-world value).
 *
 * This replaces the analytically-estimated gas figures in Section 10 with
 * actual measured gasUsed values returned by real transaction receipts
 * from a real Solidity deployment + execution.
 *
 * Run:
 *   node scripts/benchmark.js
 *
 * To run against the Ganache GUI app instead of this embedded engine,
 * change `provider` below to: new ethers.JsonRpcProvider("http://127.0.0.1:7545")
 */
const fs = require("fs");
const path = require("path");
const ethers = require("ethers");
const Ganache = require("ganache");

async function main() {
  const ganacheProvider = Ganache.provider({
    wallet: { totalAccounts: 5, defaultBalance: 100 }, // 100 fake ETH per account
    logging: { quiet: true },
  });
  const provider = new ethers.BrowserProvider(ganacheProvider);

  const accounts = await provider.send("eth_accounts", []);
  const owner = await provider.getSigner(accounts[0]);
  const alice = await provider.getSigner(accounts[1]);
  const bob = await provider.getSigner(accounts[2]);

  console.log("Ganache local EVM started.");
  console.log("Owner:", accounts[0], "| Alice:", accounts[1], "| Bob:", accounts[2]);
  const ownerBalance = await provider.getBalance(accounts[0]);
  console.log("Owner starting balance (fake test ETH):", ethers.formatEther(ownerBalance), "ETH\n");

  const artifact = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "build", "BDCSAC_AccessControl.json"), "utf8")
  );

  const results = [];

  // --- Deploy ---
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, owner);
  const contract = await factory.deploy();
  const deployTxReceipt = await contract.deploymentTransaction().wait();
  results.push({ "Function": "deployContract", "Gas Used": deployTxReceipt.gasUsed.toString() });
  const contractAddress = await contract.getAddress();
  console.log("Contract deployed at:", contractAddress, "\n");

  const contractAsOwner = contract;
  const contractAsAlice = contract.connect(alice);
  const contractAsBob = contract.connect(bob);

  // --- registerObject ---
  const contentHash = ethers.keccak256(ethers.toUtf8Bytes("encrypted-object-payload-001"));
  let tx = await contractAsOwner.registerObject(contentHash);
  let receipt = await tx.wait();
  results.push({ "Function": "registerObject", "Gas Used": receipt.gasUsed.toString() });
  const objectId = 1;

  // --- grantAccess: READ to Alice, no expiry ---
  tx = await contractAsOwner.grantAccess(objectId, accounts[1], 1 /* READ */, 0);
  receipt = await tx.wait();
  results.push({ "Function": "grantAccess (READ, no expiry)", "Gas Used": receipt.gasUsed.toString() });

  // --- grantAccess: WRITE to Bob, with 1hr expiry ---
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  tx = await contractAsOwner.grantAccess(objectId, accounts[2], 2 /* WRITE */, expiresAt);
  receipt = await tx.wait();
  results.push({ "Function": "grantAccess (WRITE, with expiry)", "Gas Used": receipt.gasUsed.toString() });

  // --- checkAccess (state-changing, audit event) called by Alice ---
  tx = await contractAsAlice.checkAccess(objectId, 1 /* READ */);
  receipt = await tx.wait();
  results.push({ "Function": "checkAccess (granted)", "Gas Used": receipt.gasUsed.toString() });

  // --- revokeAccess on Bob ---
  tx = await contractAsOwner.revokeAccess(objectId, accounts[2]);
  receipt = await tx.wait();
  results.push({ "Function": "revokeAccess", "Gas Used": receipt.gasUsed.toString() });

  // --- checkAccess after revocation (Bob, should be denied) ---
  tx = await contractAsBob.checkAccess(objectId, 1 /* READ */);
  receipt = await tx.wait();
  results.push({ "Function": "checkAccess (revoked, denied)", "Gas Used": receipt.gasUsed.toString() });

  // --- hasAccess: pure view call, free off-chain read ---
  const viewResult = await contract.hasAccess(objectId, accounts[1], 1);
  results.push({ "Function": "hasAccess (view/eth_call)", "Gas Used": "0 (view fn, off-chain)", "Note": `result=${viewResult}` });

  console.log("=== B-DCSAC Real Measured Gas Costs (local EVM, Ganache engine) ===\n");
  console.table(results);

  fs.writeFileSync(
    path.join(__dirname, "..", "benchmark-results.json"),
    JSON.stringify({ engine: "ganache (npm)", timestamp: new Date().toISOString(), results }, null, 2)
  );
  console.log("\nSaved to benchmark-results.json");

  await ganacheProvider.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
