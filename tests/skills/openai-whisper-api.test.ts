import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

describe("openai-whisper-api skill", () => {
  it("accepts Atlas succeeded predictions as completed", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "cowork-whisper-api-"));
    const binDir = join(tempDir, "bin");
    const inputPath = join(tempDir, "input.wav");
    const outputPath = join(tempDir, "output.txt");
    const statePath = join(tempDir, "poll-state");
    const curlPath = join(binDir, "curl");
    const sleepPath = join(binDir, "sleep");

    try {
      writeFileSync(inputPath, "fake audio");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        curlPath,
        `#!/usr/bin/env bash
set -euo pipefail
output=""
url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    -w) shift 2 ;;
    -X|-H|--data-binary) shift 2 ;;
    -sS) shift ;;
    *) url="$1"; shift ;;
  esac
done
if [[ "$url" == *generateAudio* ]]; then
  printf '%s' '{"data":{"id":"pred-1","status":"processing"}}' > "$output"
else
  if [[ -e "$FAKE_STATE" ]]; then
    printf '%s' '{"data":{"id":"pred-1","status":"failed"}}' > "$output"
  else
    touch "$FAKE_STATE"
    printf '%s' '{"data":{"id":"pred-1","status":"succeeded","stt_result":{"text":"hello"}}}' > "$output"
  fi
fi
printf '200'
`,
        "utf8",
      );
      writeFileSync(sleepPath, "#!/usr/bin/env bash\nexit 0\n", "utf8");
      chmodSync(curlPath, 0o755);
      chmodSync(sleepPath, 0o755);

      execFileSync(
        "bash",
        [
          resolve("resources/skills/openai-whisper-api/scripts/transcribe.sh"),
          inputPath,
          "--provider",
          "atlas",
          "--out",
          outputPath,
        ],
        {
          env: {
            ...process.env,
            ATLASCLOUD_API_KEY: "test-key",
            ATLASCLOUD_API_BASE_URL: "http://atlas.test/api/v1",
            FAKE_STATE: statePath,
            PATH: `${binDir}:${process.env.PATH || ""}`,
          },
          encoding: "utf8",
        },
      );

      expect(readFileSync(outputPath, "utf8")).toBe("hello\n");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uploads local audio and polls MuAPI Whisper", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "cowork-muapi-whisper-"));
    const binDir = join(tempDir, "bin");
    const captureDir = join(tempDir, "capture");
    const inputPath = join(tempDir, "input.wav");
    const outputPath = join(tempDir, "output.txt");
    const curlPath = join(binDir, "curl");
    const sleepPath = join(binDir, "sleep");

    try {
      writeFileSync(inputPath, "fake audio");
      mkdirSync(binDir, { recursive: true });
      mkdirSync(captureDir, { recursive: true });
      writeFileSync(
        curlPath,
        `#!/usr/bin/env bash
set -euo pipefail
output=""
data_file=""
url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    -w|-X|-H|-F) shift 2 ;;
    --data-binary) data_file="\${2#@}"; shift 2 ;;
    -sS) shift ;;
    *) if [[ -z "$url" ]]; then url="$1"; fi; shift ;;
  esac
done
if [[ "$url" == *upload_file* ]]; then
  printf '%s' '{"url":"https://files.example/audio.wav"}' > "$output"
elif [[ "$url" == *openai-whisper* ]]; then
  cp "$data_file" "$CAPTURE_DIR/request.json"
  printf '%s' '{"request_id":"pred-1","status":"processing"}' > "$output"
else
  printf '%s' '{"request_id":"pred-1","status":"completed","output":{"text":"hello from muapi"}}' > "$output"
fi
printf '200'
`,
        "utf8",
      );
      writeFileSync(sleepPath, "#!/usr/bin/env bash\nexit 0\n", "utf8");
      chmodSync(curlPath, 0o755);
      chmodSync(sleepPath, 0o755);

      execFileSync(
        "bash",
        [
          resolve("resources/skills/openai-whisper-api/scripts/transcribe.sh"),
          inputPath,
          "--provider",
          "muapi",
          "--language",
          "hi",
          "--prompt",
          "speaker names",
          "--out",
          outputPath,
        ],
        {
          env: {
            ...process.env,
            MUAPI_API_KEY: "test-key",
            MUAPI_BASE_URL: "https://muapi.test/api/v1",
            CAPTURE_DIR: captureDir,
            PATH: `${binDir}:${process.env.PATH || ""}`,
          },
          encoding: "utf8",
        },
      );

      expect(readFileSync(outputPath, "utf8")).toBe("hello from muapi\n");
      expect(JSON.parse(readFileSync(join(captureDir, "request.json"), "utf8"))).toEqual({
        audio_url: "https://files.example/audio.wav",
        language: "hi",
        prompt: "speaker names",
        response_format: "json",
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
