import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig, AgentRole, Task, Workspace } from "../../shared/types";
import {
  ExecutionEnvironmentSelectionSchema,
  ENVIRONMENT_FILE_TOOLS,
  ENVIRONMENT_COMMAND_TOOLS,
  isEnvironmentTool,
  isToolSupportedInEnvironment,
  environmentControlKey,
  type ExecutionEnvironmentBinding,
  type ExecutionEnvironmentSelection,
} from "../../shared/execution-environment";
import { isSpaceRelativePath } from "../../shared/space-sandbox";
import { assertWorkspaceFilesystemAccess } from "../security/access-profile-paths";
import { ComputerViewService } from "../computer-use/computer-view-service";
import { BotDesktopManager, findBotDesktopResources } from "../computer-use/bot-desktop-manager";
import { getUserDataDir } from "../utils/user-data-dir";
import { loadPolicies } from "../admin/policies";
import { canEnableSubprocessNetwork } from "../security/subprocess-network-policy";
import {
  snapshotSpaceInputs,
  validateSpaceOutputs,
  publishSpaceOutputs,
  decodeSpaceOutputs,
} from "../agent/sandbox/space-files";
import {
  BotDesktopEnvironmentBackend,
  CuaEnvironmentBackend,
  type EnvironmentBackend,
} from "./environment-backends";

interface EnvironmentDaemon {
  getTask(id: string): Task | undefined;
  getAgentRoleById?(id: string): AgentRole | undefined;
  updateTask(id: string, update: { agentConfig: AgentConfig }): void;
  logEvent(id: string, type: Any, payload: Any): void;
  getChildTasks?(id: string): Promise<Task[]>;
}

const READ_TOOLS = new Set([
  "read_file",
  "read_files",
  "list_directory",
  "list_directory_with_sizes",
  "get_file_info",
  "glob",
  "grep",
  "search_files",
  "process_output",
  "browser_snapshot",
  "browser_get_text",
  "browser_get_content",
  "browser_tabs",
  "browser_screenshot",
]);
const activeTasks = new Set<string>();
const resourceLocks = new Map<string, Promise<void>>();
const activeOperations = new Map<string, AbortController>();

/** Task-bound routing beneath the existing tool policy; not a second task orchestrator. */
export class ExecutionEnvironmentController {
  private backend?: EnvironmentBackend;
  private allocating?: Promise<ExecutionEnvironmentBinding>;

  static async quiesce(resourceId: string): Promise<void> {
    activeOperations.get(resourceId)?.abort(new Error("The person is taking over this computer."));
    await resourceLocks.get(resourceId);
  }

  constructor(
    private workspace: Workspace,
    private readonly daemon: EnvironmentDaemon,
    private readonly taskId: string,
    private readonly backendFactory: (
      selection: ExecutionEnvironmentSelection,
    ) => EnvironmentBackend = (selection) =>
      selection.backend === "cua"
        ? new CuaEnvironmentBackend()
        : new BotDesktopEnvironmentBackend(),
  ) {}

  updateWorkspace(workspace: Workspace): void {
    const current = this.read();
    if (workspace.id !== this.workspace.id && current && current.state !== "released")
      throw new Error("A task computer cannot switch workspaces.");
    this.workspace = workspace;
    const binding = this.read();
    if (binding)
      activeOperations
        .get(environmentControlKey(binding))
        ?.abort(new Error("Workspace authority changed."));
  }

  selection(): ExecutionEnvironmentSelection | undefined {
    const task = this.daemon.getTask?.(this.taskId);
    const saved = task?.agentConfig?.executionEnvironmentBinding;
    if (saved && saved.state !== "released") return saved.selection;
    const role = task?.assignedAgentRoleId
      ? this.daemon.getAgentRoleById?.(task.assignedAgentRoleId)
      : undefined;
    const value = task?.agentConfig?.executionEnvironment ?? role?.executionEnvironment;
    return value ? ExecutionEnvironmentSelectionSchema.parse(value) : undefined;
  }

  isSelected(): boolean {
    return Boolean(this.selection());
  }

  normalizeInput(name: string, input: Any): Any {
    if (!this.isSelected() || !ENVIRONMENT_FILE_TOOLS.has(name)) return input;
    const root =
      this.read()?.cwd ||
      (this.selection()?.backend === "cua" ? "/home/cua/work" : "/home/bot/work");
    const normalized = { ...input };
    for (const key of ["path", "file_path", "sourcePath", "destPath", "oldPath", "newPath"]) {
      const value = normalized[key];
      if (typeof value !== "string" || !value.startsWith("/")) continue;
      if (value === root) normalized[key] = ".";
      else if (value.startsWith(root + "/")) normalized[key] = value.slice(root.length + 1);
      else throw new Error("The path is outside this computer's work folder.");
    }
    return normalized;
  }

  supports(name: string): boolean {
    if (!this.isSelected()) return true;
    return isToolSupportedInEnvironment(name);
  }

  private save(binding: ExecutionEnvironmentBinding) {
    const task = this.daemon.getTask(this.taskId);
    if (!task) throw new Error("The computer's task is unavailable.");
    if (binding.taskId !== task.id || binding.workspaceId !== this.workspace.id)
      throw new Error("Computer binding ownership mismatch.");
    this.daemon.updateTask(this.taskId, {
      agentConfig: { ...task.agentConfig, executionEnvironmentBinding: structuredClone(binding) },
    });
    ComputerViewService.getInstance().publishEnvironment(this.taskId, {
      id: binding.id,
      backend: binding.selection.backend,
      lifetime: binding.selection.lifetime,
      state: binding.state,
      error: binding.error,
    });
    this.daemon.logEvent(this.taskId, "log", {
      metric: "execution_environment",
      environmentId: binding.id,
      state: binding.state,
      backend: binding.selection.backend,
    });
  }

  private read(): ExecutionEnvironmentBinding | undefined {
    return this.daemon.getTask(this.taskId)?.agentConfig?.executionEnvironmentBinding;
  }

  private getBackend(binding: ExecutionEnvironmentBinding) {
    if (!this.backend) {
      if (binding.selection.backend === "bot-desktop") {
        try {
          BotDesktopManager.getInstance();
        } catch {
          BotDesktopManager.configure({
            dataDir: getUserDataDir,
            resourcesDir: findBotDesktopResources,
            desktopHostFor: (id) => this.daemon.getAgentRoleById?.(id)?.desktopHost,
            desktopGroupFor: (id) => this.daemon.getAgentRoleById?.(id)?.desktopGroup,
            desktopNetworkFor: (id) => this.daemon.getAgentRoleById?.(id)?.desktopNetwork,
          });
        }
      }
      this.backend = this.backendFactory(binding.selection);
    }
    return this.backend;
  }

  async ensure(): Promise<ExecutionEnvironmentBinding> {
    if (this.allocating) return this.allocating;
    const existing = this.read();
    if (existing && existing.state !== "released") {
      if (existing.taskId !== this.taskId || existing.workspaceId !== this.workspace.id)
        throw new Error("Computer binding ownership mismatch.");
      if (existing.state !== "ready" || existing.pending)
        throw new Error(
          `Computer has unresolved work (${existing.state}). Use computer_environment reconcile or inspect its status.`,
        );
      ComputerViewService.getInstance().bindEnvironment(
        this.taskId,
        environmentControlKey(existing),
      );
      return existing;
    }
    this.allocating = this.allocate(existing?.generation ?? 0).finally(() => {
      this.allocating = undefined;
    });
    return this.allocating;
  }

  private async allocate(generation: number) {
    const task = this.daemon.getTask(this.taskId);
    const selection = this.selection();
    if (!task || !selection) throw new Error("No isolated computer was selected.");
    this.assertPolicy(selection);
    // Validate and bound the entire host input manifest before Any provisioning.
    snapshotSpaceInputs(this.workspace, selection.inputPaths);
    const ancestorId = task.agentConfig?.executionEnvironmentParentTaskId;
    let ancestorBinding: ExecutionEnvironmentBinding | undefined;
    if (ancestorId) {
      const ancestor = this.daemon.getTask(ancestorId);
      if (!ancestor || ancestor.workspaceId !== this.workspace.id)
        throw new Error("A delegated computer task must retain its ancestor's workspace boundary.");
      const controller = new ExecutionEnvironmentController(
        this.workspace,
        this.daemon,
        ancestorId,
        this.backendFactory,
      );
      try {
        ancestorBinding = await controller.ensure();
      } finally {
        await controller.close();
      }
    }
    const binding: ExecutionEnvironmentBinding = {
      version: 1,
      id: randomUUID(),
      generation: generation + 1,
      taskId: task.id,
      workspaceId: this.workspace.id,
      botId: task.assignedAgentRoleId,
      selection,
      resourceId: selection.space || "",
      owned: !selection.space && !ancestorBinding,
      os: "linux",
      cwd: selection.backend === "cua" ? "/home/cua/work" : "/home/bot/work",
      state: "allocating",
      exported: [],
      createdAt: Date.now(),
    };
    // Placement is pinned before provisioning. Names remain recoverable after a lost reply.
    if (ancestorBinding) {
      binding.resourceId = ancestorBinding.resourceId;
      binding.cwd = ancestorBinding.cwd;
    } else if (selection.backend === "bot-desktop") {
      this.getBackend(binding);
      binding.resourceId = BotDesktopManager.getInstance().bindEnvironment(
        binding.id,
        binding.botId,
        selection.lifetime,
      );
    } else
      binding.resourceId =
        selection.space ||
        (selection.lifetime === "persistent"
          ? `cowork-bot-${createHash("sha256")
              .update(binding.botId || this.taskId)
              .digest("hex")
              .slice(0, 20)}`
          : `cowork-${binding.id}`);
    this.save(binding);
    try {
      const result = ancestorBinding
        ? { resourceId: ancestorBinding.resourceId, cwd: ancestorBinding.cwd }
        : await this.getBackend(binding).allocate(binding);
      binding.resourceId = result.resourceId;
      binding.cwd = result.cwd;
      binding.state = "ready";
      this.save(binding);
      ComputerViewService.getInstance().bindEnvironment(
        this.taskId,
        environmentControlKey(binding),
      );
      for (const input of selection.inputPaths) await this.importFile(binding, input);
      return binding;
    } catch (error) {
      binding.state = (error as { notDispatched?: boolean })?.notDispatched
        ? "allocating"
        : "unknown";
      binding.error =
        "Computer setup did not complete. Inspect before retrying; it may already exist.";
      this.save(binding);
      throw error;
    }
  }

  private assertPolicy(selection: ExecutionEnvironmentSelection) {
    const permissions = this.workspace.permissions;
    if (permissions.accessProfileUnavailable)
      throw new Error("The active access profile is unavailable.");
    // Per-domain rules and on-request networking cannot constrain arbitrary guest code.
    if (
      (permissions.accessDomainRules || []).length ||
      permissions.accessNetworkMode === "on-request"
    ) {
      throw new Error(
        "This computer backend cannot enforce the active domain-scoped/on-request network policy.",
      );
    }
    const task = this.daemon.getTask(this.taskId);
    const role = task?.assignedAgentRoleId
      ? this.daemon.getAgentRoleById?.(task.assignedAgentRoleId)
      : undefined;
    const policies = loadPolicies();
    if (
      selection.backend === "bot-desktop" &&
      !policies.runtime.allowedSandboxTypes.includes("docker")
    ) {
      throw new Error("Container computers are disabled by administrator policy.");
    }
    if (selection.backend === "cua" && policies.runtime.requireSandboxForShell) {
      throw new Error(
        "This Cua environment has not been qualified for the administrator's required shell sandbox.",
      );
    }
    const offline = selection.backend === "bot-desktop" && role?.desktopNetwork === "off";
    if (!offline && !canEnableSubprocessNetwork(permissions, policies)) {
      throw new Error(
        "This computer cannot enforce the administrator's subprocess network policy.",
      );
    }
    const binding = this.read();
    if (
      offline &&
      binding?.resourceId.startsWith("environment:") &&
      JSON.parse(binding.resourceId.slice(12)).network !== "off"
    ) {
      throw new Error(
        "The bot's network authority narrowed. Stop this computer before starting an offline run.",
      );
    }
    if (role?.desktopNetwork === "off" && selection.backend === "cua")
      throw new Error("This Cua backend cannot enforce the bot's No network setting.");
    if (permissions.network !== true || permissions.accessNetworkMode === "disabled") {
      if (selection.backend !== "bot-desktop" || role?.desktopNetwork !== "off") {
        throw new Error("Choose a bot desktop with No network for this access profile.");
      }
    }
    if (permissions.sandboxType === "space")
      throw new Error("SPACE offline jobs and a task computer cannot be selected together.");
    if (
      [task?.agentConfig?.inheritedBotWorksOn, role?.worksOn].some(
        (limit) => limit === "off" || limit === "browser",
      )
    ) {
      throw new Error("The bot's computer limit does not permit this environment.");
    }
  }

  private assertCommandPolicy(name: string, input: Any) {
    if (!ENVIRONMENT_COMMAND_TOOLS.has(name) && name !== "desktop_run") return;
    if (this.workspace.permissions.shell !== true)
      throw new Error("Command tools are disabled by the workspace.");
    const task = this.daemon.getTask(this.taskId);
    if (task?.agentConfig?.readOnlyExecution)
      throw new Error("Commands are unavailable to this read-only task.");
    if (name === "execute_code" && input.allow_network !== true) {
      const role = task?.assignedAgentRoleId
        ? this.daemon.getAgentRoleById?.(task.assignedAgentRoleId)
        : undefined;
      if (role?.desktopNetwork !== "off")
        throw new Error("Network-disabled code requires a No network desktop.");
    }
  }

  private assertPaths(name: string, input: Any, binding: ExecutionEnvironmentBinding) {
    if (!ENVIRONMENT_FILE_TOOLS.has(name)) return;
    const writing = [
      "write_file",
      "edit_file",
      "create_directory",
      "copy_file",
      "rename_file",
      "delete_file",
    ].includes(name);
    const operation =
      name === "delete_file" || name === "rename_file" ? "delete" : writing ? "write" : "read";
    if (!writing && this.workspace.permissions.read !== true) {
      throw new Error("File reads are disabled by the workspace.");
    }
    if (
      !["path", "file_path", "sourcePath", "destPath", "oldPath", "newPath"].some(
        (key) => typeof input[key] === "string",
      )
    ) {
      assertWorkspaceFilesystemAccess(this.workspace, ".", operation, "computer work folder");
    }
    for (const key of ["path", "file_path", "sourcePath", "destPath", "oldPath", "newPath"]) {
      const value = input[key];
      if (typeof value !== "string") continue;
      const relative = value.startsWith(binding.cwd + "/")
        ? value.slice(binding.cwd.length + 1)
        : value;
      if (relative !== "." && !isSpaceRelativePath(relative))
        throw new Error("Use a relative path inside this computer's work folder.");
      assertWorkspaceFilesystemAccess(
        this.workspace,
        relative,
        key === "sourcePath" ? "read" : operation,
        "computer work file",
      );
    }
    if (writing && this.workspace.permissions.write !== true)
      throw new Error("File writes are disabled by the workspace.");
    if (operation === "delete" && this.workspace.permissions.delete !== true)
      throw new Error("File deletion is disabled by the workspace.");
  }

  async execute(name: string, input: Any = {}, signal?: AbortSignal): Promise<Any> {
    if (name === "computer_environment") return this.action(input, signal);
    if (!isEnvironmentTool(name)) throw new Error(`Tool ${name} has no guest implementation.`);
    input = this.normalizeInput(name, input);
    const binding = await this.ensure();
    this.assertPolicy(binding.selection);
    this.assertCommandPolicy(name, input);
    this.assertPaths(name, input, binding);
    signal?.throwIfAborted();
    const view = ComputerViewService.getInstance();
    const controlKey = environmentControlKey(binding);
    view.bindEnvironment(this.taskId, controlKey);
    view.assertNotHeld(this.taskId);
    if (activeTasks.has(binding.id))
      throw new Error("Another operation is using this task computer.");
    activeTasks.add(binding.id);
    const operation = randomUUID();
    if (name === "desktop_save_file") {
      activeTasks.delete(binding.id);
      return this.exportFile(binding, input.path);
    }
    let unlock!: () => void;
    const previous = resourceLocks.get(controlKey) || Promise.resolve();
    const current = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const tail = previous.then(() => current);
    resourceLocks.set(controlKey, tail);
    await previous;
    if (view.isHeldByPerson(this.taskId) || signal?.aborted) {
      unlock();
      activeTasks.delete(binding.id);
      signal?.throwIfAborted();
      throw new Error("The person has taken over this computer.");
    }
    const mutating = !READ_TOOLS.has(name);
    try {
      // Authority may have narrowed while another task held this physical computer's lease.
      this.assertPolicy(binding.selection);
      this.assertCommandPolicy(name, input);
      this.assertPaths(name, input, binding);
      if (mutating) {
        binding.pending = {
          id: operation,
          tool: name,
          inputHash: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
        };
        this.save(binding);
      }
      const cancellation = new AbortController();
      activeOperations.set(controlKey, cancellation);
      const operationSignal = AbortSignal.any([cancellation.signal, ...(signal ? [signal] : [])]);
      const request = { ...input };
      if (name === "run_command")
        request.timeout_seconds = Math.min(
          300,
          Number(input.timeout_seconds || (input.timeout ? input.timeout / 1000 : 60)),
        );
      const result = await this.getBackend(binding).request(
        binding,
        name,
        request,
        operation,
        operationSignal,
      );
      if (typeof result?.process_id === "string") {
        binding.processIds ??= [];
        if (result.status === "completed")
          binding.processIds = binding.processIds.filter((id) => id !== result.process_id);
        else if (!binding.processIds.includes(result.process_id))
          binding.processIds.push(result.process_id);
        this.save(binding);
      }
      if (result?.imageBase64 && result.mediaType === "image/png") {
        view.publishFrame(
          this.taskId,
          name.startsWith("browser_") ? "browser" : "own_desktop",
          result.imageBase64,
          "Task computer",
        );
      } else view.noteWorking(this.taskId, name.startsWith("browser_") ? "browser" : "own_desktop");
      if (mutating) {
        delete binding.pending;
        this.save(binding);
      }
      return { ...result, environmentId: binding.id, environmentGeneration: binding.generation };
    } catch (error) {
      if (mutating && binding.pending?.id === operation) {
        binding.state = "unknown";
        binding.error =
          "The computer's response was interrupted. Reconcile the original operation before continuing.";
        this.save(binding);
      }
      throw error;
    } finally {
      unlock();
      activeTasks.delete(binding.id);
      activeOperations.delete(controlKey);
      if (resourceLocks.get(controlKey) === tail) resourceLocks.delete(controlKey);
    }
  }

  private async action(input: Any, signal?: AbortSignal) {
    const action = input.action || "status";
    if (action === "status") return { selected: this.isSelected(), binding: this.read() };
    if (action === "reconcile") {
      const binding = this.read();
      if (!binding) return { selected: this.isSelected() };
      if (binding.pending) {
        const receipt = await this.getBackend(binding).request(
          binding,
          "receipt",
          { id: binding.pending.id },
          randomUUID(),
          signal,
        );
        if (receipt.found) {
          // A lost background-start response still owns a process that completion must stop.
          if (typeof receipt.result?.process_id === "string") {
            binding.processIds ??= [];
            if (receipt.result.status === "completed")
              binding.processIds = binding.processIds.filter(
                (id) => id !== receipt.result.process_id,
              );
            else if (!binding.processIds.includes(receipt.result.process_id))
              binding.processIds.push(receipt.result.process_id);
          }
          delete binding.pending;
          delete binding.error;
          binding.state = "ready";
          this.save(binding);
          return { binding, recoveredResult: receipt.result, verification: "unverified" };
        }
        return {
          binding,
          outcome_unknown: true,
          message: "No completion receipt. The command has not been replayed.",
        };
      }
      if (binding.state === "unknown" || binding.state === "allocating") {
        this.assertPolicy(binding.selection);
        // Backends recover by deterministic identity, never by replaying user commands.
        const result = await this.getBackend(binding).allocate(binding);
        Object.assign(binding, result);
        for (const input of binding.selection.inputPaths) {
          if (!binding.imported?.some((entry) => entry.path === input))
            await this.importFile(binding, input);
        }
        binding.state = "ready";
        delete binding.error;
        this.save(binding);
      }
      if (binding.state === "cleanup_pending") await this.finish();
      return { binding: this.read() };
    }
    if (action === "export" || action === "import") {
      const selection = this.selection();
      if (selection) this.assertPolicy(selection);
      ComputerViewService.getInstance().assertNotHeld(this.taskId);
    }
    if (action === "export") {
      const binding = await this.ensure();
      return this.exportFile(binding, input.path, input.destination);
    }
    if (action === "import") {
      const binding = await this.ensure();
      return this.importFile(binding, input.path);
    }
    if (action === "screenshot") {
      const binding = await this.ensure();
      ComputerViewService.getInstance().assertNotHeld(this.taskId);
      const backend = this.getBackend(binding);
      if (!backend.screenshot)
        throw new Error("Desktop capture is unavailable for this backend; use browser_screenshot.");
      const image = await backend.screenshot(binding);
      ComputerViewService.getInstance().publishFrame(
        this.taskId,
        "own_desktop",
        image,
        "Task computer",
      );
      return {
        success: true,
        imageBase64: image.toString("base64"),
        mediaType: "image/png",
        environmentId: binding.id,
      };
    }
    if (action === "finish") return this.finish();
    throw new Error("Unknown computer_environment action.");
  }

  private async importFile(binding: ExecutionEnvironmentBinding, relative: string) {
    const [{ data }] = snapshotSpaceInputs(this.workspace, [relative]);
    const result = await this.getBackend(binding).request(
      binding,
      "import_file",
      { path: relative, data: data.toString("base64") },
      randomUUID(),
    );
    if (!result.success || result.sha256 !== createHash("sha256").update(data).digest("hex"))
      throw new Error("Computer input transfer did not verify.");
    binding.imported ??= [];
    binding.imported.push({ path: relative, sha256: result.sha256 });
    this.save(binding);
    return { success: true, path: relative, bytes: data.length };
  }

  private async exportFile(
    binding: ExecutionEnvironmentBinding,
    relative: string,
    destination?: string,
  ) {
    if (!isSpaceRelativePath(relative))
      throw new Error("Select a regular guest-relative output file.");
    const target = destination || path.posix.join("artifacts", "computers", binding.id, relative);
    if (!isSpaceRelativePath(target))
      throw new Error("Output destination must be workspace-relative.");
    const root = fs.realpathSync(this.workspace.path);
    let parent = root;
    for (const part of target.split("/").slice(0, -1)) {
      parent = path.join(parent, part);
      assertWorkspaceFilesystemAccess(this.workspace, parent, "write", "computer output folder");
      try {
        fs.mkdirSync(parent, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const stat = fs.lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Output ancestors must not be symlinks.");
    }
    const bindings = validateSpaceOutputs(this.workspace, [target]);
    const result = await this.getBackend(binding).request(
      binding,
      "export_file",
      { path: relative },
      randomUUID(),
    );
    if (typeof result.data !== "string" || result.data.length > 3 * 1024 * 1024)
      throw new Error("Invalid output transfer.");
    const [{ data }] = decodeSpaceOutputs(JSON.stringify([{ ...result, path: target }]), [target]);
    const hash = createHash("sha256").update(data).digest("hex");
    if (data.length > 2 * 1024 * 1024 || data.length !== result.bytes || hash !== result.sha256)
      throw new Error("Computer output did not verify.");
    const output = path.join(root, target);
    binding.publishing = { path: target, sha256: hash, bytes: data.length };
    this.save(binding);
    publishSpaceOutputs(
      this.workspace,
      [{ path: target, data }],
      () => {
        binding.exported.push({ path: target, sha256: hash, bytes: data.length });
        delete binding.publishing;
        this.save(binding);
      },
      bindings,
    );
    this.daemon.logEvent(this.taskId, "artifact_created", {
      path: output,
      source: "execution_environment",
      environmentId: binding.id,
      sha256: hash,
    });
    return { success: true, path: target, bytes: data.length, sha256: hash };
  }

  async viewer(viewOnly: boolean): Promise<string> {
    const binding = await this.ensure();
    const backend = this.getBackend(binding);
    if (!backend.viewer) throw new Error("Open this Space in Cua Spaces to watch it.");
    return backend.viewer(binding, viewOnly);
  }

  async capture(): Promise<Buffer | null> {
    const binding = this.read();
    if (
      !binding ||
      binding.state !== "ready" ||
      ComputerViewService.getInstance().isHeldByPerson(this.taskId)
    )
      return null;
    return (await this.getBackend(binding).screenshot?.(binding)) ?? null;
  }

  async stopProcesses(): Promise<number> {
    let binding = this.read();
    if (!binding) return 0;
    await ExecutionEnvironmentController.quiesce(environmentControlKey(binding));
    binding = this.read();
    if (!binding) return 0;
    let stopped = 0;
    for (const processId of binding.processIds || []) {
      const result = await this.getBackend(binding).request(
        binding,
        "stop_process",
        { process_id: processId },
        randomUUID(),
      );
      if (result.status !== "completed")
        throw new Error("A background process has not confirmed termination; computer retained.");
      binding.processIds = binding.processIds?.filter((id) => id !== processId);
      this.save(binding);
      stopped += 1;
    }
    return stopped;
  }

  async finish() {
    const binding = this.read();
    if (!binding || binding.state === "released") return { released: true };
    if (binding.pending || activeTasks.has(binding.id))
      throw new Error("Computer has unresolved work; it was retained for recovery.");
    if (ComputerViewService.getInstance().isHeldByPerson(this.taskId))
      throw new Error("The computer is held by the person; it was retained.");
    if (this.workspace.permissions.accessProfileUnavailable)
      throw new Error("The current access profile is unavailable; computer retained.");
    if (binding.owned && this.daemon.getChildTasks) {
      const queue = [this.taskId];
      const visited = new Set<string>();
      while (queue.length) {
        const parent = queue.shift()!;
        if (visited.has(parent)) continue;
        visited.add(parent);
        if (visited.size > 64)
          throw new Error("Inspect delegated work before releasing this computer.");
        for (const child of await this.daemon.getChildTasks(parent)) {
          queue.push(child.id);
          if (
            child.agentConfig?.executionEnvironmentParentTaskId === this.taskId &&
            (!["completed", "failed", "cancelled"].includes(child.status) ||
              child.agentConfig.executionEnvironmentBinding?.pending ||
              child.agentConfig.executionEnvironmentBinding?.state === "unknown")
          ) {
            throw new Error("Delegated work still uses this computer; it was retained.");
          }
        }
      }
    }
    try {
      for (const processId of binding.processIds || []) {
        const result = await this.getBackend(binding).request(
          binding,
          "stop_process",
          { process_id: processId },
          randomUUID(),
        );
        if (result.status !== "completed")
          throw new Error("A background process has not confirmed termination; computer retained.");
        binding.processIds = binding.processIds?.filter((id) => id !== processId);
        this.save(binding);
      }
      // Delegated tasks share their ancestor's files and result manifest. The ancestor
      // publishes those results after all delegated work has finished.
      if (this.daemon.getTask(this.taskId)?.agentConfig?.executionEnvironmentParentTaskId)
        return { retained: true };
      if (binding.publishing) {
        const [{ data }] = snapshotSpaceInputs(this.workspace, [binding.publishing.path]);
        if (createHash("sha256").update(data).digest("hex") !== binding.publishing.sha256)
          throw new Error(
            "Interrupted output publication needs inspection; the file was retained.",
          );
        binding.exported.push(binding.publishing);
        delete binding.publishing;
        this.save(binding);
      }
      for (const output of binding.selection.outputPaths) {
        const target = path.posix.join("artifacts", "computers", binding.id, output);
        if (!binding.exported.some((entry) => entry.path === target))
          await this.exportFile(binding, output);
      }
      if (binding.selection.lifetime === "persistent" || !binding.owned) {
        binding.state = "ready";
        delete binding.error;
        this.save(binding);
        return { retained: true, exported: binding.exported };
      }
      binding.state = "cleanup_pending";
      this.save(binding);
      await this.getBackend(binding).release(binding);
      binding.state = "released";
      delete binding.error;
      this.save(binding);
      ComputerViewService.getInstance().unbindEnvironment(this.taskId);
      return { released: true, exported: binding.exported };
    } catch (error) {
      binding.state = "cleanup_pending";
      binding.error = error instanceof Error ? error.message : "Computer cleanup is pending.";
      this.save(binding);
      throw error;
    }
  }

  async close() {
    await this.backend?.close?.();
  }
}
