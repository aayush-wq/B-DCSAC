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

  const h = ethers.keccak256(ethers.toUtf8Bytes("token-bench-object"));
  await (await withGas(contract.registerObject, [h, h, h, h])).wait();
  const objectId = 1;

  const nonce1 = ethers.keccak256(ethers.toUtf8Bytes("nonce-001"));
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  let tx = await withGas(contract.issueToken, [objectId, accounts[1], 1, nonce1, expiresAt]);
  let receipt = await tx.wait();
  results.push({ Function: "issueToken", "Gas Used": receipt.gasUsed.toString() });
  const tokenId = 1;

  tx = await withGas(contract.connect(alice).consumeToken, [tokenId]);
  receipt = await tx.wait();
  results.push({ Function: "consumeToken", "Gas Used": receipt.gasUsed.toString() });

  const nonce2 = ethers.keccak256(ethers.toUtf8Bytes("nonce-002"));
  await (await withGas(contract.issueToken, [objectId, accounts[1], 1, nonce2, expiresAt])).wait();
  const tokenId2 = 2;
  tx = await withGas(contract.revokeToken, [tokenId2]);
  receipt = await tx.wait();
  results.push({ Function: "revokeToken", "Gas Used": receipt.gasUsed.toString() });

  const valid = await contract.isTokenValid(tokenId2, accounts[1]);
  results.push({ Function: "isTokenValid (view/eth_call)", "Gas Used": "0 (view fn, off-chain)", "Note": `result=${valid}` });

  console.log("=== Token Model Gas Costs ===\n");
  console.table(results);

  const corePath = path.join(__dirname, "..", "benchmark-results.json");
  let core = {};
  if (fs.existsSync(corePath)) {
    core = JSON.parse(fs.readFileSync(corePath, "utf8"));
  }
  core.tokenModel = results;
  fs.writeFileSync(corePath, JSON.stringify(core, null, 2));
  console.log("\nMerged into benchmark-results.json");

  await ganacheProvider.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
