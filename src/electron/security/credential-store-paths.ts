/**
 * Credential and personal-data stores in the home folder, relative to it.
 *
 * One list for every boundary: the macOS shell sandbox denies these for read
 * and write after its grants, and the workspace file evaluator refuses them,
 * so a workspace that contains one (the home folder, say) does not open it.
 * Only a grant made on the store itself, or on a folder inside it, does.
 */
export const HOME_CREDENTIAL_STORE_PATHS: readonly string[] = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".config/gcloud",
  ".config/gh",
  ".config/hub",
  ".config/op",
  ".config/git/credentials",
  ".docker",
  ".kube",
  ".netrc",
  ".git-credentials",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pypirc",
  ".cargo/credentials",
  ".cargo/credentials.toml",
  ".gradle/gradle.properties",
  ".m2/settings.xml",
  ".m2/settings-security.xml",
  ".vault-token",
  ".password-store",
  ".terraform.d",
  ".cache/huggingface",
  ".local/share/keyrings",
  "Library/Keychains",
  "Library/Cookies",
  "Library/Messages",
  "Library/Mail",
  "Library/Safari",
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/Chromium",
  "Library/Application Support/BraveSoftware",
  "Library/Application Support/Microsoft Edge",
  "Library/Application Support/Firefox",
  "Library/Application Support/Arc",
  "Library/Application Support/com.apple.TCC",
];
