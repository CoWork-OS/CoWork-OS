# CoWork OS native Harbor adapter

This directory contains a bounded installed-agent adapter for the CoWork OS Node-only Linux runtime. Harbor owns the task lifecycle and the independent verifier; the adapter starts an isolated `coworkd-node`, drives its local Control Plane only through the installed `coworkctl`, records observed usage and cleanup, and never assigns verifier reward.

The first runnable acceptance set is four disposable native file-task smoke cases: correct output, incorrect output, no proof, and task timeout. The 24-task pilot catalog remains design data and is not claimed runnable by this adapter.

## Pinned inputs

- Harbor: `0.23.0`, Python `>=3.12`; the runner enforces the installed version. `8747400dbb2a5e2298e1338e17e88eba38433c0433fd700f34d1a9021bba5c37` is a reference wheel SHA-256 only. This slice does not inspect or verify the installed wheel's integrity.
- Linux runtime image: `node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c` (linux/amd64 image reference). Run manifests retain the full image reference.
- Installed-package validation evidence: CoWork OS server bundle `v0.5.54` from source commit `27b5027a94b16d21b00caeb0f5aeba0f4ece25fe`, SHA-256 `5e773121e9759dd14cef8925c501127cc5dfc4cc6607e58c2ee1381d1b19cfbd`. The acceptance bundle was built for linux/amd64 in a pinned Node 24.14.1 container. Supply the bundle path and trusted build digest explicitly when running the adapter.

The runner checks every app artifact against an explicit SHA-256 and inspects the package metadata and archive paths before Harbor starts. Linux-server mode requires the Node daemon, Control Plane CLI, and built daemon entrypoint, and refuses direct or nested Electron packages. NPM mode also requires a separately pinned offline npm cache; the task container has no network. There is no floating image or application package tag.

## Run the local acceptance set

Use a Linux host with Docker and cgroup v2 enabled, Python 3.12 or newer, the pinned Harbor package, and the pinned Node image available locally. First build or obtain the Linux server bundle from a trusted build record, then set `APP_ARTIFACT` to that file and `APP_SHA256` to its recorded digest. The values below point to a validation artifact and are examples; they do not assume a shared temporary directory:

```sh
APP_ARTIFACT=/absolute/path/to/cowork-os-server-linux-x64-v0.5.54.tar.gz
APP_SHA256=5e773121e9759dd14cef8925c501127cc5dfc4cc6607e58c2ee1381d1b19cfbd
python3 -m venv /private/tmp/p04-harbor-venv
/private/tmp/p04-harbor-venv/bin/python -m pip install -r benchmarks/harbor/requirements.txt
docker pull node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c
sha256sum "$APP_ARTIFACT"
```

Then run the four cases with the recorded image and app pins:

```sh
PYTHONPATH="$PWD" /private/tmp/p04-harbor-venv/bin/python -m benchmarks.harbor.run_smoke \
  --provider-mode fixture-zero-cost \
  --package-mode linux-server \
  --app-artifact "$APP_ARTIFACT" \
  --app-sha256 "$APP_SHA256" \
  --node-image node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c \
  --jobs-dir /private/tmp/p04-harbor-jobs
```

The runner claims a new empty `--jobs-dir` before Docker, Harbor, or candidate work. Reusing a nonempty directory, including one with copied result files, is refused without changing its contents; choose a fresh path for every run. The run claim binds a unique identity to the package digest, Harbor version, provider mode, Node and verifier images, npm cache pin, and policy caps. Each adapter manifest must carry that identity, and each Harbor invocation must exit zero before any oracle outcome can count as success. Nonzero Harbor exits retain available result rows with their observed oracle labels, but force an overall failed run.

The runner refuses `--provider-mode remote` before starting a candidate. Remote calls remain unsupported until a provider can reserve a hard spend bound before execution. The local Ollama-compatible fixture is served inside each isolated no-network task container. It admits at most 12 model turns at zero external spend. The manifest reports admitted turns separately from HTTP attempts, rejected retry requests, completed responses, and fixture token totals; an incomplete response leaves fixture token usage partial. The native task has an eight-turn hard window, and its token budget is capped at 2,048. `usage.status=missing` means this adapter did not extract a canonical `type=llm_usage` event from supported timeline fields. It does not establish that the runtime emitted no usage; `legacyType` and wrapper forms are not interpreted in this slice. Runtime telemetry cost remains unknown unless a recognized event marks it known.

Before any candidate/provider work, the runner derives and builds a uniquely tagged verifier-only image from the already installed pinned Node image using an offline Docker build. Harbor 0.23 does not upload task tests into a separate verifier container, so the independent grader is embedded in this image and is never copied into the candidate runtime. The candidate and verifier use separate images, containers, and writable surfaces. Each case is a separate Harbor job with one attempt, no retries, no parallel trials, a 24-second CoWork task deadline, a 30-second verifier deadline, and a shared 600-second wall-clock ceiling for the set. The agent container is limited to 1.5 GiB; the independent verifier container is limited to 512 MiB. The verifier reads its cgroup-v2 `memory.max`, refuses missing, unlimited, malformed, or above-512-MiB values, and records the observed byte limit in verifier output. The Linux smoke returns success only when the correct case receives verifier reward 1 and the wrong, no-proof, and timeout cases receive verifier reward 0 with bounded verifier memory and successful process/profile cleanup.

For any later PDF task, set the candidate and verifier environments to `memory_mb = 512` or lower and make both sides verify a numeric cgroup-v2 limit no greater than `536870912` bytes. A verifier-only limit does not establish the candidate's PDF-process bound.

## Run manifests

The output directory contains `cowork-os-run-manifest.json`, `cowork-os-run-claim.json`, and the full Harbor job directories. The run manifest records the enforced Harbor version, the reference-only wheel digest with `harborWheelIntegrityStatus: unverified`, package/image hashes, provider mode, caps, and one result per case. Each trial record contains:

- candidate task/workspace IDs, terminal status, elapsed time, and cleanup status;
- Control Plane timeline event counts, token usage, and whether totals are complete or partial; unavailable usage and unknown telemetry cost remain `null`/unknown;
- collected artifact path, byte size, and SHA-256;
- the reward returned by Harbor's **separate verifier**, plus the observed verifier cgroup limit;
- an acceptance label that checks the expected oracle outcome for that fixture.

The host-only `cowork-os-adapter-manifest.json` is written beside the agent logs, outside `/workspace`. Harbor invokes the grader in its separate verifier environment after the candidate environment stops; the grader exists only in the verifier image, and the candidate cannot write verifier logs or reward files. Missing configuration, unsupported runtime/package/provider settings, a missing verifier result, incomplete evidence, and cleanup failures never count as success. Preflight refusals record no reward because no verifier ran.

## Focused checks

```sh
PYTHONPATH="$PWD" /private/tmp/p04-harbor-venv/bin/python -m unittest discover -s benchmarks/harbor/tests -v
PYTHONPATH="$PWD" /private/tmp/p04-harbor-venv/bin/python -m py_compile benchmarks/harbor/*.py
node --check benchmarks/harbor/runtime.cjs
node --check benchmarks/harbor/mock_ollama.cjs
```

The unit tests cover fixed-cap and artifact refusal, known-correct/wrong/missing outputs, candidate-claim versus verifier-reward separation, missing/truncated usage, and fail-closed verifier-memory evidence. They do not replace the installed-package Linux run above.

## Manifest preflight statuses

- `missing_config`: required pins or positive cap values are absent, or Harbor is not available.
- `unsupported`: requested remote provider execution, invalid package mode, unsafe or mismatched artifact, unsupported Harbor/runtime version, Electron dependency, or any cap above policy.
- `passed`: emitted only for the correct fixture after Harbor reports a separate-verifier reward of 1, the candidate completed, bounded verifier memory was observed, and cleanup succeeded.
- `wrong_artifact`, `no_proof`, `timeout`: expected negative fixture outcomes; each requires the separate verifier to report reward 0.
- Other verification, timeout, runtime, memory, and cleanup failures remain explicit non-success outcomes.

All benchmark artifacts use the exact developer attribution `cowork-os`.
