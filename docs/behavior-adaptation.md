# Behavior Adaptation

CoWork OS can gradually adjust how it communicates — learning from observed messages and feedback, and adapting delivery style per channel. These are **opt-in behavior controls**, not safety guardrails.

---

## Controls

Both settings live in **Settings → Guardrails → Behavior Adaptation**.

### Adaptive Style

**Setting:** `adaptiveStyleEnabled` (default: `false`)

When enabled, `AdaptiveStyleEngine` observes user messages and feedback to nudge `PersonalityManager` style dimensions (response length, emoji usage, explanation depth) within a weekly drift budget.

**Rate limit:** `adaptiveStyleMaxDriftPerWeek` (default: `1`) — the maximum number of one-level style shifts in any rolling 7-day window.

**Signals that drive adaptation:**

| Signal                 | Detected by                           | Effect                               |
| ---------------------- | ------------------------------------- | ------------------------------------ |
| Short messages         | Rolling average of last 50 lengths    | Shifts `responseLength` → `terse`    |
| Emoji in messages      | Fraction of emoji-containing messages | Shifts `emojiUsage` → `moderate`     |
| Technical vocabulary   | Density of tech terms                 | Shifts `explanationDepth` → `expert` |
| "too verbose" feedback | Reason field match                    | Shifts `responseLength` → `terse`    |
| "more detail" feedback | Reason field match                    | Shifts `responseLength` → `detailed` |
| "no emoji" feedback    | Reason field match                    | Shifts `emojiUsage` → `none`         |

**Audit:** Every adaptation is recorded with dimension, from/to values, reason, and timestamp. Retrieve via `AdaptiveStyleEngine.getAdaptationHistory()`.

**Reset:** The "Reset learned style" button in Guardrail Settings clears all accumulated state and adaptation history via `AdaptiveStyleEngine.reset()` over the shared IPC channel `KIT_RESET_ADAPTIVE_STYLE` (`kit:resetAdaptiveStyle`).

**Feedback ingress:** Thumbs-down assistant feedback reaches the adaptation pipeline over the shared IPC channel `KIT_SUBMIT_MESSAGE_FEEDBACK` (`kit:submitMessageFeedback`), so structured message feedback and style-reset behavior use the same typed channel registry.

---

### Channel Persona

**Setting:** `channelPersonaEnabled` (default: `false`)

When enabled, `ChannelPersonaAdapter` appends a channel-specific communication directive to the system prompt — without replacing the core personality. The directive adjusts response length, formatting, emoji use, and formality norms for the originating channel.

**Supported channels:**

| Channel    | Length  | Formatting | Emoji | Formal |
| ---------- | ------- | ---------- | ----- | ------ |
| `slack`    | Shorter | Structured | No    | No     |
| `email`    | Longer  | Structured | No    | Yes    |
| `whatsapp` | Shorter | Plain      | Yes   | No     |
| `imessage` | Shorter | Plain      | Yes   | No     |
| `discord`  | Normal  | Markdown   | Yes   | No     |
| `teams`    | Normal  | Structured | No    | No     |
| `telegram` | Shorter | Minimal    | No    | No     |
| `signal`   | Shorter | Plain      | No    | No     |

**Group/public overlay:** When the task's `gatewayContext` is `"group"` or `"public"`, an additional privacy directive is added regardless of channel.

---

## Relationship to Guardrails

These controls sit in Guardrail Settings because they govern agent behavior, but they are separate from safety guardrails (token budget, dangerous command blocking, etc.). A future refactor may move them to a dedicated "Behavior" settings tab.

---

## Integration points

| Component                                       | Role                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------ |
| `src/electron/memory/AdaptiveStyleEngine.ts`    | Observation, drift, state                                                |
| `src/electron/memory/ChannelPersonaAdapter.ts`  | Channel directive generation                                             |
| `src/electron/agent/executor.ts`                | Injects channel directive into system prompt                             |
| `src/electron/agent/daemon.ts`                  | Calls `observe()` and `observeFeedback()`                                |
| `src/renderer/components/GuardrailSettings.tsx` | Settings UI (Behavior Adaptation section)                                |
| `src/electron/ipc/handlers.ts`                  | `kit:resetAdaptiveStyle` and `kit:submitMessageFeedback` handlers        |
| `src/shared/types.ts`                           | Shared IPC channel constants for behavior-adaptation and feedback wiring |
