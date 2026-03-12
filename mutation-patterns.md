# Mutation-Required Code Patterns Analysis

## Summary

The grep search found **17 matches** for 'mutation-required' or 'write required' patterns across 10 files in the workspace.

## Key Findings

### 1. Completion Blocking Logic (daemon.ts ~line 5200)
```typescript
// Completion blocked message
const message = hasMutationContractBlockers
  ? `Completion blocked: unresolved mutation-required step(s): ${blockingFailedSteps.join(", ")}`
  : `Completion blocked: unresolved failed step(s): ${blockingFailedSteps.join(", ")}`;
```
- **Logic**: If any failed step has `mutation_required` contract mode, task fails with "contract_unmet_write_required" failure class
- **Key condition**: `hasMutationContractBlockers` determines if task is marked as failed vs partial_success

### 2. Failure Classification (executor.ts ~line 5260)
```typescript
private classifyFailure(error: unknown): NonNullable<Task["failureClass"]> {
  // ...
  if (/contract_unmet_write_required|artifact_write_checkpoint_failed|required artifact mutation|mutation-required contract unmet/i.test(message))
    return "contract_unmet_write_required";
}
```
- **Regex patterns**: Matches various error message patterns to classify as contract_unmet_write_required

### 3. Step Contract Resolution (executor.ts ~line 5632)
```typescript
const stepContract = this.resolveStepExecutionContract(step);
if (stepContract.mode !== "mutation_required") {
  // skips recovery for non-mutation steps
  return false;
}
```
- **Recovery logic**: Only mutation_required steps get automatic recovery attempts
- **Contract check**: Uses `resolveStepExecutionContract()` to determine step mode

### 4. Auto-Promotion to Execute Mode (executor.ts ~line 8428)
- Steps marked as mutation_required are automatically promoted from propose to execute mode

## Files Involved

### Test Files (6 files)
- `daemon-complete-task.test.ts` - Line 326
- `executor-completion-contract.test.ts` - Lines 650, 674
- `executor-step-failures.test.ts` - Lines 401, 1392
- `executor-waive-failed-steps.test.ts` - Line 161
- `executor-workspace-preflight-ack.test.ts` - Lines 487, 502, 519, 552

### Production Code (4 files)
- `daemon.ts` - Line 5200: Completion blocking
- `executor.ts` - Lines 5260, 5632, 8428: Classification and recovery
- `ImprovementCandidateService.ts` - Lines 486, 574: Pattern matching

## Root Cause Hypothesis

Based on the failure pattern "Completion blocked: unresolved mutation-required step(s): 1", the issue appears to be:

1. A step is being marked with `mutation_required` contract mode
2. The step fails to produce the required artifact/write
3. The completion gate in daemon.ts checks for unresolved mutation_required failures
4. Since the step is not resolved, task fails with "contract_unmet_write_required"

## Next Investigation Steps
1. Find `resolveStepExecutionContract()` to understand how mutation_required is determined
2. Check what triggers this mode assignment
3. Identify why steps are not completing with required artifacts
