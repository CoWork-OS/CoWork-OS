from __future__ import annotations

import argparse
import json
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
from typing import Any

from benchmarks.harbor.manifest import (
    AdapterPreflightError,
    HARBOR_VERSION,
    HARBOR_WHEEL_REFERENCE_SHA256,
    POLICY_CAPS,
    aggregate_timeline_usage,
    finalize_job,
    inspect_app_artifact,
    validate_node_image,
    validate_run_config,
)
from benchmarks.harbor.oracle import grade_exact
from benchmarks.harbor import run_smoke
from benchmarks.harbor.run_smoke import all_expected_outcomes, build_verifier_image, materialize_task, not_run_trial, unknown_start_trial
from benchmarks.harbor.cowork_agent import CoWorkOSNativeAgent
from harbor.models.agent.context import AgentContext

TEST_RUN_IDENTITY = {
    "schemaVersion": "cowork-os-harbor-run-identity/v1",
    "runId": "test-run-1",
    "identitySha256": "1" * 64,
    "package": {"sha256": "2" * 64, "mode": "linux-server"},
    "providerMode": "fixture-zero-cost",
    "policyCaps": dict(POLICY_CAPS),
}


class PreflightTests(unittest.TestCase):
    def test_fixed_caps_and_pinned_image_are_required(self) -> None:
        config = {
            "provider_mode": "fixture-zero-cost",
            "node_image": "node:24.14.1-bookworm-slim@sha256:" + "a" * 64,
            "attempts": 1,
            "max_task_seconds": 24,
            "max_job_seconds": 600,
            "max_tokens": 2048,
            "max_model_turns": 8,
        }
        self.assertEqual(validate_run_config(config)["caps"], POLICY_CAPS)
        for invalid in (
            "node:24.14.1-bookworm-slim",
            "node:24.14.1-bookworm-slim@sha256:abc",
        ):
            with self.assertRaises(AdapterPreflightError):
                validate_node_image(invalid)
        for field, value in (("attempts", 2), ("max_task_seconds", 25), ("max_job_seconds", 601), ("max_tokens", 2049), ("max_model_turns", 9)):
            changed = dict(config)
            changed[field] = value
            with self.subTest(field=field), self.assertRaises(AdapterPreflightError):
                validate_run_config(changed)
        for field in ("max_task_seconds", "max_job_seconds", "max_tokens", "max_model_turns"):
            changed = dict(config)
            changed[field] = 1
            with self.subTest(field=field), self.assertRaises(AdapterPreflightError):
                validate_run_config(changed)

    def test_verifier_image_is_derived_from_verified_digest_and_offline_grader(self) -> None:
        image = "node:24.14.1-bookworm-slim@sha256:" + "b" * 64
        commands: list[list[str]] = []

        def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
            commands.append(command)
            if command[1:3] == ["image", "inspect"] and command[-1] == image:
                return subprocess.CompletedProcess(command, 0, "linux/amd64|[\"node@" + image.rsplit("@", 1)[1] + "\"]\n", "")
            if command[1] == "build":
                return subprocess.CompletedProcess(command, 0, "", "")
            return subprocess.CompletedProcess(command, 0, "linux/amd64|sha256:" + "c" * 64 + "\n", "")

        with patch("benchmarks.harbor.run_smoke.subprocess.run", side_effect=fake_run):
            result = build_verifier_image(image)
        self.assertEqual(result["baseImage"], image)
        self.assertEqual(result["platform"], "linux/amd64")
        build = next(command for command in commands if command[1] == "build")
        self.assertIn("--network=none", build)
        self.assertIn("--pull=false", build)

    def test_materialized_task_separates_candidate_and_verifier_images(self) -> None:
        candidate_image = "node:24.14.1-bookworm-slim@sha256:" + "a" * 64
        verifier_image = "cowork-os-p04-verifier:" + "c" * 20
        with tempfile.TemporaryDirectory() as tmp:
            task = materialize_task(Path(tmp), "positive", candidate_image, verifier_image)
            task_toml = (task / "task.toml").read_text()
            self.assertIn('docker_image = "' + candidate_image + '"', task_toml)
            self.assertIn('docker_image = "' + verifier_image + '"', task_toml)
            self.assertIn('environment_mode = "separate"', task_toml)
            self.assertIn('platform: linux/amd64', (task / "environment" / "docker-compose.yaml").read_text())
            self.assertIn("actual=/workspace/p04-result.txt", (task / "tests" / "test.sh").read_text())
    def test_missing_or_remote_provider_refuses_before_run(self) -> None:
        config = {"node_image": "node:24.14.1-bookworm-slim@sha256:" + "a" * 64}
        with self.assertRaises(AdapterPreflightError) as missing:
            validate_run_config(config)
        self.assertEqual(missing.exception.status, "missing_config")
        config["provider_mode"] = "remote"
        with self.assertRaises(AdapterPreflightError) as remote:
            validate_run_config(config)
        self.assertEqual(remote.exception.status, "unsupported")

    def test_exact_electron_free_server_archive_is_accepted_and_hash_checked(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            archive_path = Path(tmp) / "server.tar.gz"
            root = "cowork-os-server-linux-x64-v1.2.3"
            entries = {
                root + "/package.json": json.dumps({"name": "cowork-os", "version": "1.2.3", "dependencies": {}}),
                root + "/bin/coworkd-node.js": "#!/usr/bin/env node\n",
                root + "/bin/coworkctl.js": "#!/usr/bin/env node\n",
                root + "/dist/daemon/daemon/main.js": "// built\n",
            }
            with tarfile.open(archive_path, "w:gz") as archive:
                for name, content in entries.items():
                    payload = content.encode()
                    info = tarfile.TarInfo(name)
                    info.size = len(payload)
                    archive.addfile(info, __import__("io").BytesIO(payload))
            import hashlib

            digest = hashlib.sha256(archive_path.read_bytes()).hexdigest()
            result = inspect_app_artifact(archive_path, "linux-server", digest)
            self.assertEqual(result["packageVersion"], "1.2.3")
            with self.assertRaises(AdapterPreflightError):
                inspect_app_artifact(archive_path, "linux-server", "0" * 64)

    def test_electron_dependency_is_unsupported_for_linux(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            archive_path = Path(tmp) / "server.tar.gz"
            root = "pkg"
            entries = {
                root + "/package.json": json.dumps({"name": "cowork-os", "version": "1.2.3", "dependencies": {"electron": "1.0.0"}}),
                root + "/bin/coworkd-node.js": "#!/usr/bin/env node\n",
                root + "/bin/coworkctl.js": "#!/usr/bin/env node\n",
                root + "/dist/daemon/daemon/main.js": "// built\n",
            }
            with tarfile.open(archive_path, "w:gz") as archive:
                for name, content in entries.items():
                    payload = content.encode()
                    info = tarfile.TarInfo(name)
                    info.size = len(payload)
                    archive.addfile(info, __import__("io").BytesIO(payload))
            import hashlib

            digest = hashlib.sha256(archive_path.read_bytes()).hexdigest()
            with self.assertRaises(AdapterPreflightError) as caught:
                inspect_app_artifact(archive_path, "linux-server", digest)
            self.assertEqual(caught.exception.status, "unsupported")

    def test_nested_electron_package_content_is_unsupported_for_linux(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            archive_path = Path(tmp) / "server.tar.gz"
            entries = {
                "pkg/package.json": json.dumps({"name": "cowork-os", "version": "1.2.3", "dependencies": {}}),
                "pkg/bin/coworkd-node.js": "#!/usr/bin/env node\n",
                "pkg/bin/coworkctl.js": "#!/usr/bin/env node\n",
                "pkg/dist/daemon/daemon/main.js": "// built\n",
                "pkg/node_modules/outer/node_modules/electron/package.json": json.dumps({"name": "electron"}),
            }
            with tarfile.open(archive_path, "w:gz") as archive:
                for name, content in entries.items():
                    payload = content.encode()
                    info = tarfile.TarInfo(name)
                    info.size = len(payload)
                    archive.addfile(info, __import__("io").BytesIO(payload))
            import hashlib

            digest = hashlib.sha256(archive_path.read_bytes()).hexdigest()
            with self.assertRaises(AdapterPreflightError) as caught:
                inspect_app_artifact(archive_path, "linux-server", digest)
            self.assertEqual(caught.exception.status, "unsupported")


class OracleAndUsageTests(unittest.TestCase):
    def test_known_correct_wrong_no_proof_and_timeout_oracles(self) -> None:
        expected = b"P04_NATIVE_HARBOR_OK"
        self.assertEqual(grade_exact(expected, expected), 1)
        self.assertEqual(grade_exact(expected, b"P04_WRONG"), 0)
        self.assertEqual(grade_exact(expected, None), 0)
        self.assertEqual(grade_exact(expected, b""), 0)

    def test_usage_is_unknown_when_events_are_missing_or_truncated(self) -> None:
        missing = aggregate_timeline_usage([])
        self.assertEqual(missing["status"], "missing")
        complete = aggregate_timeline_usage([
            {
                "events": [{
                    "type": "llm_usage",
                    "payload": {
                        "delta": {"inputTokens": 17, "outputTokens": 4, "cachedTokens": 0},
                        "totals": {"inputTokens": 17, "outputTokens": 4, "cost": 0, "costKnown": False},
                    },
                }],
                "summary": {"truncatedEventCount": 0},
                "hasMoreHistory": False,
            }
        ])
        self.assertEqual(complete["status"], "complete")
        self.assertEqual(complete["tokens"]["inputTokens"], 17)
        self.assertFalse(complete["telemetryCostKnown"])
        truncated = aggregate_timeline_usage([
            {"events": [], "summary": {"truncatedEventCount": 1}, "hasMoreHistory": False}
        ])
        self.assertEqual(truncated["status"], "missing")

    def test_usage_pagination_uses_final_cursor_state(self) -> None:
        pages = [
            {
                "events": [{"type": "llm_usage", "payload": {"delta": {"inputTokens": 7, "outputTokens": 2, "cachedTokens": 0}, "totals": {"inputTokens": 17, "outputTokens": 4, "cachedTokens": 0, "costKnown": False}}}],
                "summary": {"truncatedEventCount": 0},
                "hasMoreHistory": True,
            },
            {
                "events": [{"type": "llm_usage", "payload": {"delta": {"inputTokens": 10, "outputTokens": 2, "cachedTokens": 0}}}],
                "summary": {"truncatedEventCount": 0},
                "hasMoreHistory": False,
            },
        ]
        usage = aggregate_timeline_usage(pages)
        self.assertEqual(usage["status"], "complete")
        self.assertEqual(usage["tokens"]["inputTokens"], 17)
        self.assertEqual(usage["usageEventCount"], 2)

    def test_usage_pages_keep_newest_cumulative_totals_and_independent_delta_sum(self) -> None:
        pages = [
            {
                "events": [
                    {"type": "llm_usage", "payload": {"delta": {"inputTokens": 2, "outputTokens": 1, "cachedTokens": 0}, "totals": {"inputTokens": 995, "outputTokens": 99, "cachedTokens": 0, "cost": 9.95, "costKnown": True}}},
                    {"type": "llm_usage", "payload": {"delta": {"inputTokens": 5, "outputTokens": 2, "cachedTokens": 0}, "totals": {"inputTokens": 1000, "outputTokens": 100, "cachedTokens": 0, "cost": 10, "costKnown": True}}},
                ],
                "summary": {"truncatedEventCount": 0},
                "hasMoreHistory": True,
            },
            {
                "events": [{"type": "llm_usage", "payload": {"delta": {"inputTokens": 3, "outputTokens": 1, "cachedTokens": 0}, "totals": {"inputTokens": 100, "outputTokens": 10, "cachedTokens": 0, "cost": 1, "costKnown": True}}}],
                "summary": {"truncatedEventCount": 0},
                "hasMoreHistory": False,
            },
        ]
        usage = aggregate_timeline_usage(pages)
        self.assertEqual(usage["status"], "complete")
        self.assertEqual(usage["tokens"]["inputTokens"], 1000)
        self.assertEqual(usage["tokens"]["outputTokens"], 100)
        self.assertEqual(usage["observedTokenDeltas"]["inputTokens"], 10)
        self.assertEqual(usage["observedTokenDeltas"]["outputTokens"], 4)
        self.assertEqual(usage["telemetryCostUsd"], 10)
        self.assertNotEqual(usage["tokens"], usage["observedTokenDeltas"])

    def test_candidate_claim_cannot_replace_verifier_reward(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            job = Path(tmp)
            trial = job / "trial-a"
            trial.mkdir()
            (trial / "verifier").mkdir()
            (trial / "verifier" / "test-stdout.txt").write_text("exact artifact verified; memory_cgroup_limit_bytes=536870912\n")
            adapter = {
                "schemaVersion": "cowork-os-harbor-adapter/v1",
                "candidate": {"status": "completed"},
                "cleanup": {"status": "succeeded"},
                "fixtureCase": "correct",
                "usage": {"status": "complete"},
                "runIdentity": TEST_RUN_IDENTITY,
            }
            (trial / "cowork-os-adapter-manifest.json").write_text(json.dumps(adapter))
            (trial / "result.json").write_text(json.dumps({
                "trial_name": "trial-a",
                "task_name": "positive",
                "verifier_environment_mode": "separate",
                "verifier_result": {"rewards": {"reward": 1}},
                "exception_info": None,
            }))
            final = finalize_job(job, expected_run_identity=TEST_RUN_IDENTITY)
            self.assertEqual(final["trials"][0]["acceptance"], "passed")
            path = trial / "result.json"
            harbor = json.loads(path.read_text())
            harbor["verifier_result"] = None
            path.write_text(json.dumps(harbor))
            final = finalize_job(job, job / "without-verifier.json", expected_run_identity=TEST_RUN_IDENTITY)
            self.assertEqual(final["trials"][0]["verifier"]["reward"], None)
            self.assertEqual(final["trials"][0]["acceptance"], "verification_failed")

    def test_negative_and_timeout_cases_require_verifier_zero_and_bounded_cgroup(self) -> None:
        cases = (
            ("wrong", "completed", "completed", 0, "wrong_artifact"),
            ("no-proof", "failed", "failed", 0, "no_proof"),
            ("timeout", "timeout", 0, "timeout"),
        )
        for case in cases:
            if len(case) == 4:
                fixture_case, candidate_status, reward, expected = case
                terminal_status = candidate_status
            else:
                fixture_case, candidate_status, terminal_status, reward, expected = case
            with self.subTest(fixture_case=fixture_case), tempfile.TemporaryDirectory() as tmp:
                job = Path(tmp)
                trial = job / "trial-a"
                (trial / "verifier").mkdir(parents=True)
                (trial / "verifier" / "test-stdout.txt").write_text("memory_cgroup_limit_bytes=536870912\n")
                (trial / "cowork-os-adapter-manifest.json").write_text(json.dumps({
                    "candidate": {"status": candidate_status, "terminalStatus": terminal_status},
                    "cleanup": {"status": "succeeded"},
                    "fixtureCase": fixture_case,
                    "usage": {"status": "missing"},
                    "runIdentity": TEST_RUN_IDENTITY,
                }))
                (trial / "result.json").write_text(json.dumps({
                    "trial_name": "trial-a",
                    "task_name": fixture_case,
                    "verifier_environment_mode": "separate",
                    "verifier_result": {"rewards": {"reward": reward}},
                    "exception_info": None,
                }))
                final = finalize_job(job, expected_run_identity=TEST_RUN_IDENTITY)
                self.assertEqual(final["trials"][0]["acceptance"], expected)
                self.assertEqual(final["trials"][0]["candidate"]["status"], candidate_status)

    def test_negative_control_does_not_hide_candidate_infrastructure_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            job = Path(tmp)
            trial = job / "trial-a"
            (trial / "verifier").mkdir(parents=True)
            (trial / "verifier" / "test-stdout.txt").write_text("memory_cgroup_limit_bytes=536870912\n")
            (trial / "cowork-os-adapter-manifest.json").write_text(json.dumps({
                "candidate": {"status": "failed", "terminalStatus": "failed", "error": "Control Plane unavailable"},
                "cleanup": {"status": "succeeded"},
                "fixtureCase": "no-proof",
                "runIdentity": TEST_RUN_IDENTITY,
            }))
            (trial / "result.json").write_text(json.dumps({
                "trial_name": "trial-a",
                "task_name": "no-proof",
                "verifier_environment_mode": "separate",
                "verifier_result": {"rewards": {"reward": 0}},
                "exception_info": None,
            }))
            final = finalize_job(job, expected_run_identity=TEST_RUN_IDENTITY)
            self.assertEqual(final["trials"][0]["acceptance"], "verification_failed")

    def test_unbounded_verifier_memory_fails_closed_even_with_reward_one(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            job = Path(tmp)
            trial = job / "trial-a"
            (trial / "verifier").mkdir(parents=True)
            (trial / "verifier" / "test-stdout.txt").write_text("exact artifact verified; memory_cgroup_limit_bytes=max\n")
            (trial / "cowork-os-adapter-manifest.json").write_text(json.dumps({
                "candidate": {"status": "completed"},
                "cleanup": {"status": "succeeded"},
                "fixtureCase": "correct",
                "runIdentity": TEST_RUN_IDENTITY,
            }))
            (trial / "result.json").write_text(json.dumps({
                "trial_name": "trial-a",
                "task_name": "positive",
                "verifier_environment_mode": "separate",
                "verifier_result": {"rewards": {"reward": 1}},
                "exception_info": None,
            }))
            final = finalize_job(job, expected_run_identity=TEST_RUN_IDENTITY)
            self.assertEqual(final["trials"][0]["acceptance"], "verifier_memory_unbounded_or_unverified")

    def test_old_package_or_config_identity_cannot_pass(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            job = Path(tmp)
            trial = job / "trial-a"
            (trial / "verifier").mkdir(parents=True)
            (trial / "verifier" / "test-stdout.txt").write_text("memory_cgroup_limit_bytes=536870912\n")
            old_identity = dict(TEST_RUN_IDENTITY, runId="prior-run")
            (trial / "cowork-os-adapter-manifest.json").write_text(json.dumps({
                "candidate": {"status": "completed", "terminalStatus": "completed"},
                "cleanup": {"status": "succeeded"},
                "fixtureCase": "correct",
                "runIdentity": old_identity,
            }))
            (trial / "result.json").write_text(json.dumps({
                "trial_name": "trial-a",
                "task_name": "positive",
                "verifier_environment_mode": "separate",
                "verifier_result": {"rewards": {"reward": 1}},
                "exception_info": None,
            }))
            final = finalize_job(job, expected_run_identity=TEST_RUN_IDENTITY)
            self.assertEqual(final["trials"][0]["acceptance"], "run_identity_mismatch")
            self.assertFalse(final["trials"][0]["runIdentityMatches"])

    def test_runner_requires_four_expected_fixture_outcomes(self) -> None:
        expected = [
            {"fixtureCase": "correct", "acceptance": "passed", "harborExitCode": 0, "runIdentityMatches": True},
            {"fixtureCase": "wrong", "acceptance": "wrong_artifact", "harborExitCode": 0, "runIdentityMatches": True},
            {"fixtureCase": "no-proof", "acceptance": "no_proof", "harborExitCode": 0, "runIdentityMatches": True},
            {"fixtureCase": "timeout", "acceptance": "timeout", "harborExitCode": 0, "runIdentityMatches": True},
        ]
        self.assertTrue(all_expected_outcomes(expected))
        self.assertFalse(all_expected_outcomes(expected[:3]))
        self.assertFalse(all_expected_outcomes([*expected[:1], *expected[2:]]))

    def test_job_deadline_records_remaining_cases_without_fabricated_reward(self) -> None:
        rows = [not_run_trial(case, "not_run_job_deadline") for case in ("positive", "wrong", "no-proof", "timeout")]
        self.assertEqual([row["fixtureCase"] for row in rows], ["correct", "wrong", "no-proof", "timeout"])
        self.assertTrue(all(row["verifierReward"] is None for row in rows))
        self.assertFalse(all_expected_outcomes(rows))

    def test_failed_harbor_job_preserves_unknown_candidate_and_provider_start_state(self) -> None:
        trial = unknown_start_trial("positive", "harbor_job_failed")
        self.assertIsNone(trial["candidateStarted"])
        self.assertIsNone(trial["providerStarted"])
        self.assertIsNone(trial["verifierReward"])


class RunnerSafetyTests(unittest.TestCase):
    def _args(self, root: Path, jobs_dir: Path) -> argparse.Namespace:
        return argparse.Namespace(
            provider_mode="fixture-zero-cost",
            package_mode="linux-server",
            app_artifact=root / "app.tar.gz",
            app_sha256="a" * 64,
            node_image="node:24.14.1-bookworm-slim@sha256:" + "b" * 64,
            jobs_dir=jobs_dir,
            npm_cache_archive=None,
            npm_cache_sha256=None,
        )

    def test_existing_copied_results_are_refused_without_mutation_or_preflight_work(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            jobs = root / "copied-old-jobs"
            result = jobs / "positive" / "p04-positive" / "positive__old" / "result.json"
            result.parent.mkdir(parents=True)
            result.write_text('{"verifier_result":{"rewards":{"reward":1}}}\n')
            before = {path.relative_to(jobs): path.read_bytes() for path in jobs.rglob("*") if path.is_file()}
            with (
                patch.object(run_smoke, "_parse_args", return_value=self._args(root, jobs)),
                patch.object(run_smoke.shutil, "which") as which,
                patch.object(run_smoke, "build_verifier_image") as build,
            ):
                self.assertEqual(run_smoke.run(), 2)
            which.assert_not_called()
            build.assert_not_called()
            after = {path.relative_to(jobs): path.read_bytes() for path in jobs.rglob("*") if path.is_file()}
            self.assertEqual(after, before)

    def test_missing_harbor_cli_does_not_allocate_task_temp_or_build_verifier(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            jobs = root / "missing-cli-run"
            args = self._args(root, jobs)
            with (
                patch.object(run_smoke, "_parse_args", return_value=args),
                patch.object(run_smoke.shutil, "which", return_value=None),
                patch.object(run_smoke.tempfile, "mkdtemp") as mkdtemp,
                patch.object(run_smoke, "build_verifier_image") as build,
            ):
                self.assertEqual(run_smoke.run(), 2)
            mkdtemp.assert_not_called()
            build.assert_not_called()
            self.assertTrue((jobs / "preflight-rejection.json").is_file())

    def test_nonzero_harbor_exit_cannot_pass_and_all_four_rows_remain(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = root / "app.tar.gz"
            app.write_bytes(b"test artifact")
            jobs = root / "fresh-run"
            args = self._args(root, jobs)
            package = {
                "mode": "linux-server",
                "pathName": "app.tar.gz",
                "sha256": args.app_sha256,
                "packageName": "cowork-os",
                "packageVersion": "0.5.54",
                "electronDependencyPresent": False,
            }
            verifier = {
                "tag": "cowork-os-p04-verifier:" + "c" * 20,
                "imageId": "sha256:" + "d" * 64,
                "platform": "linux/amd64",
                "baseImage": args.node_image,
                "buildContextSha256": "e" * 64,
                "graderSha256": "f" * 64,
            }
            expected = {
                "positive": ("correct", "passed"),
                "wrong": ("wrong", "wrong_artifact"),
                "no-proof": ("no-proof", "no_proof"),
                "timeout": ("timeout", "timeout"),
            }

            def failed_harbor(command: list[str], **kwargs: object) -> tuple[int, str]:
                jobs_index = command.index("--jobs-dir")
                case_jobs_dir = Path(command[jobs_index + 1])
                job_name = command[command.index("--job-name") + 1]
                (case_jobs_dir / job_name).mkdir(parents=True)
                return 37, "simulated Harbor failure"

            def expected_finalization(job_dir: Path, **kwargs: object) -> dict[str, Any]:
                case_name = job_dir.name.removeprefix("p04-")
                fixture_case, acceptance = expected[case_name]
                return {"trials": [{
                    "fixtureCase": fixture_case,
                    "acceptance": acceptance,
                    "runIdentityMatches": kwargs["expected_run_identity"] is not None,
                    "candidate": {"status": "completed"},
                    "verifier": {"reward": 1 if case_name == "positive" else 0},
                }]}

            with (
                patch.object(run_smoke, "_parse_args", return_value=args),
                patch.object(run_smoke.shutil, "which", return_value="/tmp/harbor"),
                patch.object(run_smoke.importlib.metadata, "version", return_value=HARBOR_VERSION),
                patch.object(run_smoke, "inspect_app_artifact", return_value=package),
                patch.object(run_smoke, "build_verifier_image", return_value=verifier),
                patch.object(run_smoke, "_run_until_exit", side_effect=failed_harbor),
                patch.object(run_smoke, "finalize_job", side_effect=expected_finalization),
            ):
                self.assertEqual(run_smoke.run(), 1)

            manifest = json.loads((jobs / "cowork-os-run-manifest.json").read_text())
            self.assertEqual(manifest["status"], "failed")
            self.assertEqual(len(manifest["trials"]), 4)
            self.assertEqual([row["harborExitCode"] for row in manifest["trials"]], [37] * 4)
            self.assertTrue(all(row["runIdentityMatches"] for row in manifest["trials"]))
            self.assertTrue(all(row["acceptance"] == "harbor_nonzero_exit" for row in manifest["trials"]))
            self.assertEqual([row["observedAcceptance"] for row in manifest["trials"]], [
                "passed", "wrong_artifact", "no_proof", "timeout",
            ])


class AgentRunPathTests(unittest.IsolatedAsyncioTestCase):
    async def test_harbor_wheel_digest_is_reference_only(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = CoWorkOSNativeAgent(Path(tmp))
            harbor = agent._new_manifest()["harbor"]
            self.assertEqual(harbor["version"], HARBOR_VERSION)
            self.assertEqual(harbor["wheelReferenceSha256"], HARBOR_WHEEL_REFERENCE_SHA256)
            self.assertEqual(harbor["wheelIntegrityStatus"], "unverified")
            self.assertNotIn("wheelSha256", harbor)

    async def test_npm_mode_host_identity_matches_without_cache_hash_in_package(self) -> None:
        import hashlib
        import io
        import os

        def write_tar(path: Path, entries: dict[str, str]) -> str:
            with tarfile.open(path, "w:gz") as archive:
                for name, content in entries.items():
                    payload = content.encode()
                    info = tarfile.TarInfo(name)
                    info.size = len(payload)
                    archive.addfile(info, io.BytesIO(payload))
            return hashlib.sha256(path.read_bytes()).hexdigest()

        class ReachedUpload(Exception):
            pass

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = root / "cowork-os-1.2.3.tgz"
            app_sha = write_tar(app, {
                "package/package.json": json.dumps({"name": "cowork-os", "version": "1.2.3", "dependencies": {}}),
                "package/bin/coworkd-node.js": "#!/usr/bin/env node\n",
                "package/bin/coworkctl.js": "#!/usr/bin/env node\n",
            })
            cache = root / "npm-cache.tar.gz"
            cache_sha = write_tar(cache, {"_cacache/index-v5/placeholder": "x"})
            node_image = "node:24.14.1-bookworm-slim@sha256:" + "a" * 64
            package = inspect_app_artifact(app, "npm", app_sha)
            identity = run_smoke.make_run_identity(
                "npm-run-1",
                harbor_version=HARBOR_VERSION,
                package_mode="npm",
                package=package,
                provider_mode="fixture-zero-cost",
                node_image=node_image,
                verifier_image={"image": "verifier"},
                cache_sha256=cache_sha,
            )
            logs = root / "agent-logs"
            logs.mkdir()
            agent = CoWorkOSNativeAgent(logs)

            async def exec_as_root(*args: object, **kwargs: object) -> object:
                raise ReachedUpload()

            agent.exec_as_root = exec_as_root  # type: ignore[method-assign]
            env = {
                "COWORK_P04_PROVIDER_MODE": "fixture-zero-cost",
                "COWORK_P04_NODE_IMAGE": node_image,
                "COWORK_P04_APP_ARTIFACT": str(app),
                "COWORK_P04_PACKAGE_MODE": "npm",
                "COWORK_P04_APP_SHA256": app_sha,
                "COWORK_P04_NPM_CACHE_ARCHIVE": str(cache),
                "COWORK_P04_NPM_CACHE_SHA256": cache_sha,
                "COWORK_P04_RUN_IDENTITY": json.dumps(identity),
                "COWORK_P04_MAX_TURNS": str(POLICY_CAPS["maxModelTurns"]),
            }
            with patch.dict(os.environ, env), patch("importlib.metadata.version", return_value=HARBOR_VERSION):
                with self.assertRaises(ReachedUpload):
                    await agent.install(object())  # type: ignore[arg-type]
            self.assertEqual(agent._manifest["runIdentity"], identity)
            self.assertEqual(agent._manifest["package"]["offlineCacheSha256"], cache_sha)
            self.assertNotIn("offlineCacheSha256", identity["package"])

    async def test_task_creation_places_hard_model_turn_cap_in_agent_config(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            logs = Path(tmp) / "agent-logs"
            logs.mkdir()
            agent = CoWorkOSNativeAgent(logs)
            agent._manifest = None
            calls: list[tuple[str, dict[str, Any]]] = []

            async def runtime(environment: object, *args: str, timeout_sec: int = 8) -> dict[str, Any]:
                if args and args[0] == "stop":
                    return {"cleanup": {"status": "succeeded"}}
                return {"ok": True}

            async def call(environment: object, method: str, params: dict[str, Any], timeout_sec: int = 8) -> dict[str, Any]:
                calls.append((method, params))
                if method == "workspace.create":
                    return {"workspace": {"id": "workspace-test"}}
                if method == "task.create":
                    return {"taskId": "task-test"}
                if method == "task.get":
                    return {"task": {"status": "failed"}}
                if method == "task.timelinePage":
                    return {"events": [], "summary": {"truncatedEventCount": 0}, "hasMoreHistory": False}
                raise AssertionError("unexpected Control Plane call: " + method)

            agent._runtime = runtime  # type: ignore[method-assign]
            agent._call = call  # type: ignore[method-assign]
            await agent.run(
                "<!-- cowork-p04-case=no-proof -->\nCreate then verify the exact artifact.",
                object(),
                AgentContext(),
            )
            created = next(params for method, params in calls if method == "task.create")
            self.assertNotIn("maxTurns", created)
            self.assertEqual(created["agentConfig"]["maxTurns"], POLICY_CAPS["maxModelTurns"])
            self.assertEqual(created["agentConfig"]["turnBudgetPolicy"], "hard_window")
            self.assertEqual(agent._manifest["candidate"]["terminalStatus"], "failed")


if __name__ == "__main__":
    unittest.main()
