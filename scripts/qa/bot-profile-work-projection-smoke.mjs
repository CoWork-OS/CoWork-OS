#!/usr/bin/env node
/** Compiled profile/projection acceptance only; synthetic records, no execution. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
const require = createRequire(import.meta.url);
const { DatabaseManager } = require("../../dist/daemon/electron/database/schema.js");
const {
  WorkspaceStore,
  TaskStore,
  ApprovalStore,
} = require("../../dist/daemon/electron/database/repositories.js");
const { AgentRoleStore } = require("../../dist/daemon/electron/agents/AgentRoleRepository.js");
const { AgentTeamStore } = require("../../dist/daemon/electron/agents/AgentTeamRepository.js");
const {
  AgentTeamMemberStore,
} = require("../../dist/daemon/electron/agents/AgentTeamMemberRepository.js");
const { BotWorkQueryService } = require("../../dist/daemon/electron/agents/BotWorkQueryService.js");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-bot-profile-work-"));
const dbPath = path.join(directory, "profile.db");
let manager;
try {
  manager = new DatabaseManager({ dbPath });
  let db = manager.getDatabase();
  let roles = new AgentRoleStore(db);
  assert.equal(
    roles.findAll(true).length,
    0,
    "Opening an empty profile must not install private bots",
  );
  const workspaces = new WorkspaceStore(db);
  const workspace = workspaces.create("Synthetic projection workspace", directory, {
    read: true,
    write: false,
    delete: false,
    shell: false,
    network: false,
  });
  const otherWorkspacePath = path.join(directory, "other-workspace");
  await fs.mkdir(otherWorkspacePath);
  const otherWorkspace = workspaces.create("Unrelated projection workspace", otherWorkspacePath, {
    read: true,
    write: false,
    delete: false,
    shell: false,
    network: false,
  });
  const privatePrompt = "These disposable custom instructions must survive rename and restart.";
  const bot = roles.create({
    name: "arbitrary-cobalt-observer",
    displayName: "Cobalt observer",
    capabilities: [],
    systemPrompt: privatePrompt,
    heartbeatEnabled: false,
  });
  const otherBot = roles.create({
    name: "arbitrary-amber-helper",
    displayName: "Amber helper",
    capabilities: [],
    systemPrompt: "Unrelated private instructions",
    heartbeatEnabled: false,
  });
  let teams = new AgentTeamStore(db);
  let members = new AgentTeamMemberStore(db);
  assert.deepEqual(teams.listByWorkspace(workspace.id, true), []);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_team_members").get().count, 0);
  const team = teams.create({
    workspaceId: workspace.id,
    name: "Explicit synthetic team",
    leadAgentRoleId: bot.id,
  });
  const member = members.add({ teamId: team.id, agentRoleId: otherBot.id });
  assert.equal(members.add({ teamId: team.id, agentRoleId: otherBot.id }).id, member.id);
  assert.equal(members.listByTeam(team.id).length, 1);
  assert.equal(members.removeByTeamAndRole(team.id, otherBot.id), true);
  assert.deepEqual(members.listByTeam(team.id), []);
  const tasks = new TaskStore(db);
  const ordinary = tasks.create({
    workspaceId: workspace.id,
    assignedAgentRoleId: bot.id,
    title: "Synthetic assigned record",
    prompt: "Metadata only",
    status: "executing",
  });
  const delegated = tasks.create({
    workspaceId: workspace.id,
    parentTaskId: ordinary.id,
    assignedAgentRoleId: otherBot.id,
    title: "Synthetic delegated record",
    prompt: "Metadata only",
    status: "executing",
  });
  const unrelated = tasks.create({
    workspaceId: workspace.id,
    assignedAgentRoleId: otherBot.id,
    title: "Unrelated record",
    prompt: "Metadata only",
    status: "executing",
  });
  const foreign = tasks.create({
    workspaceId: otherWorkspace.id,
    parentTaskId: ordinary.id,
    assignedAgentRoleId: bot.id,
    title: "Foreign workspace record",
    prompt: "Metadata only",
    status: "executing",
  });
  const waiting = tasks.create({
    workspaceId: workspace.id,
    assignedAgentRoleId: bot.id,
    title: "Synthetic preserved wait",
    prompt: "Metadata only",
    status: "blocked",
    terminalStatus: "awaiting_approval",
  });
  const approval = new ApprovalStore(db).create({
    taskId: waiting.id,
    type: "run_command",
    description: "Synthetic decision only",
    details: { command: "fixture-never-executed" },
    status: "pending",
    requestedAt: Date.now(),
  });
  roles.update({ id: bot.id, displayName: "Renamed Cobalt" });
  assert.equal(roles.delete(bot.id), true);
  const expectedRoleIds = roles
    .findAll(true)
    .map((role) => role.id)
    .sort();
  const beforeTasks = db.prepare("SELECT * FROM tasks ORDER BY id").all();
  const beforeApproval = db.prepare("SELECT * FROM approvals WHERE id = ?").get(approval.id);
  manager.close();
  manager = new DatabaseManager({ dbPath });
  db = manager.getDatabase();
  roles = new AgentRoleStore(db);
  teams = new AgentTeamStore(db);
  members = new AgentTeamMemberStore(db);
  assert.deepEqual(
    roles
      .findAll(true)
      .map((role) => role.id)
      .sort(),
    expectedRoleIds,
  );
  assert.equal(roles.findById(bot.id).systemPrompt, privatePrompt);
  assert.equal(roles.findById(bot.id).name, "arbitrary-cobalt-observer");
  assert.equal(roles.findById(bot.id).displayName, "Renamed Cobalt");
  assert.equal(roles.findById(bot.id).isActive, false);
  assert.equal(roles.findById(otherBot.id).isActive, true);
  assert.equal(teams.listByWorkspace(workspace.id, true).length, 1);
  assert.equal(teams.findById(team.id).leadAgentRoleId, bot.id);
  assert.deepEqual(
    members.listByTeam(team.id),
    [],
    "Removed membership must not reappear on restart",
  );
  assert.deepEqual(db.prepare("SELECT * FROM tasks ORDER BY id").all(), beforeTasks);
  assert.deepEqual(
    db.prepare("SELECT * FROM approvals WHERE id = ?").get(approval.id),
    beforeApproval,
  );
  const query = new BotWorkQueryService(db, async () => ({ jobs: [], state: "disabled" }));
  const scope = { workspaceId: workspace.id, agentRoleId: bot.id };
  const page = await query.list({ ...scope, view: "working", limit: 100 });
  assert.deepEqual(
    page.items.map((item) => item.taskId).sort(),
    [ordinary.id, delegated.id].sort(),
  );
  assert.equal(new Set(page.items.map((item) => item.id)).size, page.items.length);
  assert(page.items.some((item) => item.taskId === delegated.id && item.ownership === "delegated"));
  assert(!page.items.some((item) => [foreign.id, unrelated.id].includes(item.taskId)));
  assert.equal(page.scheduleRuntime, "disabled");
  const needs = await query.list({ ...scope, view: "needs_you", limit: 100 });
  assert.equal(needs.items.filter((item) => item.taskId === waiting.id).length, 1);
  const paged = await query.list({ ...scope, view: "working", limit: 1 });
  assert(paged.nextCursor);
  await assert.rejects(
    query.list({ ...scope, agentRoleId: otherBot.id, view: "working", cursor: paged.nextCursor }),
    /another query/,
  );
  const milliseconds = [];
  for (let sample = 0; sample < 20; sample++) {
    const start = performance.now();
    await query.list({ ...scope, view: "working", limit: 100 });
    milliseconds.push(performance.now() - start);
  }
  milliseconds.sort((a, b) => a - b);
  assert.deepEqual(
    db.prepare("SELECT * FROM tasks ORDER BY id").all(),
    beforeTasks,
    "Read projections must not execute or modify tasks",
  );
  assert.deepEqual(
    db.prepare("SELECT * FROM approvals WHERE id = ?").get(approval.id),
    beforeApproval,
  );
  console.log(
    JSON.stringify({
      fixture: "synthetic-compiled-profile-projection",
      emptyProfilePreserved: true,
      standaloneHasNoImplicitTeam: true,
      explicitMembershipRemovedAcrossReopen: true,
      renamedDeactivatedPromptPreserved: true,
      historicalTasksAndApprovalPreserved: true,
      assignedAndDelegatedWorkDeduplicated: true,
      workspaceAndBotScopesEnforced: true,
      inactiveBotHistoryReadable: true,
      readProjectionsDoNotExecute: true,
      workViewLatencyMs: {
        samples: milliseconds.length,
        syntheticTaskRecords: beforeTasks.length,
        median: milliseconds[10],
        p95: milliseconds[18],
      },
      modelExecution: false,
      channelDelivery: false,
      renderedUi: false,
    }),
  );
} finally {
  manager?.close();
  await fs.rm(directory, { recursive: true, force: true });
}
