#!/usr/bin/env bash
#
# CoWork OS macOS installer.
#
# Installs the released desktop app without the Gatekeeper "Apple could not
# verify ... is free of malware" dialog, and without needing an Apple Developer
# account on the release side.
#
# Why this works: CoWork OS release builds are ad hoc signed, not notarized, so
# macOS refuses to open a copy that carries the com.apple.quarantine extended
# attribute (on macOS 15 and later the dialog has no "Open" button at all).
# Browsers add that attribute to every download. curl does not, and
# `ditto --noqtn` never propagates it, so an app installed through this script
# launches like any locally built app. Nothing here changes Gatekeeper settings
# or weakens checks for anything else on the Mac.
#
# Usage (one line):
#   curl -fsSL https://raw.githubusercontent.com/CoWork-OS/CoWork-OS/main/scripts/install-macos.sh | bash
#
# With options:
#   curl -fsSL https://raw.githubusercontent.com/CoWork-OS/CoWork-OS/main/scripts/install-macos.sh \
#     | bash -s -- --version 0.5.60 --install-dir "$HOME/Applications" --no-launch
#
# Or download it first, read it, then run it:
#   bash install-macos.sh
#
# What it does:
#   1. Checks the Mac: macOS version, Apple Silicon vs Intel, required tools.
#   2. Downloads the release's updater metadata (latest-mac.yml) and picks the
#      ZIP for this architecture.
#   3. Downloads the ZIP, verifies its SHA-512 against the metadata, extracts
#      it with `ditto --noqtn`, and verifies the app bundle's code signature
#      (`codesign --verify --deep --strict`), bundle identifier and version.
#   4. Copies the app into /Applications (or ~/Applications when /Applications
#      is not writable), replacing an older copy, then launches it.
#
# Re-run the same command to update. Settings and data live outside the app
# bundle and are kept.
#
# Keep the platform constants below in sync with src/shared/platform-support.json
# (scripts/release/install-macos.test.mjs checks that they match).
#
# Requires bash 3.2 (the /bin/bash that ships with macOS).

set -euo pipefail

APP_NAME="CoWork OS"
BUNDLE_ID="com.cowork-os.app"
DEFAULT_REPO="CoWork-OS/CoWork-OS"
MIN_MACOS_MAJOR=13
MIN_MACOS_LABEL="macOS 13 Ventura"
LAST_MONTEREY_VERSION="0.5.51"

# Options (flags override environment variables).
REPO="${COWORK_INSTALL_REPO:-$DEFAULT_REPO}"
REQUESTED_VERSION="${COWORK_INSTALL_VERSION:-}"
INSTALL_DIR="${COWORK_INSTALL_DIR:-}"
ARCHIVE_PATH="${COWORK_INSTALL_ARCHIVE:-}"
METADATA_PATH="${COWORK_INSTALL_METADATA:-}"
NO_LAUNCH="${COWORK_INSTALL_NO_LAUNCH:-0}"
ASSUME_YES="${COWORK_INSTALL_YES:-0}"
DRY_RUN=0
ARCH=""

# Results of parse_metadata.
MD_VERSION=""
MD_ASSET=""
MD_SHA512=""
MD_SIZE=""

TMP_DIR=""

log() { printf '[cowork-install] %s\n' "$*"; }
warn() { printf '[cowork-install] warning: %s\n' "$*" >&2; }
die() {
  printf '[cowork-install] error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<EOF
CoWork OS macOS installer

Usage:
  install-macos.sh [options]
  curl -fsSL https://raw.githubusercontent.com/$DEFAULT_REPO/main/scripts/install-macos.sh | bash -s -- [options]

Options:
  --version X.Y.Z      Install a specific release instead of the latest one.
  --install-dir DIR    Where to put "$APP_NAME.app". Default: /Applications,
                       or ~/Applications when /Applications is not writable.
  --no-launch          Do not open the app after installing.
  --yes                Quit a running copy of the app without asking.
  --dry-run            Resolve the release and print what would happen.
  --repo OWNER/NAME    GitHub repository to install from. Default: $DEFAULT_REPO.
  --archive PATH       Use an already downloaded release ZIP instead of downloading.
  --metadata PATH      Use a local latest-mac.yml instead of downloading it.
  -h, --help           Show this help.

Environment equivalents: COWORK_INSTALL_VERSION, COWORK_INSTALL_DIR,
COWORK_INSTALL_NO_LAUNCH=1, COWORK_INSTALL_YES=1, COWORK_INSTALL_REPO,
COWORK_INSTALL_ARCHIVE, COWORK_INSTALL_METADATA, COWORK_INSTALL_ARCH.

Re-run the installer to update. To uninstall, delete "$APP_NAME.app" from the
install directory; your data is stored outside the app bundle.
EOF
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --version)
        [ $# -ge 2 ] || die "--version needs a value"
        REQUESTED_VERSION="$2"
        shift 2
        ;;
      --version=*) REQUESTED_VERSION="${1#--version=}"; shift ;;
      --install-dir)
        [ $# -ge 2 ] || die "--install-dir needs a value"
        INSTALL_DIR="$2"
        shift 2
        ;;
      --install-dir=*) INSTALL_DIR="${1#--install-dir=}"; shift ;;
      --repo)
        [ $# -ge 2 ] || die "--repo needs a value"
        REPO="$2"
        shift 2
        ;;
      --repo=*) REPO="${1#--repo=}"; shift ;;
      --archive)
        [ $# -ge 2 ] || die "--archive needs a value"
        ARCHIVE_PATH="$2"
        shift 2
        ;;
      --archive=*) ARCHIVE_PATH="${1#--archive=}"; shift ;;
      --metadata)
        [ $# -ge 2 ] || die "--metadata needs a value"
        METADATA_PATH="$2"
        shift 2
        ;;
      --metadata=*) METADATA_PATH="${1#--metadata=}"; shift ;;
      --no-launch) NO_LAUNCH=1; shift ;;
      --yes | -y) ASSUME_YES=1; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) die "Unknown option: $1 (use --help)" ;;
    esac
  done
  # Accept "v0.5.60" as well as "0.5.60".
  REQUESTED_VERSION="${REQUESTED_VERSION#v}"
  case "$REPO" in
    */*) ;;
    *) die "--repo must look like OWNER/NAME, got: $REPO" ;;
  esac
}

# --- Platform checks ---------------------------------------------------------

# Returns 0 when the given macOS product version (for example 14.6.1) is
# supported by current releases.
check_macos_version() {
  local major="${1%%.*}"
  case "$major" in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "$major" -ge "$MIN_MACOS_MAJOR" ]
}

macos_too_old_message() {
  cat <<EOF
Current CoWork OS releases need $MIN_MACOS_LABEL or later; this Mac runs macOS $1.
$APP_NAME $LAST_MONTEREY_VERSION is the final release for older systems. To use it:
  npm install -g cowork-os@$LAST_MONTEREY_VERSION
EOF
}

detect_arch() {
  if [ -n "${COWORK_INSTALL_ARCH:-}" ]; then
    printf '%s\n' "$COWORK_INSTALL_ARCH"
    return 0
  fi
  # hw.optional.arm64 is 1 on Apple Silicon even inside a Rosetta shell.
  if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
    printf 'arm64\n'
  else
    printf 'x64\n'
  fi
}

preflight() {
  if [ "$(uname -s)" != "Darwin" ]; then
    die "This installer is for macOS. Windows users: download the installer from https://github.com/$REPO/releases/latest. Other systems: see the README."
  fi
  local tool
  for tool in curl ditto codesign plutil sw_vers sysctl xattr; do
    command -v "$tool" >/dev/null 2>&1 || die "Required tool not found: $tool"
  done
  local product
  product="$(sw_vers -productVersion)"
  if ! check_macos_version "$product"; then
    macos_too_old_message "$product" >&2
    exit 1
  fi
  ARCH="$(detect_arch)"
}

# --- Release metadata ----------------------------------------------------------

metadata_url() {
  local version="$1"
  if [ -z "$version" ]; then
    printf 'https://github.com/%s/releases/latest/download/latest-mac.yml\n' "$REPO"
  else
    printf 'https://github.com/%s/releases/download/v%s/latest-mac.yml\n' "$REPO" "$version"
  fi
}

asset_url() {
  local version="$1" name="$2"
  # GitHub stores release assets with spaces replaced by periods.
  name="$(printf '%s' "$name" | tr ' ' '.')"
  printf 'https://github.com/%s/releases/download/v%s/%s\n' "$REPO" "$version" "$name"
}

# Is this updater-metadata file entry the ZIP for the given architecture?
asset_matches_arch() {
  local name="$1" arch="$2"
  case "$name" in
    *.blockmap) return 1 ;;
    *.zip) ;;
    *) return 1 ;;
  esac
  case "$arch" in
    arm64)
      case "$name" in
        *-arm64-mac.zip | *-universal-mac.zip) return 0 ;;
      esac
      ;;
    x64)
      case "$name" in
        *-arm64-mac.zip) return 1 ;;
        *-x64-mac.zip | *-universal-mac.zip | *-mac.zip) return 0 ;;
      esac
      ;;
  esac
  return 1
}

strip_yaml_scalar() {
  local value="$1"
  value="${value%"${value##*[![:space:]]}"}"
  value="${value#"${value%%[![:space:]]*}"}"
  case "$value" in
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
  esac
  printf '%s' "$value"
}

_md_cur_name=""
_md_cur_sha=""
_md_cur_size=""

_md_consider_entry() {
  if [ -n "$_md_cur_name" ] && [ -z "$MD_ASSET" ] && asset_matches_arch "$_md_cur_name" "$1"; then
    MD_ASSET="$_md_cur_name"
    MD_SHA512="$_md_cur_sha"
    MD_SIZE="$_md_cur_size"
  fi
  _md_cur_name=""
  _md_cur_sha=""
  _md_cur_size=""
}

# Parse an electron-builder latest-mac.yml. Sets MD_VERSION, MD_ASSET, MD_SHA512
# and MD_SIZE for the ZIP matching the architecture in $2. Returns 1 when the
# file lists no suitable ZIP.
parse_metadata() {
  local file="$1" arch="$2"
  local line
  local re_version='^version:[[:space:]]*(.+)$'
  local re_entry='^[[:space:]]*-[[:space:]]+url:[[:space:]]*(.+)$'
  local re_sha='^[[:space:]]+sha512:[[:space:]]*(.+)$'
  local re_size='^[[:space:]]+size:[[:space:]]*([0-9]+)'
  local re_toplevel='^[^[:space:]]'

  MD_VERSION=""
  MD_ASSET=""
  MD_SHA512=""
  MD_SIZE=""
  _md_cur_name=""
  _md_cur_sha=""
  _md_cur_size=""

  [ -f "$file" ] || die "Release metadata not found: $file"

  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    if [[ "$line" =~ $re_version ]]; then
      MD_VERSION="$(strip_yaml_scalar "${BASH_REMATCH[1]}")"
      continue
    fi
    if [[ "$line" =~ $re_entry ]]; then
      _md_consider_entry "$arch"
      _md_cur_name="$(strip_yaml_scalar "${BASH_REMATCH[1]}")"
      _md_cur_name="${_md_cur_name##*/}"
      continue
    fi
    if [ -n "$_md_cur_name" ] && [[ "$line" =~ $re_sha ]]; then
      _md_cur_sha="$(strip_yaml_scalar "${BASH_REMATCH[1]}")"
      continue
    fi
    if [ -n "$_md_cur_name" ] && [[ "$line" =~ $re_size ]]; then
      _md_cur_size="${BASH_REMATCH[1]}"
      continue
    fi
    if [[ "$line" =~ $re_toplevel ]]; then
      # Top-level keys such as path:/sha512:/releaseDate: end the files list.
      _md_consider_entry "$arch"
    fi
  done <"$file"
  _md_consider_entry "$arch"

  [ -n "$MD_VERSION" ] || die "Release metadata has no version: $file"
  [ -n "$MD_ASSET" ]
}

# --- Download and verification -------------------------------------------------

download() {
  local url="$1" dest="$2"
  local verbosity="-sS"
  if [ -t 2 ]; then
    verbosity="--progress-bar"
  fi
  # curl never sets com.apple.quarantine on the files it writes.
  curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 "$verbosity" -o "$dest" "$url"
}

# Base64 (electron-builder's format) of the file's SHA-512.
sha512_base64() {
  local file="$1"
  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha512 -binary "$file" | base64 | tr -d '\n'
  else
    shasum -a 512 "$file" | awk '{print $1}' | xxd -r -p | base64 | tr -d '\n'
  fi
}

verify_sha512() {
  local file="$1" expected="$2" actual
  expected="$(printf '%s' "$expected" | tr -d '[:space:]')"
  [ -n "$expected" ] || return 1
  actual="$(sha512_base64 "$file")"
  [ "$actual" = "$expected" ]
}

plist_value() {
  local plist="$1" key="$2"
  plutil -extract "$key" raw -o - "$plist" 2>/dev/null || defaults read "${plist%.plist}" "$key"
}

# Extract the ZIP and print the path of the single .app inside it.
extract_app() {
  local zip="$1" dest="$2"
  local app="" count=0 candidate
  mkdir -p "$dest"
  # --noqtn: never carry a quarantine attribute over, whatever the ZIP's origin.
  ditto -x -k --noqtn "$zip" "$dest"
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    count=$((count + 1))
    app="$candidate"
  done <<EOF
$(find "$dest" -maxdepth 2 -name '*.app' -type d)
EOF
  [ "$count" -eq 1 ] || die "Expected one .app inside the archive, found $count."
  printf '%s\n' "$app"
}

verify_app_bundle() {
  local app="$1" expected_version="$2"
  local plist="$app/Contents/Info.plist" bundle_id version
  [ -f "$plist" ] || die "Not an app bundle (missing Info.plist): $app"
  if ! codesign --verify --deep --strict "$app" >/dev/null 2>&1; then
    die "The downloaded app failed code signature verification (codesign --verify --deep --strict). Not installing it."
  fi
  bundle_id="$(plist_value "$plist" CFBundleIdentifier)"
  [ "$bundle_id" = "$BUNDLE_ID" ] || die "Unexpected bundle identifier: $bundle_id (expected $BUNDLE_ID)"
  version="$(plist_value "$plist" CFBundleShortVersionString)"
  if [ -n "$expected_version" ] && [ "$version" != "$expected_version" ]; then
    die "The app reports version $version but the release metadata says $expected_version."
  fi
}

# --- Installation ------------------------------------------------------------

default_install_dir() {
  if [ -d /Applications ] && [ -w /Applications ]; then
    printf '/Applications\n'
  else
    printf '%s/Applications\n' "$HOME"
  fi
}

is_interactive() {
  [ -t 1 ] && [ -t 2 ]
}

# Ask on the terminal (not stdin, which carries the script under `curl | bash`).
confirm() {
  local answer=""
  is_interactive || return 1
  printf '[cowork-install] %s [y/N] ' "$1" >/dev/tty
  read -r answer </dev/tty || return 1
  case "$answer" in
    y | Y | yes | YES | Yes) return 0 ;;
  esac
  return 1
}

running_pids() {
  pgrep -f -- "$1/Contents/MacOS/" 2>/dev/null || true
}

ensure_not_running() {
  local target="$1" waited=0
  [ -n "$(running_pids "$target")" ] || return 0
  if [ "$ASSUME_YES" != "1" ] && ! confirm "$APP_NAME is running from $target. Quit it and continue?"; then
    die "$APP_NAME is running. Quit it and run the installer again."
  fi
  log "Asking the running $APP_NAME to quit …"
  pkill -TERM -f -- "$target/Contents/MacOS/" 2>/dev/null || true
  while [ -n "$(running_pids "$target")" ]; do
    if [ "$waited" -ge 20 ]; then
      die "$APP_NAME did not quit. Quit it and run the installer again."
    fi
    sleep 1
    waited=$((waited + 1))
  done
}

install_app() {
  local app="$1" install_dir="$2"
  local target="$install_dir/$APP_NAME.app"
  local staging="$install_dir/.$APP_NAME.app.installing.$$"
  local previous=""

  mkdir -p "$install_dir" || die "Cannot create $install_dir"
  [ -w "$install_dir" ] || die "Cannot write to $install_dir. Re-run with --install-dir \"\$HOME/Applications\"."

  rm -rf "$staging"
  # Stage inside the destination so the final step is a rename on one volume.
  ditto --noqtn "$app" "$staging" || die "Could not copy the app into $install_dir"

  if [ -e "$target" ]; then
    previous="$install_dir/.$APP_NAME.app.previous.$$"
    if ! mv "$target" "$previous"; then
      rm -rf "$staging"
      die "Could not replace the existing $target. macOS may ask you to let Terminal manage apps; allow it, or move the old copy to the Trash in Finder and re-run."
    fi
  fi
  if ! mv "$staging" "$target"; then
    if [ -n "$previous" ]; then
      mv "$previous" "$target" || true
    fi
    rm -rf "$staging"
    die "Could not move the app into place at $target"
  fi
  if [ -n "$previous" ]; then
    rm -rf "$previous"
  fi
  # Belt and braces: the copy was never quarantined, but make sure.
  xattr -dr com.apple.quarantine "$target" 2>/dev/null || true
  return 0
}

cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}

main() {
  parse_args "$@"
  preflight

  TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cowork-install.XXXXXX")"
  trap cleanup EXIT

  local metadata="$TMP_DIR/latest-mac.yml"
  if [ -n "$METADATA_PATH" ]; then
    [ -f "$METADATA_PATH" ] || die "Metadata file not found: $METADATA_PATH"
    cp "$METADATA_PATH" "$metadata"
  else
    log "Looking up the ${REQUESTED_VERSION:-latest} release of $APP_NAME …"
    download "$(metadata_url "$REQUESTED_VERSION")" "$metadata" ||
      die "Could not download release metadata from $(metadata_url "$REQUESTED_VERSION"). Check the version and your connection."
  fi

  if ! parse_metadata "$metadata" "$ARCH"; then
    if [ "$ARCH" = "x64" ]; then
      die "Release $MD_VERSION has no Intel (x64) macOS build. Options: install on an Apple Silicon Mac, or run 'npm install -g cowork-os' which builds the app locally (needs Node.js)."
    fi
    die "Release $MD_VERSION lists no macOS ZIP for $ARCH."
  fi
  if [ -n "$REQUESTED_VERSION" ] && [ "$MD_VERSION" != "$REQUESTED_VERSION" ]; then
    die "Requested $REQUESTED_VERSION but the release metadata describes $MD_VERSION."
  fi

  if [ -z "$INSTALL_DIR" ]; then
    INSTALL_DIR="$(default_install_dir)"
  fi
  local target="$INSTALL_DIR/$APP_NAME.app"

  if [ "$DRY_RUN" = "1" ]; then
    log "Dry run. Would install $APP_NAME $MD_VERSION ($ARCH):"
    log "  archive:  ${ARCHIVE_PATH:-$(asset_url "$MD_VERSION" "$MD_ASSET")}"
    log "  sha512:   ${MD_SHA512:-<none in metadata>}"
    log "  target:   $target"
    return 0
  fi

  local archive="$TMP_DIR/$MD_ASSET"
  if [ -n "$ARCHIVE_PATH" ]; then
    [ -f "$ARCHIVE_PATH" ] || die "Archive not found: $ARCHIVE_PATH"
    archive="$ARCHIVE_PATH"
    log "Using local archive $archive"
  else
    log "Downloading $APP_NAME $MD_VERSION for Apple ${ARCH} ($MD_ASSET) …"
    download "$(asset_url "$MD_VERSION" "$MD_ASSET")" "$archive" ||
      die "Download failed: $(asset_url "$MD_VERSION" "$MD_ASSET")"
  fi

  if [ -n "$MD_SIZE" ]; then
    local actual_size
    actual_size="$(stat -f %z "$archive" 2>/dev/null || stat -c %s "$archive")"
    [ "$actual_size" = "$MD_SIZE" ] || die "Archive size $actual_size does not match the published size $MD_SIZE."
  fi
  [ -n "$MD_SHA512" ] || die "The release metadata carries no SHA-512 for $MD_ASSET; refusing to install an unverified archive."
  log "Verifying checksum …"
  verify_sha512 "$archive" "$MD_SHA512" || die "SHA-512 mismatch for $MD_ASSET. The download is corrupt or has been altered; nothing was installed."

  log "Extracting …"
  local app
  app="$(extract_app "$archive" "$TMP_DIR/extract")"
  verify_app_bundle "$app" "$MD_VERSION"

  ensure_not_running "$target"
  log "Installing into $INSTALL_DIR …"
  install_app "$app" "$INSTALL_DIR"

  if ! codesign --verify --deep --strict "$target" >/dev/null 2>&1; then
    die "The installed app failed code signature verification after copying: $target"
  fi
  if xattr -p com.apple.quarantine "$target" >/dev/null 2>&1; then
    warn "$target still carries com.apple.quarantine; macOS will show the Gatekeeper dialog on first launch."
  fi

  log "Installed $APP_NAME $MD_VERSION at $target"
  log "Re-run this installer any time to update."
  if [ "$NO_LAUNCH" != "1" ]; then
    log "Opening $APP_NAME …"
    open "$target" || warn "Could not open the app automatically; open it from $INSTALL_DIR."
  fi
}

# Run main unless this file is being sourced (the tests source it to call
# individual functions). `return` only succeeds inside a sourced script.
if ! (return 0 2>/dev/null); then
  main "$@"
fi
