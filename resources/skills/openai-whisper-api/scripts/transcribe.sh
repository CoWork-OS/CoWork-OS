#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: transcribe.sh <audio-file> [--model whisper-1] [--out FILE] [--language LANG] [--prompt TEXT] [--json]
USAGE
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

INPUT=""
MODEL="whisper-1"
OUT=""
LANG=""
PROMPT=""
AS_JSON=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)
      MODEL="${2:-}"
      shift 2
      ;;
    --out)
      OUT="${2:-}"
      shift 2
      ;;
    --language)
      LANG="${2:-}"
      shift 2
      ;;
    --prompt)
      PROMPT="${2:-}"
      shift 2
      ;;
    --json)
      AS_JSON=1
      shift
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

if [[ -z "$INPUT" ]]; then
  echo "Missing audio file." >&2
  usage
  exit 1
fi

if [[ ! -f "$INPUT" ]]; then
  echo "Input file not found: $INPUT" >&2
  exit 1
fi

if [[ -z "$OUT" ]]; then
  if [[ "$AS_JSON" -eq 1 ]]; then
    OUT="${INPUT%.*}.json"
  else
    OUT="${INPUT%.*}.txt"
  fi
fi

API_KEY="${OPENAI_API_KEY:-}"
if [[ -z "$API_KEY" && -f "$HOME/.CoWork-OSS/CoWork-OSS.json" ]] && command -v node >/dev/null 2>&1; then
  API_KEY="$(node -e 'const fs=require("fs");try{const j=JSON.parse(fs.readFileSync(process.env.HOME+"/.CoWork-OSS/CoWork-OSS.json","utf8"));const k=(j.skills&&j.skills["openai-whisper-api"]&&j.skills["openai-whisper-api"].apiKey)||(j.skills&&j.skills.entries&&j.skills.entries["openai-whisper-api"]&&j.skills.entries["openai-whisper-api"].apiKey)||"";process.stdout.write(k)}catch{process.stdout.write("")}' )"
fi

if [[ -z "$API_KEY" ]]; then
  echo "OPENAI_API_KEY is required (or set skills.openai-whisper-api.apiKey in ~/.CoWork-OSS/CoWork-OSS.json)." >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required." >&2
  exit 1
fi

tmp_resp="$(mktemp)"
trap 'rm -f "$tmp_resp"' EXIT

curl_args=(
  -sS
  -X POST "https://api.openai.com/v1/audio/transcriptions"
  -H "Authorization: Bearer ${API_KEY}"
  -F "file=@${INPUT}"
  -F "model=${MODEL}"
)

if [[ -n "$LANG" ]]; then
  curl_args+=( -F "language=${LANG}" )
fi
if [[ -n "$PROMPT" ]]; then
  curl_args+=( -F "prompt=${PROMPT}" )
fi
if [[ "$AS_JSON" -eq 1 ]]; then
  curl_args+=( -F "response_format=json" )
else
  curl_args+=( -F "response_format=text" )
fi

http_code="$(curl "${curl_args[@]}" -o "$tmp_resp" -w '%{http_code}')"
if [[ "$http_code" -lt 200 || "$http_code" -ge 300 ]]; then
  echo "OpenAI API request failed (HTTP $http_code):" >&2
  cat "$tmp_resp" >&2
  exit 1
fi

cp "$tmp_resp" "$OUT"
echo "Wrote transcript to: $OUT"
