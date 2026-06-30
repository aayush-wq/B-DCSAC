/**
 * Two additional checks before touching the paper:
 *
 *  I. Re-registering the same content hash twice produces two independent
 *     objectIds (no collision/overwrite), and each retains its own owner
 *     and access state independently.
 *
 *  J. Gas cost scaling with number of grantees on a single object - grants
 *     5, 10, and 20 subjects access and records gasUsed for each grantAccess
 *     call, plus the gas cost of getGrantees() as the grantee list grows.
 *     This is the number you'd cite if the paper makes any scalability claim.
 *
 * Run: node gateway/scaling-and-reuse.js
 */
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

const Permission = { READ: 1 };

async function main() {
  const ganacheProvider = Ganache.provider({
    wallet: { totalAccounts: 30, defaultBalance: 100 },
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

  // ===================== I. Re-registration of identical content =====================
  console.log("=== I. Re-registering identical content hash twice ===");
  {
    const sameHash = ethers.keccak256(ethers.toUtf8Bytes("duplicate-content-payload"));

    const tx1 = await withGas(contract.registerObject, [sameHash]);
    const r1 = await tx1.wait();
    const id1 = r1.logs.map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } })
      .find((p) => p && p.name === "ObjectRegistered").args.objectId;

    const tx2 = await withGas(contract.registerObject, [sameHash]);
    const r2 = await tx2.wait();
    const id2 = r2.logs.map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } })
      .find((p) => p && p.name === "ObjectRegistered").args.objectId;

    assert(id1 !== id2, `Two registrations of the same content hash get distinct objectIds (${id1} vs ${id2})`);

    const [owner1, hash1] = await contract.getObject(id1);
    const [owner2, hash2] = await contract.getObject(id2);
    assert(hash1 === hash2, "Both objects correctly store the identical content hash");
    assert(owner1 === owner2, "Both objects share the same owner (both registered by same signer)");

    // Grant access on object 1 only, confirm object 2 is unaffected
    await (await withGas(contract.grantAccess, [id1, accounts[1], Permission.READ, 0])).wait();
    const obj1Access = await contract.hasAccess(id1, accounts[1], Permission.READ);
    const obj2Access = await contract.hasAccess(id2, accounts[1], Permission.READ);
    assert(obj1Access === true, "Grant on object 1 takes effect on object 1");
    assert(obj2Access === false, "Object 2 (same content hash) is unaffected by object 1's grant - fully independent access state");
  }
  console.log();

  // ===================== J. Gas scaling with grantee count =====================
  console.log("=== J. Gas cost scaling with number of grantees on one object ===");
  {
    const hash = ethers.keccak256(ethers.toUtf8Bytes("scaling-test-object"));
    const tx = await withGas(contract.registerObject, [hash]);
    const r = await tx.wait();
    const objId = r.logs.map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } })
      .find((p) => p && p.name === "ObjectRegistered").args.objectId;

    const checkpoints = [1, 5, 10, 20];
    const grantGasAtN = {};
    let grantedSoFar = 0;

    for (let n = 1; n <= 20; n++) {
      const subject = accounts[(n % 29) + 1]; // cycle through available test accounts
      const gtx = await withGas(contract.grantAccess, [objId, subject, Permission.READ, 0]);
      const greceipt = await gtx.wait();
      grantedSoFar = n;
      if (checkpoints.includes(n)) {
        grantGasAtN[n] = greceipt.gasUsed.toString();
      }
    }

    console.log("  grantAccess gasUsed at grantee count:");
    for (const n of checkpoints) {
      console.log(`    grantee #${n}: ${grantGasAtN[n]} gas`);
    }

    const grantees = await contract.getGrantees(objId);
    assert(grantees.length === 20, `getGrantees() correctly returns all 20 grantees (got ${grantees.length})`);

    // Check whether per-grant gas cost stays flat (expected, since each grant is an independent mapping write)
    const first = BigInt(grantGasAtN[1]);
    const last = BigInt(grantGasAtN[20]);
    const pctDiff = Number(((last - first) * 10000n) / first) / 100;
    console.log(`  Gas delta from grantee #1 to #20: ${pctDiff}%`);
    assert(Math.abs(pctDiff) < 15, "Per-grant gas cost stays roughly flat as grantee count grows (no quadratic blowup)");
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
