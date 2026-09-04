#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: transcribe.sh <audio-file> [--provider openai|atlas|muapi] [--model MODEL] [--out FILE] [--language LANG] [--prompt TEXT] [--json]
USAGE
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

INPUT=""
PROVIDER="openai"
MODEL=""
OUT=""
LANG=""
PROMPT=""
AS_JSON=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --provider)
      PROVIDER="${2:-}"
      shift 2
      ;;
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

case "$PROVIDER" in
  openai)
    MODEL="${MODEL:-whisper-1}"
    ;;
  atlas)
    MODEL="${MODEL:-xai/stt-v1}"
    if [[ "$MODEL" != "xai/stt-v1" ]]; then
      echo "Unsupported Atlas Cloud model: $MODEL (expected xai/stt-v1)." >&2
      exit 1
    fi
    ;;
  muapi)
    MODEL="${MODEL:-openai-whisper}"
    if [[ "$MODEL" != "openai-whisper" ]]; then
      echo "Unsupported MuAPI model: $MODEL (expected openai-whisper)." >&2
      exit 1
    fi
    ;;
  *)
    echo "Unsupported provider: $PROVIDER (expected openai, atlas, or muapi)." >&2
    exit 1
    ;;
esac

if [[ -z "$OUT" ]]; then
  if [[ "$AS_JSON" -eq 1 ]]; then
    OUT="${INPUT%.*}.json"
  else
    OUT="${INPUT%.*}.txt"
  fi
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required." >&2
  exit 1
fi

read_config_key() {
  local key="$1"
  if [[ ! -f "$HOME/.CoWork-OSS/CoWork-OSS.json" ]] || ! command -v node >/dev/null 2>&1; then
    return
  fi
  CONFIG_KEY="$key" node -e 'const fs=require("fs");try{const j=JSON.parse(fs.readFileSync(process.env.HOME+"/.CoWork-OSS/CoWork-OSS.json","utf8"));const s=j.skills&&j.skills["openai-whisper-api"];const e=j.skills&&j.skills.entries&&j.skills.entries["openai-whisper-api"];const k=(s&&s[process.env.CONFIG_KEY])||(e&&e[process.env.CONFIG_KEY])||"";process.stdout.write(k)}catch{process.stdout.write("")}'
}

tmp_resp="$(mktemp)"
tmp_req="$(mktemp)"
trap 'rm -f "$tmp_resp" "$tmp_req"' EXIT

if [[ "$PROVIDER" == "openai" ]]; then
  API_KEY="${OPENAI_API_KEY:-}"
  if [[ -z "$API_KEY" ]]; then
    API_KEY="$(read_config_key apiKey)"
  fi

  if [[ -z "$API_KEY" ]]; then
    echo "OPENAI_API_KEY is required (or set skills.openai-whisper-api.apiKey in ~/.CoWork-OSS/CoWork-OSS.json)." >&2
    exit 1
  fi

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
elif [[ "$PROVIDER" == "atlas" ]]; then
  if ! command -v node >/dev/null 2>&1; then
    echo "node is required for Atlas Cloud transcription." >&2
    exit 1
  fi

  API_KEY="${ATLASCLOUD_API_KEY:-}"
  if [[ -z "$API_KEY" ]]; then
    API_KEY="$(read_config_key atlasApiKey)"
  fi
  if [[ -z "$API_KEY" ]]; then
    echo "ATLASCLOUD_API_KEY is required (or set skills.openai-whisper-api.atlasApiKey in ~/.CoWork-OSS/CoWork-OSS.json)." >&2
    exit 1
  fi

  node - "$INPUT" "$MODEL" "$LANG" "$PROMPT" "$tmp_req" <<'NODE'
const fs = require("fs");
const [input, model, language, prompt, output] = process.argv.slice(2);
if (prompt.length > 50) {
  console.error("Atlas Cloud key term from --prompt must be 50 characters or fewer.");
  process.exit(1);
}
const payload = {
  model,
  audio: fs.readFileSync(input).toString("base64"),
  audio_format: "auto",
};
if (language) payload.language = language;
if (prompt) payload.keyterm = [prompt];
fs.writeFileSync(output, JSON.stringify(payload));
NODE

  atlas_base="${ATLASCLOUD_API_BASE_URL:-https://api.atlascloud.ai/api/v1}"
  http_code="$(curl -sS -X POST "${atlas_base}/model/generateAudio" \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "Content-Type: application/json" \
    --data-binary "@${tmp_req}" \
    -o "$tmp_resp" -w '%{http_code}')"
  if [[ "$http_code" -lt 200 || "$http_code" -ge 300 ]]; then
    echo "Atlas Cloud API request failed (HTTP $http_code):" >&2
    cat "$tmp_resp" >&2
    exit 1
  fi

  read_atlas_field() {
    local field="$1"
    ATLAS_FIELD="$field" node - "$tmp_resp" <<'NODE'
const fs = require("fs");
const body = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const data = body.data || body;
const value = data[process.env.ATLAS_FIELD];
process.stdout.write(value == null ? "" : String(value));
NODE
  }

  request_id="$(read_atlas_field id)"
  status="$(read_atlas_field status)"
  if [[ -z "$request_id" ]]; then
    echo "Atlas Cloud response did not include a prediction ID:" >&2
    cat "$tmp_resp" >&2
    exit 1
  fi

  delay=1
  for ((attempt=1; attempt<=60; attempt++)); do
    if [[ "$status" == "completed" || "$status" == "succeeded" ]]; then
      break
    fi
    if [[ "$status" == "failed" || "$status" == "timeout" ]]; then
      echo "Atlas Cloud prediction ${status}:" >&2
      cat "$tmp_resp" >&2
      exit 1
    fi
    sleep "$delay"
    http_code="$(curl -sS "${atlas_base}/model/prediction/${request_id}" \
      -H "Authorization: Bearer ${API_KEY}" \
      -o "$tmp_resp" -w '%{http_code}')"
    if [[ "$http_code" -ge 200 && "$http_code" -lt 300 ]]; then
      status="$(read_atlas_field status)"
      delay=1
    elif [[ "$http_code" -eq 429 || "$http_code" -ge 500 ]]; then
      delay=$((delay < 8 ? delay * 2 : 8))
    else
      echo "Atlas Cloud prediction request failed (HTTP $http_code):" >&2
      cat "$tmp_resp" >&2
      exit 1
    fi
  done

  if [[ "$status" != "completed" && "$status" != "succeeded" ]]; then
    echo "Atlas Cloud prediction did not complete after 60 checks." >&2
    exit 1
  fi

  if [[ "$AS_JSON" -eq 0 ]]; then
    node - "$tmp_resp" "$tmp_req" <<'NODE'
const fs = require("fs");
const body = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const data = body.data || body;
const text = data.stt_result?.text || data.outputs?.[0];
if (typeof text !== "string" || !text) {
  console.error("Atlas Cloud response did not include transcript text.");
  process.exit(1);
}
fs.writeFileSync(process.argv[3], `${text}\n`);
NODE
    cp "$tmp_req" "$tmp_resp"
  fi
else
  if ! command -v node >/dev/null 2>&1; then
    echo "node is required for MuAPI transcription." >&2
    exit 1
  fi

  API_KEY="${MUAPI_API_KEY:-${MU_API_KEY:-}}"
  if [[ -z "$API_KEY" ]]; then
    API_KEY="$(read_config_key muapiApiKey)"
  fi
  if [[ -z "$API_KEY" ]]; then
    echo "MUAPI_API_KEY is required (or set skills.openai-whisper-api.muapiApiKey in ~/.CoWork-OSS/CoWork-OSS.json)." >&2
    exit 1
  fi

  muapi_base="${MUAPI_BASE_URL:-https://api.muapi.ai/api/v1}"
  muapi_base="${muapi_base%/}"
  http_code="$(curl -sS -X POST "${muapi_base}/upload_file" \
    -H "x-api-key: ${API_KEY}" \
    -F "file=@${INPUT}" \
    -o "$tmp_resp" -w '%{http_code}')"
  if [[ "$http_code" -lt 200 || "$http_code" -ge 300 ]]; then
    echo "MuAPI file upload failed (HTTP $http_code):" >&2
    cat "$tmp_resp" >&2
    exit 1
  fi

  audio_url="$(node - "$tmp_resp" <<'NODE'
const fs = require("fs");
const body = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const value = body.url || body.data?.url;
if (typeof value !== "string" || !value) {
  console.error("MuAPI upload response did not include a file URL.");
  process.exit(1);
}
const parsed = new URL(value);
if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) {
  console.error("MuAPI upload response included an insecure file URL.");
  process.exit(1);
}
process.stdout.write(value);
NODE
)"

  node - "$audio_url" "$LANG" "$PROMPT" "$AS_JSON" "$tmp_req" <<'NODE'
const fs = require("fs");
const [audioUrl, language, prompt, asJson, output] = process.argv.slice(2);
const payload = {
  audio_url: audioUrl,
  response_format: asJson === "1" ? "verbose_json" : "json",
};
if (language) payload.language = language;
if (prompt) payload.prompt = prompt;
fs.writeFileSync(output, JSON.stringify(payload));
NODE

  http_code="$(curl -sS -X POST "${muapi_base}/openai-whisper" \
    -H "x-api-key: ${API_KEY}" \
    -H "Content-Type: application/json" \
    --data-binary "@${tmp_req}" \
    -o "$tmp_resp" -w '%{http_code}')"
  if [[ "$http_code" -lt 200 || "$http_code" -ge 300 ]]; then
    echo "MuAPI transcription request failed (HTTP $http_code):" >&2
    cat "$tmp_resp" >&2
    exit 1
  fi

  read_muapi_field() {
    local field="$1"
    MUAPI_FIELD="$field" node - "$tmp_resp" <<'NODE'
const fs = require("fs");
const body = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const data = body.data && typeof body.data === "object" ? body.data : body;
let value = data[process.env.MUAPI_FIELD];
if (!value && process.env.MUAPI_FIELD === "request_id") {
  value = data.id || data.prediction_id || data.task_id;
}
process.stdout.write(value == null ? "" : String(value));
NODE
  }

  request_id="$(read_muapi_field request_id)"
  status="$(read_muapi_field status)"
  if [[ -z "$request_id" ]]; then
    echo "MuAPI response did not include a prediction ID:" >&2
    cat "$tmp_resp" >&2
    exit 1
  fi

  encoded_request_id="$(node - "$request_id" <<'NODE'
process.stdout.write(encodeURIComponent(process.argv[2]));
NODE
)"

  delay=1
  for ((attempt=1; attempt<=60; attempt++)); do
    if [[ "$status" == "completed" || "$status" == "succeeded" || "$status" == "success" ]]; then
      break
    fi
    if [[ "$status" == "failed" || "$status" == "error" || "$status" == "cancelled" || "$status" == "canceled" || "$status" == "timeout" ]]; then
      echo "MuAPI prediction ${status}:" >&2
      cat "$tmp_resp" >&2
      exit 1
    fi
    sleep "$delay"
    http_code="$(curl -sS "${muapi_base}/predictions/${encoded_request_id}/result" \
      -H "x-api-key: ${API_KEY}" \
      -o "$tmp_resp" -w '%{http_code}')"
    if [[ "$http_code" -ge 200 && "$http_code" -lt 300 ]]; then
      status="$(read_muapi_field status)"
      delay=1
    elif [[ "$http_code" -eq 429 || "$http_code" -ge 500 ]]; then
      delay=$((delay < 8 ? delay * 2 : 8))
    else
      echo "MuAPI prediction request failed (HTTP $http_code):" >&2
      cat "$tmp_resp" >&2
      exit 1
    fi
  done

  if [[ "$status" != "completed" && "$status" != "succeeded" && "$status" != "success" ]]; then
    echo "MuAPI prediction did not complete after 60 checks." >&2
    exit 1
  fi

  if [[ "$AS_JSON" -eq 0 ]]; then
    node - "$tmp_resp" "$tmp_req" <<'NODE'
const fs = require("fs");
const body = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const containers = [body, body.data].filter(
  (value) => value && typeof value === "object",
);
const candidates = containers.flatMap((container) => {
  const outputs = Array.isArray(container.outputs)
    ? container.outputs
    : [container.outputs];
  return [
    container.text,
    container.transcript,
    container.output,
    container.output?.text,
    container.result,
    container.result?.text,
    ...outputs,
    ...outputs.map((output) => output?.text),
  ];
});
const text = candidates.find((value) => typeof value === "string" && value.length > 0);
if (!text) {
  console.error("MuAPI response did not include transcript text.");
  process.exit(1);
}
fs.writeFileSync(process.argv[3], `${text}\n`);
NODE
    cp "$tmp_req" "$tmp_resp"
  fi
fi

cp "$tmp_resp" "$OUT"
echo "Wrote transcript to: $OUT"
