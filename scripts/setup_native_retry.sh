#!/bin/sh
# POSIX retry wrapper for native setup.
#
# Why this exists:
# - On some macOS machines under memory pressure, the OS can SIGKILL `node` while
#   downloading Electron or rebuilding native modules ("Killed: 9").
# - If the retry logic is implemented in Node, the driver process itself can get
#   SIGKILL'd before it can retry.
# - A tiny shell wrapper is far less likely to be killed and can re-run the Node
#   setup script after a short backoff.

set -u

MAX_ATTEMPTS="${COWORK_SETUP_NATIVE_SHELL_ATTEMPTS:-6}"

# Validate MAX_ATTEMPTS (fallback to 6).
case "$MAX_ATTEMPTS" in
  ''|*[!0-9]*) MAX_ATTEMPTS=6 ;;
esac
if [ "$MAX_ATTEMPTS" -lt 1 ]; then
  MAX_ATTEMPTS=1
fi

attempt=1
delay=2
last_status=1

while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  if [ "$attempt" -gt 1 ]; then
    echo "[cowork] setup:native shell retry ${attempt}/${MAX_ATTEMPTS} in ${delay}s..."
    sleep "$delay"

    # Exponential backoff (2,4,8,16,20,20,...) to give macOS time to recover.
    delay=$((delay * 2))
    if [ "$delay" -gt 20 ]; then
      delay=20
    fi
  fi

  node scripts/setup_native.mjs
  last_status=$?

  if [ "$last_status" -eq 0 ]; then
    exit 0
  fi

  # SIGKILL usually surfaces as 137 (128 + 9). Handle 9 too just in case a shell
  # reports the raw signal number.
  if [ "$last_status" -ne 137 ] && [ "$last_status" -ne 9 ]; then
    exit "$last_status"
  fi

  attempt=$((attempt + 1))
done

exit "$last_status"
