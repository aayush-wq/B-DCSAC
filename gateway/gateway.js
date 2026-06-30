/**
 * BDCSAC Gateway
 *
 * This is the component that sits between a requester and the off-chain
 * encrypted storage. It NEVER releases ciphertext/keys directly — every
 * request goes through the on-chain checkAccess() function first. This
 * mirrors the architecture described in the paper: the chain is the
 * authorization source of truth, the gateway is just an enforcement point.
 *
 * Flow:
 *   1. Owner stores an object -> storage.putObject() -> gets contentHash + key
 *   2. Owner registers the object on-chain -> registerObject(contentHashAsBytes32)
 *   3. Owner grants access to subjects -> grantAccess(...)
 *   4. A requester asks the gateway for the object
 *   5. Gateway calls checkAccess() on-chain AS the requester's signer
 *   6. If granted: gateway fetches ciphertext from storage and returns
 *      plaintext (the key hand-off here stands in for what a real CP-ABE
 *      scheme would do automatically based on the policy - see storage.js note)
 *      If denied: gateway refuses, no data ever leaves storage.
 */
const ethers = require("ethers");
const storage = require("./storage");

const Permission = { NONE: 0, READ: 1, WRITE: 2, ADMIN: 3 };

// Ganache's eth_estimateGas can underestimate certain call paths when
// accessed through ethers' BrowserProvider wrapper (observed during
// verification: an identical code path succeeded at a higher gas limit but
// reverted at the auto-estimated limit). We pad every estimate by 30% as a
// defensive measure so transactions don't spuriously revert from gas
// underestimation. This does not change the actual measured gasUsed
// reported in receipts (gasUsed comes from the EVM, not from gasLimit).
async function withGasBuffer(contractMethodCall, args) {
  const estimated = await contractMethodCall.estimateGas(...args);
  const padded = (estimated * 130n) / 100n;
  return contractMethodCall(...args, { gasLimit: padded });
}

class BDCSACGateway {
  /**
   * @param {ethers.Contract} contract - the deployed BDCSAC_AccessControl contract
   * @param {Map} keyRegistry - in-memory map of objectId -> { contentHashHex, decryptionKey }
   *        In production the owner would distribute keys out-of-band per
   *        access-control policy (CP-ABE). Here it's a stand-in so the demo
   *        is fully runnable and inspectable.
   */
  constructor(contract, keyRegistry) {
    this.contract = contract;
    this.keyRegistry = keyRegistry;
  }

  /**
   * Owner-side: encrypts+stores a payload off-chain, registers it on-chain,
   * and records the key registry entry the gateway will need later.
   */
  async storeAndRegisterObject(ownerSigner, plaintextBuffer) {
    const { contentHashHex, decryptionKey } = storage.putObject(plaintextBuffer);
    const contentHashBytes32 = ethers.keccak256(ethers.toUtf8Bytes(contentHashHex));

    const contractAsOwner = this.contract.connect(ownerSigner);
    const tx = await withGasBuffer(contractAsOwner.registerObject, [contentHashBytes32]);
    const receipt = await tx.wait();

    // Parse the ObjectRegistered event to get the assigned objectId
    const event = receipt.logs
      .map((log) => {
        try { return this.contract.interface.parseLog(log); } catch { return null; }
      })
      .find((parsed) => parsed && parsed.name === "ObjectRegistered");

    const objectId = event.args.objectId;
    this.keyRegistry.set(objectId.toString(), { contentHashHex, decryptionKey });

    return { objectId, gasUsed: receipt.gasUsed.toString() };
  }

  /**
   * Owner-side: grant a subject access via the contract.
   */
  async grantAccess(ownerSigner, objectId, subjectAddress, permission, expiresAt = 0) {
    const contractAsOwner = this.contract.connect(ownerSigner);
    const tx = await withGasBuffer(contractAsOwner.grantAccess, [objectId, subjectAddress, permission, expiresAt]);
    const receipt = await tx.wait();
    return { gasUsed: receipt.gasUsed.toString() };
  }

  /**
   * Owner-side: revoke a subject's access.
   */
  async revokeAccess(ownerSigner, objectId, subjectAddress) {
    const contractAsOwner = this.contract.connect(ownerSigner);
    const tx = await withGasBuffer(contractAsOwner.revokeAccess, [objectId, subjectAddress]);
    const receipt = await tx.wait();
    return { gasUsed: receipt.gasUsed.toString() };
  }

  /**
   * Requester-side: THIS is the core enforcement function. The gateway will
   * not look at storage at all unless the on-chain check passes.
   */
  async requestObject(requesterSigner, objectId, requiredPermission = Permission.READ) {
    const contractAsRequester = this.contract.connect(requesterSigner);

    // Step 1: on-chain authorization check (state-changing, audited)
    const tx = await withGasBuffer(contractAsRequester.checkAccess, [objectId, requiredPermission]);
    const receipt = await tx.wait();

    // Step 2: read back whether it was granted, from the emitted event
    const event = receipt.logs
      .map((log) => {
        try { return this.contract.interface.parseLog(log); } catch { return null; }
      })
      .find((parsed) => parsed && parsed.name === "AccessChecked");

    const granted = event.args.granted;

    if (!granted) {
      return {
        granted: false,
        data: null,
        gasUsed: receipt.gasUsed.toString(),
        reason: "Access denied by on-chain policy (no grant, expired, or revoked).",
      };
    }

    // Step 3: only now does the gateway touch off-chain storage
    const requesterAddress = await requesterSigner.getAddress();
    const entry = this.keyRegistry.get(objectId.toString());
    if (!entry) {
      throw new Error(`Gateway: object ${objectId} authorized on-chain but no storage entry found.`);
    }

    const plaintext = storage.getObject(entry.contentHashHex, entry.decryptionKey);

    return {
      granted: true,
      data: plaintext,
      gasUsed: receipt.gasUsed.toString(),
      requester: requesterAddress,
    };
  }
}

module.exports = { BDCSACGateway, Permission };
