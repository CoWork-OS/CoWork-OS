import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      const Database = module.default;
      const probe = new Database(":memory:");
      probe.close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

function writePackageFixture(rootDir: string): void {
  const files: Array<[string, string]> = [
    [
      "COMPANY.md",
      `---
name: "GStack"
slug: "gstack"
description: "Autonomous software company"
---
Reusable companies for shipping software.
`,
    ],
    [
      "engineering/TEAM.md",
      `---
name: "Engineering"
slug: "engineering"
description: "Builds and operates the platform"
manager: "cto"
includes:
  - "cto/AGENTS.md"
  - "staff/AGENTS.md"
---
Engineering team package.
`,
    ],
    [
      "ceo/AGENTS.md",
      `---
name: "CEO"
slug: "ceo"
description: "Chief executive"
---
Own the company direction.
`,
    ],
    [
      "engineering/cto/AGENTS.md",
      `---
name: "CTO"
slug: "cto"
description: "Technology lead"
reportsTo: "../../ceo/AGENTS.md"
---
Own the architecture and delivery system.
`,
    ],
    [
      "engineering/staff/AGENTS.md",
      `---
name: "Staff Engineer"
slug: "staff-engineer"
description: "Ships the core product"
reportsTo: "../cto/AGENTS.md"
skills:
  - "../../skills/release-review/SKILL.md"
---
Implement and review high-leverage systems.
`,
    ],
    [
      "skills/release-review/SKILL.md",
      `---
name: "release-review"
slug: "release-review"
description: "Reviews releases before launch"
---
Check the release candidate before shipping.
`,
    ],
    [
      "projects/platform/PROJECT.md",
      `---
name: "Platform"
slug: "platform"
description: "Core platform delivery"
---
Platform workstream.
`,
    ],
    [
      "projects/platform/release/TASK.md",
      `---
name: "Prepare launch candidate"
slug: "prepare-launch-candidate"
description: "Seed the launch issue"
project: "../PROJECT.md"
assignee: "staff-engineer"
---
Create the first release candidate and validate it.
`,
    ],
  ];

  for (const [relativePath, content] of files) {
    const absolutePath = path.join(rootDir, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, "utf8");
  }
}

describeWithSqlite("AgentCompaniesService", () => {
  let tmpDir: string;
  let packageDir: string;
  let previousUserDataDir: string | undefined;
  let manager: import("../../database/schema").DatabaseManager;
  let db: ReturnType<import("../../database/schema").DatabaseManager["getDatabase"]>;
  let core: import("../ControlPlaneCoreService").ControlPlaneCoreService;
  let agentRoleRepo: import("../../agents/AgentRoleRepository").AgentRoleRepository;
  let service: import("../AgentCompaniesService").AgentCompaniesService;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-agent-companies-"));
    packageDir = path.join(tmpDir, "fixture-package");
    writePackageFixture(packageDir);

    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;

    const [
      { DatabaseManager },
      { ControlPlaneCoreService },
      { AgentRoleRepository },
      { AgentCompaniesService },
    ] = await Promise.all([
      import("../../database/schema"),
      import("../ControlPlaneCoreService"),
      import("../../agents/AgentRoleRepository"),
      import("../AgentCompaniesService"),
    ]);

    manager = new DatabaseManager();
    db = manager.getDatabase();
    core = new ControlPlaneCoreService(db);
    agentRoleRepo = new AgentRoleRepository(db);
    service = new AgentCompaniesService(db, core, agentRoleRepo);
  });

  afterEach(() => {
    manager?.close();
    if (previousUserDataDir === undefined) {
      delete process.env.COWORK_USER_DATA_DIR;
    } else {
      process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("previews a local package as a resolved company graph with org relationships", () => {
    const preview = service.previewImport({
      source: {
        sourceKind: "local",
        rootUri: packageDir,
        localPath: packageDir,
      },
    });

    expect(preview.graph.packageName).toBe("GStack");
    expect(preview.graph.manifests).toHaveLength(8);
    expect(preview.graph.nodes).toHaveLength(8);
    expect(preview.warnings).toEqual([]);
    expect(
      preview.items.some((item) => item.manifestKind === "company" && item.action === "create"),
    ).toBe(true);
    expect(preview.graph.edges.map((edge) => edge.kind)).toEqual(
      expect.arrayContaining([
        "contains",
        "reports_to",
        "manages_team",
        "belongs_to",
        "attaches_skill",
        "assigned_to",
        "related_to_project",
      ]),
    );
  });

  it("imports a package into Cowork runtime and updates the same runtime entities on re-import", () => {
    const request = {
      source: {
        sourceKind: "local" as const,
        rootUri: packageDir,
        localPath: packageDir,
      },
    };

    const firstImport = service.importPackage(request);

    expect(firstImport.company.name).toBe("GStack");
    expect(firstImport.createdCount).toBe(5);
    expect(firstImport.updatedCount).toBe(0);
    expect(firstImport.linkedCount).toBe(5);

    const companyProjects = core.listProjects({
      companyId: firstImport.company.id,
      includeArchived: true,
    });
    const companyIssues = core.listIssues({ companyId: firstImport.company.id, limit: 20 });
    const companyRoles = agentRoleRepo.findByCompanyId(firstImport.company.id, true);
    const syncStates = service.listSyncStates(firstImport.company.id);
    const sources = service.listSources(firstImport.company.id);

    expect(companyProjects).toHaveLength(1);
    expect(companyProjects[0]?.name).toBe("Platform");
    expect(companyIssues).toHaveLength(1);
    expect(companyIssues[0]?.title).toBe("Prepare launch candidate");
    expect(companyIssues[0]?.projectId).toBe(companyProjects[0]?.id);
    expect(companyIssues[0]?.metadata?.packageTask).toBe(true);
    expect(companyRoles).toHaveLength(3);
    expect(companyRoles.every((role) => role.isActive === false)).toBe(true);
    expect(syncStates.filter((state) => state.runtimeEntityKind === "agent_role")).toHaveLength(3);
    expect(syncStates.filter((state) => state.runtimeEntityKind === "project")).toHaveLength(1);
    expect(syncStates.filter((state) => state.runtimeEntityKind === "issue")).toHaveLength(1);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.status).toBe("imported");

    const secondImport = service.importPackage(request);

    expect(secondImport.company.id).toBe(firstImport.company.id);
    expect(secondImport.createdCount).toBe(0);
    expect(secondImport.updatedCount).toBe(5);
    expect(
      core.listProjects({ companyId: firstImport.company.id, includeArchived: true }),
    ).toHaveLength(1);
    expect(core.listIssues({ companyId: firstImport.company.id, limit: 20 })).toHaveLength(1);
    expect(agentRoleRepo.findByCompanyId(firstImport.company.id, true)).toHaveLength(3);
  });

  it("creates new source-managed entities instead of mutating unrelated runtime items with the same labels", () => {
    const existingCompany = core.createCompany({
      name: "Import Target",
      slug: "import-target",
    });

    agentRoleRepo.create({
      name: "manual_cto",
      companyId: existingCompany.id,
      displayName: "CTO",
      capabilities: [],
      heartbeatEnabled: false,
    });
    core.createProject({
      companyId: existingCompany.id,
      name: "Platform",
    });
    core.createIssue({
      companyId: existingCompany.id,
      title: "Prepare launch candidate",
    });

    const imported = service.importPackage({
      companyId: existingCompany.id,
      source: {
        sourceKind: "local",
        rootUri: packageDir,
        localPath: packageDir,
      },
    });

    expect(imported.company.id).toBe(existingCompany.id);
    expect(imported.createdCount).toBe(5);
    expect(imported.updatedCount).toBe(0);
    expect(agentRoleRepo.findByCompanyId(existingCompany.id, true)).toHaveLength(4);
    expect(
      core.listProjects({ companyId: existingCompany.id, includeArchived: true }),
    ).toHaveLength(2);
    expect(core.listIssues({ companyId: existingCompany.id, limit: 20 })).toHaveLength(2);
  });

  it("archives or deactivates source-managed runtime entities removed from a package on re-import", () => {
    const request = {
      source: {
        sourceKind: "local" as const,
        rootUri: packageDir,
        localPath: packageDir,
      },
    };

    const firstImport = service.importPackage(request);
    const importedRole = agentRoleRepo
      .findByCompanyId(firstImport.company.id, true)
      .find((role) => role.name === "company_gstack_staff-engineer");
    const importedProject = core
      .listProjects({ companyId: firstImport.company.id, includeArchived: true })
      .find((project) => project.name === "Platform");
    const importedIssue = core
      .listIssues({ companyId: firstImport.company.id, limit: 20 })
      .find((issue) => issue.title === "Prepare launch candidate");

    expect(importedRole).toBeTruthy();
    expect(importedProject).toBeTruthy();
    expect(importedIssue).toBeTruthy();

    agentRoleRepo.update({ id: importedRole!.id, isActive: true });
    fs.rmSync(path.join(packageDir, "engineering", "staff"), { recursive: true, force: true });
    fs.rmSync(path.join(packageDir, "projects"), { recursive: true, force: true });

    service.importPackage(request);

    expect(agentRoleRepo.findById(importedRole!.id)?.isActive).toBe(false);
    expect(core.getProject(importedProject!.id)?.status).toBe("archived");
    expect(core.getIssue(importedIssue!.id)?.status).toBe("cancelled");
  });

  it("only auto-targets a company when the package source has already been imported", () => {
    const existingCompany = core.createCompany({
      name: "GStack",
      slug: "gstack",
    });

    const freshPreview = service.previewImport({
      source: {
        sourceKind: "local",
        rootUri: packageDir,
        localPath: packageDir,
      },
    });
    expect(freshPreview.targetCompany).toBeUndefined();

    const imported = service.importPackage({
      companyId: existingCompany.id,
      source: {
        sourceKind: "local",
        rootUri: packageDir,
        localPath: packageDir,
      },
    });

    const repeatPreview = service.previewImport({
      source: {
        sourceKind: "local",
        rootUri: packageDir,
        localPath: packageDir,
      },
    });
    expect(repeatPreview.targetCompany?.id).toBe(imported.company.id);
  });

  it("links an imported agent org node to an explicit runtime operator", () => {
    const imported = service.importPackage({
      source: {
        sourceKind: "local",
        rootUri: packageDir,
        localPath: packageDir,
      },
    });

    const graph = service.getResolvedGraph(imported.company.id);
    const staffNode = graph.nodes.find(
      (node) => node.kind === "agent" && node.slug === "staff-engineer",
    );
    expect(staffNode).toBeTruthy();

    const overrideRole = agentRoleRepo.create({
      name: "manual_staff_engineer",
      displayName: "Manual Staff Engineer",
      capabilities: ["ship"],
      heartbeatEnabled: false,
    });

    const syncState = service.linkOrgNodeToAgentRole({
      companyId: imported.company.id,
      orgNodeId: staffNode!.id,
      agentRoleId: overrideRole.id,
    });

    expect(syncState?.runtimeEntityId).toBe(overrideRole.id);
    expect(agentRoleRepo.findById(overrideRole.id)?.companyId).toBe(imported.company.id);

    const staffMappings = service
      .listSyncStates(imported.company.id)
      .filter(
        (state) => state.orgNodeId === staffNode!.id && state.runtimeEntityKind === "agent_role",
      );
    expect(staffMappings).toHaveLength(1);
    expect(staffMappings[0]?.runtimeEntityId).toBe(overrideRole.id);
  });
});
