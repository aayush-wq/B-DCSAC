const ethers = require("ethers");
const storage = require("./storage");

const Permission = { NONE: 0, READ: 1, WRITE: 2, ADMIN: 3 };

async function withGasBuffer(contractMethodCall, args) {
  const estimated = await contractMethodCall.estimateGas(...args);
  const padded = (estimated * 130n) / 100n;
  return contractMethodCall(...args, { gasLimit: padded });
}

class BDCSACGateway {
  constructor(contract, keyRegistry) {
    this.contract = contract;
    this.keyRegistry = keyRegistry;
  }

  async storeAndRegisterObject(ownerSigner, plaintextBuffer, policyLabel = "default-policy") {
    const { contentHashHex, decryptionKey } = storage.putObject(plaintextBuffer);
    const contentHashBytes32 = ethers.keccak256(ethers.toUtf8Bytes(contentHashHex));
    const cidHash = ethers.keccak256(ethers.toUtf8Bytes(`cid:${contentHashHex}`));
    const policyHashVal = ethers.keccak256(ethers.toUtf8Bytes(policyLabel));
    const keyRef = ethers.keccak256(ethers.toUtf8Bytes(`keyref:${contentHashHex}`));

    const contractAsOwner = this.contract.connect(ownerSigner);
    const tx = await withGasBuffer(contractAsOwner.registerObject, [cidHash, contentHashBytes32, policyHashVal, keyRef]);
    const receipt = await tx.wait();

    const event = receipt.logs
      .map((log) => { try { return this.contract.interface.parseLog(log); } catch { return null; } })
      .find((parsed) => parsed && parsed.name === "ObjectRegistered");

    const objectId = event.args.objectId;
    this.keyRegistry.set(objectId.toString(), { contentHashHex, decryptionKey });

    return { objectId, gasUsed: receipt.gasUsed.toString() };
  }

  async grantAccess(ownerSigner, objectId, subjectAddress, permission, expiresAt = 0) {
    const contractAsOwner = this.contract.connect(ownerSigner);
    const tx = await withGasBuffer(contractAsOwner.grantAccess, [objectId, subjectAddress, permission, expiresAt]);
    const receipt = await tx.wait();
    return { gasUsed: receipt.gasUsed.toString() };
  }

  async revokeAccess(ownerSigner, objectId, subjectAddress) {
    const contractAsOwner = this.contract.connect(ownerSigner);
    const tx = await withGasBuffer(contractAsOwner.revokeAccess, [objectId, subjectAddress]);
    const receipt = await tx.wait();
    return { gasUsed: receipt.gasUsed.toString() };
  }

  async requestObject(requesterSigner, objectId, requiredPermission = Permission.READ) {
    const contractAsRequester = this.contract.connect(requesterSigner);

    const tx = await withGasBuffer(contractAsRequester.checkAccess, [objectId, requiredPermission]);
    const receipt = await tx.wait();

    const parsedLogs = receipt.logs.map((log) => {
      try { return this.contract.interface.parseLog(log); } catch { return null; }
    });
    const validatedEvent = parsedLogs.find((p) => p && p.name === "AccessValidated");
    const deniedEvent = parsedLogs.find((p) => p && p.name === "AccessDenied");
    const granted = Boolean(validatedEvent) && !deniedEvent;

    if (!granted) {
      return {
        granted: false,
        data: null,
        gasUsed: receipt.gasUsed.toString(),
        reason: "Access denied.",
      };
    }

    const entry = this.keyRegistry.get(objectId.toString());
    if (!entry) {
      throw new Error(`Gateway: object ${objectId} not found in key registry.`);
    }

    const plaintext = storage.getObject(entry.contentHashHex, entry.decryptionKey);

    return {
      granted: true,
      data: plaintext,
      gasUsed: receipt.gasUsed.toString(),
      requester: await requesterSigner.getAddress(),
    };
  }

  async requestObjectByToken(requesterSigner, objectId, tokenId) {
    const contractAsRequester = this.contract.connect(requesterSigner);

    const tx = await withGasBuffer(contractAsRequester.consumeToken, [tokenId]);
    const receipt = await tx.wait();

    const parsedLogs = receipt.logs.map((log) => {
      try { return this.contract.interface.parseLog(log); } catch { return null; }
    });
    const consumed = parsedLogs.find((p) => p && p.name === "TokenConsumed");

    if (!consumed) {
      return {
        granted: false,
        data: null,
        gasUsed: receipt.gasUsed.toString(),
        reason: "Token invalid, expired, revoked, or policy changed.",
      };
    }

    const entry = this.keyRegistry.get(objectId.toString());
    if (!entry) {
      throw new Error(`Gateway: object ${objectId} not found in key registry.`);
    }

    const plaintext = storage.getObject(entry.contentHashHex, entry.decryptionKey);

    return {
      granted: true,
      data: plaintext,
      gasUsed: receipt.gasUsed.toString(),
      requester: await requesterSigner.getAddress(),
      tokenId,
    };
  }
}

module.exports = { BDCSACGateway, Permission };
