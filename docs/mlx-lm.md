# MLX-LM Local Inference

CoWork OS can use [MLX-LM](https://github.com/ml-explore/mlx-lm) as a first-class local
model provider on Apple Silicon Macs. MLX-LM runs the model in a separate Python process
and exposes an OpenAI-compatible HTTP API. CoWork keeps its normal provider, tool, memory,
approval, artifact, and task-runtime behavior while sending model requests to that local API.

This guide documents the current CoWork integration. For the provider catalog, fallback
behavior, and billing/privacy overview, also see [Model Providers](providers.md).

## What was integrated from the article

The referenced [Perplexity article](https://www.perplexity.ai/hub/blog/optimizing-on-device-inference-for-apple-silicon)
describes Lily, Perplexity's custom Rust and Metal inference engine for Apple silicon. The
article says that Lily will be open-sourced soon; it is not a released dependency that CoWork
can install today.

The currently available open-source path is Apple's [MLX](https://github.com/ml-explore/mlx)
framework with [MLX-LM](https://github.com/ml-explore/mlx-lm). CoWork integrates that path
through the official MLX-LM server. Lily-specific Rust runtime code, custom Metal kernels,
and the article's benchmark results are not copied into CoWork.

MLX-LM is the appropriate integration boundary because it provides the model execution and
Apple Silicon kernels while CoWork retains its existing OpenAI-compatible provider adapter.

## Support and requirements

| Requirement | Current behavior |
|-------------|------------------|
| Operating system | CoWork-supported macOS 13 Ventura or later |
| Hardware | Native Apple Silicon (`arm64`) Mac |
| Python command | `python3` must be visible to the CoWork desktop process |
| Python package | `mlx-lm`, including importable `mlx_lm` and `mlx.core` modules |
| Model format | A compatible MLX model or Hugging Face repository with the required MLX files |
| First run | The model may be downloaded from Hugging Face before the server becomes ready |
| API key | Not required for the local server |
| Other platforms | Intel Macs, Windows, and Linux are rejected by the MLX provider readiness gate |

CoWork requires the process itself to report `darwin` and `arm64`. An Apple Silicon Mac running
the app under an x86/Rosetta process is treated as unsupported for this route because the
integration is intended to use the native MLX/Metal runtime.

Model size, context length, quantization, and concurrent work determine memory pressure. Start
with a smaller quantized model and move up only after confirming that the machine has enough
unified memory.

## Install MLX-LM

Install into the same Python installation that CoWork will find as `python3`:

```bash
python3 -m pip install --upgrade mlx-lm
```

Verify both the language-model package and the MLX runtime from that interpreter:

```bash
python3 -c "import mlx_lm; import mlx.core; print('MLX-LM ready')"
```

Optional package information check:

```bash
python3 -m pip show mlx-lm mlx
```

If a virtual environment is used, an already-running desktop app may not inherit the shell's
activated environment. Make sure `python3` resolves to the interpreter where `mlx-lm` was
installed, then restart CoWork before checking the provider status again.

## Configure CoWork Desktop

1. Open **Settings > AI & Models > Model Access**.
2. Select **MLX (Apple Silicon)**.
3. Choose a recommended model or enter a compatible Hugging Face model ID.
4. Leave the API key empty. The local MLX-LM server does not require one.
5. Confirm that the status panel reports that MLX-LM is installed and ready.
6. Click **Start MLX Server**.
7. Wait for the status to change from model download/loading to **Server running**.
8. Use **Test Connection**, then save the provider settings if the settings surface presents a
   save action.

CoWork stores the provider as `mlx`, uses `http://localhost:8080/v1` as its default base URL,
and keeps the selected model in the normal custom-provider settings structure. The server
control in Settings is desktop-only; a CLI or headless process can use MLX-LM when the same
server is already running and the provider is configured to reach it.

## Recommended models

The catalog includes these starting points:

| Model ID | Suggested use |
|----------|---------------|
| `mlx-community/Qwen3-8B-4bit` | Smaller and faster starting point |
| `mlx-community/Qwen3-14B-4bit` | Balanced local coding and knowledge work |
| `mlx-community/Qwen3-30B-A3B-4bit` | Larger mixture-of-experts option when memory allows |
| `mlx-community/Qwen3.6-35B-A3B-4bit-DWQ` | Larger Qwen3.6 option for higher-memory Apple Silicon systems; see the [model card](https://huggingface.co/mlx-community/Qwen3.6-35B-A3B-4bit-DWQ/tree/main) |

These are selectable examples, not a guarantee that every model will fit every Mac. Model
availability, repository contents, chat templates, tool-call behavior, and memory use can
change upstream. Any compatible MLX model ID can be entered in the provider's model field.

The `mlx://` prefix used internally by CoWork is a runtime marker that tells the Electron
server handler to launch MLX-LM. It is removed before the model ID is sent to the OpenAI API.
Users should normally enter the raw model ID, such as
`mlx-community/Qwen3-8B-4bit`, in Settings.

## Local API contract

CoWork launches the official MLX-LM server with the equivalent of:

```bash
python3 -m mlx_lm.server \
  --model mlx-community/Qwen3-8B-4bit \
  --port 8080
```

The server contract used by CoWork is:

| Request | Purpose |
|---------|---------|
| `GET http://localhost:8080/v1/models` | Readiness probe and model discovery |
| `POST http://localhost:8080/v1/chat/completions` | Normal and agentic model requests |

The provider sends OpenAI-compatible chat messages and can include tool definitions for
agentic tasks. MLX-LM and the selected model must support the relevant chat template and tool
format for tool-using tasks to work reliably.

CoWork normalizes these saved base-URL forms for `mlx` and the existing `hf-agents` provider:

- `http://localhost:8080` becomes `http://localhost:8080/v1`
- a trailing `/models` or `/chat/completions` is reduced to the API base first
- `/v1` is preserved without being duplicated
- internal `mlx://` model markers are removed from outgoing requests

## Runtime lifecycle

The integration is intentionally a small bridge over CoWork's existing provider abstraction:

1. The shared provider catalog registers `mlx` as an OpenAI-compatible local provider.
2. Settings initializes the base URL/model defaults and displays the MLX-specific controls.
3. Electron checks the platform, imports `mlx_lm` and `mlx.core`, and reports installation or
   dynamic-library errors without attempting to start an incompatible runtime.
4. **Start MLX Server** spawns `python3 -m mlx_lm.server --model <model> --port 8080`.
5. Electron polls `/v1/models`. Model download/loading can continue after the initial start
   request returns a downloading state.
6. CoWork's OpenAI-compatible provider sends requests to `/v1/chat/completions`.
7. Settings polls process status and the MLX stdout/stderr buffer and exposes **Stop Server**.

MLX-LM and HuggingFace Local AI share one CoWork-managed process slot and port (`8080`). Stop
the currently running local runtime before starting the other one. CoWork does not run both
local runtimes concurrently through these controls.

## Data, privacy, and security

- Model requests from CoWork target `localhost`; no MLX API key is needed.
- The first model launch can download model files from Hugging Face. After the files are cached,
  model execution remains on the Mac unless another integration or tool in the task is
  explicitly configured to call a remote service.
- Local model inference does not make connected tools local. Email, web search, channels, MCP
  connectors, and other integrations keep their own provider and network behavior.
- The MLX-LM server is a local development server, not an authenticated production gateway.
  Keep it bound to the local machine and do not expose port `8080` publicly.
- Do not paste secrets into model IDs, command arguments, or diagnostic logs. CoWork's local
  API key field is optional and should remain empty for this route.

## Current limitations

- MLX is Apple Silicon-only in the CoWork integration.
- Image attachments are not advertised as supported for the MLX provider.
- The Settings lifecycle currently uses the fixed local port `8080`.
- Only one CoWork-managed MLX/hf-agents local server can run at a time.
- Model download and initial loading can take several minutes and consume substantial unified
  memory. The server may be alive before `/v1/models` is ready.
- Tool calls depend on MLX-LM version, model chat template, and model-specific parser support.
- CoWork does not reimplement Lily's custom Rust/Metal kernels or promise the performance numbers
  in the Perplexity article.

## Troubleshooting

### “MLX-LM requires an Apple Silicon Mac”

The route only enables when Electron reports macOS `arm64`. Check that the Mac is Apple
Silicon and that CoWork is running natively rather than through an x86/Rosetta launch path.

### “MLX-LM is not installed”

Install and verify the package with the same command name used by CoWork:

```bash
python3 -m pip install --upgrade mlx-lm
python3 -c "import mlx_lm; import mlx.core; print('MLX-LM ready')"
```

Restart CoWork after installation so the desktop process refreshes its environment.

### “mlx_lm failed to import” or a missing `libmlx.dylib`

The package may be installed into a different interpreter, or the MLX native libraries may be
incomplete. First confirm the import command above. If the diagnostic specifically reports a
missing MLX dynamic library, reinstall the MLX runtime dependencies:

```bash
python3 -m pip install --upgrade --force-reinstall --no-cache-dir mlx mlx-metal
python3 -c "import mlx_lm; import mlx.core; print('MLX-LM ready')"
```

If the import still fails, inspect the Python environment and package versions before changing
the CoWork database or deleting model caches.

### The server stays in “Starting” or “Downloading”

Large model downloads and weight loading can exceed the initial readiness probe. Inspect the
live log in the MLX provider panel and wait while the process remains alive. You can also check
the endpoint manually:

```bash
curl http://localhost:8080/v1/models
```

If the process exits, read the final MLX log lines in Settings and rerun the import verification
command. Make sure the selected model repository is available and compatible.

### The endpoint returns 404

Use the OpenAI-compatible `/v1` base URL:

```text
http://localhost:8080/v1
```

CoWork automatically upgrades the older saved `http://localhost:8080` value for the MLX and
hf-agents providers. If you are calling the server manually, use `/v1/models` and
`/v1/chat/completions` rather than the root path.

### Port 8080 is already in use

Stop the existing local AI server or other service using port `8080`, then start MLX-LM from
CoWork again. The current Settings control does not expose a custom MLX port; the provider and
readiness probe must use the same port.

### A tool-using task fails while plain chat works

Tool support is model- and template-dependent. Update MLX-LM, try one of the catalogued Qwen
models, and confirm that the server is receiving a standard OpenAI-compatible tool request.
If the model's template does not support the tool format, use another model or a provider with
the required capability.

### MLX and hf-agents conflict

They share CoWork's `8080` process slot. Stop the active runtime before starting the other. Also
be aware that Python package changes made for one Hugging Face runtime can affect the other;
re-run both providers' installation checks after upgrading shared Python dependencies.

## Manual smoke test

To verify MLX-LM independently of CoWork:

```bash
python3 -c "import mlx_lm; import mlx.core; print('MLX-LM ready')"
python3 -m mlx_lm.server --model mlx-community/Qwen3-8B-4bit --port 8080
```

In another terminal, confirm readiness:

```bash
curl http://localhost:8080/v1/models
```

Stop the manual server with `Ctrl-C` before using CoWork's **Start MLX Server** button. Do not
run the manual server and CoWork's local-AI server controls against port `8080` at the same time.

## Maintainer notes

The implementation is intentionally dependency-light:

- `src/shared/llm-provider-catalog.ts` owns the provider name, default endpoint, and model list.
- `src/shared/types.ts` registers `mlx` in the provider union and display metadata.
- `src/shared/model-access.ts` and `src/shared/first-run-readiness.ts` classify it as a local
  provider without an API key.
- `src/electron/agent/llm/openai-compatible-provider.ts` owns `/v1` URL and model-marker
  normalization.
- `src/electron/ipc/handlers.ts` owns platform/package checks, subprocess lifecycle, readiness
  probes, and log/status reporting.
- `src/renderer/components/Settings.tsx` owns the provider status, model quick picks, and server
  controls.
- `src/electron/agent/llm/__tests__/mlx-provider.test.ts` covers endpoint normalization and
  outgoing model IDs; `src/shared/__tests__/first-run-readiness.test.ts` covers local readiness.

When adding a new MLX model, update the shared catalog, the Settings quick-pick list when it is
intended to be prominent, and this guide. Keep the raw Hugging Face model ID separate from the
internal `mlx://` runtime marker.

## Validation

The source integration is covered by the normal CoWork checks:

```bash
npx vitest run \
  src/electron/agent/llm/__tests__/mlx-provider.test.ts \
  src/shared/__tests__/first-run-readiness.test.ts \
  src/shared/__tests__/model-access.test.ts
npm run type-check
npm run build:electron
npm run build:react
```

These checks validate CoWork's wiring and HTTP contract. A live model download, Metal kernel
execution, throughput measurement, and memory-pressure check still require an Apple Silicon
machine with `mlx-lm` installed.
