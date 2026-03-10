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

describeWithSqlite("PersonaTemplateService company assignment", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let manager: import("../../database/schema").DatabaseManager;
  let agentRoleRepo: import("../AgentRoleRepository").AgentRoleRepository;
  let controlPlaneService: import("../../control-plane/ControlPlaneCoreService").ControlPlaneCoreService;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-persona-template-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;

    const [{ DatabaseManager }, { AgentRoleRepository }, { ControlPlaneCoreService }] = await Promise.all([
      import("../../database/schema"),
      import("../AgentRoleRepository"),
      import("../../control-plane/ControlPlaneCoreService"),
    ]);

    manager = new DatabaseManager();
    const db = manager.getDatabase();
    agentRoleRepo = new AgentRoleRepository(db);
    controlPlaneService = new ControlPlaneCoreService(db);
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

  it("persists company assignment updates on agent roles", () => {
    const companyA = controlPlaneService.createCompany({ name: "Acme Ops" });
    const companyB = controlPlaneService.createCompany({ name: "Beta Ops" });

    const created = agentRoleRepo.create({
      name: "company-planner-acme",
      companyId: companyA.id,
      displayName: "Acme Company Planner",
      capabilities: ["plan"],
    });

    expect(agentRoleRepo.findById(created.id)?.companyId).toBe(companyA.id);

    agentRoleRepo.update({
      id: created.id,
      companyId: companyB.id,
    });

    expect(agentRoleRepo.findById(created.id)?.companyId).toBe(companyB.id);

    agentRoleRepo.update({
      id: created.id,
      companyId: null,
    });

    expect(agentRoleRepo.findById(created.id)?.companyId).toBeUndefined();
  });

  it("activates the same persona template for multiple companies without role-name collisions", async () => {
    const resourcesDir = path.join(process.cwd(), "resources", "persona-templates");
    const companyA = controlPlaneService.createCompany({ name: "Acme Ventures" });
    const companyB = controlPlaneService.createCompany({ name: "Beta Ventures" });

    const { PersonaTemplateService } = await import("../PersonaTemplateService");
    const service = new PersonaTemplateService(agentRoleRepo, {
      bundledTemplatesDir: resourcesDir,
    });
    await service.initialize();

    const acmeResult = service.activate({
      templateId: "company-planner",
      customization: {
        companyId: companyA.id,
        displayName: "Acme Company Planner",
      },
    });
    const betaResult = service.activate({
      templateId: "company-planner",
      customization: {
        companyId: companyB.id,
        displayName: "Beta Company Planner",
      },
    });

    expect(acmeResult.agentRole.companyId).toBe(companyA.id);
    expect(betaResult.agentRole.companyId).toBe(companyB.id);
    expect(acmeResult.agentRole.name).not.toBe(betaResult.agentRole.name);
  });
});
