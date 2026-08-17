const fs = require("fs");
const path = require("path");

function isSourceCheckout(rootDir) {
  return fs.existsSync(path.join(rootDir, ".git"));
}

function getNpmInstallModeArgs(rootDir) {
  return isSourceCheckout(rootDir)
    ? ["--include=dev"]
    : ["--omit=dev", "--package-lock=false"];
}

function getRuntimeDependencyRepairArgs(rootDir, missingSpecs) {
  return [
    ...getNpmInstallModeArgs(rootDir),
    ...(isSourceCheckout(rootDir) ? [] : missingSpecs),
  ];
}

module.exports = {
  getNpmInstallModeArgs,
  getRuntimeDependencyRepairArgs,
  isSourceCheckout,
};
