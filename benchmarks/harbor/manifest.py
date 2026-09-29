"""Fail-closed preflight, usage, and Harbor-result manifest helpers."""
from __future__ import annotations

import hashlib
import json
import os
import re
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

HARBOR_VERSION = "0.23.0"
HARBOR_WHEEL_REFERENCE_SHA256 = "8747400dbb2a5e2298e1338e17e88eba38433c0433fd700f34d1a9021bba5c37"
POLICY_CAPS = {
    "attempts": 1,
    "maxTaskSeconds": 24,
    "maxHarborAgentSeconds": 90,
    "maxJobSeconds": 600,
    "maxVerifierSeconds": 30,
    "maxTokens": 2048,
    "maxModelTurns": 8,
    "maxModelRequests": 12,
    "externalSpendCapUsd": 0.0,
}
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
NODE_IMAGE_RE = re.compile(
    r"^node:24\.14\.1-bookworm-slim@sha256:[0-9a-f]{64}$"
)


class AdapterPreflightError(RuntimeError):
    def __init__(self, status: str, message: str):
        super().__init__(message)
        self.status = status


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_node_image(image: str) -> str:
    image = image.strip()
    if not NODE_IMAGE_RE.fullmatch(image):
        raise AdapterPreflightError(
            "missing_config",
            "COWORK_P04_NODE_IMAGE must pin node:24.14.1-bookworm-slim by sha256 digest",
        )
    return image


def _archive_package_json(path: Path, package_mode: str) -> tuple[str, dict[str, Any], set[str]]:
    try:
        archive = tarfile.open(path, mode="r:gz")
    except (OSError, tarfile.TarError) as exc:
        raise AdapterPreflightError("missing_config", "app artifact is not a readable gzip tarball") from exc

    with archive:
        members = archive.getmembers()
        names: set[str] = set()
        package_names: list[str] = []
        for member in members:
            name = member.name
            pure = PurePosixPath(name)
            if pure.is_absolute() or ".." in pure.parts:
                raise AdapterPreflightError("unsupported", "app artifact contains an unsafe archive path")
            names.add(name.rstrip("/"))
            if package_mode == "linux-server" and len(pure.parts) == 2 and name.endswith("/package.json"):
                package_names.append(name)
            elif package_mode == "npm" and name == "package/package.json":
                package_names.append(name)
        if len(package_names) != 1:
            raise AdapterPreflightError("unsupported", "app artifact must contain exactly one package.json")
        package_file = archive.extractfile(package_names[0])
        if package_file is None:
            raise AdapterPreflightError("unsupported", "app artifact package.json is unreadable")
        try:
            package = json.load(package_file)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise AdapterPreflightError("unsupported", "app artifact package.json is invalid") from exc
        return package_names[0], package, names


def inspect_app_artifact(path: Path, package_mode: str, expected_sha256: str) -> dict[str, Any]:
    if package_mode not in {"linux-server", "npm"}:
        raise AdapterPreflightError("unsupported", "package mode must be linux-server or npm")
    if not path.is_file():
        raise AdapterPreflightError("missing_config", "pinned CoWork OS app artifact is missing")
    expected_sha256 = expected_sha256.strip().lower()
    if not SHA256_RE.fullmatch(expected_sha256):
        raise AdapterPreflightError("missing_config", "an exact app artifact SHA-256 is required")
    actual_sha256 = sha256_file(path)
    if actual_sha256 != expected_sha256:
        raise AdapterPreflightError("unsupported", "app artifact SHA-256 does not match the declared pin")

    package_json_path, package, names = _archive_package_json(path, package_mode)
    dependencies = {
        **(package.get("dependencies") or {}),
        **(package.get("optionalDependencies") or {}),
    }
    electron_refs = sorted(
        name
        for name in dependencies
        if name in {"electron", "electron-updater", "@electron/rebuild"}
    )
    if electron_refs:
        raise AdapterPreflightError(
            "unsupported",
            "Linux acceptance refuses app packages with Electron dependencies: " + ", ".join(electron_refs),
        )
    if package_mode == "linux-server":
        root = package_json_path.removesuffix("/package.json")
        required = {
            root + "/bin/coworkd-node.js",
            root + "/bin/coworkctl.js",
            root + "/dist/daemon/daemon/main.js",
        }
        if not required.issubset(names):
            raise AdapterPreflightError("unsupported", "Linux server artifact is missing daemon or coworkctl entrypoints")
        if any(
            "/node_modules/electron/" in "/" + name + "/"
            or "/node_modules/electron-updater/" in "/" + name + "/"
            or "/node_modules/@electron/rebuild/" in "/" + name + "/"
            for name in names
        ):
            raise AdapterPreflightError("unsupported", "Linux server artifact contains an Electron package")
    else:
        if "package/bin/coworkd-node.js" not in names or "package/bin/coworkctl.js" not in names:
            raise AdapterPreflightError("unsupported", "npm artifact is missing coworkd-node or coworkctl")
    return {
        "mode": package_mode,
        "pathName": path.name,
        "sha256": actual_sha256,
        "packageName": str(package.get("name") or ""),
        "packageVersion": str(package.get("version") or ""),
        "electronDependencyPresent": bool(electron_refs),
    }


def validate_run_config(config: dict[str, Any]) -> dict[str, Any]:
    provider_mode = str(config.get("provider_mode") or "").strip()
    if not provider_mode:
        raise AdapterPreflightError("missing_config", "provider mode is required; choose fixture-zero-cost explicitly")
    if provider_mode != "fixture-zero-cost":
        raise AdapterPreflightError(
            "unsupported",
            "remote provider execution is disabled until provider-enforced spend reservation is implemented",
        )
    image = validate_node_image(str(config.get("node_image") or ""))
    if config.get("attempts") != POLICY_CAPS["attempts"]:
        raise AdapterPreflightError("unsupported", "P04 smoke runs are pinned to one attempt and no retries")
    task_seconds = int(config.get("max_task_seconds") or 0)
    if task_seconds < 1:
        raise AdapterPreflightError("missing_config", "a positive task deadline is required")
    if task_seconds != POLICY_CAPS["maxTaskSeconds"]:
        raise AdapterPreflightError("unsupported", "the pinned P04 smoke requires its exact task deadline")
    job_seconds = int(config.get("max_job_seconds") or 0)
    if job_seconds < 1:
        raise AdapterPreflightError("missing_config", "a positive job deadline is required")
    if job_seconds != POLICY_CAPS["maxJobSeconds"]:
        raise AdapterPreflightError("unsupported", "the pinned P04 smoke requires its exact job deadline")
    token_cap = int(config.get("max_tokens") or 0)
    if token_cap < 1:
        raise AdapterPreflightError("missing_config", "a positive token budget is required")
    if token_cap != POLICY_CAPS["maxTokens"]:
        raise AdapterPreflightError("unsupported", "the pinned P04 smoke requires its exact token budget")
    model_turns = int(config.get("max_model_turns") or 0)
    if model_turns < 1:
        raise AdapterPreflightError("missing_config", "a positive native model-turn limit is required")
    if model_turns != POLICY_CAPS["maxModelTurns"]:
        raise AdapterPreflightError("unsupported", "the pinned P04 smoke requires its exact native model-turn limit")
    return {
        "providerMode": provider_mode,
        "nodeImage": image,
        "maxModelTurns": model_turns,
        "caps": dict(POLICY_CAPS),
        "networkPolicy": "no-network",
    }


def aggregate_timeline_usage(pages: list[dict[str, Any]]) -> dict[str, Any]:
    tokens = {"inputTokens": 0, "outputTokens": 0, "cachedTokens": 0}
    usage_events = 0
    truncated = False
    has_more = bool(pages and pages[-1].get("hasMoreHistory") is True)
    last_totals: dict[str, Any] | None = None
    event_count = 0
    # Harbor reads timeline pages newest-first; events within each page are
    # chronological. Walk oldest-to-newest so the final totals belong to the
    # newest usage event while deltas remain an independent sum.
    for page in reversed(pages):
        events = page.get("events")
        if not isinstance(events, list):
            truncated = True
            continue
        event_count += len(events)
        summary = page.get("summary") if isinstance(page.get("summary"), dict) else {}
        truncated = truncated or int(summary.get("truncatedEventCount") or 0) > 0
        for event in events:
            if not isinstance(event, dict) or event.get("type") != "llm_usage":
                continue
            usage_events += 1
            payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
            delta = payload.get("delta") if isinstance(payload.get("delta"), dict) else {}
            for key in tokens:
                value = delta.get(key)
                if isinstance(value, (int, float)) and value >= 0:
                    tokens[key] += int(value)
                else:
                    truncated = True
            totals = payload.get("totals")
            if isinstance(totals, dict):
                last_totals = totals

    if usage_events == 0:
        return {
            "status": "missing",
            "source": "coworkctl task.timelinePage",
            "eventCount": event_count,
            "usageEventCount": 0,
            "tokens": None,
            "telemetryCostUsd": None,
            "telemetryCostKnown": False,
            "externalSpendCapUsd": 0.0,
            "limitation": "canonical type=llm_usage events only; missing means none were extracted, not that the runtime emitted none",
        }

    complete = not truncated and not has_more
    observed_deltas = dict(tokens)
    reported_tokens = dict(tokens)
    if last_totals:
        for key, target in (("inputTokens", "inputTokens"), ("outputTokens", "outputTokens")):
            value = last_totals.get(key)
            if isinstance(value, (int, float)) and value >= 0:
                reported_tokens[target] = int(value)
            else:
                complete = False
        cache_value = last_totals.get("cachedTokens")
        if isinstance(cache_value, (int, float)) and cache_value >= 0:
            reported_tokens["cachedTokens"] = int(cache_value)

    cost_known = bool(last_totals and last_totals.get("costKnown") is True)
    telemetry_cost = last_totals.get("cost") if cost_known else None
    return {
        "status": "complete" if complete else "partial",
        "source": "coworkctl task.timelinePage",
        "eventCount": event_count,
        "usageEventCount": usage_events,
        "tokens": reported_tokens if complete else None,
        "observedTokenDeltas": observed_deltas,
        "telemetryCostUsd": float(telemetry_cost) if isinstance(telemetry_cost, (int, float)) and cost_known else None,
        "telemetryCostKnown": cost_known,
        "externalSpendCapUsd": 0.0,
        "externalSpendBasis": "local fixture provider in a no-network task container",
    }


def manifest_path_for_agent(logs_dir: Path) -> Path:
    # Harbor mounts the agent log directory at /logs/agent; this sibling is host-only.
    return logs_dir.parent / "cowork-os-adapter-manifest.json"


def write_manifest(path: Path, manifest: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=".p04-manifest-", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(manifest, stream, sort_keys=True, indent=2, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_name, path)
        os.chmod(path, 0o600)
    finally:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass


def finalize_job(
    job_dir: Path,
    output_path: Path | None = None,
    *,
    expected_run_identity: dict[str, Any] | None = None,
) -> dict[str, Any]:
    trials: list[dict[str, Any]] = []
    for result_path in sorted(job_dir.rglob("result.json")):
        if result_path.name != "result.json" or result_path.parent == job_dir:
            continue
        adapter_path = result_path.parent / "cowork-os-adapter-manifest.json"
        try:
            harbor_result = json.loads(result_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            harbor_result = {}
        try:
            adapter = json.loads(adapter_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            adapter = {"schemaVersion": "cowork-os-harbor-adapter/v1", "candidate": {"status": "missing_manifest"}}

        verifier_result = harbor_result.get("verifier_result")
        rewards = verifier_result.get("rewards") if isinstance(verifier_result, dict) else None
        verifier_reward = rewards.get("reward") if isinstance(rewards, dict) else None
        reward_is_pass = isinstance(verifier_reward, (int, float)) and not isinstance(verifier_reward, bool) and verifier_reward == 1
        reward_is_fail = isinstance(verifier_reward, (int, float)) and not isinstance(verifier_reward, bool) and verifier_reward == 0
        candidate = adapter.get("candidate") if isinstance(adapter.get("candidate"), dict) else {}
        cleanup = adapter.get("cleanup") if isinstance(adapter.get("cleanup"), dict) else {}
        candidate_status = candidate.get("status")
        cleanup_ok = cleanup.get("status") == "succeeded"
        run_identity_matches = (
            expected_run_identity is not None
            and adapter.get("runIdentity") == expected_run_identity
        )
        fixture_case = adapter.get("fixtureCase")
        expected_task_names = {
            "correct": "positive",
            "wrong": "wrong",
            "no-proof": "no-proof",
            "timeout": "timeout",
        }
        task_identity_matches = (
            isinstance(fixture_case, str)
            and expected_task_names.get(fixture_case) == harbor_result.get("task_name")
        )
        exception_info = harbor_result.get("exception_info")
        harbor_trial_ok = exception_info is None and harbor_result.get("verifier_environment_mode") == "separate"
        verifier_stdout_path = result_path.parent / "verifier" / "test-stdout.txt"
        verifier_stdout = ""
        try:
            verifier_stdout = verifier_stdout_path.read_text(encoding="utf-8")
        except OSError:
            pass
        memory_match = re.search(r"memory_cgroup_limit_bytes=([0-9]+)", verifier_stdout)
        memory_limit_bytes = int(memory_match.group(1)) if memory_match else None
        memory_ok = memory_limit_bytes is not None and memory_limit_bytes <= 512 * 1024 * 1024
        if not run_identity_matches or not task_identity_matches:
            acceptance = "run_identity_mismatch"
        elif candidate_status in {"unsupported", "missing_config"}:
            acceptance = candidate_status
        elif not harbor_trial_ok:
            acceptance = "harbor_trial_failed_or_unverified"
        elif not memory_ok:
            acceptance = "verifier_memory_unbounded_or_unverified"
        elif not cleanup_ok:
            acceptance = "cleanup_failed"
        elif candidate_status == "timeout" and reward_is_fail:
            acceptance = "timeout"
        elif candidate_status == "completed" and reward_is_pass:
            acceptance = "passed" if adapter.get("fixtureCase") == "correct" else "oracle_mismatch"
        elif (
            candidate_status in {"completed", "failed"}
            and not candidate.get("error")
            and candidate.get("terminalStatus") in {"completed", "failed"}
            and reward_is_fail
            and adapter.get("fixtureCase") == "wrong"
        ):
            acceptance = "wrong_artifact"
        elif (
            candidate_status in {"completed", "failed"}
            and not candidate.get("error")
            and candidate.get("terminalStatus") in {"completed", "failed"}
            and reward_is_fail
            and adapter.get("fixtureCase") == "no-proof"
        ):
            acceptance = "no_proof"
        else:
            acceptance = "verification_failed"

        artifact = result_path.parent / "artifacts" / "workspace" / "p04-result.txt"
        artifact_record: dict[str, Any] = {"path": "artifacts/workspace/p04-result.txt", "exists": artifact.is_file()}
        if artifact.is_file():
            artifact_record["sha256"] = sha256_file(artifact)
            artifact_record["sizeBytes"] = artifact.stat().st_size

        trials.append({
            "trialName": harbor_result.get("trial_name"),
            "taskName": harbor_result.get("task_name"),
            "fixtureCase": fixture_case,
            "runIdentityMatches": run_identity_matches and task_identity_matches,
            "runIdentity": adapter.get("runIdentity"),
            "harborResultPath": str(result_path),
            "adapterManifestPath": str(adapter_path),
            "candidate": candidate,
            "usage": adapter.get("usage", {
                "status": "missing",
                "limitation": "canonical type=llm_usage events only; missing means none were extracted, not that the runtime emitted none",
            }),
            "cleanup": cleanup,
            "artifact": artifact_record,
            "verifier": {
                "owner": "Harbor separate verifier",
                "reward": verifier_reward,
                "rewards": rewards,
                "stdoutPath": str(verifier_stdout_path),
                "memoryCgroupLimitBytes": memory_limit_bytes,
                "memoryLimitCapBytes": 512 * 1024 * 1024,
                "memoryLimitVerified": memory_ok,
            },
            "harborException": exception_info,
            "acceptance": acceptance,
        })

    output = {
        "schemaVersion": "cowork-os-harbor-run/v1",
        "developer": "cowork-os",
        "harborVersion": HARBOR_VERSION,
        "startedAt": utc_now(),
        "policyCaps": dict(POLICY_CAPS),
        "trialCount": len(trials),
        "trials": trials,
    }
    target = output_path or (job_dir / "cowork-os-run-manifest.json")
    write_manifest(target, output)
    return output


def inspect_cache_archive(path: Path, expected_sha256: str) -> dict[str, Any]:
    """Validate an optional, explicitly pinned offline npm cache archive."""
    if not path.is_file():
        raise AdapterPreflightError("missing_config", "pinned offline npm cache archive is missing")
    expected = expected_sha256.strip().lower()
    if not SHA256_RE.fullmatch(expected):
        raise AdapterPreflightError("missing_config", "an exact npm cache SHA-256 is required")
    actual = sha256_file(path)
    if actual != expected:
        raise AdapterPreflightError("unsupported", "offline npm cache SHA-256 does not match its pin")
    try:
        with tarfile.open(path, mode="r:gz") as archive:
            members = archive.getmembers()
            if not members:
                raise AdapterPreflightError("unsupported", "offline npm cache archive is empty")
            for member in members:
                pure = PurePosixPath(member.name)
                if pure.is_absolute() or ".." in pure.parts:
                    raise AdapterPreflightError("unsupported", "offline npm cache contains an unsafe archive path")
    except (OSError, tarfile.TarError) as error:
        raise AdapterPreflightError("missing_config", "offline npm cache is not a readable gzip tarball") from error
    return {"sha256": actual, "pathName": path.name}
