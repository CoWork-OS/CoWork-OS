import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  Company,
  CompanyGraphEdge,
  CompanyGraphEdgeKind,
  CompanyGraphNode,
  CompanyImportPreview,
  CompanyImportPreviewItem,
  CompanyPackageImportRequest,
  CompanyPackageImportResult,
  CompanyPackageManifest,
  CompanyPackageManifestKind,
  CompanyPackageSource,
  CompanyPackageSourceInput,
  CompanyRuntimeEntityKind,
  CompanySyncState,
  ResolvedCompanyGraph,
} from "../../shared/types";
import { AgentRoleRepository } from "../agents/AgentRoleRepository";
import { ControlPlaneCoreService } from "./ControlPlaneCoreService";

const MANIFEST_FILENAMES: Record<string, CompanyPackageManifestKind> = {
  "COMPANY.md": "company",
  "TEAM.md": "team",
  "AGENTS.md": "agent",
  "PROJECT.md": "project",
  "TASK.md": "task",
  "SKILL.md": "skill",
};

interface ParsedFrontmatterResult {
  frontmatter: Record<string, unknown>;
  body: string;
}

interface ExistingSourceRuntimeLink {
  syncState: CompanySyncState;
  nodeKind: CompanyGraphNode["kind"];
  nodeSlug: string;
  nodeRelativePath?: string;
}

interface ExistingSourceRuntimeIndex {
  source: CompanyPackageSource;
  links: ExistingSourceRuntimeLink[];
}

function normalizeSlashPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function normalizeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseScalar(value: string): unknown {
  const normalized = stripQuotes(value);
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  if (normalized === "null") return null;
  return normalized;
}

function parseFrontmatter(raw: string): ParsedFrontmatterResult {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {}, body: raw };
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) {
    return { frontmatter: {}, body: raw };
  }

  const block = normalized.slice(4, end);
  const body = normalized.slice(end + 5);
  const lines = block.split("\n");
  const frontmatter: Record<string, unknown> = {};

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/);
    if (!match) continue;

    const [, key, rawValue = ""] = match;
    if (rawValue.trim().length > 0) {
      frontmatter[key] = parseScalar(rawValue);
      continue;
    }

    const items: string[] = [];
    let nextIndex = index + 1;
    while (nextIndex < lines.length) {
      const itemMatch = lines[nextIndex]?.match(/^\s*-\s+(.+)$/);
      if (!itemMatch) break;
      items.push(stripQuotes(itemMatch[1] || ""));
      nextIndex += 1;
    }

    if (items.length > 0) {
      frontmatter[key] = items;
      index = nextIndex - 1;
    } else {
      frontmatter[key] = "";
    }
  }

  return { frontmatter, body };
}

function arrayValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return [value.trim()];
  }
  return [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function manifestSortWeight(kind: CompanyPackageManifestKind): number {
  switch (kind) {
    case "company":
      return 0;
    case "team":
      return 1;
    case "agent":
      return 2;
    case "project":
      return 3;
    case "task":
      return 4;
    case "skill":
      return 5;
    default:
      return 100;
  }
}

function nodeSortWeight(kind: CompanyPackageManifestKind): number {
  switch (kind) {
    case "company":
      return 0;
    case "team":
      return 1;
    case "agent":
      return 2;
    case "project":
      return 3;
    case "task":
      return 4;
    case "skill":
      return 5;
    default:
      return 100;
  }
}

function inferSourceName(input: CompanyPackageSourceInput): string {
  const localPath = input.localPath?.trim();
  if (localPath) {
    return path.basename(localPath);
  }
  const rootUri = input.rootUri.trim();
  return rootUri.split("/").filter(Boolean).pop() || "company-package";
}

export class AgentCompaniesService {
  constructor(
    private readonly db: Database.Database,
    private readonly core: ControlPlaneCoreService,
    private readonly agentRoleRepo: AgentRoleRepository,
  ) {}

  listSources(companyId?: string): CompanyPackageSource[] {
    const rows = companyId
      ? (this.db
          .prepare(
            `
              SELECT * FROM company_package_sources
              WHERE company_id = ?
              ORDER BY updated_at DESC, created_at DESC
            `,
          )
          .all(companyId) as Any[])
      : (this.db
          .prepare("SELECT * FROM company_package_sources ORDER BY updated_at DESC, created_at DESC")
          .all() as Any[]);
    return rows.map((row) => this.mapSource(row));
  }

  listManifests(sourceId: string): CompanyPackageManifest[] {
    const rows = this.db
      .prepare(
        `
          SELECT * FROM company_package_manifests
          WHERE source_id = ?
          ORDER BY kind ASC, relative_path ASC
        `,
      )
      .all(sourceId) as Any[];
    return rows.map((row) => this.mapManifest(row));
  }

  listGraphNodes(companyId: string): CompanyGraphNode[] {
    const rows = this.db
      .prepare(
        `
          SELECT * FROM company_org_nodes
          WHERE company_id = ?
          ORDER BY kind ASC, name COLLATE NOCASE ASC, created_at ASC
        `,
      )
      .all(companyId) as Any[];
    return rows.map((row) => this.mapNode(row));
  }

  listGraphEdges(companyId: string): CompanyGraphEdge[] {
    const rows = this.db
      .prepare(
        `
          SELECT * FROM company_org_edges
          WHERE company_id = ?
          ORDER BY created_at ASC
        `,
      )
      .all(companyId) as Any[];
    return rows.map((row) => this.mapEdge(row));
  }

  listSyncStates(companyId: string): CompanySyncState[] {
    const rows = this.db
      .prepare(
        `
          SELECT * FROM company_sync_states
          WHERE company_id = ?
          ORDER BY created_at ASC
        `,
      )
      .all(companyId) as Any[];
    return rows.map((row) => this.mapSyncState(row));
  }

  getResolvedGraph(companyId: string): ResolvedCompanyGraph {
    const nodes = this.listGraphNodes(companyId);
    const sourceIds = Array.from(new Set(nodes.map((node) => node.sourceId).filter(Boolean))) as string[];
    const manifests = sourceIds.flatMap((sourceId) => this.listManifests(sourceId));
    const companyManifest =
      manifests.find((manifest) => manifest.kind === "company") || null;
    return {
      packageName: companyManifest?.name || this.core.getCompany(companyId)?.name || "Company Package",
      companyManifest,
      manifests,
      nodes,
      edges: this.listGraphEdges(companyId),
      warnings: [],
    };
  }

  previewImport(request: CompanyPackageImportRequest): CompanyImportPreview {
    const source = this.normalizeSourceInput(request.source);
    const graph = this.resolveLocalGraph(source);
    const sourceMatch = this.findSourceByRootUri(source.rootUri);
    const targetCompany = request.companyId
      ? this.core.getCompany(request.companyId)
      : sourceMatch?.companyId
        ? this.core.getCompany(sourceMatch.companyId)
        : undefined;
    const existingSource =
      targetCompany?.id
        ? this.findSourceByCompanyAndRootUri(targetCompany.id, source.rootUri)
        : sourceMatch;
    const existingRuntimeIndex = existingSource
      ? this.buildExistingRuntimeIndex(existingSource)
      : undefined;
    const companySlug =
      graph.companyManifest?.slug || graph.nodes.find((node) => node.kind === "company")?.slug;

    const items: CompanyImportPreviewItem[] = [];
    const roles = targetCompany ? this.agentRoleRepo.findByCompanyId(targetCompany.id, true) : [];

    items.push({
      id: "preview-company",
      manifestKind: "company",
      action: targetCompany ? "update" : "create",
      label: graph.packageName,
      details: targetCompany
        ? `Will sync package metadata into ${targetCompany.name}`
        : "Will create a Cowork company shell from the package",
      runtimeEntityKind: "company",
      runtimeEntityId: targetCompany?.id,
      manifestId: graph.companyManifest?.id,
    });

    for (const node of [...graph.nodes].sort((left, right) => nodeSortWeight(left.kind) - nodeSortWeight(right.kind) || left.name.localeCompare(right.name))) {
      if (node.kind === "company") continue;

      if (node.kind === "agent") {
        const existingLink = this.findExistingRuntimeLink(existingRuntimeIndex, node, "agent_role");
        const existing =
          (existingLink?.runtimeEntityId
            ? this.agentRoleRepo.findById(existingLink.runtimeEntityId)
            : undefined) ||
          roles.find((role) => role.name === this.agentRoleName(companySlug || "company", node.slug));
        items.push({
          id: `preview:${node.id}`,
          manifestKind: "agent",
          action: existing ? "update" : "create",
          label: node.name,
          details: existing
            ? `Will refresh the role template for ${existing.displayName || existing.name}`
            : "Will create a dormant Cowork operator template",
          orgNodeId: node.id,
          runtimeEntityKind: "agent_role",
          runtimeEntityId: existing?.id,
          manifestId: node.manifestId,
        });
        continue;
      }

      if (node.kind === "project") {
        const existingLink = this.findExistingRuntimeLink(existingRuntimeIndex, node, "project");
        const existing = existingLink?.runtimeEntityId
          ? this.core.getProject(existingLink.runtimeEntityId)
          : undefined;
        items.push({
          id: `preview:${node.id}`,
          manifestKind: "project",
          action: existing ? "update" : "create",
          label: node.name,
          details: existing
            ? `Will refresh project metadata for ${existing.name}`
            : "Will seed a Cowork project",
          orgNodeId: node.id,
          runtimeEntityKind: "project",
          runtimeEntityId: existing?.id,
          manifestId: node.manifestId,
        });
        continue;
      }

      if (node.kind === "task") {
        const existingLink = this.findExistingRuntimeLink(existingRuntimeIndex, node, "issue");
        const existing = existingLink?.runtimeEntityId
          ? this.core.getIssue(existingLink.runtimeEntityId)
          : undefined;
        items.push({
          id: `preview:${node.id}`,
          manifestKind: "task",
          action: existing ? "update" : "create",
          label: node.name,
          details: existing
            ? `Will refresh planner seed issue ${existing.title}`
            : "Will seed a planner issue from the package task",
          orgNodeId: node.id,
          runtimeEntityKind: "issue",
          runtimeEntityId: existing?.id,
          manifestId: node.manifestId,
        });
        continue;
      }

      items.push({
        id: `preview:${node.id}`,
        manifestKind: node.kind,
        action: targetCompany ? "link" : "create",
        label: node.name,
        details:
          node.kind === "skill"
            ? "Will attach as package-level capability metadata"
            : "Will be stored in the org graph for the builder",
        orgNodeId: node.id,
        manifestId: node.manifestId,
      });
    }

    return {
      source,
      graph,
      targetCompany: targetCompany || undefined,
      items,
      warnings: [...graph.warnings],
    };
  }

  importPackage(request: CompanyPackageImportRequest): CompanyPackageImportResult {
    const preview = this.previewImport(request);
    const now = Date.now();

    const result = this.db.transaction(() => {
      const company = this.upsertCompanyForPreview(preview);
      const existingSource = this.findSourceByCompanyAndRootUri(company.id, preview.source.rootUri);
      const existingRuntimeIndex = existingSource
        ? this.buildExistingRuntimeIndex(existingSource)
        : undefined;
      const source = this.upsertSource(company.id, preview.source, now);
      this.clearSourceGraph(source.id);

      const manifestIdMap = new Map<string, string>();
      const nodeIdMap = new Map<string, string>();

      for (const manifest of preview.graph.manifests) {
        const nextId = randomUUID();
        manifestIdMap.set(manifest.id, nextId);
        this.db
          .prepare(
            `
              INSERT INTO company_package_manifests (
                id, source_id, kind, slug, name, description, relative_path,
                body, body_hash, frontmatter_json, provenance_json, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            nextId,
            source.id,
            manifest.kind,
            manifest.slug,
            manifest.name,
            manifest.description || null,
            manifest.relativePath,
            manifest.body,
            manifest.bodyHash,
            JSON.stringify(manifest.frontmatter || {}),
            JSON.stringify(manifest.provenance || {}),
            now,
            now,
          );
      }

      for (const node of preview.graph.nodes) {
        const nextId = randomUUID();
        nodeIdMap.set(node.id, nextId);
        this.db
          .prepare(
            `
              INSERT INTO company_org_nodes (
                id, company_id, source_id, manifest_id, kind, slug, name, description,
                relative_path, parent_node_id, metadata_json, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
            `,
          )
          .run(
            nextId,
            company.id,
            source.id,
            node.manifestId ? manifestIdMap.get(node.manifestId) || null : null,
            node.kind,
            node.slug,
            node.name,
            node.description || null,
            node.relativePath || null,
            JSON.stringify(node.metadata || {}),
            now,
            now,
          );
      }

      for (const node of preview.graph.nodes) {
        const persistedNodeId = nodeIdMap.get(node.id);
        const persistedParentId = node.parentNodeId ? nodeIdMap.get(node.parentNodeId) : null;
        if (!persistedNodeId) continue;
        this.db
          .prepare("UPDATE company_org_nodes SET parent_node_id = ?, updated_at = ? WHERE id = ?")
          .run(persistedParentId || null, now, persistedNodeId);
      }

      for (const edge of preview.graph.edges) {
        this.db
          .prepare(
            `
              INSERT INTO company_org_edges (
                id, company_id, source_id, from_node_id, to_node_id, kind, metadata_json, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            randomUUID(),
            company.id,
            source.id,
            nodeIdMap.get(edge.fromNodeId),
            nodeIdMap.get(edge.toNodeId),
            edge.kind,
            JSON.stringify(edge.metadata || {}),
            now,
            now,
          );
      }

      let createdCount = 0;
      let updatedCount = 0;
      let linkedCount = 0;

      const projectIdsByNode = new Map<string, string>();

      for (const node of preview.graph.nodes) {
        const persistedNodeId = nodeIdMap.get(node.id);
        const manifestId = node.manifestId ? manifestIdMap.get(node.manifestId) : undefined;
        if (!persistedNodeId) continue;

        if (node.kind === "agent") {
          const existingRoleId = this.findExistingRuntimeLink(existingRuntimeIndex, node, "agent_role")
            ?.runtimeEntityId;
          const existing =
            (existingRoleId ? this.agentRoleRepo.findById(existingRoleId) : undefined) ||
            this.agentRoleRepo
              .findByCompanyId(company.id, true)
              .find((role) => role.name === this.agentRoleName(company.slug, node.slug));
          const role =
            existing ||
            this.agentRoleRepo.create({
              name: this.agentRoleName(company.slug, node.slug),
              companyId: company.id,
              displayName: node.name,
              description: node.description,
              icon: "🤖",
              color: "#2563eb",
              capabilities: [],
              systemPrompt: this.getManifestBody(preview.graph.manifests, node.manifestId),
              heartbeatEnabled: false,
            });
          if (!existing) {
            createdCount += 1;
            this.agentRoleRepo.update({ id: role.id, isActive: false });
          } else {
            updatedCount += 1;
            this.agentRoleRepo.update({
              id: role.id,
              companyId: company.id,
              displayName: node.name,
              description: node.description,
              systemPrompt: this.getManifestBody(preview.graph.manifests, node.manifestId),
            });
          }

          this.insertSyncState({
            companyId: company.id,
            sourceId: source.id,
            manifestId,
            orgNodeId: persistedNodeId,
            runtimeEntityKind: "agent_role",
            runtimeEntityId: role.id,
            syncStatus: "in_sync",
            lastSyncedAt: now,
            metadata: {
              slug: node.slug,
            },
          });
          linkedCount += 1;
          continue;
        }

        if (node.kind === "project") {
          const existingProjectId = this.findExistingRuntimeLink(existingRuntimeIndex, node, "project")
            ?.runtimeEntityId;
          const existing = existingProjectId
            ? this.core.getProject(existingProjectId)
            : undefined;
          const project = existing
            ? this.core.updateProject(existing.id, {
                name: node.name,
                description: node.description,
                status: "active",
                archivedAt: null,
              })
            : this.core.createProject({
                companyId: company.id,
                name: node.name,
                description: node.description,
              });
          if (existing) {
            updatedCount += 1;
          } else {
            createdCount += 1;
          }
          if (project) {
            projectIdsByNode.set(node.id, project.id);
            this.insertSyncState({
              companyId: company.id,
              sourceId: source.id,
              manifestId,
              orgNodeId: persistedNodeId,
              runtimeEntityKind: "project",
              runtimeEntityId: project.id,
              syncStatus: "in_sync",
              lastSyncedAt: now,
              metadata: {
                slug: node.slug,
              },
            });
            linkedCount += 1;
          }
          continue;
        }
      }

      const taskProjectLinks = new Map<string, string>();
      for (const edge of preview.graph.edges) {
        if (edge.kind !== "related_to_project") continue;
        const taskNode = preview.graph.nodes.find((node) => node.id === edge.fromNodeId);
        const projectNode = preview.graph.nodes.find((node) => node.id === edge.toNodeId);
        if (!taskNode || !projectNode) continue;
        const projectId = projectIdsByNode.get(projectNode.id);
        if (projectId) {
          taskProjectLinks.set(taskNode.id, projectId);
        }
      }

      for (const node of preview.graph.nodes) {
        if (node.kind !== "task") continue;
        const persistedNodeId = nodeIdMap.get(node.id);
        const manifestId = node.manifestId ? manifestIdMap.get(node.manifestId) : undefined;
        if (!persistedNodeId) continue;
        const existingIssueId = this.findExistingRuntimeLink(existingRuntimeIndex, node, "issue")
          ?.runtimeEntityId;
        const existing = existingIssueId
          ? this.core.getIssue(existingIssueId)
          : undefined;
        const metadata = {
          packageNodeSlug: node.slug,
          packageSourceId: source.id,
          packageSourceRootUri: source.rootUri,
          packageRelativePath: node.relativePath,
          packageTask: true,
        };
        const issue = existing
          ? this.core.updateIssue(existing.id, {
              title: node.name,
              description: node.description,
              projectId: taskProjectLinks.get(node.id),
              status: existing.status === "cancelled" ? "backlog" : existing.status,
              completedAt: existing.status === "cancelled" ? null : existing.completedAt,
              metadata: {
                ...(existing.metadata || {}),
                ...metadata,
              },
            })
          : this.core.createIssue({
              companyId: company.id,
              title: node.name,
              description: node.description,
              projectId: taskProjectLinks.get(node.id),
              metadata,
            });
        if (existing) {
          updatedCount += 1;
        } else {
          createdCount += 1;
        }
        if (issue) {
          this.insertSyncState({
            companyId: company.id,
            sourceId: source.id,
            manifestId,
            orgNodeId: persistedNodeId,
            runtimeEntityKind: "issue",
            runtimeEntityId: issue.id,
            syncStatus: "in_sync",
            lastSyncedAt: now,
            metadata: {
              slug: node.slug,
            },
          });
          linkedCount += 1;
        }
      }

      this.reconcileRemovedRuntimeEntities(existingRuntimeIndex, preview.graph.nodes, now);

      return {
        source,
        company,
        graph: this.getResolvedGraph(company.id),
        createdCount,
        updatedCount,
        linkedCount,
        warningCount: preview.warnings.length,
      };
    });

    return result();
  }

  linkOrgNodeToAgentRole(input: {
    companyId: string;
    orgNodeId: string;
    agentRoleId: string | null;
  }): CompanySyncState | null {
    const orgNode = this.db
      .prepare("SELECT * FROM company_org_nodes WHERE id = ? AND company_id = ?")
      .get(input.orgNodeId, input.companyId) as Any | undefined;
    if (!orgNode || orgNode.kind !== "agent") {
      throw new Error("Agent org node not found");
    }

    const now = Date.now();
    this.db
      .prepare(
        `
          DELETE FROM company_sync_states
          WHERE org_node_id = ? AND runtime_entity_kind = 'agent_role'
        `,
      )
      .run(input.orgNodeId);

    if (!input.agentRoleId) {
      return null;
    }

    const role = this.agentRoleRepo.findById(input.agentRoleId);
    if (!role) {
      throw new Error("Agent role not found");
    }

    if (role.companyId !== input.companyId) {
      this.agentRoleRepo.update({
        id: role.id,
        companyId: input.companyId,
      });
    }

    const syncState: CompanySyncState = {
      id: randomUUID(),
      companyId: input.companyId,
      orgNodeId: input.orgNodeId,
      runtimeEntityKind: "agent_role",
      runtimeEntityId: role.id,
      syncStatus: "in_sync",
      lastSyncedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `
          INSERT INTO company_sync_states (
            id, company_id, source_id, manifest_id, org_node_id, runtime_entity_kind,
            runtime_entity_id, sync_status, last_synced_at, metadata_json, created_at, updated_at
          ) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, ?, ?)
        `,
      )
      .run(
        syncState.id,
        syncState.companyId,
        syncState.orgNodeId,
        syncState.runtimeEntityKind,
        syncState.runtimeEntityId,
        syncState.syncStatus,
        syncState.lastSyncedAt,
        syncState.createdAt,
        syncState.updatedAt,
      );

    return syncState;
  }

  private normalizeSourceInput(input: CompanyPackageSourceInput): CompanyPackageSourceInput {
    const rootUri = input.rootUri.trim();
    const localPath = input.localPath?.trim();
    return {
      companyId: input.companyId || undefined,
      sourceKind: input.sourceKind,
      name: input.name?.trim() || inferSourceName(input),
      rootUri,
      localPath: localPath || undefined,
      ref: input.ref?.trim() || undefined,
      pin: input.pin?.trim() || undefined,
      trustLevel: input.trustLevel || (input.sourceKind === "local" ? "local" : "trusted"),
      status: input.status || "ready",
      notes: input.notes?.trim() || undefined,
    };
  }

  private findSourceByCompanyAndRootUri(
    companyId: string,
    rootUri: string,
  ): CompanyPackageSource | undefined {
    const row = this.db
      .prepare(
        `
          SELECT * FROM company_package_sources
          WHERE company_id = ? AND root_uri = ?
          LIMIT 1
        `,
      )
      .get(companyId, rootUri) as Any | undefined;
    return row ? this.mapSource(row) : undefined;
  }

  private findSourceByRootUri(rootUri: string): CompanyPackageSource | undefined {
    const row = this.db
      .prepare(
        `
          SELECT * FROM company_package_sources
          WHERE root_uri = ?
          ORDER BY updated_at DESC, created_at DESC
          LIMIT 1
        `,
      )
      .get(rootUri) as Any | undefined;
    return row ? this.mapSource(row) : undefined;
  }

  private resolveLocalGraph(source: CompanyPackageSourceInput): ResolvedCompanyGraph {
    if (source.sourceKind !== "local" || !source.localPath) {
      throw new Error("Only local Agent Companies packages are supported in this build");
    }
    const rootPath = source.localPath;
    if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
      throw new Error(`Package folder not found: ${rootPath}`);
    }

    const manifests = this.scanManifests(rootPath, rootPath, source);
    manifests.sort(
      (left, right) =>
        manifestSortWeight(left.kind) - manifestSortWeight(right.kind) ||
        left.relativePath.localeCompare(right.relativePath),
    );

    const warnings: string[] = [];
    const companyManifest = manifests.find((manifest) => manifest.kind === "company") || null;
    if (!companyManifest) {
      warnings.push("No COMPANY.md found at the package root. Import will infer the company from the folder name.");
    }

    const graph = this.buildGraph(manifests, source, warnings);
    return {
      packageName: companyManifest?.name || source.name || path.basename(rootPath),
      companyManifest,
      manifests,
      nodes: graph.nodes,
      edges: graph.edges,
      warnings,
    };
  }

  private scanManifests(
    absDir: string,
    rootDir: string,
    source: CompanyPackageSourceInput,
  ): CompanyPackageManifest[] {
    const results: CompanyPackageManifest[] = [];
    const entries = fs.readdirSync(absDir, { withFileTypes: true });

    for (const entry of entries) {
      const absPath = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.scanManifests(absPath, rootDir, source));
        continue;
      }
      const kind = MANIFEST_FILENAMES[entry.name];
      if (!kind) continue;

      const raw = fs.readFileSync(absPath, "utf8");
      const { frontmatter, body } = parseFrontmatter(raw);
      const relativePath = normalizeSlashPath(path.relative(rootDir, absPath));
      const fallbackSlug = normalizeSlug(path.basename(path.dirname(absPath)));
      const slug = normalizeSlug(String(frontmatter.slug || fallbackSlug));
      const name =
        stringValue(frontmatter.name) ||
        path.basename(path.dirname(absPath)).replace(/[-_]/g, " ") ||
        entry.name;

      results.push({
        id: `manifest:${relativePath}`,
        sourceId: `source:${source.rootUri}`,
        kind,
        slug,
        name,
        description: stringValue(frontmatter.description),
        relativePath,
        body: body.trim(),
        bodyHash: createHash("sha256").update(raw).digest("hex"),
        frontmatter,
        provenance: {
          sourceKind: source.sourceKind,
          rootUri: source.rootUri,
          localPath: source.localPath,
          ref: source.ref,
          pin: source.pin,
        },
        createdAt: 0,
        updatedAt: 0,
      });
    }

    return results;
  }

  private buildGraph(
    manifests: CompanyPackageManifest[],
    source: CompanyPackageSourceInput,
    warnings: string[],
  ): { nodes: CompanyGraphNode[]; edges: CompanyGraphEdge[] } {
    const nodes: CompanyGraphNode[] = [];
    const edges: CompanyGraphEdge[] = [];
    const manifestByPath = new Map(manifests.map((manifest) => [manifest.relativePath, manifest]));
    const nodeByManifestId = new Map<string, CompanyGraphNode>();
    const nodeBySlugAndKind = new Map<string, CompanyGraphNode>();

    const companyManifest =
      manifests.find((manifest) => manifest.kind === "company") ||
      ({
        id: "manifest:inferred-company",
        sourceId: `source:${source.rootUri}`,
        kind: "company",
        slug: normalizeSlug(source.name || path.basename(source.localPath || source.rootUri)),
        name: source.name || path.basename(source.localPath || source.rootUri),
        description: undefined,
        relativePath: "COMPANY.md",
        body: "",
        bodyHash: "",
        frontmatter: {},
        provenance: {},
        createdAt: 0,
        updatedAt: 0,
      } satisfies CompanyPackageManifest);

    for (const manifest of [companyManifest, ...manifests.filter((entry) => entry.id !== companyManifest.id)]) {
      const parentNodeId =
        manifest.kind === "company" ? undefined : `node:${companyManifest.relativePath}`;
      const node: CompanyGraphNode = {
        id: `node:${manifest.relativePath}`,
        sourceId: `source:${source.rootUri}`,
        manifestId: manifest.id,
        kind: manifest.kind,
        slug: manifest.slug,
        name: manifest.name,
        description: manifest.description,
        relativePath: manifest.relativePath,
        parentNodeId,
        metadata: {
          frontmatter: manifest.frontmatter,
        },
        createdAt: 0,
        updatedAt: 0,
      };
      nodes.push(node);
      nodeByManifestId.set(manifest.id, node);
      nodeBySlugAndKind.set(`${manifest.kind}:${manifest.slug}`, node);
    }

    for (const node of nodes) {
      if (!node.parentNodeId) continue;
      edges.push(this.previewEdge("contains", node.parentNodeId, node.id));
    }

    for (const manifest of manifests) {
      const node = nodeByManifestId.get(manifest.id);
      if (!node) continue;
      const frontmatter = manifest.frontmatter;

      if (manifest.kind === "agent") {
        const reportsTo = stringValue(frontmatter.reportsTo);
        if (reportsTo) {
          const targetNode = this.resolveReferencedNode(node.relativePath, reportsTo, manifestByPath, nodeBySlugAndKind, "agent");
          if (targetNode) {
            edges.push(this.previewEdge("reports_to", node.id, targetNode.id));
          } else {
            warnings.push(`Could not resolve reportsTo target "${reportsTo}" from ${manifest.relativePath}`);
          }
        }

        for (const skillRef of arrayValue(frontmatter.skills)) {
          const targetNode = this.resolveReferencedNode(node.relativePath, skillRef, manifestByPath, nodeBySlugAndKind, "skill");
          if (targetNode) {
            edges.push(this.previewEdge("attaches_skill", node.id, targetNode.id));
          }
        }
      }

      if (manifest.kind === "team") {
        const manager = stringValue(frontmatter.manager);
        if (manager) {
          const managerNode = this.resolveReferencedNode(node.relativePath, manager, manifestByPath, nodeBySlugAndKind, "agent");
          if (managerNode) {
            edges.push(this.previewEdge("manages_team", managerNode.id, node.id));
          }
        }

        for (const includeRef of arrayValue(frontmatter.includes)) {
          const targetNode = this.resolveReferencedNode(node.relativePath, includeRef, manifestByPath, nodeBySlugAndKind);
          if (targetNode) {
            const kind: CompanyGraphEdgeKind =
              targetNode.kind === "agent" ? "belongs_to" : "includes";
            edges.push(this.previewEdge(kind, node.id, targetNode.id));
          }
        }
      }

      if (manifest.kind === "task") {
        const assignee = stringValue(frontmatter.assignee);
        if (assignee) {
          const assigneeNode = this.resolveReferencedNode(node.relativePath, assignee, manifestByPath, nodeBySlugAndKind, "agent");
          if (assigneeNode) {
            edges.push(this.previewEdge("assigned_to", node.id, assigneeNode.id));
          }
        }

        const project = stringValue(frontmatter.project);
        if (project) {
          const projectNode = this.resolveReferencedNode(node.relativePath, project, manifestByPath, nodeBySlugAndKind, "project");
          if (projectNode) {
            edges.push(this.previewEdge("related_to_project", node.id, projectNode.id));
          }
        }
      }
    }

    return { nodes, edges };
  }

  private resolveReferencedNode(
    fromRelativePath: string | undefined,
    reference: string,
    manifestByPath: Map<string, CompanyPackageManifest>,
    nodeBySlugAndKind: Map<string, CompanyGraphNode>,
    preferredKind?: CompanyPackageManifestKind,
  ): CompanyGraphNode | undefined {
    const trimmed = reference.trim();
    if (!trimmed) return undefined;

    if (trimmed.includes("/")) {
      const baseDir = fromRelativePath ? path.posix.dirname(normalizeSlashPath(fromRelativePath)) : ".";
      const resolvedPath = normalizeSlashPath(path.posix.normalize(path.posix.join(baseDir, trimmed)));
      const manifest = manifestByPath.get(resolvedPath);
      if (manifest) {
        return nodeBySlugAndKind.get(`${manifest.kind}:${manifest.slug}`);
      }
    }

    if (preferredKind) {
      const preferred = nodeBySlugAndKind.get(`${preferredKind}:${normalizeSlug(trimmed)}`);
      if (preferred) return preferred;
    }

    return nodeBySlugAndKind.get(`agent:${normalizeSlug(trimmed)}`)
      || nodeBySlugAndKind.get(`skill:${normalizeSlug(trimmed)}`)
      || nodeBySlugAndKind.get(`project:${normalizeSlug(trimmed)}`)
      || nodeBySlugAndKind.get(`team:${normalizeSlug(trimmed)}`);
  }

  private previewEdge(kind: CompanyGraphEdgeKind, fromNodeId: string, toNodeId: string): CompanyGraphEdge {
    return {
      id: `edge:${kind}:${fromNodeId}:${toNodeId}`,
      sourceId: undefined,
      fromNodeId,
      toNodeId,
      kind,
      createdAt: 0,
      updatedAt: 0,
    };
  }

  private upsertCompanyForPreview(preview: CompanyImportPreview): Company {
    if (preview.targetCompany) {
      const updated = this.core.updateCompany(preview.targetCompany.id, {
        name: preview.graph.packageName,
        slug: preview.graph.companyManifest?.slug,
        description: preview.graph.companyManifest?.description,
      });
      return updated || preview.targetCompany;
    }

    return this.core.createCompany({
      name: preview.graph.packageName,
      slug: preview.graph.companyManifest?.slug,
      description: preview.graph.companyManifest?.description,
    });
  }

  private buildExistingRuntimeIndex(source: CompanyPackageSource): ExistingSourceRuntimeIndex {
    const rows = this.db
      .prepare(
        `
          SELECT
            s.*,
            n.kind AS node_kind,
            n.slug AS node_slug,
            n.relative_path AS node_relative_path
          FROM company_sync_states s
          LEFT JOIN company_org_nodes n ON n.id = s.org_node_id
          WHERE s.source_id = ?
            AND s.runtime_entity_kind IN ('agent_role', 'project', 'issue')
        `,
      )
      .all(source.id) as Any[];

    return {
      source,
      links: rows.reduce<ExistingSourceRuntimeLink[]>((acc, row) => {
        if (!row.node_kind || !row.node_slug) {
          return acc;
        }
        acc.push({
          syncState: this.mapSyncState(row),
          nodeKind: row.node_kind,
          nodeSlug: row.node_slug,
          nodeRelativePath: row.node_relative_path || undefined,
        });
        return acc;
      }, []),
    };
  }

  private relativePathIdentityKey(kind: CompanyGraphNode["kind"], relativePath?: string): string | null {
    if (!relativePath) return null;
    return `${kind}:${normalizeSlashPath(relativePath)}`;
  }

  private slugIdentityKey(kind: CompanyGraphNode["kind"], slug: string): string {
    return `${kind}:${normalizeSlug(slug)}`;
  }

  private findExistingRuntimeLink(
    index: ExistingSourceRuntimeIndex | undefined,
    node: CompanyGraphNode,
    runtimeEntityKind: CompanyRuntimeEntityKind,
  ): CompanySyncState | undefined {
    if (!index) return undefined;

    const relativePathKey = this.relativePathIdentityKey(node.kind, node.relativePath);
    if (relativePathKey) {
      const relativeMatch = index.links.find(
        (link) =>
          link.syncState.runtimeEntityKind === runtimeEntityKind &&
          this.relativePathIdentityKey(link.nodeKind, link.nodeRelativePath) === relativePathKey,
      );
      if (relativeMatch) return relativeMatch.syncState;
    }

    const slugKey = this.slugIdentityKey(node.kind, node.slug);
    const slugMatch = index.links.find(
      (link) =>
        link.syncState.runtimeEntityKind === runtimeEntityKind &&
        this.slugIdentityKey(link.nodeKind, link.nodeSlug) === slugKey,
    );
    return slugMatch?.syncState;
  }

  private reconcileRemovedRuntimeEntities(
    index: ExistingSourceRuntimeIndex | undefined,
    currentNodes: CompanyGraphNode[],
    now: number,
  ): void {
    if (!index) return;

    const activeKeys = new Set<string>();
    for (const node of currentNodes) {
      if (node.kind !== "agent" && node.kind !== "project" && node.kind !== "task") continue;
      const relativeKey = this.relativePathIdentityKey(node.kind, node.relativePath);
      if (relativeKey) activeKeys.add(relativeKey);
      activeKeys.add(this.slugIdentityKey(node.kind, node.slug));
    }

    const reconciled = new Set<string>();
    for (const link of index.links) {
      const relativeKey = this.relativePathIdentityKey(link.nodeKind, link.nodeRelativePath);
      const slugKey = this.slugIdentityKey(link.nodeKind, link.nodeSlug);
      if ((relativeKey && activeKeys.has(relativeKey)) || activeKeys.has(slugKey)) {
        continue;
      }

      const runtimeKey = `${link.syncState.runtimeEntityKind}:${link.syncState.runtimeEntityId}`;
      if (reconciled.has(runtimeKey)) continue;
      reconciled.add(runtimeKey);

      if (link.syncState.runtimeEntityKind === "agent_role") {
        const role = this.agentRoleRepo.findById(link.syncState.runtimeEntityId);
        if (role?.isActive) {
          this.agentRoleRepo.update({ id: role.id, isActive: false });
        }
        continue;
      }

      if (link.syncState.runtimeEntityKind === "project") {
        const project = this.core.getProject(link.syncState.runtimeEntityId);
        if (project && project.status !== "archived") {
          this.core.updateProject(project.id, { status: "archived", archivedAt: now });
        }
        continue;
      }

      if (link.syncState.runtimeEntityKind === "issue") {
        const issue = this.core.getIssue(link.syncState.runtimeEntityId);
        if (issue && issue.status !== "cancelled") {
          this.core.updateIssue(issue.id, { status: "cancelled", completedAt: issue.completedAt ?? now });
        }
      }
    }
  }

  private upsertSource(companyId: string, source: CompanyPackageSourceInput, now: number): CompanyPackageSource {
    const existing = this.db
      .prepare(
        `
          SELECT * FROM company_package_sources
          WHERE company_id = ? AND root_uri = ?
          LIMIT 1
        `,
      )
      .get(companyId, source.rootUri) as Any | undefined;

    if (existing) {
      this.db
        .prepare(
          `
            UPDATE company_package_sources
            SET source_kind = ?, name = ?, local_path = ?, ref = ?, pin = ?, trust_level = ?,
                status = 'imported', notes = ?, last_synced_at = ?, updated_at = ?
            WHERE id = ?
          `,
        )
        .run(
          source.sourceKind,
          source.name,
          source.localPath || null,
          source.ref || null,
          source.pin || null,
          source.trustLevel,
          source.notes || null,
          now,
          now,
          existing.id,
        );
      return this.mapSource({
        ...existing,
        company_id: companyId,
        source_kind: source.sourceKind,
        name: source.name,
        root_uri: source.rootUri,
        local_path: source.localPath,
        ref: source.ref,
        pin: source.pin,
        trust_level: source.trustLevel,
        status: "imported",
        notes: source.notes,
        last_synced_at: now,
        updated_at: now,
      });
    }

    const created: CompanyPackageSource = {
      id: randomUUID(),
      companyId,
      sourceKind: source.sourceKind,
      name: source.name || inferSourceName(source),
      rootUri: source.rootUri,
      localPath: source.localPath || undefined,
      ref: source.ref || undefined,
      pin: source.pin || undefined,
      trustLevel: source.trustLevel || "local",
      status: "imported",
      notes: source.notes || undefined,
      lastSyncedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `
          INSERT INTO company_package_sources (
            id, company_id, source_kind, name, root_uri, local_path, ref, pin,
            trust_level, status, notes, last_synced_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        created.id,
        created.companyId,
        created.sourceKind,
        created.name,
        created.rootUri,
        created.localPath || null,
        created.ref || null,
        created.pin || null,
        created.trustLevel,
        created.status,
        created.notes || null,
        created.lastSyncedAt || null,
        created.createdAt,
        created.updatedAt,
      );
    return created;
  }

  private clearSourceGraph(sourceId: string): void {
    this.db.prepare("DELETE FROM company_sync_states WHERE source_id = ?").run(sourceId);
    this.db.prepare("DELETE FROM company_org_edges WHERE source_id = ?").run(sourceId);
    this.db.prepare("DELETE FROM company_org_nodes WHERE source_id = ?").run(sourceId);
    this.db.prepare("DELETE FROM company_package_manifests WHERE source_id = ?").run(sourceId);
  }

  private insertSyncState(
    state: Omit<CompanySyncState, "id" | "createdAt" | "updatedAt">,
  ): void {
    const now = Date.now();
    this.db
      .prepare(
        `
          INSERT INTO company_sync_states (
            id, company_id, source_id, manifest_id, org_node_id, runtime_entity_kind,
            runtime_entity_id, sync_status, last_synced_at, metadata_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        randomUUID(),
        state.companyId,
        state.sourceId || null,
        state.manifestId || null,
        state.orgNodeId || null,
        state.runtimeEntityKind,
        state.runtimeEntityId,
        state.syncStatus,
        state.lastSyncedAt || null,
        JSON.stringify(state.metadata || {}),
        now,
        now,
      );
  }

  private getManifestBody(
    manifests: CompanyPackageManifest[],
    manifestId?: string,
  ): string | undefined {
    return manifests.find((manifest) => manifest.id === manifestId)?.body || undefined;
  }

  private agentRoleName(companySlug: string, agentSlug: string): string {
    return `company_${normalizeSlug(companySlug)}_${normalizeSlug(agentSlug)}`;
  }

  private mapSource(row: Any): CompanyPackageSource {
    return {
      id: row.id,
      companyId: row.company_id || undefined,
      sourceKind: row.source_kind,
      name: row.name,
      rootUri: row.root_uri,
      localPath: row.local_path || undefined,
      ref: row.ref || undefined,
      pin: row.pin || undefined,
      trustLevel: row.trust_level,
      status: row.status,
      notes: row.notes || undefined,
      lastSyncedAt: row.last_synced_at || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapManifest(row: Any): CompanyPackageManifest {
    return {
      id: row.id,
      sourceId: row.source_id,
      kind: row.kind,
      slug: row.slug,
      name: row.name,
      description: row.description || undefined,
      relativePath: row.relative_path,
      body: row.body || "",
      bodyHash: row.body_hash || "",
      frontmatter: row.frontmatter_json ? JSON.parse(row.frontmatter_json) : {},
      provenance: row.provenance_json ? JSON.parse(row.provenance_json) : {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapNode(row: Any): CompanyGraphNode {
    return {
      id: row.id,
      companyId: row.company_id || undefined,
      sourceId: row.source_id || undefined,
      manifestId: row.manifest_id || undefined,
      kind: row.kind,
      slug: row.slug,
      name: row.name,
      description: row.description || undefined,
      relativePath: row.relative_path || undefined,
      parentNodeId: row.parent_node_id || undefined,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapEdge(row: Any): CompanyGraphEdge {
    return {
      id: row.id,
      companyId: row.company_id || undefined,
      sourceId: row.source_id || undefined,
      fromNodeId: row.from_node_id,
      toNodeId: row.to_node_id,
      kind: row.kind,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapSyncState(row: Any): CompanySyncState {
    return {
      id: row.id,
      companyId: row.company_id,
      sourceId: row.source_id || undefined,
      manifestId: row.manifest_id || undefined,
      orgNodeId: row.org_node_id || undefined,
      runtimeEntityKind: row.runtime_entity_kind,
      runtimeEntityId: row.runtime_entity_id,
      syncStatus: row.sync_status,
      lastSyncedAt: row.last_synced_at || undefined,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
