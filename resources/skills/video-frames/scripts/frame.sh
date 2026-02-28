#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: frame.sh <video-file> [--time HH:MM:SS[.ms]] [--out output.jpg]
USAGE
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

INPUT=""
TIME_AT=""
OUT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --time)
      TIME_AT="${2:-}"
      shift 2
      ;;
    --out)
      OUT="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -* )
      echo "Unknown flag: $1" >&2
      usage
      exit 1
      ;;
    *)
      if [[ -z "$INPUT" ]]; then
        INPUT="$1"
      else
        echo "Unexpected argument: $1" >&2
        usage
        exit 1
      fi
      shift
      ;;
  esac
done

if [[ -z "$INPUT" || ! -f "$INPUT" ]]; then
  echo "Input video not found: $INPUT" >&2
  exit 1
fi

if [[ -z "$OUT" ]]; then
  OUT="${INPUT%.*}-frame.jpg"
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is required." >&2
  exit 1
fi

if [[ -n "$TIME_AT" ]]; then
  ffmpeg -hide_banner -loglevel error -y -ss "$TIME_AT" -i "$INPUT" -frames:v 1 "$OUT"
else
  ffmpeg -hide_banner -loglevel error -y -i "$INPUT" -frames:v 1 "$OUT"
fi

echo "Wrote frame to: $OUT"
