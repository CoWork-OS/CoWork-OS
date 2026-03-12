# Mutation-Required Pattern Analysis

## Error Source
The error "Completion blocked: unresolved mutation-required step(s): 1" originates from:
- **File**: `src/electron/agent/daemon.ts`
- **Function**: `completeTask()`
- **Location**: Line ~5200

## Contract System
- `mutation_required` is a step contract mode in `step-contract.ts`
- Required tools for mutation_required: `write_file`, `canvas_push`
- Defined in `agent-policy.ts`

## Key Locations
1. **daemon.ts (line 5200)**: Handles task completion and checks for unresolved mutation-required failures
2. **executor.ts**: Executes steps and enforces contract mode requirements
3. **step-contract.ts**: Defines contract modes including `mutation_required`
4. **agent-policy.ts**: Parses policy and defines tool families

## Root Cause
The executor reports `failedMutationRequiredStepIds` to the daemon when mutation-required steps fail. In `completeTask()`:
- Line 4868-4874: Creates `failedMutationRequiredStepIds` set from metadata
- Line 5038: Gets mutation contract blockers
- Line 5180: Checks if blocking failed steps are mutation contract blockers
- Line 5200: If mutation blockers exist, blocks completion with the error

## Missing Method Issue
This workspace's `executor.ts` appears to be missing the `getFailedMutationRequiredStepIdsAtCompletion()` method that exists in other worktrees. This method is called in other versions to properly track which mutation-required steps failed, allowing the daemon to determine if they should block completion.

## Related Test Files
- `executor-step-failures.test.ts` - Tests mutation-required step behavior
- `daemon-complete-task.test.ts` - Tests completion blocking logic
- `executor-workspace-preflight-ack.test.ts` - Tests preflight contract resolution
