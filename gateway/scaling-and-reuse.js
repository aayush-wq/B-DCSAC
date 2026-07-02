const fs = require("fs");
const path = require("path");
const ethers = require("ethers");
const Ganache = require("ganache");

async function main() {
  const ganacheProvider = Ganache.provider({
    wallet: { totalAccounts: 10, defaultBalance: 100 },
    logging: { quiet: true },
  });
  const provider = new ethers.BrowserProvider(ganacheProvider);
  const accounts = await provider.send("eth_accounts", []);
  const owner = await provider.getSigner(accounts[0]);

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

  const h = ethers.keccak256(ethers.toUtf8Bytes("scaling"));
  const results = [];

  // Scaling: register many objects
  const objectCounts = [1, 5, 10, 20, 50];
  for (const count of objectCounts) {
    const start = Date.now();
    for (let i = 0; i < count; i++) {
      await (await withGas(contract.registerObject, [h, h, h, h])).wait();
    }
    const elapsed = Date.now() - start;
    results.push({ Test: `Register ${count} objects`, "Total ms": elapsed, "Avg ms": (elapsed / count).toFixed(2) });
  }

  // Scaling: grant access to many users for one object
  const userCounts = [1, 5, 9];
  for (const count of userCounts) {
    const objTx = await withGas(contract.registerObject, [h, h, h, h]);
    await objTx.wait();
    const objectId = await contract.totalObjects();
    const start = Date.now();
    for (let i = 0; i < count; i++) {
      await (await withGas(contract.grantAccess, [objectId, accounts[i + 1], 1, 0])).wait();
    }
    const elapsed = Date.now() - start;
    results.push({ Test: `Grant to ${count} users`, "Total ms": elapsed, "Avg ms": (elapsed / count).toFixed(2) });
  }

  // Reuse: revoke then re-grant
  const reuseTx = await withGas(contract.registerObject, [h, h, h, h]);
  await reuseTx.wait();
  const reuseObj = await contract.totalObjects();
  const reuseStart = Date.now();
  await (await withGas(contract.grantAccess, [reuseObj, accounts[1], 1, 0])).wait();
  await (await withGas(contract.revokeAccess, [reuseObj, accounts[1]])).wait();
  await (await withGas(contract.grantAccess, [reuseObj, accounts[1], 2, 0])).wait();
  const reuseElapsed = Date.now() - reuseStart;
  results.push({ Test: "Grant -> Revoke -> Re-grant", "Total ms": reuseElapsed, "Avg ms": "-" });

  console.log("=== Scaling & Reuse Results ===\n");
  console.table(results);

  const outPath = path.join(__dirname, "..", "benchmark-results.json");
  let existing = {};
  if (fs.existsSync(outPath)) {
    existing = JSON.parse(fs.readFileSync(outPath, "utf8"));
  }
  existing.scaling = results;
  fs.writeFileSync(outPath, JSON.stringify(existing, null, 2));
  console.log("\nAppended to benchmark-results.json");

  await ganacheProvider.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
