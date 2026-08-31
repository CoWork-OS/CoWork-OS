import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { v4 as uuidv4 } from "uuid";
import { AgentDaemon } from "../agent/daemon";
import { ArtifactRepository, TaskRepository, WorkspaceRepository } from "../database/repositories";
import type {
  DocumentEditorSession,
  DocumentEditRequest,
  DocumentVersionEntry,
  DocxBlockSelection,
  PdfRegionSelection,
  Task,
  TaskOutputSummary,
  Workspace,
} from "../../shared/types";
import { parseDocxBlocksFromBuffer } from "./docx-blocks";
import { editPdfRegion } from "./pdf-region-editor";
import { extractPdfReviewData } from "../utils/pdf-review";
import {
  applyAccessProfileToWorkspace,
  applyDefaultAccessProfile,
  resolveEffectiveAccessProfile,
} from "../security/access-profile-resolver";
import {
  assertWorkspaceFilesystemAccess,
  evaluateWorkspaceFilesystemAccess,
} from "../security/access-profile-paths";
import { PermissionSettingsManager } from "../security/permission-settings-manager";
import { loadPolicies } from "../admin/policies";

type SessionRecord = {
  id: string;
  workspaceId: string;
  workspacePath?: string;
  basePath: string;
  currentPath: string;
  fileType: "pdf" | "docx";
  sourceTaskId?: string;
};

type PdfRegionEditInput = {
  sourcePath: string;
  destPath: string;
  pageIndex: number;
  bbox: { x: number; y: number; w: number; h: number };
  instruction: string;
};

type PdfRegionEditor = {
  edit: (input: PdfRegionEditInput & { selectionText?: string }) => Promise<void>;
};

const defaultPdfRegionEditor: PdfRegionEditor = {
  edit: editPdfRegion,
};

function getFileType(filePath: string): "pdf" | "docx" | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".docx") return "docx";
  return null;
}

function normalizeVersionBase(filePath: string): { dir: string; ext: string; stem: string } {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const name = path.basename(filePath, ext);
  return {
    dir,
    ext,
    stem: name.replace(/-v\d+$/i, ""),
  };
}

function versionSortKey(filePath: string): number {
  const match = path.basename(filePath).match(/-v(\d+)(?=\.[^.]+$)/i);
  return match ? Number(match[1]) : 1;
}

export class DocumentEditorSessionService {
  // NOTE: sessions are intentionally in-memory only. If the Electron process restarts
  // mid-edit, the renderer's sessionId will be orphaned and the user will need to
  // re-open the document. Persisting sessions to disk is left for a future iteration.
  private sessions = new Map<string, SessionRecord>();

  constructor(
    private workspaceRepo: WorkspaceRepository,
    private taskRepo: TaskRepository,
    private artifactRepo: ArtifactRepository,
    private agentDaemon: AgentDaemon,
    private pdfRegionEditor: PdfRegionEditor = defaultPdfRegionEditor,
  ) {}

  private resolvePath(filePath: string, workspacePath?: string): string {
    const rawPath = String(filePath || "").trim();
    if (!rawPath) {
      throw new Error("File path is required.");
    }
    const candidate = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : workspacePath
        ? path.resolve(workspacePath, rawPath)
        : path.resolve(rawPath);
    if (!fsSync.existsSync(candidate)) {
      throw new Error(`File not found: ${filePath}`);
    }
    return fsSync.realpathSync(candidate);
  }

  private assertDocumentPathAccess(
    workspace: Workspace,
    filePath: string,
    operation: "read" | "write",
  ): string {
    return assertWorkspaceFilesystemAccess(workspace, filePath, operation, "document path");
  }

  private findWorkspaceById(workspaceId: string): Workspace | undefined {
    const repository = this.workspaceRepo as Any;
    if (typeof repository.findById === "function") {
      return repository.findById(workspaceId) || undefined;
    }
    return typeof repository.findAll === "function"
      ? repository.findAll().find((workspace: Workspace) => workspace.id === workspaceId)
      : undefined;
  }

  listVersions(filePath: string, workspacePath?: string): DocumentVersionEntry[] {
    const resolvedPath = this.resolvePath(filePath, workspacePath);
    const workspace = this.resolveWorkspaceForPath(resolvedPath, workspacePath);
    const visiblePath = (candidate: string): boolean => {
      try {
        this.assertDocumentPathAccess(workspace, candidate, "read");
        return true;
      } catch {
        return false;
      }
    };
    const { dir, ext, stem } = normalizeVersionBase(resolvedPath);
    this.assertDocumentPathAccess(workspace, dir, "read");
    const entries = fsSync
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(dir, entry.name))
      .filter((candidate) => {
        const candidateExt = path.extname(candidate).toLowerCase();
        if (candidateExt !== ext.toLowerCase()) return false;
        const candidateStem = path.basename(candidate, candidateExt).replace(/-v\d+$/i, "");
        return candidateStem === stem && visiblePath(candidate);
      })
      .sort((a, b) => versionSortKey(a) - versionSortKey(b));

    return entries.map((candidate) => {
      const artifact = this.artifactRepo.findLatestByPath(candidate);
      const stat = fsSync.statSync(candidate);
      return {
        path: candidate,
        fileName: path.basename(candidate),
        createdAt: artifact?.createdAt ?? stat.mtimeMs,
        taskId: artifact?.taskId,
        artifactId: artifact?.id,
        isCurrent: candidate === entries[entries.length - 1],
      };
    });
  }

  private buildNextVersionPath(currentPath: string): string {
    const versions = this.listVersions(currentPath);
    const latestPath = versions.length > 0 ? versions[versions.length - 1].path : currentPath;
    const { dir, ext, stem } = normalizeVersionBase(latestPath);
    const nextVersion = versions.length + 1;
    return path.join(dir, `${stem}-v${nextVersion}${ext}`);
  }

  private resolveWorkspaceForPath(filePath: string, preferredWorkspacePath?: string): Workspace {
    const normalizedPreferred = preferredWorkspacePath
      ? path.resolve(preferredWorkspacePath)
      : undefined;
    const workspaces = this.workspaceRepo.findAll();
    const ordered = normalizedPreferred
      ? [...workspaces].sort((a, b) => {
          const aMatch = path.resolve(a.path) === normalizedPreferred ? 0 : 1;
          const bMatch = path.resolve(b.path) === normalizedPreferred ? 0 : 1;
          return aMatch - bMatch;
        })
      : workspaces;
    const workspace = ordered.find((item) => {
      try {
        // Workspace/profile roots, filesystem deny rules, symlink resolution,
        // and legacy allowed paths all live in the shared evaluator. Keeping
        // editor workspace discovery on that path prevents a file that is
        // visible to the editor from bypassing a named profile boundary later.
        return evaluateWorkspaceFilesystemAccess(item, filePath, "read").decision === "allow";
      } catch {
        return false;
      }
    });
    if (!workspace) {
      throw new Error("Could not resolve workspace for editable document.");
    }
    return workspace;
  }

  private getEffectiveWorkspace(workspace: Workspace, task?: Task): Workspace {
    // A document opened from a task inherits that task's exact profile. A
    // standalone editor task gets the current configured default profile when
    // it is created below; opening the file itself still uses the workspace's
    // persisted boundary so legacy allowed-path documents remain discoverable.
    if (!task) return workspace;
    const profile = resolveEffectiveAccessProfile({
      task,
      workspace,
      settings: PermissionSettingsManager.loadSettings(),
      adminPolicies: loadPolicies(),
    });
    return applyAccessProfileToWorkspace(workspace, profile);
  }

  private async ensureDirectPdfAccess(
    task: Task,
    workspace: Workspace,
    sourcePath: string,
    destPath: string,
  ): Promise<void> {
    const effectiveWorkspace = this.getEffectiveWorkspace(workspace, task);
    for (const [candidate, operation] of [
      [sourcePath, "read"],
      [destPath, "write"],
    ] as const) {
      const decision = evaluateWorkspaceFilesystemAccess(effectiveWorkspace, candidate, operation);
      if (decision.decision === "allow") continue;
      if (decision.reason !== "outside_workspace") {
        throw new Error(`Access denied for document ${operation}: ${candidate}`);
      }

      const approved = await this.agentDaemon.requestApproval(
        task.id,
        "external_file_access",
        `Allow ${operation} access to external document: ${candidate}`,
        {
          path: candidate,
          operation,
          tool: "document_editor",
        },
      );
      if (!approved) {
        throw new Error(`External document ${operation} was not approved.`);
      }
      const granted = evaluateWorkspaceFilesystemAccess(effectiveWorkspace, candidate, operation, {
        externalApprovalGranted: true,
      });
      if (granted.decision !== "allow") {
        throw new Error(`Access denied for document ${operation}: ${granted.reason}`);
      }
      const consume = (this.agentDaemon as Any).consumeExternalFileApproval;
      if (typeof consume === "function")
        consume.call(this.agentDaemon, task.id, candidate, operation);
    }
  }

  private createDirectDocumentTask(params: {
    session: SessionRecord;
    workspace: Workspace;
    title: string;
    prompt: string;
    instruction: string;
  }): Task {
    const sourceTask = params.session.sourceTaskId
      ? this.taskRepo.findById(params.session.sourceTaskId)
      : undefined;
    const agentConfig = applyDefaultAccessProfile(
      sourceTask?.agentConfig,
      PermissionSettingsManager.loadSettings(),
    );
    const hasParent = Boolean(
      params.session.sourceTaskId && this.taskRepo.findById(params.session.sourceTaskId),
    );
    const task = this.taskRepo.create({
      title: params.title,
      prompt: params.prompt,
      rawPrompt: params.prompt,
      userPrompt: params.instruction,
      status: "executing",
      workspaceId: params.workspace.id,
      parentTaskId: hasParent ? params.session.sourceTaskId : undefined,
      agentType: hasParent ? "sub" : "main",
      depth: hasParent ? 1 : 0,
      agentConfig,
      source: "manual",
    });
    this.agentDaemon.logEvent(task.id, "task_created", { task });
    this.agentDaemon.logEvent(task.id, "task_status", {
      status: "executing",
      message: "Starting inline document edit.",
    });
    return task;
  }

  private failDirectTask(
    taskId: string,
    message: string,
    failureClass: Task["failureClass"] = "tool_error",
  ): void {
    this.agentDaemon.failTask(taskId, message, {
      terminalStatus: "failed",
      failureClass,
    });
  }

  private async runDirectPdfEditTask(params: {
    task: Task;
    sourcePath: string;
    destPath: string;
    selection: PdfRegionSelection;
    instruction: string;
  }): Promise<void> {
    const { task, sourcePath, destPath, selection, instruction } = params;
    const stepId = "document_edit:pdf";
    try {
      const workspace = this.findWorkspaceById(task.workspaceId);
      if (!workspace) throw new Error("Document workspace not found.");
      await this.ensureDirectPdfAccess(task, workspace, sourcePath, destPath);
      this.agentDaemon.logEvent(task.id, "timeline_step_updated", {
        stepId,
        status: "in_progress",
        actor: "system",
        legacyType: "progress_update",
        message: "Applying PDF edit locally.",
      });
      await this.pdfRegionEditor.edit({
        sourcePath,
        destPath,
        pageIndex: selection.pageIndex,
        bbox: {
          x: selection.x,
          y: selection.y,
          w: selection.w,
          h: selection.h,
        },
        instruction,
        selectionText: selection.excerpt,
      });
      this.agentDaemon.logEvent(task.id, "file_created", {
        path: path.basename(destPath),
        type: "document",
        format: "pdf",
        action: "edit_pdf_region",
        pageIndex: selection.pageIndex,
        bbox: {
          x: selection.x,
          y: selection.y,
          w: selection.w,
          h: selection.h,
        },
      });
      this.agentDaemon.registerArtifact(task.id, destPath, "application/pdf");
      this.agentDaemon.logEvent(task.id, "artifact_created", {
        path: destPath,
        mimeType: "application/pdf",
        fileName: path.basename(destPath),
        message: `Created ${path.basename(destPath)}`,
      });
      this.agentDaemon.logEvent(task.id, "timeline_step_updated", {
        stepId,
        status: "completed",
        actor: "system",
        legacyType: "step_completed",
        message: `Created ${path.basename(destPath)}`,
      });
      const outputSummary: TaskOutputSummary = {
        created: [destPath],
        primaryOutputPath: destPath,
        outputCount: 1,
        folders: [path.dirname(destPath)],
      };
      this.agentDaemon.completeTask(task.id, `Created ${path.basename(destPath)}`, {
        outputSummary,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Inline PDF edit failed.";
      this.agentDaemon.logEvent(task.id, "timeline_step_updated", {
        stepId,
        status: "failed",
        actor: "system",
        legacyType: "step_failed",
        message,
      });
      this.failDirectTask(
        task.id,
        message,
        /not installed/i.test(message) ? "dependency_unavailable" : "tool_error",
      );
    }
  }

  async openSession(filePath: string, workspacePath?: string): Promise<DocumentEditorSession> {
    const resolvedPath = this.resolvePath(filePath, workspacePath);
    const fileType = getFileType(resolvedPath);
    if (!fileType) {
      throw new Error("Only PDF and DOCX files are editable.");
    }

    const workspace = this.resolveWorkspaceForPath(resolvedPath, workspacePath);
    const allVersions = this.listVersions(resolvedPath, workspace.path);
    const sourceArtifact =
      this.artifactRepo.findLatestByPath(allVersions[allVersions.length - 1]?.path || "") ||
      this.artifactRepo.findLatestByPath(resolvedPath);
    const sourceTask = sourceArtifact?.taskId
      ? this.taskRepo.findById(sourceArtifact.taskId)
      : undefined;
    const effectiveWorkspace = this.getEffectiveWorkspace(workspace, sourceTask);
    this.assertDocumentPathAccess(effectiveWorkspace, resolvedPath, "read");

    const versions = allVersions
      .filter((version) => {
        try {
          this.assertDocumentPathAccess(effectiveWorkspace, version.path, "read");
          return true;
        } catch {
          return false;
        }
      })
      .map((version, index, visibleVersions) => ({
        ...version,
        isCurrent: index === visibleVersions.length - 1,
      }));
    const currentVersion = versions[versions.length - 1];
    const currentPath = currentVersion?.path || resolvedPath;
    this.assertDocumentPathAccess(effectiveWorkspace, currentPath, "read");
    const sessionId = uuidv4();

    const session: DocumentEditorSession = {
      sessionId,
      filePath: resolvedPath,
      workspacePath,
      currentPath,
      currentFileName: path.basename(currentPath),
      fileType,
      sourceTaskId: sourceArtifact?.taskId,
      versions,
    };

    if (fileType === "pdf") {
      const pdfBytes = await fs.readFile(currentPath);
      session.pdfDataBase64 = pdfBytes.toString("base64");
      session.pdfReviewSummary = await extractPdfReviewData(currentPath, {
        maxPages: 12,
        maxCharsPerPage: 1600,
        maxOcrPages: 4,
        includeOcr: true,
      });
    } else {
      const docxBytes = await fs.readFile(currentPath);
      const blocks = await parseDocxBlocksFromBuffer(docxBytes);
      session.docxBlocks = blocks.map((block) => ({
        id: block.id,
        type: block.type,
        text: block.text,
        level: block.level,
        rows: block.rows,
        order: block.order,
      }));
    }

    this.sessions.set(sessionId, {
      id: sessionId,
      workspaceId: workspace.id,
      workspacePath,
      basePath: resolvedPath,
      currentPath,
      fileType,
      sourceTaskId: sourceArtifact?.taskId,
    });

    return session;
  }

  private selectionPrompt(selection: PdfRegionSelection | DocxBlockSelection): string {
    if (selection.kind === "pdf") {
      return JSON.stringify({
        pageIndex: selection.pageIndex,
        bbox: {
          x: Number(selection.x.toFixed(4)),
          y: Number(selection.y.toFixed(4)),
          w: Number(selection.w.toFixed(4)),
          h: Number(selection.h.toFixed(4)),
        },
        excerpt: selection.excerpt || "",
      });
    }
    return JSON.stringify({
      blockIds: selection.blockIds,
      excerpt: selection.excerpt || "",
    });
  }

  async startEditTask(request: DocumentEditRequest): Promise<Task> {
    const session = this.sessions.get(request.sessionId);
    if (!session) {
      throw new Error("Document editor session not found.");
    }
    const instruction = String(request.instruction || "").trim();
    if (!instruction) {
      throw new Error("Instruction is required.");
    }

    const workspace =
      this.findWorkspaceById(session.workspaceId) ||
      this.resolveWorkspaceForPath(session.currentPath, session.workspacePath);
    const sourceTask = session.sourceTaskId
      ? this.taskRepo.findById(session.sourceTaskId)
      : undefined;
    const effectiveWorkspace = this.getEffectiveWorkspace(workspace, sourceTask);
    this.assertDocumentPathAccess(effectiveWorkspace, session.currentPath, "read");

    if (session.fileType === "pdf") {
      const selection = request.selection as PdfRegionSelection;
      const destPathAbs = this.buildNextVersionPath(session.currentPath);
      const prompt =
        `Apply this inline PDF edit directly without planner orchestration.\n` +
        `Source: ${session.currentPath}\nDestination: ${destPathAbs}\n` +
        `Instruction: ${instruction}\nSelection: ${this.selectionPrompt(selection)}`;
      const task = this.createDirectDocumentTask({
        session,
        workspace,
        title: `Edit ${path.basename(session.currentPath)}`,
        prompt,
        instruction,
      });
      setTimeout(() => {
        void this.runDirectPdfEditTask({
          task,
          sourcePath: session.currentPath,
          destPath: destPathAbs,
          selection,
          instruction,
        });
      }, 50);
      return task;
    }

    const destPathAbs = this.buildNextVersionPath(session.currentPath);
    const sourceRel = path.relative(workspace.path, session.currentPath);
    const destRel = path.relative(workspace.path, destPathAbs);

    const selection = request.selection as DocxBlockSelection;
    const prompt =
      `Edit the DOCX selection and create a new sibling version.\n` +
      `Use edit_document with action="replace_blocks", sourcePath="${sourceRel}", destPath="${destRel}", ` +
      `blockIds=${JSON.stringify(selection.blockIds)} and newContent as content blocks that satisfy the instruction.\n` +
      `Instruction: ${instruction}\n` +
      `Selected block context: ${this.selectionPrompt(selection)}.\n` +
      `Preserve unselected content. Do not overwrite the source file.`;

    const title = `Edit ${path.basename(session.currentPath)}`;
    const task =
      session.sourceTaskId && this.taskRepo.findById(session.sourceTaskId)
        ? await this.agentDaemon.createChildTask({
            title,
            prompt,
            userPrompt: instruction,
            workspaceId: workspace.id,
            parentTaskId: session.sourceTaskId,
            agentType: "sub",
            depth: 1,
          })
        : await this.agentDaemon.createTask({
            title,
            prompt,
            workspaceId: workspace.id,
            source: "manual",
          });

    return task;
  }
}
