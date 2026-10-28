const fs = require("fs");
const path = require("path");

function isSourceCheckout(rootDir) {
  return fs.existsSync(path.join(rootDir, ".git"));
}

function getNpmInstallModeArgs(rootDir) {
  return isSourceCheckout(rootDir) ? ["--include=dev"] : ["--omit=dev", "--package-lock=false"];
}

function getRuntimeDependencyRepairArgs(rootDir, missingSpecs) {
  return [...getNpmInstallModeArgs(rootDir), ...(isSourceCheckout(rootDir) ? [] : missingSpecs)];
}

function listMissingRuntimeDependencies(rootDir) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
  } catch {
    return [];
  }
  const missing = [];
  for (const [name, version] of Object.entries(pkg.dependencies || {})) {
    if (name.startsWith("@types/")) continue;
    try {
      require.resolve(name, { paths: [rootDir] });
    } catch (error) {
      // Import-only packages intentionally have no CommonJS root export. Node found
      // their package metadata, so reinstalling them cannot repair this resolution mode.
      if (error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED") continue;
      missing.push({ name, version });
    }
  }
  return missing;
}

module.exports = {
  listMissingRuntimeDependencies,
  getNpmInstallModeArgs,
  getRuntimeDependencyRepairArgs,
  isSourceCheckout,
};
