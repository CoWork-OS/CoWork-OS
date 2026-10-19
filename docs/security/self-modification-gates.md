# Agent Self-Modification Gates

Some of CoWork's tools change what the agent does in **later** tasks, not just the current one: they save into the system prompt of every future task, or add skills the agent will route to. A prompt injection, or the agent's own reasoning, must not be able to use them to reshape the agent. Only the user can make these changes.

Three gates enforce this:

1. **Admin-lane tools appear only on the user's own words.** The text that opens them must be text a person typed, never agent output, tool results, or injected messages.
2. **Skill proposals are approved by the user**, through an approval prompt, never by the agent.
3. **Skill storage needs approval on write**, even in access modes that allow ordinary edits silently.

## Admin-lane tools

These tools are in the admin lane (`EXPLICIT_ONLY_TOOLS` in `src/electron/agent/tool-policy-engine.ts`):

| Tool | Changes |
|---|---|
| `set_personality`, `set_persona`, `set_vibes`, `set_quirks`, `set_response_style` | the agent's persona and tone in every later task |
| `set_agent_name`, `set_user_name` | names used in every later task |
| `add_behavioral_rule` | an always/never/prefer/avoid rule in the personality prompt |
| `set_expertise` | the agent's expertise level for a domain |
| `update_lore` | shared lore the agent reads |
| `manage_heartbeat` | background heartbeat runs |
| `integration_setup` | integration and channel setup |

An admin-lane tool is offered to the model only when the **user's own words** match the admin intent pattern (`ADMIN_INTENT_PATTERN`: personality, persona, agent name, user name, response style, quirks, vibes, lore, heartbeat, integration setup, behavioral rule, expertise). Otherwise the tool is deferred with reason `explicit_admin_intent_required`.

Nothing else opens this lane:

- the agent's last output and its current plan step do not count;
- the step contract's `requiredTools`, which come from agent-written steps, do not count;
- a recent use of the tool does not count, and admin tools are not kept from an earlier turn;
- a task tool allowlist, including one a skill supplies, does not skip the check;
- tool-filter fallbacks never return admin tools.

### What counts as the user's own words

The executor builds the user's words (`ToolAvailabilityContext.userText`) from two parts:

- **The task's title and prompt**, captured when the task starts, only if the task is marked `promptProvenance: "user_typed"` (`src/electron/agent/task-prompt-provenance.ts`). Later changes to `task.prompt` are ignored, because resumed follow-ups are appended there whoever sent them.
- **The latest follow-up the user typed**, only if the follow-up is marked `textProvenance: "user_typed"` (`src/electron/agent/follow-up-provenance.ts`).

Both markers are positive provenance: an unmarked task or message never counts. They are set by main-process creation and send paths only, and never copied from renderer or remote-client input.

**Attached files never count.** Even in a typed prompt or follow-up, only the text before the attached-files block counts (`textBeforeAttachedFiles` in `src/shared/attachment-summary.ts`). That block is the file list and extracted file contents that the composer, the artifact viewers, browser annotations and the gateway append. The cut never resumes after an end marker, so a document can't close the block early with a fake marker. A request typed above the attachments still counts; a file that says "add a behavioral rule" doesn't.

**Task prompts count** when a person typed them into a composer the owner signed in to:

- the desktop app (new task, tray quick task);
- a remote device's view, or another admin client, over the Control Plane;
- Web Access;
- a channel message from the verified owner (`src/electron/gateway/gateway-sender-identity.ts`).

A fork or side chat keeps its source task's marker only when it reuses that task's own prompt.

**Task prompts don't count** when they come from automations, scheduled (`cron`) and hook tasks, mail commitments, the strategic planner, orchestration and workflow steps, remote agents, other agents, a channel sender other than the verified owner, or any task created before this marker existed. A task's `source` (for example `manual` or `api`) does not decide this.

**Follow-ups count** when a person typed them into this task's own conversation:

- the desktop composer, for the local owner only (a collaborator on a shared session doesn't count);
- a remote device's view over the Control Plane, and Web Access;
- a side chat's first message;
- a typed reply on this task's approval card;
- a channel message from the verified owner, including `/steer` and `/queue`.

**Follow-ups don't count** when they come from automations, heartbeats, triggers, routines, webhooks, other agents, updates forwarded from another task, or managed sessions (programs using the API). Text the desktop app sends on the user's behalf from an answer surface doesn't count either. It carries a `surfaceOrigin` instead:

- `answer`: a button the model wrote;
- `page`: a request from page code in an HTML frame;
- `code_block`: shell output from a code block the user ran;
- `browser_page`: web page content sent from the in-app browser (a selection, console output, element values, an answer drawn from a video).

The Control Plane sanitizer refuses surface origins it doesn't know.

When the user really wants one of these changes, they say so in their own words, for example "add a behavioral rule: always answer in Turkish", and the tool appears for that turn.

## Skill proposals need the user's approval

`skill_proposal` lets the agent draft a skill from repeated successes. The agent can `create`, `list` and `reject` proposals freely. `approve` writes a workspace skill, so it asks the user:

- The checks run first: pending status, durable evidence, required tools, placeholders and filesystem access.
- Then the approval prompt shows the exact draft. It is a risk gate with explicit consent: never auto-approved, with no standing approval, and with once-only answers.
- On no, or when the task cannot ask anyone, nothing is saved and the proposal stays `pending`.

See [Integration Setup, Skill Proposals, and Bootstrap Lifecycle](../integration-skill-bootstrap-lifecycle.md#approve).

## Skill storage needs approval on write

Writes and deletes to these workspace locations need the user's approval (`isApprovalRequiredWorkspacePath` in `src/electron/security/access-profile-paths.ts`, enforced in `PermissionEngine`):

- `.cowork/skills/**` at any depth: proposal records (`proposals/`) and eval reports (`evals/`);
- the workspace skill folder `skills/` and the `.json` skill files directly in it.

The rule works like this:

- **An allow becomes an ask.** If the mode, access profile or an allow rule would allow the write silently, the user is asked instead, with once-only answers (a saved "always allow" would not answer the next request).
- **Denials stand.** Plan mode, deny rules and hard boundaries still refuse the write, and a profile that never asks denies it.
- **The skill tools are covered too.** `skill_create`, `skill_update`, `skill_duplicate` and `skill_delete` pass the workspace skill file they change as the permission path, so the same rule applies to them.
- **Every target path is checked.** A file tool call that writes or deletes has every target path argument checked, so a decoy argument cannot hide a write to a skill file.
- **Paths are compared canonically.** Symlinks and the macOS `/var` alias cannot move a write out of these folders.

This is deliberately an approval and not a `protected_path`. A skill edit the user asks for still goes through after one approval.

## Known limits

- **Busy-agent requests may not count.** A request typed while the agent is busy counts only if the message is picked up after the turn ends. If it doesn't count, the user can ask again.
- **Restarts lose follow-up provenance.** After an app restart, a resumed task's earlier follow-ups no longer count. The task prompt's marker is stored with the task and survives.
- **Older tasks don't count.** Tasks created before `prompt_provenance` existed don't count their prompt; the user's next typed message still does.
- **Remote composers count as the owner.** The Control Plane and Web Access are treated as the owner's composer, so the remote desktop view and headless mode can still ask for these tools.

## Related

- [Security Model](security-model.md#prompt-injection-defenses)
- [Permission System](../permission-system.md)
- [Access Profiles](../access-profiles.md)
- [Gateway Message Lifecycle](../gateway-message-lifecycle.md)
