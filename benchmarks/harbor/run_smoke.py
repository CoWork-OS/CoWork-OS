"""Run the four local CoWork OS native smoke oracles through pinned Harbor."""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import signal
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

from benchmarks.harbor.manifest import (
    HARBOR_VERSION,
    HARBOR_WHEEL_REFERENCE_SHA256,
    POLICY_CAPS,
    AdapterPreflightError,
    finalize_job,
    inspect_app_artifact,
    inspect_cache_archive,
    sha256_file,
    validate_run_config,
    write_manifest,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
CASES = {
    "positive": ("correct", "Create p04-result.txt containing exactly P04_NATIVE_HARBOR_OK, then read it back to verify the text."),
    "wrong": ("wrong", "Create p04-result.txt containing exactly P04_NATIVE_HARBOR_OK, then read it back to verify the text."),
    "no-proof": ("no-proof", "Create p04-result.txt containing exactly P04_NATIVE_HARBOR_OK, then read it back to verify the text."),
    "timeout": ("timeout", "Create p04-result.txt containing exactly P04_NATIVE_HARBOR_OK, then read it back to verify the text."),
}
EXPECTED_BYTES = b"P04_NATIVE_HARBOR_OK"
EXPECTED_ACCEPTANCE = {
    "positive": "passed",
    "wrong": "wrong_artifact",
    "no-proof": "no_proof",
    "timeout": "timeout",
}


def not_run_trial(case_name: str, reason: str) -> dict[str, Any]:
    return {
        "case": case_name,
        "fixtureCase": CASES[case_name][0],
        "acceptance": reason,
        "candidateStarted": False,
        "providerStarted": False,
        "verifierReward": None,
        "harborExitCode": None,
        "runIdentityMatches": None,
    }


def unknown_start_trial(case_name: str, reason: str) -> dict[str, Any]:
    return {
        "case": case_name,
        "fixtureCase": CASES[case_name][0],
        "acceptance": reason,
        "candidateStarted": None,
        "providerStarted": None,
        "verifierReward": None,
        "harborExitCode": None,
        "runIdentityMatches": None,
    }


def all_expected_outcomes(trials: list[dict[str, Any]]) -> bool:
    expected = [
        (name, CASES[name][0], EXPECTED_ACCEPTANCE[name])
        for name in CASES
    ]
    return len(trials) == len(expected) and all(
        trial.get("case") in (None, case_name)
        and trial.get("fixtureCase") == fixture_case
        and trial.get("acceptance") == acceptance
        and trial.get("harborExitCode") == 0
        and trial.get("runIdentityMatches") is True
        for trial, (case_name, fixture_case, acceptance) in zip(trials, expected)
    )


def verifier_script() -> str:
    expected = EXPECTED_BYTES.decode("ascii")
    return """#!/bin/sh
set -eu
actual=/workspace/p04-result.txt
expected=/tmp/p04-expected.txt
memory_limit_path=/sys/fs/cgroup/memory.max
memory_limit=
if [ -r "$memory_limit_path" ]; then
  memory_limit=$(cat "$memory_limit_path")
fi
memory_ok=0
case "$memory_limit" in
  ''|max|*[!0-9]*) ;;
  *) if [ "$memory_limit" -le 536870912 ]; then memory_ok=1; fi ;;
esac
printf '%s' '""" + expected + """' > "$expected"
if [ "$memory_ok" -eq 1 ] && [ -f "$actual" ] && cmp -s "$actual" "$expected"; then
  printf '1\\n' > /logs/verifier/reward.txt
  printf 'exact artifact verified; memory_cgroup_limit_bytes=%s\\n' "$memory_limit"
else
  printf '0\\n' > /logs/verifier/reward.txt
  printf 'exact artifact, separate verification, or bounded cgroup check failed; memory_cgroup_limit_bytes=%s\\n' "${memory_limit:-unknown}"
fi
"""


def _docker(*args: str, timeout: int = 30) -> str:
    try:
        result = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise AdapterPreflightError("missing_config", "Docker is unavailable or did not answer the bounded preflight") from error
    if result.returncode != 0:
        message = (result.stderr or result.stdout or "Docker command failed").strip()
        raise AdapterPreflightError("infrastructure_failed", message[:400])
    return result.stdout.strip()


def build_verifier_image(node_image: str) -> dict[str, str]:
    """Build a separate, offline verifier image from the already pinned runtime image."""
    inspect = _docker("image", "inspect", "--format", "{{.Os}}/{{.Architecture}}|{{json .RepoDigests}}", node_image)
    parts = inspect.split("|", 1)
    if len(parts) != 2 or parts[0] != "linux/amd64":
        raise AdapterPreflightError("unsupported", "pinned base image is not a locally installed linux/amd64 image")
    try:
        repo_digests = json.loads(parts[1])
    except json.JSONDecodeError as error:
        raise AdapterPreflightError("unsupported", "Docker did not report pinned base image digests") from error
    requested_digest = node_image.rsplit("@", 1)[1]
    if not isinstance(repo_digests, list) or not any(
        isinstance(item, str) and item == "node@" + requested_digest
        for item in repo_digests
    ):
        raise AdapterPreflightError("unsupported", "local base image digest does not match the requested image pin")

    script = verifier_script()
    dockerfile = "FROM --platform=linux/amd64 " + node_image + "\nCOPY test.sh /tests/test.sh\nRUN chmod 0555 /tests/test.sh\n"
    build_digest = hashlib.sha256((dockerfile + script).encode("utf-8")).hexdigest()
    tag = "cowork-os-p04-verifier:" + build_digest[:20]
    with tempfile.TemporaryDirectory(prefix="cowork-p04-verifier-") as temp:
        context = Path(temp)
        (context / "Dockerfile").write_text(dockerfile, encoding="utf-8")
        (context / "test.sh").write_text(script, encoding="utf-8")
        _docker("build", "--platform", "linux/amd64", "--network=none", "--pull=false", "--tag", tag, str(context), timeout=120)
    result = _docker("image", "inspect", "--format", "{{.Os}}/{{.Architecture}}|{{.Id}}", tag)
    image_parts = result.split("|", 1)
    if len(image_parts) != 2 or image_parts[0] != "linux/amd64" or not image_parts[1].startswith("sha256:"):
        raise AdapterPreflightError("unsupported", "built verifier image is not an inspectable linux/amd64 image")
    return {
        "tag": tag,
        "imageId": image_parts[1],
        "platform": image_parts[0],
        "baseImage": node_image,
        "buildContextSha256": build_digest,
        "graderSha256": hashlib.sha256(script.encode("utf-8")).hexdigest(),
    }


def materialize_task(task_root: Path, case_name: str, docker_image: str, verifier_image: str) -> Path:
    fixture_case, prompt = CASES[case_name]
    task_dir = task_root / case_name
    (task_dir / "tests").mkdir(parents=True, exist_ok=True)
    (task_dir / "environment").mkdir(parents=True, exist_ok=True)
    (task_dir / "environment" / "docker-compose.yaml").write_text(
        "services:\n  main:\n    platform: linux/amd64\n",
        encoding="utf-8",
    )
    task_toml = f'''schema_version = "1.4"
artifacts = ["/workspace/p04-result.txt"]

[metadata]
developer = "cowork-os"
benchmark = "CoWork OS P04 native Harbor smoke"
fixture_case = "{fixture_case}"

[agent]
timeout_sec = 90.0
user = "node"
network_mode = "no-network"

[verifier]
timeout_sec = 30.0
environment_mode = "separate"
network_mode = "no-network"

[verifier.environment]
docker_image = "{verifier_image}"
cpus = 1
memory_mb = 512
network_mode = "no-network"

[environment]
docker_image = "{docker_image}"
workdir = "/workspace"
cpus = 2
memory_mb = 1536
build_timeout_sec = 120.0
network_mode = "no-network"
'''
    (task_dir / "task.toml").write_text(task_toml, encoding="utf-8")
    marker = "<!-- cowork-p04-case=" + fixture_case + " -->"
    (task_dir / "instruction.md").write_text(marker + "\n\n" + prompt + "\n", encoding="utf-8")
    test_path = task_dir / "tests" / "test.sh"
    test_path.write_text(verifier_script(), encoding="utf-8")
    test_path.chmod(0o755)
    return task_dir


def _run_until_exit(command: list[str], *, env: dict[str, str], cwd: Path, deadline: float) -> tuple[int, str]:
    process = subprocess.Popen(
        command,
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    try:
        remaining = max(0.1, deadline - time.monotonic())
        output, _ = process.communicate(timeout=remaining)
        return process.returncode or 0, output[-12000:]
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGINT)
        except ProcessLookupError:
            pass
        try:
            output, _ = process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                output, _ = process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                output, _ = process.communicate()
        return 124, (output or "")[-12000:]


def _write_preflight_rejection(output_dir: Path, status: str, reason: str) -> None:
    write_manifest(output_dir / "preflight-rejection.json", {
        "schemaVersion": "cowork-os-harbor-run/v1",
        "developer": "cowork-os",
        "harborVersion": HARBOR_VERSION,
        "status": status,
        "reason": reason[:500],
        "policyCaps": dict(POLICY_CAPS),
        "candidateStarted": False,
        "providerStarted": False,
    })


class JobsRootConflict(RuntimeError):
    """Raised when a jobs directory may contain results from another run."""


def claim_jobs_root(output_dir: Path) -> str:
    """Exclusively claim an empty output root before any Docker or candidate work."""
    output_dir.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        output_dir.mkdir(mode=0o700)
    except FileExistsError:
        if not output_dir.is_dir():
            raise JobsRootConflict("jobs path exists and is not a directory")
        try:
            if any(output_dir.iterdir()):
                raise JobsRootConflict("jobs directory is not empty; choose a fresh --jobs-dir")
        except OSError as error:
            raise JobsRootConflict("jobs directory cannot be inspected safely") from error
    run_id = uuid.uuid4().hex
    claim_path = output_dir / "cowork-os-run-claim.json"
    claim = {
        "schemaVersion": "cowork-os-harbor-run-claim/v1",
        "developer": "cowork-os",
        "runId": run_id,
        "status": "claimed",
    }
    try:
        fd = os.open(claim_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as error:
        raise JobsRootConflict("jobs directory has already been claimed; choose a fresh --jobs-dir") from error
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump(claim, stream, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    if any(path != claim_path for path in output_dir.iterdir()):
        raise JobsRootConflict("jobs directory changed while it was being claimed")
    os.chmod(output_dir, 0o700)
    return run_id


def make_run_identity(
    run_id: str,
    *,
    harbor_version: str,
    package_mode: str,
    package: dict[str, Any],
    provider_mode: str,
    node_image: str,
    verifier_image: dict[str, Any],
    cache_sha256: str | None,
) -> dict[str, Any]:
    identity: dict[str, Any] = {
        "schemaVersion": "cowork-os-harbor-run-identity/v1",
        "runId": run_id,
        "harborVersion": harbor_version,
        "packageMode": package_mode,
        "package": package,
        "providerMode": provider_mode,
        "nodeImage": node_image,
        "verifierImage": verifier_image,
        "npmCacheSha256": cache_sha256,
        "policyCaps": dict(POLICY_CAPS),
    }
    canonical = json.dumps(identity, sort_keys=True, separators=(",", ":"), allow_nan=False)
    identity["identitySha256"] = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return identity


def _update_run_claim(output_dir: Path, run_id: str, status: str, run_identity: dict[str, Any] | None = None) -> None:
    claim = {
        "schemaVersion": "cowork-os-harbor-run-claim/v1",
        "developer": "cowork-os",
        "runId": run_id,
        "status": status,
    }
    if run_identity is not None:
        claim["runIdentity"] = run_identity
    write_manifest(output_dir / "cowork-os-run-claim.json", claim)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run CoWork OS local native Harbor smoke cases.")
    parser.add_argument("--provider-mode", required=True, choices=["fixture-zero-cost", "remote"])
    parser.add_argument("--package-mode", required=True, choices=["linux-server", "npm"])
    parser.add_argument("--app-artifact", type=Path, required=True)
    parser.add_argument("--app-sha256", required=True)
    parser.add_argument("--node-image", required=True)
    parser.add_argument("--jobs-dir", type=Path, required=True)
    parser.add_argument("--npm-cache-archive", type=Path)
    parser.add_argument("--npm-cache-sha256")
    return parser.parse_args()


def run() -> int:
    args = _parse_args()
    output_dir = args.jobs_dir.expanduser().resolve()
    try:
        run_id = claim_jobs_root(output_dir)
    except JobsRootConflict as error:
        print("jobs_root_conflict: " + str(error), file=sys.stderr)
        return 2

    harbor_executable = os.environ.get("COWORK_P04_HARBOR_BIN") or "harbor"
    harbor_path = shutil.which(harbor_executable)
    if not harbor_path:
        reason = "pinned Harbor CLI is not installed or not on PATH"
        _write_preflight_rejection(output_dir, "missing_config", reason)
        _update_run_claim(output_dir, run_id, "preflight_rejected")
        print("missing_config: " + reason, file=sys.stderr)
        return 2

    try:
        config = validate_run_config({
            "provider_mode": args.provider_mode,
            "node_image": args.node_image,
            "attempts": 1,
            "max_task_seconds": 24,
            "max_job_seconds": POLICY_CAPS["maxJobSeconds"],
            "max_tokens": POLICY_CAPS["maxTokens"],
            "max_model_turns": POLICY_CAPS["maxModelTurns"],
        })
        harbor_version = importlib.metadata.version("harbor")
        if harbor_version != HARBOR_VERSION:
            raise AdapterPreflightError("unsupported", "install the exact Harbor version " + HARBOR_VERSION)
        app = args.app_artifact.expanduser().resolve()
        package = inspect_app_artifact(app, args.package_mode, args.app_sha256)
        verifier_image = build_verifier_image(config["nodeImage"])
        cache: dict[str, Any] | None = None
        if args.package_mode == "npm":
            if args.npm_cache_archive is None or not args.npm_cache_sha256:
                raise AdapterPreflightError("missing_config", "npm mode requires an exact offline npm cache archive and SHA-256")
            cache = inspect_cache_archive(args.npm_cache_archive.expanduser().resolve(), args.npm_cache_sha256)
    except AdapterPreflightError as error:
        _write_preflight_rejection(output_dir, error.status, str(error))
        _update_run_claim(output_dir, run_id, "preflight_rejected")
        print(error.status + ": " + str(error), file=sys.stderr)
        return 2
    except Exception as error:
        _write_preflight_rejection(output_dir, "missing_config", str(error))
        _update_run_claim(output_dir, run_id, "preflight_rejected")
        print("missing_config: " + str(error), file=sys.stderr)
        return 2

    run_identity = make_run_identity(
        run_id,
        harbor_version=harbor_version,
        package_mode=args.package_mode,
        package=package,
        provider_mode=args.provider_mode,
        node_image=config["nodeImage"],
        verifier_image=verifier_image,
        cache_sha256=str(cache["sha256"]) if cache is not None else None,
    )
    _update_run_claim(output_dir, run_id, "running", run_identity)
    started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    job_start = time.monotonic()
    final_results: list[dict[str, Any]] = []
    env = os.environ.copy()
    env["PYTHONPATH"] = str(REPO_ROOT) + os.pathsep + env.get("PYTHONPATH", "")
    env.update({
        "COWORK_P04_PROVIDER_MODE": args.provider_mode,
        "COWORK_P04_PACKAGE_MODE": args.package_mode,
        "COWORK_P04_APP_ARTIFACT": str(app),
        "COWORK_P04_APP_SHA256": args.app_sha256.lower(),
        "COWORK_P04_NODE_IMAGE": config["nodeImage"],
        "COWORK_P04_ATTEMPTS": "1",
        "COWORK_P04_TASK_SECONDS": str(POLICY_CAPS["maxTaskSeconds"]),
        "COWORK_P04_JOB_SECONDS": str(POLICY_CAPS["maxJobSeconds"]),
        "COWORK_P04_TOKEN_CAP": str(POLICY_CAPS["maxTokens"]),
        "COWORK_P04_MAX_TURNS": str(config["maxModelTurns"]),
        "COWORK_P04_RUN_IDENTITY": json.dumps(run_identity, sort_keys=True, separators=(",", ":")),
    })
    if cache is not None:
        env["COWORK_P04_NPM_CACHE_ARCHIVE"] = str(args.npm_cache_archive.expanduser().resolve())
        env["COWORK_P04_NPM_CACHE_SHA256"] = str(cache["sha256"])

    task_workspace: Path | None = None
    try:
        task_workspace = Path(tempfile.mkdtemp(prefix="cowork-p04-tasks-"))
        os.chmod(task_workspace, 0o700)
        case_names = list(CASES)
        for case_index, case_name in enumerate(case_names):
            remaining = POLICY_CAPS["maxJobSeconds"] - (time.monotonic() - job_start)
            if remaining <= 0:
                final_results.extend(
                    not_run_trial(name, "not_run_job_deadline")
                    for name in case_names[case_index:]
                )
                break
            task_dir = materialize_task(task_workspace, case_name, config["nodeImage"], verifier_image["tag"])
            job_name = "p04-" + case_name.replace("_", "-")
            case_jobs_dir = output_dir / case_name
            command = [
                harbor_path, "run",
                "--path", str(task_dir),
                "--agent", "benchmarks.harbor.cowork_agent:CoWorkOSNativeAgent",
                "--n-attempts", "1",
                "--n-concurrent", "1",
                "--max-retries", "0",
                "--timeout-multiplier", "1",
                "--jobs-dir", str(case_jobs_dir),
                "--job-name", job_name,
            ]
            deadline = min(time.monotonic() + remaining, job_start + POLICY_CAPS["maxJobSeconds"])
            exit_code, _output = _run_until_exit(command, env=env, cwd=REPO_ROOT, deadline=deadline)
            job_dir = case_jobs_dir / job_name
            if job_dir.exists():
                finalized = finalize_job(job_dir, expected_run_identity=run_identity)
                trials = finalized.get("trials", [])
                if trials:
                    for trial in trials:
                        trial["case"] = case_name
                        trial["harborExitCode"] = exit_code
                        trial["observedAcceptance"] = trial.get("acceptance")
                        if exit_code != 0:
                            trial["acceptance"] = "harbor_nonzero_exit"
                    final_results.extend(trials)
                else:
                    final_results.append({
                        **unknown_start_trial(case_name, "timeout" if exit_code == 124 else "missing_trial_result"),
                        "harborExitCode": exit_code,
                    })
            else:
                final_results.append({
                    **unknown_start_trial(case_name, "timeout" if exit_code == 124 else "harbor_job_failed"),
                    "harborExitCode": exit_code,
                })
            if exit_code == 124:
                final_results.extend(
                    not_run_trial(name, "not_run_after_deadline")
                    for name in case_names[case_index + 1:]
                )
                break
    finally:
        if task_workspace is not None:
            try:
                shutil.rmtree(task_workspace)
            except OSError:
                pass

    succeeded = all_expected_outcomes(final_results)
    run_manifest = {
        "schemaVersion": "cowork-os-harbor-run/v1",
        "developer": "cowork-os",
        "harborVersion": harbor_version,
        "harborVersionStatus": "verified",
        "harborWheelReferenceSha256": HARBOR_WHEEL_REFERENCE_SHA256,
        "harborWheelIntegrityStatus": "unverified",
        "startedAt": started_at,
        "runIdentity": run_identity,
        "status": "passed" if succeeded else "failed",
        "package": package,
        "nodeImage": config["nodeImage"],
        "verifierImage": verifier_image,
        "providerMode": args.provider_mode,
        "runtimeArchitecture": "linux/amd64",
        "policyCaps": dict(POLICY_CAPS),
        "trialCount": len(final_results),
        "trials": final_results,
    }
    write_manifest(output_dir / "cowork-os-run-manifest.json", run_manifest)
    _update_run_claim(output_dir, run_id, "completed" if succeeded else "failed", run_identity)
    print(json.dumps({"manifest": str(output_dir / "cowork-os-run-manifest.json"), "trials": len(final_results)}, indent=2))
    return 0 if succeeded else 1


if __name__ == "__main__":
    raise SystemExit(run())
