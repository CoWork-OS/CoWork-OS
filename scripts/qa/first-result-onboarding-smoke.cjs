#!/usr/bin/env node
// Run only against an isolated npm run dev profile with a configured ChatGPT subscription.
// COWORK_FIRST_RESULT_QA=1 COWORK_QA_CDP_URL=http://127.0.0.1:9355 node scripts/qa/first-result-onboarding-smoke.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

async function main() {
  assert.equal(process.env.COWORK_FIRST_RESULT_QA, '1', 'Use an isolated QA profile; this resets its onboarding and registers a local fixture.');
  assert.ok(process.env.COWORK_QA_CDP_URL, 'Set the isolated dev app CDP URL explicitly.');
  const browser = await chromium.connectOverCDP(process.env.COWORK_QA_CDP_URL);
  try {
    const page = browser.contexts()[0].pages().find((candidate) => /^http:\/\/127\.0\.0\.1:/.test(candidate.url()));
    assert.ok(page, 'The target must be the running Electron dev renderer.');
    const output = path.resolve('output/playwright/first-result');
    fs.mkdirSync(output, { recursive: true });
    const fixturePath = path.resolve('scripts/qa/fixtures/first-result-linear.cjs');
    const baseline = await page.evaluate(async ({ command, fixturePath }) => {
      const api = window.electronAPI;
      const config = await api.getLLMConfigStatus();
      if (config.currentProvider !== 'openai' || !config.providers.some((provider) => provider.type === 'openai' && provider.configured)) throw new Error('Configure the requested ChatGPT subscription in the QA profile first.');
      const llm = await api.getLLMSettings();
      if (llm.openai?.authMethod !== 'oauth') throw new Error('This acceptance run requires subscription OAuth, not an API key.');
      const settings = await api.getMCPSettings();
      let fixture = settings.servers.find((server) => server.args?.includes(fixturePath));
      if (!fixture) fixture = await api.addMCPServer({ name: 'Linear', command, args: [fixturePath], enabled: true, transport: 'stdio', env: {} });
      await api.disconnectMCPServer(fixture.id).catch(() => {});
      await api.saveAppearanceSettings({ onboardingCompleted: false });
      return { count: (await api.listTasks()).length, fixtureId: fixture.id };
    }, { command: process.execPath, fixturePath });
    await page.reload();
    await page.getByRole('heading', { name: 'What would you like to get done?', exact: true }).waitFor();
    await page.screenshot({ animations: 'disabled', path: path.join(output, '01-first-task.png') });
    await page.getByRole('button', { name: 'Create a project update', exact: true }).click();
    const prompt = await page.getByRole('textbox', { name: 'Your first task', exact: true }).inputValue();
    await page.getByRole('button', { name: 'Start task', exact: true }).dblclick();
    const dialog = page.getByRole('dialog', { name: 'Connect apps for your task', exact: true });
    const notice = page.getByRole('button', { name: 'I understand the risks', exact: true });
    await Promise.race([notice.waitFor({ timeout: 30000 }), dialog.waitFor({ timeout: 30000 })]);
    if (await notice.isVisible()) await notice.click();
    await dialog.waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: 'Check connection', exact: true }).waitFor(); // Also catches a stuck StrictMode readiness check.
    await page.screenshot({ animations: 'disabled', path: path.join(output, '04-contextual-setup.png') });
    await page.getByRole('button', { name: 'Back to request', exact: true }).click();
    await page.getByRole('textbox', { name: 'Your first task', exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Your first task', exact: true }).inputValue(), prompt);
    assert.equal(await page.evaluate(async () => (await window.electronAPI.listTasks()).length), baseline.count);
    console.log('PASS: cancel restores the exact prompt and creates no task.');
    await page.getByRole('button', { name: 'Start task', exact: true }).click();
    await dialog.waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: 'Set up', exact: true }).click();
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('button', { name: 'Disconnect', exact: true }).waitFor({ timeout: 20000 });
    await page.screenshot({ animations: 'disabled', path: path.join(output, '05-connector-connected.png') });
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Continue task', exact: true }).waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: 'Continue task', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(async (count) => (await window.electronAPI.listTasks()).length === count + 1, baseline.count, { timeout: 20000 });
    const [task] = await page.evaluate(() => window.electronAPI.listTasks());
    assert.equal(task.prompt, prompt);
    console.log('PASS: connection resumes the original request exactly once. Task:', task.id);
    // Polling does not interact with the app or replace provider/tool implementations.
    let state;
    for (let attempt = 0; attempt < 60; attempt++) {
      state = await page.evaluate((id) => window.electronAPI.getTask(id), task.id);
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(state.status)) break;
      if (attempt % 6 === 0) console.log('Task state:', state.status);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    assert.equal(state.status, 'completed', `Task did not complete: ${state.status}`);
    const resultText = await page.locator('body').innerText();
    assert.doesNotMatch(resultText, /Completed - partial success|Execution completed with partial results|Completed with preserved outputs/i, 'The journey must finish without a failed intermediate step.');
    const workspace = await page.evaluate(() => window.electronAPI.getTempWorkspace());
    assert.equal(workspace.id, task.workspaceId);
    const artifact = path.join(workspace.path, 'project-update.md');
    const text = fs.readFileSync(artifact, 'utf8');
    for (const issue of ['QA-101', 'QA-102', 'QA-103']) assert.ok(text.includes(issue), `Missing fixture record ${issue}`);
    assert.match(text, /synthetic|fixture/i);
    assert.match(text, /blocker/i);
    assert.match(text, /next steps/i);
    const events = await page.evaluate((id) => window.electronAPI.getTaskEvents(id), task.id);
    const successfulTools = new Set(events.filter((event) => event.payload?.legacyType === 'tool_result' && event.payload.envelope?.status === 'success').map((event) => event.payload.tool));
    assert.ok(successfulTools.has('mcp_linear_list_issues'), 'The model must read the real local MCP fixture.');
    assert.ok(successfulTools.has('read_file') && successfulTools.has('write_file'), 'The journey must save and read back the result.');
    assert.ok(!events.some((event) => event.type === 'timeline_step_finished' && event.payload?.status === 'failed'), 'Every execution step must complete cleanly.');
    assert.equal(await page.evaluate(async () => (await window.electronAPI.listTasks()).length), baseline.count + 1);
    await page.screenshot({ animations: 'disabled', path: path.join(output, '07-verified-result.png') });
    fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify({ provider: 'ChatGPT subscription OAuth', connector: 'Real local read-only MCP transport with synthetic issues', taskId: task.id, status: state.status, artifact, fixtureId: baseline.fixtureId, screenshot: '07-verified-result.png' }, null, 2));
    console.log('PASS: completed model-backed task, inspected saved artifact:', artifact);
  } finally { await browser.close(); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
