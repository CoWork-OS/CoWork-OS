#!/usr/bin/env bash
set -euo pipefail

TARGET=""
PATTERN=""
FIXED=0
TIMEOUT=15
INTERVAL=0.5
LINES=1000
SOCKET="${CoWork-OSS_TMUX_SOCKET:-${TMPDIR:-/tmp}/CoWork-OSS-tmux-sockets/CoWork-OSS.sock}"

usage() {
  cat <<'USAGE'
Usage: wait-for-text.sh -t <session:window.pane> -p <pattern> [-F] [-T seconds] [-i interval] [-l lines] [-S socket]
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -t|--target)
      TARGET="${2:-}"
      shift 2
      ;;
    -p|--pattern)
      PATTERN="${2:-}"
      shift 2
      ;;
    -F)
      FIXED=1
      shift
      ;;
    -T)
      TIMEOUT="${2:-}"
      shift 2
      ;;
    -i)
      INTERVAL="${2:-}"
      shift 2
      ;;
    -l)
      LINES="${2:-}"
      shift 2
      ;;
    -S)
      SOCKET="${2:-}"
      shift 2
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

if [[ -z "$TARGET" || -z "$PATTERN" ]]; then
  usage
  exit 1
fi

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is required." >&2
  exit 1
fi

end_epoch=$(( $(date +%s) + TIMEOUT ))

while [[ $(date +%s) -lt $end_epoch ]]; do
  pane="$(tmux -S "$SOCKET" capture-pane -p -J -t "$TARGET" -S "-$LINES" 2>/dev/null || true)"
  if [[ "$FIXED" -eq 1 ]]; then
    if grep -Fq -- "$PATTERN" <<<"$pane"; then
      exit 0
    fi
  else
    if grep -Eq -- "$PATTERN" <<<"$pane"; then
      exit 0
    fi
  fi
  sleep "$INTERVAL"
done

echo "Timed out waiting for pattern in $TARGET" >&2
exit 1
