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
  const bob = await provider.getSigner(accounts[2]);

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
  const h = ethers.keccak256(ethers.toUtf8Bytes("benchmark"));

  // registerObject
  let tx = await withGas(contract.registerObject, [h, h, h, h]);
  let receipt = await tx.wait();
  results.push({ Function: "registerObject", "Gas Used": receipt.gasUsed.toString() });
  const objectId = 1;

  // grantAccess
  tx = await withGas(contract.grantAccess, [objectId, accounts[1], 1, 0]);
  receipt = await tx.wait();
  results.push({ Function: "grantAccess", "Gas Used": receipt.gasUsed.toString() });

  // checkAccess (granted)
  tx = await withGas(contract.connect(alice).checkAccess, [objectId, 1]);
  receipt = await tx.wait();
  results.push({ Function: "checkAccess (granted)", "Gas Used": receipt.gasUsed.toString() });

  // checkAccess (denied)
  tx = await withGas(contract.connect(bob).checkAccess, [objectId, 1]);
  receipt = await tx.wait();
  results.push({ Function: "checkAccess (denied)", "Gas Used": receipt.gasUsed.toString() });

  // revokeAccess
  tx = await withGas(contract.revokeAccess, [objectId, accounts[1]]);
  receipt = await tx.wait();
  results.push({ Function: "revokeAccess", "Gas Used": receipt.gasUsed.toString() });

  // hasAccess (view)
  const has = await contract.hasAccess(objectId, accounts[1], 1);
  results.push({ Function: "hasAccess (view)", "Gas Used": "0", "Note": `result=${has}` });

  // getObject (view)
  const obj = await contract.getObject(objectId);
  results.push({ Function: "getObject (view)", "Gas Used": "0", "Note": `owner=${obj[0]}` });

  console.log("=== Core Access Control Gas Costs ===\n");
  console.table(results);

  const outPath = path.join(__dirname, "..", "benchmark-results.json");
  fs.writeFileSync(outPath, JSON.stringify({ core: results }, null, 2));
  console.log("\nSaved to benchmark-results.json");

  await ganacheProvider.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
