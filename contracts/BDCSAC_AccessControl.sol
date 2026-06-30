// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title BDCSAC_AccessControl
 * @notice On-chain access-control registry for the Blockchain-based Decentralized
 *         Cloud Storage with Smart Contract Access Control (B-DCSAC) framework.
 *
 * Design notes (matches the architecture described in the paper):
 *  - Each stored object is represented on-chain only by its content hash / CID
 *    (the off-chain ciphertext lives in decentralized storage, e.g. IPFS).
 *    No file content ever touches the chain — only metadata + access policy.
 *  - Access is capability-based: the owner grants a (subject, objectId) pair
 *    a permission level and an optional expiry. checkAccess() is the function
 *    a storage gateway calls before releasing a decryption capability/CID.
 *  - CP-ABE / encryption itself stays off-chain (interface-only on-chain, as
 *    disclosed in the paper) — this contract enforces *authorization*, not
 *    cryptographic key management.
 */
contract BDCSAC_AccessControl {
    enum Permission { NONE, READ, WRITE, ADMIN }

    struct ObjectRecord {
        address owner;
        bytes32 contentHash;   // hash/CID of the off-chain encrypted object
        uint256 registeredAt;
        bool exists;
    }

    struct Grant {
        Permission permission;
        uint256 expiresAt;     // 0 = never expires
        bool revoked;
    }

    uint256 private objectCounter;

    mapping(uint256 => ObjectRecord) public objects;                 // objectId => record
    mapping(uint256 => mapping(address => Grant)) private grants;    // objectId => subject => grant
    mapping(uint256 => address[]) private grantees;                  // objectId => list of subjects ever granted
    mapping(uint256 => mapping(address => bool)) private hasBeenGranted; // objectId => subject => ever appended to grantees[]
    // ^ O(1) duplicate check for the grantees[] append below. Earlier version of this
    // contract scanned the full grantees[] array on every grantAccess call to avoid
    // duplicate entries — that made each grant cost O(n) gas (n = existing grantee
    // count), so granting access to n total subjects cost O(n^2) cumulative gas.
    // Measured before fix: grant #1 cost 101,440 gas, grant #100 cost 321,537 gas
    // (3.2x). This mapping makes every grantAccess call O(1) regardless of how many
    // grantees an object already has.

    event ObjectRegistered(uint256 indexed objectId, address indexed owner, bytes32 contentHash, uint256 timestamp);
    event AccessGranted(uint256 indexed objectId, address indexed owner, address indexed subject, Permission permission, uint256 expiresAt);
    event AccessRevoked(uint256 indexed objectId, address indexed owner, address indexed subject);
    event AccessChecked(uint256 indexed objectId, address indexed subject, bool granted);

    modifier onlyOwner(uint256 objectId) {
        require(objects[objectId].exists, "BDCSAC: object does not exist");
        require(objects[objectId].owner == msg.sender, "BDCSAC: caller is not owner");
        _;
    }

    /**
     * @notice Register a new storage object on-chain.
     * @param contentHash keccak256 hash (or CID-derived hash) of the encrypted object.
     * @return objectId the newly assigned object identifier.
     */
    function registerObject(bytes32 contentHash) external returns (uint256 objectId) {
        objectId = ++objectCounter;
        objects[objectId] = ObjectRecord({
            owner: msg.sender,
            contentHash: contentHash,
            registeredAt: block.timestamp,
            exists: true
        });
        emit ObjectRegistered(objectId, msg.sender, contentHash, block.timestamp);
    }

    /**
     * @notice Grant a subject a permission level on an object, with optional expiry.
     * @param objectId the object to grant access to.
     * @param subject the address receiving access.
     * @param permission the permission level (READ/WRITE/ADMIN).
     * @param expiresAt unix timestamp after which the grant is no longer valid (0 = never).
     */
    function grantAccess(
        uint256 objectId,
        address subject,
        Permission permission,
        uint256 expiresAt
    ) external onlyOwner(objectId) {
        require(subject != address(0), "BDCSAC: invalid subject");
        require(permission != Permission.NONE, "BDCSAC: use revokeAccess to remove access");

        if (!hasBeenGranted[objectId][subject]) {
            grantees[objectId].push(subject);
            hasBeenGranted[objectId][subject] = true;
        }

        grants[objectId][subject] = Grant({
            permission: permission,
            expiresAt: expiresAt,
            revoked: false
        });

        emit AccessGranted(objectId, msg.sender, subject, permission, expiresAt);
    }

    /**
     * @notice Revoke a previously granted access right.
     */
    function revokeAccess(uint256 objectId, address subject) external onlyOwner(objectId) {
        require(grants[objectId][subject].permission != Permission.NONE, "BDCSAC: no active grant");
        grants[objectId][subject].revoked = true;
        grants[objectId][subject].permission = Permission.NONE;
        emit AccessRevoked(objectId, msg.sender, subject);
    }

    /**
     * @notice View-only access check (no event, no gas cost off-chain via .call).
     */
    function hasAccess(uint256 objectId, address subject, Permission required) public view returns (bool) {
        if (!objects[objectId].exists) return false;
        if (objects[objectId].owner == subject) return true; // owner always has full access

        Grant memory g = grants[objectId][subject];
        if (g.revoked || g.permission == Permission.NONE) return false;
        if (g.expiresAt != 0 && g.expiresAt < block.timestamp) return false;
        return uint8(g.permission) >= uint8(required);
    }

    /**
     * @notice State-changing access check that emits an auditable on-chain event.
     *         This is the function a storage gateway would call before serving
     *         a decryption capability — gives an immutable audit trail.
     */
    function checkAccess(uint256 objectId, Permission required) external returns (bool granted) {
        granted = hasAccess(objectId, msg.sender, required);
        emit AccessChecked(objectId, msg.sender, granted);
        return granted;
    }

    function getObject(uint256 objectId) external view returns (address owner, bytes32 contentHash, uint256 registeredAt) {
        require(objects[objectId].exists, "BDCSAC: object does not exist");
        ObjectRecord memory o = objects[objectId];
        return (o.owner, o.contentHash, o.registeredAt);
    }

    function getGrant(uint256 objectId, address subject) external view returns (Permission permission, uint256 expiresAt, bool revoked) {
        Grant memory g = grants[objectId][subject];
        return (g.permission, g.expiresAt, g.revoked);
    }

    function getGrantees(uint256 objectId) external view returns (address[] memory) {
        return grantees[objectId];
    }

    function totalObjects() external view returns (uint256) {
        return objectCounter;
    }
}
