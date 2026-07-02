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
    console.log(`  FAIL - ${label} (expected revert, transaction succeeded)`);
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

  const h = ethers.keccak256(ethers.toUtf8Bytes("token-test-object"));
  await (await withGas(contract.registerObject, [h, h, h, h])).wait();
  const objectId = 1;
  const future = Math.floor(Date.now() / 1000) + 3600;

  console.log("=== A. Normal token flow: issue then consume ===");
  {
    const nonce = ethers.keccak256(ethers.toUtf8Bytes("nonce-A"));
    await (await withGas(contract.issueToken, [objectId, accounts[1], 1, nonce, future])).wait();
    const tokenId = 1;
    assert(await contract.isTokenValid(tokenId, accounts[1]) === true, "Token is valid before consumption");
    await (await withGas(contract.connect(alice).consumeToken, [tokenId])).wait();
    assert(await contract.isTokenValid(tokenId, accounts[1]) === false, "Token invalid after consumption");
  }
  console.log();

  console.log("=== B. Replay attack: consuming same token twice fails ===");
  {
    const nonce = ethers.keccak256(ethers.toUtf8Bytes("nonce-B"));
    await (await withGas(contract.issueToken, [objectId, accounts[1], 1, nonce, future])).wait();
    const tokenId = 2;
    await (await withGas(contract.connect(alice).consumeToken, [tokenId])).wait();
    await expectRevert(
      withGas(contract.connect(alice).consumeToken, [tokenId]),
      "Consuming the same token twice reverts"
    );
  }
  console.log();

  console.log("=== C. Nonce reuse across different token issues fails ===");
  {
    const nonce = ethers.keccak256(ethers.toUtf8Bytes("nonce-C-reuse"));
    await (await withGas(contract.issueToken, [objectId, accounts[1], 1, nonce, future])).wait();
    await expectRevert(
      withGas(contract.issueToken, [objectId, accounts[2], 1, nonce, future]),
      "Same nonce cannot be used for two different token issues"
    );
  }
  console.log();

  console.log("=== D. Wrong subject cannot consume token ===");
  {
    const nonce = ethers.keccak256(ethers.toUtf8Bytes("nonce-D"));
    await (await withGas(contract.issueToken, [objectId, accounts[1], 1, nonce, future])).wait();
    const tokenId = 4;
    await expectRevert(
      withGas(contract.connect(eve).consumeToken, [tokenId]),
      "Non-subject cannot consume token"
    );
    assert(await contract.isTokenValid(tokenId, accounts[1]) === true, "Token still valid after failed consume attempt");
  }
  console.log();

  console.log("=== E. Revoked token cannot be consumed ===");
  {
    const nonce = ethers.keccak256(ethers.toUtf8Bytes("nonce-E"));
    await (await withGas(contract.issueToken, [objectId, accounts[1], 1, nonce, future])).wait();
    const tokenId = 5;
    await (await withGas(contract.revokeToken, [tokenId])).wait();
    assert(await contract.isTokenValid(tokenId, accounts[1]) === false, "Revoked token is invalid");
    await expectRevert(
      withGas(contract.connect(alice).consumeToken, [tokenId]),
      "Revoked token cannot be consumed"
    );
  }
  console.log();

  console.log("=== F. Policy change invalidates outstanding tokens ===");
  {
    const nonce = ethers.keccak256(ethers.toUtf8Bytes("nonce-F"));
    await (await withGas(contract.issueToken, [objectId, accounts[1], 1, nonce, future])).wait();
    const tokenId = 6;
    assert(await contract.isTokenValid(tokenId, accounts[1]) === true, "Token valid before policy update");
    await (await withGas(contract.updatePolicy, [objectId, ethers.keccak256(ethers.toUtf8Bytes("new-policy"))])).wait();
    assert(await contract.isTokenValid(tokenId, accounts[1]) === false, "Token invalid after policy update");
    await expectRevert(
      withGas(contract.connect(alice).consumeToken, [tokenId]),
      "Token issued before policy change cannot be consumed"
    );
  }
  console.log();

  console.log("=== G. Non-owner cannot issue a token ===");
  {
    const nonce = ethers.keccak256(ethers.toUtf8Bytes("nonce-G"));
    await expectRevert(
      withGas(contract.connect(eve).issueToken, [objectId, accounts[2], 1, nonce, future]),
      "Non-owner cannot issue a token"
    );
  }
  console.log();

  console.log("=== H. Token with past expiry cannot be issued ===");
  {
    const nonce = ethers.keccak256(ethers.toUtf8Bytes("nonce-H"));
    const pastExpiry = Math.floor(Date.now() / 1000) - 10;
    await expectRevert(
      withGas(contract.issueToken, [objectId, accounts[1], 1, nonce, pastExpiry]),
      "Token with past expiry reverts on issue"
    );
  }
  console.log();

  console.log("=== I. Grant-based and token-based flows coexist independently ===");
  {
    await (await withGas(contract.grantAccess, [objectId, accounts[2], 1, 0])).wait();
    const grantCheck = await contract.hasAccess(objectId, accounts[2], 1);
    assert(grantCheck === true, "Bob has access via grant");

    const nonce = ethers.keccak256(ethers.toUtf8Bytes("nonce-I"));
    await (await withGas(contract.issueToken, [objectId, accounts[1], 1, nonce, future])).wait();
    const tokenId = 7;
    assert(await contract.isTokenValid(tokenId, accounts[1]) === true, "Alice has valid token");
    assert(await contract.hasAccess(objectId, accounts[1], 1) === false, "Alice has no grant (token and grant are separate)");
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
