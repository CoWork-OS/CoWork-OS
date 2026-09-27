"""Harbor installed-agent adapter for CoWork OS native task execution."""
from __future__ import annotations

import json
import os
import re
import shlex
import time
from pathlib import Path
from typing import Any

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext, ModelUsage

from benchmarks.harbor.manifest import (
    HARBOR_VERSION,
    HARBOR_WHEEL_REFERENCE_SHA256,
    POLICY_CAPS,
    AdapterPreflightError,
    aggregate_timeline_usage,
    inspect_app_artifact,
    manifest_path_for_agent,
    validate_run_config,
    write_manifest,
)

CASE_PATTERN = re.compile(r"^<!-- cowork-p04-case=(correct|wrong|no-proof|timeout) -->\s*\n?", re.MULTILINE)
RUNTIME_HELPER = Path(__file__).with_name("runtime.cjs")
FIXTURE_PROVIDER = Path(__file__).with_name("mock_ollama.cjs")
APP_REMOTE_PATH = "/tmp/cowork-os-p04-app.tar.gz"
RUNTIME_REMOTE_TMP = "/tmp/cowork-os-p04-runtime.cjs"
PROVIDER_REMOTE_TMP = "/tmp/cowork-os-p04-mock-ollama.cjs"


def _safe_error(value: object) -> str:
    message = str(value or "")
    message = re.sub(r"(?i)(token|api[_-]?key|secret)\s*[:=]\s*[^\s,;]+", r"\1=[redacted]", message)
    message = re.sub(r"\b(?:sk|rk|pk|ghp|github_pat)_[A-Za-z0-9._-]+\b", "[redacted]", message)
    return message[:500]


def _required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise AdapterPreflightError("missing_config", name + " is required")
    return value


def _command_result(result: Any) -> tuple[int, str, str]:
    return (
        int(getattr(result, "return_code", 1)),
        str(getattr(result, "stdout", "") or ""),
        str(getattr(result, "stderr", "") or ""),
    )


class CoWorkOSNativeAgent(BaseInstalledAgent):
    """Install and run the pinned CoWork OS Node daemon through coworkctl."""

    @staticmethod
    def name() -> str:
        return "cowork-os-native"

    def _manifest_path(self) -> Path:
        return manifest_path_for_agent(Path(self.logs_dir))

    def _write(self) -> None:
        if self._manifest is not None:
            write_manifest(self._manifest_path(), self._manifest)

    def _new_manifest(self) -> dict[str, Any]:
        return {
            "schemaVersion": "cowork-os-harbor-adapter/v1",
            "developer": "cowork-os",
            "harbor": {
                "version": HARBOR_VERSION,
                "versionStatus": "not_checked",
                "wheelReferenceSha256": HARBOR_WHEEL_REFERENCE_SHA256,
                "wheelIntegrityStatus": "unverified",
            },
            "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "caps": {
                "attempts": 1,
                "taskDeadlineSeconds": 24,
                "maxHarborAgentSeconds": 90,
                "maxJobDeadlineSeconds": 600,
                "maxTokens": 2048,
                "maxModelTurns": POLICY_CAPS["maxModelTurns"],
                "maxFixtureModelRequests": 12,
                "externalSpendCapUsd": 0.0,
            },
            "package": {},
            "provider": {"mode": "fixture-zero-cost", "route": "ollama", "model": "p04-fixture"},
            "candidate": {"status": "not_started"},
            "usage": {
                "status": "missing",
                "limitation": "canonical type=llm_usage events only; missing means none were extracted, not that the runtime emitted none",
                "tokens": None,
                "telemetryCostUsd": None,
                "telemetryCostKnown": False,
            },
            "cleanup": {"status": "not_started"},
        }

    async def install(self, environment: BaseEnvironment) -> None:
        self._manifest = self._new_manifest()
        try:
            harbor_version = __import__("importlib.metadata", fromlist=["version"]).version("harbor")
            if harbor_version != HARBOR_VERSION:
                raise AdapterPreflightError("unsupported", "installed Harbor version does not match the pinned adapter version")
            self._manifest["harbor"]["versionStatus"] = "verified"
            config = validate_run_config({
                "provider_mode": os.environ.get("COWORK_P04_PROVIDER_MODE"),
                "node_image": os.environ.get("COWORK_P04_NODE_IMAGE"),
                "attempts": int(os.environ.get("COWORK_P04_ATTEMPTS", "1")),
                "max_task_seconds": int(os.environ.get("COWORK_P04_TASK_SECONDS", "24")),
                "max_job_seconds": int(os.environ.get("COWORK_P04_JOB_SECONDS", "600")),
                "max_tokens": int(os.environ.get("COWORK_P04_TOKEN_CAP", "2048")),
                "max_model_turns": int(os.environ.get("COWORK_P04_MAX_TURNS", "0")),
            })
            artifact_path = Path(_required_env("COWORK_P04_APP_ARTIFACT")).expanduser().resolve()
            package_mode = _required_env("COWORK_P04_PACKAGE_MODE")
            expected_hash = _required_env("COWORK_P04_APP_SHA256")
            package = inspect_app_artifact(artifact_path, package_mode, expected_hash)
            try:
                run_identity = json.loads(_required_env("COWORK_P04_RUN_IDENTITY"))
            except json.JSONDecodeError as error:
                raise AdapterPreflightError("missing_config", "host run identity is invalid") from error
            if not isinstance(run_identity, dict):
                raise AdapterPreflightError("missing_config", "host run identity is invalid")
            self._manifest["package"] = dict(package)
            self._manifest["nodeImage"] = config["nodeImage"]
            self._manifest["runtimeArchitecture"] = "linux/amd64"
            self._manifest["preflight"] = {"status": "passed", "providerMode": config["providerMode"], "networkPolicy": config["networkPolicy"]}
            if package_mode == "npm":
                cache_archive = Path(_required_env("COWORK_P04_NPM_CACHE_ARCHIVE")).expanduser().resolve()
                cache_hash = _required_env("COWORK_P04_NPM_CACHE_SHA256")
                from benchmarks.harbor.manifest import inspect_cache_archive
                inspect_cache_archive(cache_archive, cache_hash)
                self._manifest["package"]["offlineCacheSha256"] = cache_hash.lower()
            cache_sha256 = self._manifest["package"].get("offlineCacheSha256")
            identity_body = {key: value for key, value in run_identity.items() if key != "identitySha256"}
            identity_digest = __import__("hashlib").sha256(
                json.dumps(identity_body, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
            ).hexdigest()
            if (
                run_identity.get("schemaVersion") != "cowork-os-harbor-run-identity/v1"
                or run_identity.get("identitySha256") != identity_digest
                or run_identity.get("harborVersion") != harbor_version
                or run_identity.get("packageMode") != package_mode
                or run_identity.get("package") != package
                or run_identity.get("providerMode") != config["providerMode"]
                or run_identity.get("nodeImage") != config["nodeImage"]
                or run_identity.get("npmCacheSha256") != cache_sha256
                or run_identity.get("policyCaps") != config["caps"]
            ):
                raise AdapterPreflightError("unsupported", "host run identity does not match installed package and runtime configuration")
            self._manifest["runIdentity"] = run_identity
            self._write()

            await self.exec_as_root(environment, command="mkdir -p /opt/cowork-os /opt/cowork-os-harness /workspace && chown -R root:root /opt/cowork-os /opt/cowork-os-harness && chmod 0755 /opt/cowork-os /opt/cowork-os-harness && chown node:node /workspace && chmod 0700 /workspace", cwd="/")
            await environment.upload_file(artifact_path, APP_REMOTE_PATH)
            remote_hash = await self.exec_as_root(environment, command="sha256sum " + shlex.quote(APP_REMOTE_PATH))
            _, hash_stdout, _ = _command_result(remote_hash)
            if not hash_stdout.split() or hash_stdout.split()[0].lower() != package["sha256"]:
                raise AdapterPreflightError("unsupported", "uploaded app artifact hash does not match its host pin")
            if package_mode == "linux-server":
                install_command = "tar -xzf " + shlex.quote(APP_REMOTE_PATH) + " -C /opt/cowork-os --strip-components=1"
                await self.exec_as_root(environment, command=install_command, timeout_sec=30)
            else:
                cache_archive = Path(_required_env("COWORK_P04_NPM_CACHE_ARCHIVE")).expanduser().resolve()
                cache_info = inspect_cache_archive(cache_archive, cache_hash)
                await environment.upload_file(cache_archive, "/tmp/cowork-os-p04-npm-cache.tar.gz")
                cache_remote = await self.exec_as_root(environment, command="sha256sum /tmp/cowork-os-p04-npm-cache.tar.gz")
                if _command_result(cache_remote)[1].split()[0].lower() != cache_info["sha256"]:
                    raise AdapterPreflightError("unsupported", "uploaded npm cache hash does not match its pin")
                await self.exec_as_root(environment, command="mkdir -p /tmp/cowork-os-p04-npm-cache && tar -xzf /tmp/cowork-os-p04-npm-cache.tar.gz -C /tmp/cowork-os-p04-npm-cache && npm install --prefix /opt/cowork-os --offline --cache /tmp/cowork-os-p04-npm-cache --omit=optional --no-audit --no-fund " + shlex.quote(APP_REMOTE_PATH) + " && test -f /opt/cowork-os/node_modules/cowork-os/package.json && ln -s /opt/cowork-os/node_modules/cowork-os/bin /opt/cowork-os/bin && ln -s /opt/cowork-os/node_modules/cowork-os/dist /opt/cowork-os/dist && ln -s /opt/cowork-os/node_modules/cowork-os/package.json /opt/cowork-os/package.json", timeout_sec=60)
                await self.exec_as_root(environment, command="npm rebuild --prefix /opt/cowork-os --offline --ignore-scripts=false better-sqlite3", timeout_sec=60)

            node_result = await environment.exec(command="node --version && node -e 'const p=require(\"/opt/cowork-os/package.json\"); if ([\"electron\",\"electron-updater\",\"@electron/rebuild\"].some(n => (p.dependencies||{})[n] || (p.optionalDependencies||{})[n])) process.exit(9); let present=false; try { require.resolve(\"electron\", {paths:[\"/opt/cowork-os\"]}); present=true; } catch (e) { if (e.code !== \"MODULE_NOT_FOUND\") throw e; } if (present) process.exit(8); const D=require(\"/opt/cowork-os/node_modules/better-sqlite3\"); const d=new D(\":memory:\"); d.close();' && if find /opt/cowork-os -type f \\( -path '*/node_modules/electron/package.json' -o -path '*/node_modules/electron-updater/package.json' -o -path '*/node_modules/@electron/rebuild/package.json' \\) -print -quit | grep -q .; then exit 10; fi", timeout_sec=15)
            node_code, node_stdout, node_stderr = _command_result(node_result)
            if node_code != 0 or "v24.14.1" not in node_stdout:
                raise AdapterPreflightError("unsupported", "installed runtime must be Node v24.14.1 with working better-sqlite3 and no Electron package")
            daemon_help = await environment.exec(command="node /opt/cowork-os/bin/coworkd-node.js --help", timeout_sec=10)
            ctl_help = await environment.exec(command="node /opt/cowork-os/bin/coworkctl.js --help", timeout_sec=10)
            daemon_text = _command_result(daemon_help)[1]
            ctl_text = _command_result(ctl_help)[1] + _command_result(ctl_help)[2]
            if "Node-only, headless" not in daemon_text or "Usage:" not in ctl_text:
                raise AdapterPreflightError("unsupported", "installed coworkd-node or coworkctl entrypoint failed its help probe")
            await environment.upload_file(RUNTIME_HELPER, RUNTIME_REMOTE_TMP)
            await environment.upload_file(FIXTURE_PROVIDER, PROVIDER_REMOTE_TMP)
            await self.exec_as_root(environment, command="install -o root -g root -m 0644 " + shlex.quote(RUNTIME_REMOTE_TMP) + " /opt/cowork-os-harness/runtime.cjs && install -o root -g root -m 0644 " + shlex.quote(PROVIDER_REMOTE_TMP) + " /opt/cowork-os-harness/mock_ollama.cjs && rm -f " + shlex.quote(RUNTIME_REMOTE_TMP) + " " + shlex.quote(PROVIDER_REMOTE_TMP))
            self._manifest["install"] = {"status": "succeeded", "nodeVersion": node_stdout.strip().splitlines()[0], "electronPackagePresent": False, "betterSqlite3": "opened and closed in-memory database"}
            self._write()
        except AdapterPreflightError as error:
            self._manifest["preflight"] = {"status": error.status, "reason": _safe_error(error)}
            self._manifest["candidate"] = {"status": error.status}
            self._write()
            raise RuntimeError(str(error)) from error
        except Exception as error:
            self._manifest["preflight"] = {"status": "install_failed", "reason": _safe_error(error)}
            self._manifest["candidate"] = {"status": "install_failed"}
            self._write()
            raise

    async def _runtime(self, environment: BaseEnvironment, *args: str, timeout_sec: int = 8) -> dict[str, Any]:
        command = "node " + shlex.quote("/opt/cowork-os-harness/runtime.cjs") + " " + " ".join(shlex.quote(arg) for arg in args)
        result = await environment.exec(command=command, timeout_sec=timeout_sec)
        code, stdout, stderr = _command_result(result)
        lines = [line for line in stdout.splitlines() if line.strip()]
        if not lines:
            raise RuntimeError("runtime controller returned no structured response: " + _safe_error(stderr))
        try:
            payload = json.loads(lines[-1])
        except json.JSONDecodeError as error:
            raise RuntimeError("runtime controller returned invalid JSON") from error
        if code != 0 or payload.get("ok") is not True:
            raise RuntimeError(_safe_error(payload.get("error") or stderr or "runtime controller failed"))
        return payload

    async def _call(self, environment: BaseEnvironment, method: str, params: dict[str, Any], timeout_sec: int = 8) -> dict[str, Any]:
        return (await self._runtime(environment, "call", method, json.dumps(params, separators=(",", ":")), timeout_sec=timeout_sec))["payload"]

    async def _collect_usage(self, environment: BaseEnvironment, task_id: str) -> dict[str, Any]:
        pages: list[dict[str, Any]] = []
        cursor: dict[str, Any] | None = None
        for _ in range(16):
            params: dict[str, Any] = {"taskId": task_id, "limit": 128, "byteLimit": 262144, "singleEventByteLimit": 65536}
            if cursor is not None:
                params["cursor"] = cursor
            page = await self._call(environment, "task.timelinePage", params)
            pages.append(page)
            if page.get("hasMoreHistory") is not True:
                break
            next_cursor = page.get("nextCursor")
            if not isinstance(next_cursor, dict) or next_cursor == cursor:
                pages[-1]["hasMoreHistory"] = True
                break
            cursor = next_cursor
        else:
            pages[-1]["hasMoreHistory"] = True
        return aggregate_timeline_usage(pages)

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        if self._manifest is None:
            self._manifest = self._new_manifest()
        match = CASE_PATTERN.match(instruction)
        if match is None:
            self._manifest["candidate"] = {"status": "missing_config", "reason": "fixture case marker is absent"}
            self._write()
            return
        case = match.group(1)
        prompt = instruction[match.end():].strip()
        if not prompt:
            self._manifest["candidate"] = {"status": "missing_config", "reason": "task instruction is empty"}
            self._write()
            return
        self._manifest["fixtureCase"] = case
        self._manifest["candidate"] = {"status": "running", "startedAt": time.time()}
        self._write()
        started = time.monotonic()
        workspace_id: str | None = None
        task_id: str | None = None
        terminal_status: str | None = None
        usage = {"status": "missing", "tokens": None, "telemetryCostUsd": None, "telemetryCostKnown": False}
        cleanup: dict[str, Any] = {"status": "failed", "reason": "cleanup has not run"}
        try:
            await self._runtime(environment, "start", case, timeout_sec=45)
            workspace_result = await self._call(environment, "workspace.create", {
                "name": "P04 native smoke " + case,
                "path": "/workspace",
            })
            workspace = workspace_result.get("workspace") if isinstance(workspace_result, dict) else None
            workspace_id = workspace.get("id") if isinstance(workspace, dict) else None
            if not isinstance(workspace_id, str) or not workspace_id:
                raise RuntimeError("workspace.create returned no workspace identity")

            created = await self._call(environment, "task.create", {
                "title": "P04 native Harbor smoke " + case,
                "prompt": prompt,
                "workspaceId": workspace_id,
                "shellAccess": False,
                "budgetTokens": 2048,
                "budgetCost": 0.0,
                "agentConfig": {
                    "permissionMode": "bypass_permissions",
                    "shellAccess": False,
                    "allowedTools": ["write_file", "read_file", "list_directory"],
                    "retainMemory": False,
                    "maxTurns": self._manifest["caps"]["maxModelTurns"],
                    "turnBudgetPolicy": "hard_window",
                },
            })
            task_id = created.get("taskId") or (created.get("task") or {}).get("id")
            if not isinstance(task_id, str) or not task_id:
                raise RuntimeError("task.create returned no task identity")
            self._manifest["candidate"]["taskId"] = task_id
            self._manifest["candidate"]["workspaceId"] = workspace_id
            self._write()
            deadline = time.monotonic() + 24
            while True:
                status_result = await self._call(environment, "task.get", {"taskId": task_id}, timeout_sec=6)
                task = status_result.get("task") if isinstance(status_result, dict) else None
                terminal_status = task.get("status") if isinstance(task, dict) else None
                if terminal_status in {"completed", "failed", "cancelled"}:
                    break
                if time.monotonic() >= deadline:
                    try:
                        await self._call(environment, "task.cancel", {"taskId": task_id}, timeout_sec=4)
                    except Exception:
                        pass
                    grace_deadline = time.monotonic() + 3
                    while time.monotonic() < grace_deadline:
                        try:
                            current = await self._call(environment, "task.get", {"taskId": task_id}, timeout_sec=4)
                            row = current.get("task") if isinstance(current, dict) else None
                            terminal_status = row.get("status") if isinstance(row, dict) else terminal_status
                            if terminal_status in {"completed", "failed", "cancelled"}:
                                break
                        except Exception:
                            break
                        await __import__("asyncio").sleep(0.25)
                    self._manifest["candidate"] = {
                        **self._manifest["candidate"],
                        "status": "timeout",
                        "terminalStatus": terminal_status,
                        "deadlineSeconds": 24,
                    }
                    break
                await __import__("asyncio").sleep(0.5)

            if self._manifest["candidate"].get("status") != "timeout":
                candidate_status = "completed" if terminal_status == "completed" else terminal_status or "failed"
                self._manifest["candidate"] = {
                    **self._manifest["candidate"],
                    "status": candidate_status,
                    "terminalStatus": terminal_status,
                }
            usage = await self._collect_usage(environment, task_id)
            self._manifest["usage"] = usage
        except Exception as error:
            self._manifest["candidate"] = {
                **self._manifest.get("candidate", {}),
                "status": "failed",
                "error": _safe_error(error),
                "terminalStatus": terminal_status,
            }
        finally:
            if task_id and terminal_status not in {"completed", "failed", "cancelled"} and self._manifest["candidate"].get("status") != "timeout":
                try:
                    await self._call(environment, "task.cancel", {"taskId": task_id}, timeout_sec=4)
                except Exception:
                    pass
            try:
                stopped = await self._runtime(environment, "stop", timeout_sec=8)
                cleanup = stopped.get("cleanup") if isinstance(stopped.get("cleanup"), dict) else {"status": "failed"}
            except Exception as error:
                cleanup = {"status": "failed", "reason": _safe_error(error)}
            self._manifest["cleanup"] = cleanup
            self._manifest["candidate"]["elapsedSeconds"] = round(time.monotonic() - started, 3)
            self._manifest["finishedAt"] = time.time()
            if self._manifest.get("usage", {}).get("status") == "missing" and usage.get("status") != "missing":
                self._manifest["usage"] = usage
            provider_usage = cleanup.get("providerUsage") if isinstance(cleanup.get("providerUsage"), dict) else None
            self._manifest["provider"]["requestCap"] = 12
            self._manifest["provider"]["usage"] = provider_usage or {
                "status": "missing",
                "chatAttempts": None,
                "modelRequestsAdmitted": None,
                "rejectedRequests": None,
                "completedResponses": None,
                "tokens": None,
                "externalSpendUsd": None,
                "externalSpendKnown": False,
            }
            self._write()

    def populate_context_post_run(self, context: AgentContext) -> None:
        try:
            manifest = json.loads(self._manifest_path().read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        usage = manifest.get("usage") if isinstance(manifest.get("usage"), dict) else {}
        tokens = usage.get("tokens") if isinstance(usage.get("tokens"), dict) else None
        if usage.get("status") == "complete" and tokens is not None:
            context.n_input_tokens = int(tokens["inputTokens"])
            context.n_cache_tokens = int(tokens.get("cachedTokens", 0))
            context.n_output_tokens = int(tokens["outputTokens"])
            context.cost_usd = 0.0
            context.model_usage = {
                "ollama/p04-fixture": ModelUsage(
                    n_input_tokens=context.n_input_tokens,
                    n_cache_tokens=context.n_cache_tokens,
                    n_output_tokens=context.n_output_tokens,
                    cost_usd=0.0,
                )
            }
