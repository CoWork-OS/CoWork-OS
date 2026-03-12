# Step 2: Grep Results - Mutation-Required Code Patterns

## Search Results Summary

### Pattern: "mutation-required"
- **Total matches**: 15 across agent subsystem
- **Files found in**: daemon.ts, executor.ts, and multiple test files

### Key Code Locations

#### 1. daemon.ts (Line 5200)
```typescript
`Completion blocked: unresolved mutation-required step(s): ${blockingFailedSteps.join(", ")}`
```
**Context**: This is the exact error message from the training evidence. The daemon checks for "mutation contract blockers" and blocks task completion when mutation-required steps have unresolved failures.

#### 2. executor.ts (Line 5260)
```typescript
/contract_unmet_write_required|artifact_write_checkpoint_failed|required artifact mutation|mutation-required contract unmet/i.test(
```
**Context**: Regex pattern matching for various contract failure modes related to writes.

#### 3. executor.ts (Line 8428)
```typescript
`Auto-promoted execution mode from "${from}" to "execute" for mutation-required step `
```
**Context**: Auto-promotes from "propose" to "execute" mode when a step requires mutations.

#### 4. executor.ts (Line 16795-16799)
```typescript
"Execution failed: one or more mutation-required steps failed unrecovered and cannot be auto-waived."
`Task failed: mutation-required contract unmet - ${failedMutationDescriptions}`
```
**Context**: Final error throwing when mutation-required contract is not met.

### Pattern: "write required"
- **Total matches**: 0

### Test Coverage Found
- `daemon-complete-task.test.ts` - Tests blocking completion when mutation-required failures exist
- `executor-completion-contract.test.ts` - Tests mutation-required contract behavior
- `executor-step-failures.test.ts` - Tests retry logic for mutation-required steps
- `executor-waive-failed-steps.test.ts` - Tests that mutation-required cannot be waived
- `executor-workspace-preflight-ack.test.ts` - Tests inference of mutation-required contracts

## Root Cause Hypothesis

The error "Completion blocked: unresolved mutation-required step(s): 1" originates from daemon.ts around line 5200. The system checks for "mutation contract blockers" - steps that require file writes but failed to complete those writes.

When a task step:
1. Is marked as mutation-required (requires write operations)
2. Fails to complete the write operation
3. Has an unresolved failure status

The daemon blocks task completion with this specific error message.

## Next Steps for Fix

1. Identify why mutation-required steps are failing to complete their writes
2. Check the step contract validation logic in step-contract.ts
3. Examine the preflight acknowledgment logic that determines mutation requirements
