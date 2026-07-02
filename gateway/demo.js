const fs = require("fs");
const path = require("path");
const ethers = require("ethers");
const Ganache = require("ganache");
const { BDCSACGateway, Permission } = require("./gateway");

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

  const gateway = new BDCSACGateway(contract, new Map());

  // Register users
  const didHash = ethers.keccak256(ethers.toUtf8Bytes("did:owner"));
  const pkHash = ethers.keccak256(ethers.toUtf8Bytes("pk:owner"));
  await (await contract.registerUser(accounts[0], didHash, pkHash)).wait();
  await (await contract.registerUser(accounts[1], didHash, pkHash)).wait();
  await (await contract.assignRole(accounts[0], 3)).wait(); // ADMIN
  await (await contract.assignRole(accounts[1], 1)).wait(); // READ

  // Upload file
  const plaintext = Buffer.from("Hello, B-DCSAC secure sharing!");
  const regResult = await gateway.storeAndRegisterObject(owner, plaintext, "demo-policy");
  console.log("Object registered:", regResult);

  // Grant access
  const grantResult = await gateway.grantAccess(owner, regResult.objectId, accounts[1], Permission.READ, 0);
  console.log("Access granted:", grantResult);

  // Request access
  const reqResult = await gateway.requestObject(alice, regResult.objectId, Permission.READ);
  console.log("Access request:", reqResult);
  console.log("Retrieved text:", reqResult.data.toString("utf8"));

  // Revoke access
  const revResult = await gateway.revokeAccess(owner, regResult.objectId, accounts[1]);
  console.log("Access revoked:", revResult);

  // Request after revocation (should deny)
  const deniedResult = await gateway.requestObject(alice, regResult.objectId, Permission.READ);
  console.log("Access after revocation:", deniedResult);

  // Token-based flow
  const future = Math.floor(Date.now() / 1000) + 3600;
  const nonce = ethers.keccak256(ethers.toUtf8Bytes("demo-nonce"));
  await (await contract.issueToken(regResult.objectId, accounts[1], Permission.READ, nonce, future)).wait();
  const tokenId = 1;

  const tokenResult = await gateway.requestObjectByToken(alice, regResult.objectId, tokenId);
  console.log("Token-based access:", tokenResult);
  console.log("Retrieved via token:", tokenResult.data.toString("utf8"));

  await ganacheProvider.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
