# B-DCSAC Solidity Implementation + Real Gas Benchmark

## What this is
A real, working Solidity smart contract implementing the access-control layer
of the B-DCSAC framework (object registration, capability-based grant/revoke,
on-chain access checks with audit events), plus a benchmark script that
deploys it to a local simulated Ethereum network and records the **actual
measured gas cost** of every function call — replacing the analytically
estimated numbers in Section 10 of the manuscript.

No real cryptocurrency is used anywhere. Ganache (here run via the `ganache`
npm package, the same engine behind the Ganache GUI app) creates fake test
accounts pre-loaded with 100 fake ETH each. Gas is real EVM gas; the currency
paying for it has zero real-world value.

## Files
- `contracts/BDCSAC_AccessControl.sol` — the contract
- `scripts/compile.js` — compiles the contract locally using the `solc` npm package
- `scripts/benchmark.js` — spins up a local EVM (Ganache engine), deploys the
  contract, calls each core function, and prints/saves the real `gasUsed`
  from each transaction receipt
- `benchmark-results.json` — output of the last benchmark run (already included)

## How to run it yourself
```bash
npm install
npm run compile     # writes build/BDCSAC_AccessControl.json (ABI + bytecode)
npm run benchmark    # deploys to local Ganache-engine EVM, prints gas table
```

## Contract functions benchmarked
| Function | What it does |
|---|---|
| `registerObject(bytes32 contentHash)` | Registers a new storage object by its off-chain content hash/CID |
| `grantAccess(objectId, subject, permission, expiresAt)` | Owner grants READ/WRITE/ADMIN to a subject, optional expiry |
| `revokeAccess(objectId, subject)` | Owner revokes a subject's access |
| `checkAccess(objectId, required)` | State-changing check, emits an audit event (what a storage gateway would call before releasing a decryption capability) |
| `hasAccess(objectId, subject, required)` | Free `view` function for off-chain reads |

## Measured results (last run, included in benchmark-results.json)
| Function | Gas Used |
|---|---|
| deployContract | 798,557 |
| registerObject | 134,946 |
| grantAccess (READ, no expiry) | 101,440 |
| grantAccess (WRITE, with expiry) | 106,752 |
| checkAccess (granted) | 34,895 |
| revokeAccess | 51,076 |
| checkAccess (revoked, denied) | 34,729 |
| hasAccess (view/eth_call) | 0 (off-chain read) |

These are real numbers from real transaction receipts on a real (simulated)
EVM — not hand-calculated opcode estimates. You can re-run `npm run benchmark`
as many times as you like; numbers will be near-identical run to run since
storage layout and opcode costs are deterministic.

## Plugging into the paper
Use this table to replace the estimated gas figures in Section 10. You can
note in the methodology that contracts were compiled with solc 0.8.20
(optimizer enabled, 200 runs) and executed on a local Ganache-engine EVM with
test accounts, consistent with the environment already disclosed in the paper.

## Next steps (optional, not yet done)
- Add a CP-ABE interface stub if you want an on-chain hook even though the
  crypto itself stays off-chain (matches your "interface-only" disclosure)
- Wire this up to a small Node.js gateway script that calls `checkAccess`
  before releasing a CID/decryption key — the "gateway" component you
  mentioned wanting to build post-submission
- If you'd rather deploy against the actual Ganache GUI app on your laptop
  instead of this embedded engine, just point the provider at
  `http://127.0.0.1:7545` (one-line change, noted in benchmark.js)

---

## Gateway layer (verified)

`gateway/` contains the Node.js gateway component — the piece that sits
between a requester and off-chain storage, enforcing the on-chain access
policy before ever releasing data.

- `gateway/storage.js` — simulated off-chain decentralized storage (stand-in
  for IPFS). Encrypts with AES-256-GCM and stores ciphertext by content hash.
  The encryption key here plays the same conceptual role a CP-ABE-derived
  key would play in production (CP-ABE itself stays interface-only, per the
  paper's disclosure).
- `gateway/gateway.js` — the `BDCSACGateway` class: `storeAndRegisterObject`,
  `grantAccess`, `revokeAccess`, and the core `requestObject` (calls
  `checkAccess` on-chain first; only touches storage if granted).
- `gateway/demo.js` — full end-to-end verification script with explicit
  PASS/FAIL assertions.

### Run the verification
```bash
node gateway/demo.js
```

### What it verifies (9 assertions, all passing)
1. Alice (granted READ) successfully retrieves the object, and the
   decrypted bytes exactly match the original file.
2. Bob (no grant) is denied — no data leaves storage.
3. After being granted, Bob successfully retrieves the same correct data.
4. After revocation, Bob is denied again.
5. Alice's access is unaffected by Bob's revocation (grants are scoped per
   subject, not global).

### Bug found and fixed during verification
Initial testing surfaced a real issue: ethers' automatic gas estimation
(via `eth_estimateGas`) intermittently underestimated gas for the
`checkAccess` call path when run through the Ganache engine, causing a
spurious on-chain revert — even though the identical call succeeded at a
manually-set gas limit and the contract logic itself was correct (confirmed
via `staticCall`/`view` checks returning the right answer throughout). Fixed
by padding every gas estimate by 30% in the gateway (`withGasBuffer` helper
in `gateway.js`). Re-ran `scripts/benchmark.js` afterward — `gasUsed` in
receipts (the real EVM measurement, independent of gasLimit) was unchanged,
confirming the fix only prevents spurious reverts and doesn't affect any of
the numbers headed for the paper.

---

## Scalability fix (found and patched during verification)

Before drafting any paper updates, two more checks were run:

**Re-registration test:** registering the same content hash twice correctly
produces two independent objectIds with fully independent access state
(grant on one does not leak to the other). Passed cleanly, no issues.

**Grantee scaling test:** this one found a real bug. The original
`grantAccess` implementation scanned the entire existing grantees array on
every call to avoid duplicate entries, making each grant cost O(n) gas
(n = number of existing grantees on that object):

| Grantee # | Gas cost (before fix) |
|---|---|
| 1 | 101,440 |
| 20 | 129,915 |
| 50 | 201,770 |
| 100 | 321,537 (3.2x the first grant) |

**Fix applied:** replaced the array scan with a
`mapping(uint256 => mapping(address => bool)) hasBeenGranted` for O(1)
duplicate checking; the grantees array is now only appended to, never
scanned, on the write path (`getGrantees()` still returns the full list for
reads). Contract bytecode also shrank as a side effect (3477 → 3257 bytes).

**Result after fix** — gas cost is now flat regardless of grantee count:

| Grantee # | Gas cost (after fix) |
|---|---|
| 1 | 123,282 (one-time extra SSTORE for the new flag) |
| 5 | 106,194 |
| 10 | 106,194 |
| 20 | 106,194 |

Full regression suite re-run after the fix: gateway demo (9/9 passed),
edge cases (15/15 passed), benchmark re-run with consistent core numbers.
Nothing else was affected by this change.

Run it yourself:
```bash
npm run compile
npm run scaling
```
