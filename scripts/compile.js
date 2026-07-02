const fs = require("fs");
const path = require("path");
const solc = require("solc");

const sourcePath = path.join(__dirname, "..", "contracts", "BDCSAC_AccessControl.sol");
const source = fs.readFileSync(sourcePath, "utf8");

const input = {
  language: "Solidity",
  sources: {
    "BDCSAC_AccessControl.sol": {
      content: source,
    },
  },
  settings: {
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode.object"],
      },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));

const contractName = "BDCSAC_AccessControl";
const compiled = output.contracts["BDCSAC_AccessControl.sol"][contractName];

const buildDir = path.join(__dirname, "..", "build");
if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true });

const outPath = path.join(buildDir, "BDCSAC_AccessControl.json");
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      contractName,
      abi: compiled.abi,
      bytecode: compiled.evm.bytecode.object,
    },
    null,
    2
  )
);

console.log("Compiled successfully:", outPath);
