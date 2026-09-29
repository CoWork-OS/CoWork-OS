#!/usr/bin/env python3
"""Materialize and validate the two bounded CoWork OS development fixtures."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Any

BASE = Path(__file__).resolve().parent
REPO = BASE.parents[1]
IMAGE = "node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c"
EXPECTED_NODE = "v24.14.1"
CENT = Decimal("0.01")
MAX_STDOUT = 64 * 1024
MAX_STDERR = 16 * 1024
CONTAINER_TIMEOUT_SECONDS = 12
RUN_ID_RE = re.compile(r"^\d{8}T\d{6}Z-[0-9a-f]{12}$")


class PilotError(Exception):
    pass


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def locked_entries() -> dict[str, dict[str, str]]:
    lock_path = BASE / "HASHES.json"
    if not lock_path.is_file():
        raise PilotError("HASHES.json is missing; the fixture lock must be present")
    lock = read_json(lock_path)
    if lock.get("schema") != "cowork-os-pilot-hashes-v1":
        raise PilotError("unsupported HASHES.json schema")
    entries = lock.get("files")
    if not isinstance(entries, list) or not entries:
        raise PilotError("HASHES.json has no file entries")
    result: dict[str, dict[str, str]] = {}
    for entry in entries:
        relative = entry.get("path")
        digest = entry.get("sha256")
        role = entry.get("role")
        if not isinstance(relative, str) or not isinstance(digest, str) or role not in {
            "grader",
            "input",
            "known-submission",
            "documentation",
        }:
            raise PilotError("invalid entry in HASHES.json")
        if relative in result or Path(relative).is_absolute() or ".." in Path(relative).parts:
            raise PilotError(f"unsafe or duplicate locked path: {relative}")
        result[relative] = {"sha256": digest, "role": role}
    return result


# Finder/Explorer metadata is created just by browsing the folder and is never read by
# the fixtures. Bytecode caches stay unlisted-and-rejected: a planted .pyc could run.
OS_METADATA_NAMES = {".DS_Store", "Thumbs.db", "desktop.ini"}


def is_os_metadata(path: Path) -> bool:
    return path.name in OS_METADATA_NAMES or path.name.startswith("._")


def verify_hash_lock() -> dict[str, dict[str, str]]:
    entries = locked_entries()
    expected_paths = set(entries)
    actual_paths = {
        path.relative_to(BASE).as_posix()
        for path in BASE.rglob("*")
        if path.is_file() and path.name != "HASHES.json" and not is_os_metadata(path)
    }
    if actual_paths != expected_paths:
        missing = sorted(expected_paths - actual_paths)
        unlisted = sorted(actual_paths - expected_paths)
        raise PilotError(f"hash inventory mismatch; missing={missing}, unlisted={unlisted}")
    for relative, entry in entries.items():
        actual = sha256_file(BASE / relative)
        if actual != entry["sha256"]:
            raise PilotError(f"locked SHA-256 mismatch: {relative}")
    return entries


def copy_material(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)


def materialize(fixture: str, destination: Path) -> Path:
    verify_hash_lock()
    if fixture not in {"C01", "R02"}:
        raise PilotError("fixture must be C01 or R02")
    destination = destination.expanduser()
    if destination.exists() or destination.is_symlink():
        raise PilotError(f"destination already exists; refusing to overwrite: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.mkdir(mode=0o700)
    if fixture == "C01":
        copy_material(BASE / "C01/README.md", destination / "README.md")
        copy_material(BASE / "C01/starter/src/invoice.mjs", destination / "src/invoice.mjs")
        copy_material(BASE / "C01/starter/tests/public-cases.json", destination / "tests/public-cases.json")
    else:
        copy_material(BASE / "R02/README.md", destination / "README.md")
        copy_material(BASE / "R02/packet.json", destination / "packet.json")
    return destination.resolve()


def decimal_cents(value: str | int | Decimal) -> int:
    return int((Decimal(str(value)) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def oracle_c01_case(invoice: dict[str, Any]) -> dict[str, Any]:
    line_cents = []
    for line in invoice["lines"]:
        amount = Decimal(line["unitPrice"]) * int(line["quantity"])
        rounded_line = amount.quantize(CENT, rounding=ROUND_HALF_UP)
        line_cents.append(int(rounded_line * 100))
    subtotal = sum(line_cents)
    discount_cents = int(
        (Decimal(subtotal) * Decimal(invoice["discountPercent"]) / 100).quantize(
            Decimal("1"), rounding=ROUND_HALF_UP
        )
    )
    requested_refund_cents = decimal_cents(invoice["refund"])
    applied_refund_cents = min(requested_refund_cents, max(0, subtotal - discount_cents))
    due = max(0, subtotal - discount_cents - applied_refund_cents)
    return {
        "id": invoice["id"],
        "lineCents": line_cents,
        "subtotalCents": subtotal,
        "discountCents": discount_cents,
        "refundCents": applied_refund_cents,
        "amountDueCents": due,
    }


def oracle_c01(cases: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [oracle_c01_case(case) for case in cases]


def docker_runtime_info() -> dict[str, str]:
    inspect = subprocess.run(
        ["docker", "image", "inspect", IMAGE, "--format", "{{.Os}}/{{.Architecture}} {{.Id}}"],
        check=False,
        capture_output=True,
        text=True,
        timeout=20,
    )
    if inspect.returncode != 0:
        detail = (inspect.stderr or inspect.stdout).strip()
        raise PilotError(f"pinned Docker image is unavailable or Docker is inaccessible: {detail}")
    image_metadata = inspect.stdout.strip()
    if not image_metadata.startswith("linux/amd64 "):
        raise PilotError(f"pinned image platform mismatch: {image_metadata}")
    version = subprocess.run(
        [
            "docker",
            "run",
            "--rm",
            "--pull=never",
            "--platform=linux/amd64",
            "--network=none",
            "--read-only",
            "--entrypoint=node",
            IMAGE,
            "--version",
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=20,
    )
    if version.returncode != 0 or version.stdout.strip() != EXPECTED_NODE:
        raise PilotError(
            "pinned Node runtime check failed: "
            + (version.stderr or version.stdout).strip()
        )
    return {"image": IMAGE, "image_metadata": image_metadata, "node_version": version.stdout.strip()}


def bounded_docker_run(source: Path, payload: bytes, container_name: str) -> dict[str, Any]:
    if "," in str(source):
        raise PilotError("Docker source paths may not contain commas")
    command = [
        "docker",
        "run",
        "--interactive",
        "--name",
        container_name,
        "--pull=never",
        "--platform=linux/amd64",
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=32",
        "--memory=128m",
        "--memory-swap=128m",
        "--cpus=0.50",
        "--ulimit=nofile=64:64",
        "--ulimit=fsize=1048576:1048576",
        "--user=65534:65534",
        "--mount",
        f"type=bind,src={source},dst=/submission.mjs,readonly",
        "--entrypoint=node",
        IMAGE,
        "/submission.mjs",
    ]
    stdout = bytearray()
    stderr = bytearray()
    overflow = threading.Event()
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def drain(stream: Any, target: bytearray, maximum: int) -> None:
        while True:
            chunk = stream.read(4096)
            if not chunk:
                return
            if len(target) + len(chunk) > maximum:
                overflow.set()
                try:
                    process.kill()
                except OSError:
                    pass
                return
            target.extend(chunk)

    out_thread = threading.Thread(target=drain, args=(process.stdout, stdout, MAX_STDOUT), daemon=True)
    err_thread = threading.Thread(target=drain, args=(process.stderr, stderr, MAX_STDERR), daemon=True)
    out_thread.start()
    err_thread.start()
    timed_out = False
    try:
        try:
            assert process.stdin is not None
            process.stdin.write(payload)
            process.stdin.close()
        except (BrokenPipeError, OSError):
            pass
        try:
            return_code = process.wait(timeout=CONTAINER_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            timed_out = True
            process.kill()
            return_code = process.wait(timeout=3)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=3)
        out_thread.join(timeout=3)
        err_thread.join(timeout=3)
        cleanup = subprocess.run(
            ["docker", "rm", "-f", container_name],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
        inspect = subprocess.run(
            ["docker", "container", "inspect", container_name],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
        not_found = inspect.returncode != 0 and any(
            phrase in inspect.stderr.lower() for phrase in ("no such", "not found")
        )
        cleanup_evidence = {
            "remove_exit_code": cleanup.returncode,
            "remove_stdout": cleanup.stdout.strip(),
            "remove_stderr": cleanup.stderr.strip(),
            "post_cleanup_inspect_exit_code": inspect.returncode,
            "post_cleanup_inspect_stderr": inspect.stderr.strip(),
            "container_absence_confirmed": cleanup.returncode == 0 and not_found,
        }
    return {
        "command": command,
        "exit_code": return_code,
        "timed_out": timed_out,
        "output_overflow": overflow.is_set(),
        "stdout": bytes(stdout),
        "stderr": bytes(stderr),
        "container_cleanup": cleanup_evidence,
    }

def stage_candidate(stage: Path, relative_source: Path, filename: str) -> Path:
    target = stage / filename
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(relative_source, target)
    target.chmod(0o444)
    return target.resolve()


def validate_c01_output_schema(actual: Any, expected: list[dict[str, Any]]) -> list[str]:
    errors: list[str] = []
    if type(actual) is not list:
        return ["output must be a JSON array"]
    if len(actual) != len(expected):
        errors.append(f"expected {len(expected)} result rows, got {len(actual)}")
    required = {"id", "lineCents", "subtotalCents", "discountCents", "refundCents", "amountDueCents"}
    amount_fields = ("subtotalCents", "discountCents", "refundCents", "amountDueCents")
    for index, row in enumerate(actual):
        if type(row) is not dict:
            errors.append(f"result row {index} must be an object")
            continue
        if set(row) != required:
            errors.append(f"result row {index} has fields outside the exact output schema")
        if type(row.get("id")) is not str:
            errors.append(f"result row {index} id must be a string")
        line_values = row.get("lineCents")
        if type(line_values) is not list:
            errors.append(f"result row {index} lineCents must be an array")
        else:
            expected_line_count = len(expected[index]["lineCents"]) if index < len(expected) else None
            if expected_line_count is not None and len(line_values) != expected_line_count:
                errors.append(f"result row {index} lineCents has the wrong length")
            for line_index, value in enumerate(line_values):
                if type(value) is not int:
                    errors.append(f"result row {index} lineCents[{line_index}] must be an integer (booleans and floats are invalid)")
        for field in amount_fields:
            if type(row.get(field)) is not int:
                errors.append(f"result row {index} {field} must be an integer (booleans and floats are invalid)")
    return errors


def parse_tamper_attempts(stderr: bytes) -> tuple[list[dict[str, str]] | None, str | None]:
    prefix = "TAMPER_ATTEMPTS="
    for line in stderr.decode("utf-8", errors="replace").splitlines():
        if line.startswith(prefix):
            try:
                value = json.loads(line[len(prefix):])
                if type(value) is list and all(type(item) is dict for item in value):
                    return value, None
                return None, "tamper evidence is not a list of objects"
            except json.JSONDecodeError:
                return None, "tamper evidence is invalid JSON"
    return None, "tamper evidence was not emitted"


def check_c01_submission(source: Path, all_cases: list[dict[str, Any]], container_name: str) -> dict[str, Any]:
    payload = json.dumps({"cases": all_cases}, separators=(",", ":")).encode("utf-8")
    docker = bounded_docker_run(source, payload, container_name)
    expected = oracle_c01(all_cases)
    reasons: list[str] = []
    if docker["timed_out"]:
        reasons.append("container timeout")
    if docker["output_overflow"]:
        reasons.append("bounded stdout/stderr exceeded")
    if docker["exit_code"] != 0:
        reasons.append(f"container exit code {docker['exit_code']}")
    if not docker["container_cleanup"]["container_absence_confirmed"]:
        reasons.append("owned container removal was not confirmed")
    actual: Any = None
    output_parsed = False
    try:
        actual = json.loads(docker["stdout"].decode("utf-8"))
        output_parsed = True
    except (UnicodeDecodeError, json.JSONDecodeError):
        reasons.append("stdout was not one JSON value")
    schema_errors = validate_c01_output_schema(actual, expected) if output_parsed else []
    reasons.extend(schema_errors)
    oracle_matches = output_parsed and not schema_errors and actual == expected
    if output_parsed and not schema_errors and not oracle_matches:
        reasons.append("host Decimal oracle mismatch")
    tamper_attempts = None
    tamper_evidence_error = None
    stderr_text = docker["stderr"].decode("utf-8", errors="replace")
    if "TAMPER_ATTEMPTS=" in stderr_text:
        tamper_attempts, tamper_evidence_error = parse_tamper_attempts(docker["stderr"])
    execution_completed = (
        docker["exit_code"] == 0
        and not docker["timed_out"]
        and not docker["output_overflow"]
        and output_parsed
        and docker["container_cleanup"]["container_absence_confirmed"]
    )
    return {
        "accepted": not reasons,
        "reason": reasons,
        "execution_completed": execution_completed,
        "output_parsed": output_parsed,
        "output_schema_valid": output_parsed and not schema_errors,
        "oracle_matches": oracle_matches,
        "exit_code": docker["exit_code"],
        "timed_out": docker["timed_out"],
        "output_overflow": docker["output_overflow"],
        "stdout_sha256": sha256_bytes(docker["stdout"]),
        "stderr": stderr_text[:4000],
        "tamper_attempt_results": tamper_attempts,
        "tamper_evidence_error": tamper_evidence_error,
        "container_cleanup": docker["container_cleanup"],
    }

def grade_r02(result_value: Any, explanation: str, packet: dict[str, Any]) -> dict[str, Any]:
    failures: list[str] = []
    required_keys = {
        "period",
        "metric",
        "value_usd_millions",
        "controlling_source_id",
        "conflict_acknowledged",
    }
    if type(result_value) is not dict:
        return {"accepted": False, "failures": ["result.json must contain one object"]}
    if set(result_value) != required_keys:
        failures.append("result fields do not match the required schema")
    expected_fields = {
        "period": "FY2027",
        "metric": "EBITDA",
        "value_usd_millions": "10.8",
        "controlling_source_id": "FORECAST-REVISION-2026-01-20",
    }
    for key, expected in expected_fields.items():
        if type(result_value.get(key)) is not str or result_value.get(key) != expected:
            failures.append(f"incorrect {key}")
    if type(result_value.get("conflict_acknowledged")) is not bool or result_value.get("conflict_acknowledged") is not True:
        failures.append("the conflicting older forecast was not acknowledged")
    if type(explanation) is not str:
        return {"accepted": False, "failures": failures + ["explanation.md must be text"]}

    lines = explanation.splitlines()
    control_pattern = re.compile(
        r"^Controlling forecast: period=(FY[0-9]{4}); metric=([A-Z][A-Z0-9]*); "
        r"value_usd_millions=([0-9]+(?:\.[0-9]+)?); source_id=([A-Z0-9-]+); "
        r"citations=\[\[([A-Z0-9-]+#S[0-9]{2})\]\] \[\[([A-Z0-9-]+#S[0-9]{2})\]\]$"
    )
    prior_pattern = re.compile(
        r"^Prior forecast: period=(FY[0-9]{4}); metric=([A-Z][A-Z0-9]*); "
        r"value_usd_millions=([0-9]+(?:\.[0-9]+)?); source_id=([A-Z0-9-]+); "
        r"status=(current|superseded); citations=\[\[([A-Z0-9-]+#S[0-9]{2})\]\]$"
    )
    precedence_pattern = re.compile(
        r"^Precedence: newer_source_id=([A-Z0-9-]+); older_source_id=([A-Z0-9-]+); "
        r"relation=([a-z_]+); citations=\[\[([A-Z0-9-]+#S[0-9]{2})\]\]$"
    )
    if len(lines) != 3:
        failures.append("explanation must use exactly the three documented claim lines")
        return {"accepted": False, "failures": failures}
    control = control_pattern.fullmatch(lines[0])
    prior = prior_pattern.fullmatch(lines[1])
    precedence = precedence_pattern.fullmatch(lines[2])
    if not control or not prior or not precedence:
        failures.append("explanation does not match the bounded claim-line grammar")
        return {"accepted": False, "failures": failures}

    control_period, control_metric, control_value, control_source, control_cite_1, control_cite_2 = control.groups()
    prior_period, prior_metric, prior_value, prior_source, prior_status, prior_cite = prior.groups()
    newer_source, older_source, relation, precedence_cite = precedence.groups()
    control_claim = {
        "period": control_period,
        "metric": control_metric,
        "value_usd_millions": control_value,
        "controlling_source_id": control_source,
    }
    result_claim = {key: result_value.get(key) for key in control_claim}
    if control_claim != result_claim:
        failures.append("controlling claim disagrees with result.json")
    if control_claim != expected_fields:
        failures.append("explanation controlling forecast is not the approved revision")

    old_id = "FORECAST-ORIGINAL-2025-12-15"
    new_id = "FORECAST-REVISION-2026-01-20"
    expected_prior = ("FY2027", "EBITDA", "12.4", old_id, "superseded")
    if (prior_period, prior_metric, prior_value, prior_source, prior_status) != expected_prior:
        failures.append("prior forecast claim does not identify the superseded high forecast")
    if newer_source == old_id and older_source == new_id:
        failures.append("supersession direction is reversed")
    elif (newer_source, older_source, relation) != (new_id, old_id, "newer_supersedes_older"):
        failures.append("precedence claim does not match the packet's revision order")

    spans: set[str] = set()
    for source in packet.get("sources", []):
        for span in source.get("spans", []):
            spans.add(f"{source['source_id']}#{span['span_id']}")
    citation_roles = [
        ([control_cite_1, control_cite_2], [f"{new_id}#S01", f"{new_id}#S02"], "controlling forecast"),
        ([prior_cite], [f"{old_id}#S01"], "prior forecast"),
        ([precedence_cite], [f"{new_id}#S02"], "precedence"),
    ]
    for actual_citations, required_citations, role in citation_roles:
        for citation in actual_citations:
            if citation not in spans:
                failures.append(f"invalid source-span citation for {role}: {citation}")
        if actual_citations != required_citations:
            if any(citation not in spans for citation in actual_citations):
                continue
            failures.append(f"citation does not support the {role} claim")
    return {"accepted": not failures, "failures": failures}

def run_id_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + os.urandom(6).hex()


def make_owner_marker(stage: Path, run_id: str) -> None:
    marker = {
        "schema": "cowork-os-pilot-owned-submissions-v1",
        "run_id": run_id,
        "path": str(stage.resolve()),
    }
    (stage / ".pilot-owned.json").write_text(json.dumps(marker, indent=2) + "\n", encoding="utf-8")


def safe_cleanup_submissions(output_root: Path, run_id: str) -> bool:
    if not RUN_ID_RE.fullmatch(run_id):
        raise PilotError("invalid run ID; cleanup accepts only generated run IDs")
    root = output_root.expanduser().resolve()
    run_dir = root / run_id
    stage = run_dir / "submissions"
    if not run_dir.is_dir() or run_dir.is_symlink() or not stage.exists():
        return False
    if stage.is_symlink() or not stage.is_dir() or stage.parent.resolve() != run_dir.resolve():
        raise PilotError("owned cleanup path is not the exact run's submissions directory")
    marker_path = stage / ".pilot-owned.json"
    if not marker_path.is_file() or marker_path.is_symlink():
        raise PilotError("owned cleanup marker is missing or unsafe")
    marker = read_json(marker_path)
    if marker != {
        "schema": "cowork-os-pilot-owned-submissions-v1",
        "run_id": run_id,
        "path": str(stage.resolve()),
    }:
        raise PilotError("owned cleanup marker does not match this run")
    shutil.rmtree(stage)
    return True


def append_log(log_path: Path, message: str) -> None:
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(message.rstrip() + "\n")


def locked_snapshot(entries: dict[str, dict[str, str]]) -> dict[str, str]:
    return {relative: sha256_file(BASE / relative) for relative in sorted(entries)}


def write_manifest(path: Path, manifest: dict[str, Any]) -> None:
    path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def validate(output_root_arg: Path) -> tuple[int, Path | None, Path | None]:
    entries = verify_hash_lock()
    output_root = output_root_arg.expanduser()
    if output_root.exists() and output_root.is_symlink():
        raise PilotError("output root may not be a symlink")
    output_root.mkdir(parents=True, exist_ok=True)
    output_root = output_root.resolve()
    run_id = run_id_now()
    run_dir = output_root / run_id
    run_dir.mkdir(mode=0o700)
    run_marker = {
        "schema": "cowork-os-pilot-run-v1",
        "run_id": run_id,
        "path": str(run_dir.resolve()),
    }
    (run_dir / ".pilot-run.json").write_text(json.dumps(run_marker, indent=2) + "\n", encoding="utf-8")
    stage = run_dir / "submissions"
    stage.mkdir(mode=0o700)
    make_owner_marker(stage, run_id)
    manifest_path = run_dir / "validation-manifest.json"
    log_path = run_dir / "validation.log"
    sentinel_inside = run_dir / "unrelated-sentinel.txt"
    sentinel_outside = output_root / f"{run_id}-unrelated-sentinel.txt"
    sentinel_inside.write_text("cowork-os-pilot-sentinel-inside\n", encoding="utf-8")
    sentinel_outside.write_text("cowork-os-pilot-sentinel-outside\n", encoding="utf-8")
    sentinel_before = {
        "inside": sha256_file(sentinel_inside),
        "outside": sha256_file(sentinel_outside),
    }
    pre_locked = locked_snapshot(entries)
    manifest: dict[str, Any] = {
        "schema": "cowork-os-pilot-validation-v1",
        "attribution": "cowork-os",
        "run_id": run_id,
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "repository_head": "unknown",
        "fixture_scope": ["C01", "R02"],
        "claim_boundary": "fixture oracle/control validation only; no model trial or competitive result",
        "unsupported": {
            "remaining_approved_catalog_tasks": 22,
            "p04_adapter": "fixture-only; cannot execute arbitrary real-model tasks",
            "model_provider_integration": "not qualified",
            "provider_budget": "not qualified",
        },
        "hashes": {
            "lock_sha256": sha256_file(BASE / "HASHES.json"),
            "locked_files": [
                {"path": path, **entries[path]}
                for path in sorted(entries)
            ],
            "grader_sha256": {
                path: entries[path]["sha256"]
                for path in sorted(entries)
                if entries[path]["role"] == "grader"
            },
            "input_sha256": {
                path: entries[path]["sha256"]
                for path in sorted(entries)
                if entries[path]["role"] == "input"
            },
        },
        "candidate_permissions": {
            "container_image": IMAGE,
            "platform": "linux/amd64",
            "network": "none",
            "root_filesystem": "read-only",
            "capabilities": "all dropped",
            "no_new_privileges": True,
            "container_user": "65534:65534",
            "memory": "128m",
            "memory_swap": "128m",
            "cpus": "0.50",
            "pids_limit": 32,
            "open_files_limit": "64",
            "file_size_limit": "1 MiB",
            "timeout_seconds": CONTAINER_TIMEOUT_SECONDS,
            "stdout_limit_bytes": MAX_STDOUT,
            "stderr_limit_bytes": MAX_STDERR,
            "host_bind_mounts": ["one read-only submitted source file"],
            "hidden_oracle_mounts": 0,
            "reward_file_mounts": 0,
            "input_channel": "case inputs on stdin",
            "host_credentials_passed": False,
        },
        "artifacts": {
            "run_directory": str(run_dir),
            "manifest": str(manifest_path),
            "log": str(log_path),
        },
        "fixture_outcomes": {},
        "cleanup": {
            "owned_path": str(stage),
            "owned_containers": [],
            "sentinel_sha256_before": sentinel_before,
        },
    }
    try:
        try:
            head = subprocess.run(
                ["git", "-C", str(REPO), "rev-parse", "HEAD"],
                check=True,
                capture_output=True,
                text=True,
                timeout=10,
            ).stdout.strip()
        except Exception as error:  # recorded as context; not a grader input
            head = f"unavailable: {type(error).__name__}"
        manifest["repository_head"] = head
        append_log(log_path, f"run_id={run_id} attribution=cowork-os")
        append_log(log_path, "scope=two synthetic fixture graders and known-control submissions only")
        runtime = docker_runtime_info()
        manifest["runtime"] = runtime
        append_log(log_path, f"runtime={runtime}")

        public = read_json(BASE / "C01/starter/tests/public-cases.json")["cases"]
        hidden = read_json(BASE / "C01/inputs/hidden-cases.json")["cases"]
        all_cases = public + hidden
        c01_checks: dict[str, Any] = {}
        controls = [
            ("correct", True, None),
            ("display-only", False, "host Decimal oracle mismatch"),
            ("binary-float", False, "host Decimal oracle mismatch"),
            ("tamper", False, "host Decimal oracle mismatch"),
            ("boolean-cents", False, "amountDueCents must be an integer"),
        ]
        for name, should_accept, required_rejection in controls:
            source = stage_candidate(
                stage,
                BASE / f"known-submissions/C01/{name}.mjs",
                f"C01/{name}/submission.mjs",
            )
            container_name = f"cowork-pilot-{run_id}-c01-{name}"
            candidate = check_c01_submission(source, all_cases, container_name)
            candidate["expected_accepted"] = should_accept
            candidate["expected_rejection_reason"] = required_rejection
            reason_matched = required_rejection is None or any(
                required_rejection in reason for reason in candidate["reason"]
            )
            tamper_evidence_valid = True
            if name == "tamper":
                attempts = candidate.get("tamper_attempt_results")
                # /grader and /rewards are absent in the container, so ENOENT there proves
                # nothing about the sandbox. The /tmp and / probes only fail with EROFS when
                # --read-only is in force, and the uid entry pins --user=65534:65534.
                expected_attempts = {
                    "/grader/pilot.py": {"ENOENT", "EROFS", "EACCES"},
                    "/rewards/result.json": {"ENOENT", "EROFS", "EACCES"},
                    "/tmp/tamper-probe": {"EROFS"},
                    "/tamper-probe": {"EROFS"},
                    "process.uid": {"65534"},
                }
                tamper_evidence_valid = (
                    candidate.get("tamper_evidence_error") is None
                    and type(attempts) is list
                    and {entry.get("path") for entry in attempts} == set(expected_attempts)
                    and all(entry.get("result") in expected_attempts.get(entry.get("path"), set()) for entry in attempts)
                )
                candidate["tamper_evidence_valid"] = tamper_evidence_valid
            candidate["rejection_reason_matches"] = reason_matched
            candidate["control_verdict_matches"] = (
                candidate["execution_completed"]
                and reason_matched
                and tamper_evidence_valid
                and candidate["accepted"] is should_accept
            )
            c01_checks[name] = candidate
            manifest["cleanup"]["owned_containers"].append(
                {"name": container_name, **candidate["container_cleanup"]}
            )
            append_log(
                log_path,
                f"C01 control={name} accepted={candidate['accepted']} expected={should_accept} "
                f"executed={candidate['execution_completed']} reason_match={reason_matched} "
                f"container_removed={candidate['container_cleanup']['container_absence_confirmed']} "
                f"matches={candidate['control_verdict_matches']} reason={candidate['reason']}",
            )
        c01_ok = all(item["control_verdict_matches"] for item in c01_checks.values())
        manifest["fixture_outcomes"]["C01"] = {
            "status": "runnable" if c01_ok else "failed",
            "public_case_count": len(public),
            "host_only_boundary_case_count": len(hidden),
            "oracle": "independent Python Decimal with ROUND_HALF_UP and strict JSON integer types",
            "controls": c01_checks,
        }

        packet = read_json(BASE / "R02/packet.json")
        r02_controls = [
            ("correct", True, None),
            ("stale-high", False, "incorrect value_usd_millions"),
            ("invented-citation", False, "invalid source-span citation"),
            ("missing-conflict", False, "exactly the three documented claim lines"),
            ("reversed-supersession", False, "supersession direction is reversed"),
            ("json-explanation-disagreement", False, "controlling claim disagrees with result.json"),
            ("probe-contradiction", False, "exactly the three documented claim lines"),
        ]
        r02_checks: dict[str, Any] = {}
        for name, should_accept, required_rejection in r02_controls:
            candidate_dir = stage / "R02" / name
            candidate_dir.mkdir(parents=True, exist_ok=True)
            result_file = candidate_dir / "result.json"
            explanation_file = candidate_dir / "explanation.md"
            shutil.copyfile(BASE / f"known-submissions/R02/{name}.json", result_file)
            shutil.copyfile(BASE / f"known-submissions/R02/{name}.md", explanation_file)
            outcome = grade_r02(read_json(result_file), explanation_file.read_text(encoding="utf-8"), packet)
            outcome["grader_completed"] = True
            outcome["expected_accepted"] = should_accept
            outcome["expected_rejection_reason"] = required_rejection
            outcome["rejection_reason_matches"] = required_rejection is None or any(
                required_rejection in failure for failure in outcome["failures"]
            )
            outcome["control_verdict_matches"] = (
                outcome["grader_completed"]
                and outcome["rejection_reason_matches"]
                and outcome["accepted"] is should_accept
            )
            r02_checks[name] = outcome
            append_log(
                log_path,
                f"R02 control={name} accepted={outcome['accepted']} expected={should_accept} "
                f"grader_completed={outcome['grader_completed']} reason_match={outcome['rejection_reason_matches']} "
                f"matches={outcome['control_verdict_matches']} failures={outcome['failures']}",
            )
        r02_ok = all(item["control_verdict_matches"] for item in r02_checks.values())
        manifest["fixture_outcomes"]["R02"] = {
            "status": "runnable" if r02_ok else "failed",
            "source_count": len(packet["sources"]),
            "oracle": "deterministic schema, controlling-version, conflict, and exact citation-span checks",
            "controls": r02_checks,
        }
        post_locked = locked_snapshot(entries)
        manifest["cleanup"]["locked_hashes_unchanged_before_cleanup"] = post_locked == pre_locked
        if post_locked != pre_locked:
            raise PilotError("one or more locked fixture/oracle files changed during validation")
        inventory = subprocess.run(
            ["docker", "ps", "-aq", "--filter", f"name=cowork-pilot-{run_id}"],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
        remaining_containers = [line for line in inventory.stdout.splitlines() if line.strip()]
        all_owned_removed = (
            inventory.returncode == 0
            and not remaining_containers
            and all(item.get("container_absence_confirmed") for item in manifest["cleanup"]["owned_containers"])
        )
        manifest["cleanup"]["container_inventory"] = {
            "query_exit_code": inventory.returncode,
            "remaining_container_ids": remaining_containers,
            "all_owned_containers_removed": all_owned_removed,
        }
        cleaned = safe_cleanup_submissions(output_root, run_id)
        manifest["cleanup"]["submissions_removed"] = cleaned
        manifest["cleanup"]["sentinel_sha256_after"] = {
            "inside": sha256_file(sentinel_inside),
            "outside": sha256_file(sentinel_outside),
        }
        manifest["cleanup"]["sentinels_unchanged"] = (
            manifest["cleanup"]["sentinel_sha256_before"]
            == manifest["cleanup"]["sentinel_sha256_after"]
        )
        all_passed = (
            c01_ok
            and r02_ok
            and manifest["cleanup"]["sentinels_unchanged"]
            and manifest["cleanup"]["container_inventory"]["all_owned_containers_removed"]
            and cleaned
        )
        manifest["status"] = "runnable" if all_passed else "failed"
        append_log(log_path, f"summary status={manifest['status']}")
    except Exception as error:
        manifest["status"] = "failed"
        manifest["error"] = f"{type(error).__name__}: {error}"
        append_log(log_path, manifest["error"])
        if stage.exists() and not stage.is_symlink():
            try:
                manifest["cleanup"]["submissions_removed"] = safe_cleanup_submissions(output_root, run_id)
            except Exception as cleanup_error:
                manifest["cleanup"]["error"] = f"{type(cleanup_error).__name__}: {cleanup_error}"
        if sentinel_inside.exists() and sentinel_outside.exists():
            after = {"inside": sha256_file(sentinel_inside), "outside": sha256_file(sentinel_outside)}
            manifest["cleanup"]["sentinel_sha256_after"] = after
            manifest["cleanup"]["sentinels_unchanged"] = sentinel_before == after
    finally:
        if stage.exists() and not stage.is_symlink():
            try:
                manifest["cleanup"]["submissions_removed"] = safe_cleanup_submissions(output_root, run_id)
            except Exception as cleanup_error:
                manifest["cleanup"]["error"] = f"{type(cleanup_error).__name__}: {cleanup_error}"
        write_manifest(manifest_path, manifest)
    return (0 if manifest.get("status") == "runnable" else 1, manifest_path, log_path)


def cleanup_command(output_root_arg: Path, run_id: str) -> bool:
    output_root = output_root_arg.expanduser().resolve()
    return safe_cleanup_submissions(output_root, run_id)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="CoWork OS two-fixture pilot materializer and oracle validation")
    subparsers = parser.add_subparsers(dest="command", required=True)
    materialize_parser = subparsers.add_parser("materialize", help="copy one public task workspace")
    materialize_parser.add_argument("fixture", choices=["C01", "R02"])
    materialize_parser.add_argument("--destination", type=Path, required=True)
    validate_parser = subparsers.add_parser("validate", help="run known controls through both independent graders")
    validate_parser.add_argument(
        "--output-root",
        type=Path,
        default=Path("/private/tmp/cowork-pilot-validation"),
    )
    cleanup_parser = subparsers.add_parser("cleanup", help="remove only a marked run-owned submissions directory")
    cleanup_parser.add_argument("--output-root", type=Path, required=True)
    cleanup_parser.add_argument("--run-id", required=True)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.command == "materialize":
            path = materialize(args.fixture, args.destination)
            print(f"materialized {args.fixture}: {path}")
            print("This workspace contains task inputs only; it contains no host grader or expected results.")
            return 0
        if args.command == "validate":
            code, manifest, log = validate(args.output_root)
            print(f"validation manifest: {manifest}")
            print(f"validation log: {log}")
            if code == 0:
                print("Both fixture oracles accepted the correct control and rejected every known-wrong control.")
                print("This is fixture/oracle validation only; no model trial or competitive result was run.")
            return code
        if args.command == "cleanup":
            removed = cleanup_command(args.output_root, args.run_id)
            print("removed owned submissions directory" if removed else "no owned submissions directory to remove")
            return 0
    except (PilotError, OSError, json.JSONDecodeError, subprocess.SubprocessError) as error:
        print(f"pilot error: {error}", file=sys.stderr)
        return 2
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
