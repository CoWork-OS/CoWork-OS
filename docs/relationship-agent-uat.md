# Relationship-Agent UAT Checklist

Use this checklist to validate that CoWork OS behaves as a personal relationship agent, not only a task executor.

## Preconditions

1. App is running with a configured LLM provider.
2. Workspace is selected.
3. Build health already passes:
   - `npm run type-check`
   - `npm run build`

## Test 1: Strategy Prompt (Answer First)

### Input
`I built you, how should I position you, who should I target, and what should I aim to achieve?`

### Expected
1. A direct answer appears early.
2. The agent may continue deeper execution, but should not withhold the main answer.
3. Task final state is `completed`.

## Test 2: Mixed Mode (Talk + Act)

### Input
`Give me a quick positioning recommendation first, then produce a deeper GTM strategy document.`

### Expected
1. Initial concise recommendation.
2. Follow-on execution for deeper artifact.
3. Final user-facing completion response.

## Test 3: Timeout Recovery (No Silent End)

### Setup
Use a prompt likely to create a long synthesis step.

### Expected
1. If timeout occurs, logs show recovery behavior.
2. Task still returns a best-effort final response.
3. Task should not terminate without user-facing output.

### Diagnostic Logs
- Good signal:
  - `Task cancelled - not logging as error (reason: timeout)` with recovery/finalization events.
- Bad signal:
  - cancellation log without any final user response.

## Test 4: Relationship Memory Capture

### Input
`Call me Mesut. I prefer concise responses. Remind me to send investor update tomorrow.`

### Expected
1. Relationship memory includes identity and preference items.
2. Commitment item exists and is `open`.
3. Due-soon reminder is returned within the configured window.

## Test 5: Relationship Memory Controls

### Actions (Settings > Memory System)
1. Edit a relationship item.
2. Mark a commitment done.
3. Reopen the same commitment.
4. Forget one item.

### Expected
1. UI updates immediately.
2. Changes persist across restart.
3. Due-soon list reflects status changes.

## Test 6: Shared Context Safety

### Setup
Run equivalent prompts from private and shared channel contexts (if configured).

### Expected
1. Private context can use relationship memory normally.
2. Shared context follows memory isolation policy unless explicitly trusted (`allowSharedContextMemory`).

## Pass Criteria

Release is accepted when all tests above pass with no silent task termination and no regression in completion behavior.

