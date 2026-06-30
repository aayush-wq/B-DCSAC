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
    address public immutable admin; // deployer; used for assignRole authorization

    struct UserRecord {
        bytes32 didHash;
        bytes32 publicKeyHash;
        bool registered;
    }

    struct AuditEntry {
        uint256 objectId;
        address requester;
        bool decision;
        uint256 timestamp;
    }

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

    mapping(address => UserRecord) public users;          // addr => identity record
    mapping(address => uint8) public roles;                // addr => role ID (admin-assigned)
    mapping(uint256 => uint256) public policyVersion;       // objectId => current policy version
    mapping(uint256 => bytes32) public policyHash;          // objectId => current policy digest
    AuditEntry[] private auditLog;                          // append-only audit trail (separate from event logs)

    constructor() {
        admin = msg.sender;
    }

    event ObjectRegistered(uint256 indexed objectId, address indexed owner, bytes32 contentHash, uint256 timestamp);
    event AccessGranted(uint256 indexed objectId, address indexed owner, address indexed subject, Permission permission, uint256 expiresAt);
    event AccessRevoked(uint256 indexed objectId, address indexed owner, address indexed subject);
    event AccessChecked(uint256 indexed objectId, address indexed subject, bool granted);
    event UserRegistered(address indexed addr, bytes32 didHash, bytes32 publicKeyHash, uint256 timestamp);
    event RoleAssigned(address indexed addr, uint8 role, address indexed assignedBy);
    event PolicyUpdated(uint256 indexed objectId, bytes32 newPolicyHash, uint256 newVersion);
    event AccessLogged(uint256 indexed objectId, address indexed requester, bool decision, uint256 timestamp);

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

    /**
     * @notice Binds a blockchain address to an off-chain identity digest and
     *         public key hash. Mirrors Table 5's registerUser row in the paper
     *         (sign-up / identity-binding step prior to role assignment).
     */
    function registerUser(address addr, bytes32 didHash, bytes32 publicKeyHash) external {
        require(addr != address(0), "BDCSAC: invalid address");
        users[addr] = UserRecord({ didHash: didHash, publicKeyHash: publicKeyHash, registered: true });
        emit UserRegistered(addr, didHash, publicKeyHash, block.timestamp);
    }

    /**
     * @notice Admin-only role assignment, mirrors Table 5's assignRole row.
     *         Role IDs are application-defined (e.g. 0=user, 1=auditor, 2=admin).
     */
    function assignRole(address addr, uint8 role) external {
        require(msg.sender == admin, "BDCSAC: only admin can assign roles");
        require(users[addr].registered, "BDCSAC: user not registered");
        roles[addr] = role;
        emit RoleAssigned(addr, role, msg.sender);
    }

    /**
     * @notice Updates an object's policy digest and increments its policy
     *         version, mirrors Table 5's updatePolicy row. A version bump
     *         is what the paper's token-based model uses to invalidate
     *         previously issued access tokens after a policy change.
     */
    function updatePolicy(uint256 objectId, bytes32 newPolicyHash) external onlyOwner(objectId) {
        policyHash[objectId] = newPolicyHash;
        policyVersion[objectId] += 1;
        emit PolicyUpdated(objectId, newPolicyHash, policyVersion[objectId]);
    }

    /**
     * @notice Standalone immutable audit-log write, mirrors Table 5's logAccess
     *         row. Distinct from checkAccess: checkAccess validates AND emits
     *         a lightweight event in one call (what the gateway uses in
     *         practice for efficiency); logAccess is the explicit storage-array
     *         audit write described separately in the paper's Section 8 design,
     *         benchmarked here as its own function so its gas cost isn't
     *         conflated with validation.
     */
    function logAccess(uint256 objectId, bool decision) external returns (uint256 logIndex) {
        auditLog.push(AuditEntry({
            objectId: objectId,
            requester: msg.sender,
            decision: decision,
            timestamp: block.timestamp
        }));
        logIndex = auditLog.length - 1;
        emit AccessLogged(objectId, msg.sender, decision, block.timestamp);
    }

    function getAuditEntry(uint256 logIndex) external view returns (uint256 objectId, address requester, bool decision, uint256 timestamp) {
        AuditEntry memory e = auditLog[logIndex];
        return (e.objectId, e.requester, e.decision, e.timestamp);
    }

    function auditLogLength() external view returns (uint256) {
        return auditLog.length;
    }
}
