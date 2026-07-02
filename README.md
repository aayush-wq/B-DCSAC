# B-DCSAC

Blockchain-based decentralized cloud storage with smart contract access control.

## Overview

This repository contains the Solidity smart contract and Node.js implementation for a decentralized access control system built on Ethereum. The system manages object registration, user identity, role assignment, permission grants, revocations, policy updates, token-based one-time access, and on-chain audit logging.

## Requirements

- Node.js v18 or higher
- npm

No additional tools required. The Ganache Ethereum simulator runs locally via the npm package — no real cryptocurrency or external network access needed.

## Installation

```bash
npm install
```

## Project Structure

```
contracts/
  BDCSAC_AccessControl.sol   - Solidity smart contract
scripts/
  compile.js                 - Compiles the contract using local solc
  benchmark.js               - Gas costs for core functions
  benchmark-extended.js      - Gas costs for user/role/policy/audit functions
  benchmark-token.js         - Gas costs for token model functions
gateway/
  storage.js                 - Off-chain encrypted object storage
  gateway.js                 - Access control gateway
  demo.js                    - End-to-end lifecycle test
  edge-cases.js              - Boundary and security condition tests
  edge-cases-extended.js     - User, role, policy, and audit tests
  edge-cases-token.js        - Token model security tests
  scaling-and-reuse.js       - Scaling and reuse tests
```

## Usage

### Compile
```bash
npm run compile
```

### Benchmarks
```bash
npm run benchmark
npm run benchmark-extended
npm run benchmark-token
```

### Tests
```bash
npm run demo
npm run edge-cases
npm run edge-cases-extended
npm run edge-cases-token
npm run scaling
```

## Smart Contract Functions

### Access Control
| Function | Description |
|---|---|
| `registerObject(cidHash, contentHash, policyHash, keyRef)` | Registers a storage object |
| `grantAccess(objectId, subject, permission, expiresAt)` | Grants READ/WRITE/ADMIN permission |
| `checkAccess(objectId, permission)` | Validates grant-based access, emits audit event |
| `revokeAccess(objectId, subject)` | Revokes a subject's permission |
| `hasAccess(objectId, subject, permission)` | View-only access check |

### Token Model
| Function | Description |
|---|---|
| `issueToken(objectId, subject, permission, nonce, expiresAt)` | Owner issues a one-time access token |
| `consumeToken(tokenId)` | Subject consumes the token for single-use access |
| `revokeToken(tokenId)` | Owner or admin revokes an unconsumed token |
| `isTokenValid(tokenId, subject)` | View-only token validity check |

### Identity and Policy
| Function | Description |
|---|---|
| `registerUser(addr, didHash, pubKeyHash)` | Registers a user identity |
| `assignRole(addr, role)` | Admin assigns a role to a registered user |
| `updatePolicy(objectId, newPolicyHash)` | Updates policy and increments version, invalidating outstanding tokens |
| `logAccess(objectId, decision)` | Writes an entry to the on-chain audit log |

## Events

| Event | Emitted by |
|---|---|
| `ObjectRegistered` | registerObject |
| `PermissionGranted` | grantAccess |
| `PermissionRevoked` | revokeAccess |
| `AccessValidated` | checkAccess (granted), consumeToken (success) |
| `AccessDenied` | checkAccess (denied) |
| `TokenIssued` | issueToken |
| `TokenConsumed` | consumeToken |
| `TokenRevoked` | revokeToken |
| `UserRegistered` | registerUser |
| `RoleAssigned` | assignRole |
| `PolicyUpdated` | updatePolicy |
| `AccessLogged` | logAccess |

## License

MIT
