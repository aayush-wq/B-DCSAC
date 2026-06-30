const fs = require("fs");
const path = require("path");
const solc = require("solc");

const contractPath = path.join(__dirname, "..", "contracts", "BDCSAC_AccessControl.sol");
const source = fs.readFileSync(contractPath, "utf8");

const input = {
  language: "Solidity",
  sources: {
    "BDCSAC_AccessControl.sol": { content: source },
  },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: {
      "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));

if (output.errors) {
  const fatal = output.errors.filter((e) => e.severity === "error");
  output.errors.forEach((e) => console.log(e.formattedMessage));
  if (fatal.length) process.exit(1);
}

const contract = output.contracts["BDCSAC_AccessControl.sol"]["BDCSAC_AccessControl"];

const artifact = {
  abi: contract.abi,
  bytecode: "0x" + contract.evm.bytecode.object,
};

const outDir = path.join(__dirname, "..", "build");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "BDCSAC_AccessControl.json"), JSON.stringify(artifact, null, 2));

console.log("Compiled OK. ABI functions:", contract.abi.filter((x) => x.type === "function").map((x) => x.name));
console.log("Bytecode length (bytes):", (contract.evm.bytecode.object.length / 2));
console.log("Artifact written to build/BDCSAC_AccessControl.json");
