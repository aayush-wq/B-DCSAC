// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract BDCSAC_AccessControl {
    enum Permission { NONE, READ, WRITE, ADMIN }

    struct ObjectRecord {
        address owner;
        bytes32 cidHash;
        bytes32 contentHash;
        bytes32 policyHash;
        bytes32 keyRef;
        uint256 registeredAt;
        bool exists;
    }

    struct Grant {
        Permission permission;
        uint256 expiresAt;
        bool revoked;
    }

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

    struct TokenRecord {
        uint256 objectId;
        address subject;
        Permission permission;
        bytes32 nonce;
        uint256 issuedAt;
        uint256 expiresAt;
        uint256 policyVersionAtIssuance;
        bool consumed;
        bool revoked;
    }

    uint256 private objectCounter;
    uint256 private tokenCounter;
    address public immutable admin;

    mapping(uint256 => ObjectRecord) public objects;
    mapping(uint256 => mapping(address => Grant)) private grants;
    mapping(uint256 => address[]) private grantees;
    mapping(uint256 => mapping(address => bool)) private hasBeenGranted;

    mapping(address => UserRecord) public users;
    mapping(address => uint8) public roles;
    mapping(uint256 => uint256) public policyVersion;
    mapping(uint256 => bytes32) public policyHash;
    AuditEntry[] private auditLog;

    mapping(uint256 => TokenRecord) public tokens;
    mapping(bytes32 => bool) private usedNonces;

    constructor() {
        admin = msg.sender;
    }

    event ObjectRegistered(uint256 indexed objectId, address indexed owner, bytes32 cidHash, bytes32 contentHash, bytes32 policyHash, bytes32 keyRef, uint256 timestamp);
    event PermissionGranted(uint256 indexed objectId, address indexed owner, address indexed subject, Permission permission, uint256 expiresAt);
    event PermissionRevoked(uint256 indexed objectId, address indexed owner, address indexed subject);
    event AccessValidated(uint256 indexed objectId, address indexed subject);
    event AccessDenied(uint256 indexed objectId, address indexed subject);
    event UserRegistered(address indexed addr, bytes32 didHash, bytes32 publicKeyHash, uint256 timestamp);
    event RoleAssigned(address indexed addr, uint8 role, address indexed assignedBy);
    event PolicyUpdated(uint256 indexed objectId, bytes32 newPolicyHash, uint256 newVersion);
    event AccessLogged(uint256 indexed objectId, address indexed requester, bool decision, uint256 timestamp);
    event TokenIssued(uint256 indexed tokenId, uint256 indexed objectId, address indexed subject, Permission permission, bytes32 nonce, uint256 expiresAt);
    event TokenConsumed(uint256 indexed tokenId, uint256 indexed objectId, address indexed subject);
    event TokenRevoked(uint256 indexed tokenId, address indexed revokedBy);

    modifier onlyOwner(uint256 objectId) {
        require(objects[objectId].exists, "BDCSAC: object does not exist");
        require(objects[objectId].owner == msg.sender, "BDCSAC: caller is not owner");
        _;
    }

    function registerObject(
        bytes32 cidHash,
        bytes32 contentHash,
        bytes32 initialPolicyHash,
        bytes32 keyRef
    ) external returns (uint256 objectId) {
        objectId = ++objectCounter;
        objects[objectId] = ObjectRecord({
            owner: msg.sender,
            cidHash: cidHash,
            contentHash: contentHash,
            policyHash: initialPolicyHash,
            keyRef: keyRef,
            registeredAt: block.timestamp,
            exists: true
        });
        policyHash[objectId] = initialPolicyHash;
        emit ObjectRegistered(objectId, msg.sender, cidHash, contentHash, initialPolicyHash, keyRef, block.timestamp);
    }

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

        emit PermissionGranted(objectId, msg.sender, subject, permission, expiresAt);
    }

    function revokeAccess(uint256 objectId, address subject) external onlyOwner(objectId) {
        require(grants[objectId][subject].permission != Permission.NONE, "BDCSAC: no active grant");
        grants[objectId][subject].revoked = true;
        grants[objectId][subject].permission = Permission.NONE;
        emit PermissionRevoked(objectId, msg.sender, subject);
    }

    function hasAccess(uint256 objectId, address subject, Permission required) public view returns (bool) {
        if (!objects[objectId].exists) return false;
        if (objects[objectId].owner == subject) return true;

        Grant memory g = grants[objectId][subject];
        if (g.revoked || g.permission == Permission.NONE) return false;
        if (g.expiresAt != 0 && g.expiresAt < block.timestamp) return false;
        return uint8(g.permission) >= uint8(required);
    }

    function checkAccess(uint256 objectId, Permission required) external returns (bool granted) {
        granted = hasAccess(objectId, msg.sender, required);
        if (granted) {
            emit AccessValidated(objectId, msg.sender);
        } else {
            emit AccessDenied(objectId, msg.sender);
        }
        return granted;
    }

    function getObject(uint256 objectId) external view returns (address owner, bytes32 cidHash, bytes32 contentHash, bytes32 objPolicyHash, bytes32 keyRef, uint256 registeredAt) {
        require(objects[objectId].exists, "BDCSAC: object does not exist");
        ObjectRecord memory o = objects[objectId];
        return (o.owner, o.cidHash, o.contentHash, o.policyHash, o.keyRef, o.registeredAt);
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

    function registerUser(address addr, bytes32 didHash, bytes32 publicKeyHash) external {
        require(addr != address(0), "BDCSAC: invalid address");
        users[addr] = UserRecord({ didHash: didHash, publicKeyHash: publicKeyHash, registered: true });
        emit UserRegistered(addr, didHash, publicKeyHash, block.timestamp);
    }

    function assignRole(address addr, uint8 role) external {
        require(msg.sender == admin, "BDCSAC: only admin can assign roles");
        require(users[addr].registered, "BDCSAC: user not registered");
        roles[addr] = role;
        emit RoleAssigned(addr, role, msg.sender);
    }

    function updatePolicy(uint256 objectId, bytes32 newPolicyHash) external onlyOwner(objectId) {
        policyHash[objectId] = newPolicyHash;
        policyVersion[objectId] += 1;
        emit PolicyUpdated(objectId, newPolicyHash, policyVersion[objectId]);
    }

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

    function issueToken(
        uint256 objectId,
        address subject,
        Permission permission,
        bytes32 nonce,
        uint256 expiresAt
    ) external onlyOwner(objectId) returns (uint256 tokenId) {
        require(subject != address(0), "BDCSAC: invalid subject");
        require(permission != Permission.NONE, "BDCSAC: invalid permission");
        require(!usedNonces[nonce], "BDCSAC: nonce already used");
        require(expiresAt > block.timestamp, "BDCSAC: expiry must be in the future");

        usedNonces[nonce] = true;
        tokenId = ++tokenCounter;

        tokens[tokenId] = TokenRecord({
            objectId: objectId,
            subject: subject,
            permission: permission,
            nonce: nonce,
            issuedAt: block.timestamp,
            expiresAt: expiresAt,
            policyVersionAtIssuance: policyVersion[objectId],
            consumed: false,
            revoked: false
        });

        emit TokenIssued(tokenId, objectId, subject, permission, nonce, expiresAt);
    }

    function consumeToken(uint256 tokenId) external returns (bool granted) {
        TokenRecord storage t = tokens[tokenId];
        require(t.issuedAt != 0, "BDCSAC: token does not exist");
        require(t.subject == msg.sender, "BDCSAC: caller is not the token subject");
        require(!t.consumed, "BDCSAC: token already consumed");
        require(!t.revoked, "BDCSAC: token has been revoked");
        require(t.expiresAt >= block.timestamp, "BDCSAC: token expired");
        require(
            t.policyVersionAtIssuance == policyVersion[t.objectId],
            "BDCSAC: policy changed after token was issued"
        );

        t.consumed = true;
        emit TokenConsumed(tokenId, t.objectId, msg.sender);
        emit AccessValidated(t.objectId, msg.sender);
        return true;
    }

    function revokeToken(uint256 tokenId) external {
        TokenRecord storage t = tokens[tokenId];
        require(t.issuedAt != 0, "BDCSAC: token does not exist");
        require(
            objects[t.objectId].owner == msg.sender || msg.sender == admin,
            "BDCSAC: only object owner or admin can revoke tokens"
        );
        require(!t.consumed, "BDCSAC: cannot revoke consumed token");
        t.revoked = true;
        emit TokenRevoked(tokenId, msg.sender);
    }

    function isTokenValid(uint256 tokenId, address subject) external view returns (bool) {
        TokenRecord memory t = tokens[tokenId];
        if (t.issuedAt == 0) return false;
        if (t.subject != subject) return false;
        if (t.consumed) return false;
        if (t.revoked) return false;
        if (t.expiresAt < block.timestamp) return false;
        if (t.policyVersionAtIssuance != policyVersion[t.objectId]) return false;
        return true;
    }

    function totalTokens() external view returns (uint256) {
        return tokenCounter;
    }
}
