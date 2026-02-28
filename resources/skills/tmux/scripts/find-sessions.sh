#!/usr/bin/env bash
set -euo pipefail

SOCKET=""
SCAN_ALL=0

usage() {
  cat <<'USAGE'
Usage:
  find-sessions.sh -S <socket>
  find-sessions.sh --all
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -S)
      SOCKET="${2:-}"
      shift 2
      ;;
    --all)
      SCAN_ALL=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is not installed or not on PATH." >&2
  exit 1
fi

list_for_socket() {
  local sock="$1"
  if tmux -S "$sock" has-session 2>/dev/null; then
    tmux -S "$sock" list-sessions -F "${sock}\t#{session_name}\t#{session_windows}\t#{session_attached}" \
      | awk -F'\t' 'BEGIN {print "socket\tsession\twindows\tattached"} {print}'
    return 0
  fi
  return 1
}

if [[ "$SCAN_ALL" -eq 0 ]]; then
  if [[ -z "$SOCKET" ]]; then
    usage
    exit 1
  fi
  list_for_socket "$SOCKET"
  exit 0
fi

SOCKET_DIR="${CoWork-OSS_TMUX_SOCKET_DIR:-${CoWork-OSSBOT_TMUX_SOCKET_DIR:-${TMPDIR:-/tmp}/CoWork-OSS-tmux-sockets}}"
if [[ ! -d "$SOCKET_DIR" ]]; then
  echo "No socket directory found at: $SOCKET_DIR" >&2
  exit 1
fi

found=0
for sock in "$SOCKET_DIR"/*; do
  [[ -e "$sock" ]] || continue
  if list_for_socket "$sock"; then
    found=1
  fi
done

if [[ "$found" -eq 0 ]]; then
  echo "No active tmux sessions found under: $SOCKET_DIR" >&2
  exit 1
fi
