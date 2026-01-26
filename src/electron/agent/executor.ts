import { Task, Workspace, Plan, PlanStep, TaskEvent, SuccessCriteria } from '../../shared/types';
import * as fs from 'fs';
import * as path from 'path';
import { AgentDaemon } from './daemon';
import { ToolRegistry } from './tools/registry';
import { SandboxRunner } from './sandbox/runner';
import {
  LLMProvider,
  LLMProviderFactory,
  LLMMessage,
  LLMToolResult,
} from './llm';
import {
  ContextManager,
  truncateToolResult,
  estimateTokens,
} from './context-manager';
import { GuardrailManager } from '../guardrails/guardrail-manager';
import { calculateCost, formatCost } from './llm/pricing';

// Timeout for LLM API calls (2 minutes)
const LLM_TIMEOUT_MS = 2 * 60 * 1000;

// Maximum consecutive failures for the same tool before giving up
const MAX_TOOL_FAILURES = 2;

// Patterns that indicate non-retryable errors (quota, rate limits, etc.)
// These errors should immediately disable the tool
const NON_RETRYABLE_ERROR_PATTERNS = [
  /quota.*exceeded/i,
  /rate.*limit/i,
  /exceeded.*quota/i,
  /too many requests/i,
  /429/i,
  /resource.*exhausted/i,
  /billing/i,
  /payment.*required/i,
];

// Patterns that indicate input-dependent errors (not tool failures)
// These are normal operational errors that should NOT count towards circuit breaker
const INPUT_DEPENDENT_ERROR_PATTERNS = [
  /ENOENT/i,           // File/directory not found
  /ENOTDIR/i,          // Not a directory
  /EISDIR/i,           // Is a directory (when expecting file)
  /no such file/i,     // File not found
  /not found/i,        // Generic not found
  /does not exist/i,   // Resource doesn't exist
  /invalid path/i,     // Invalid path provided
  /path.*invalid/i,    // Path is invalid
  /cannot find/i,      // Cannot find resource
  /permission denied/i, // Permission on specific file (not API permission)
  /EACCES/i,           // Access denied to specific file
];

/**
 * Check if an error is non-retryable (quota/rate limit related)
 * These errors indicate a systemic problem with the tool/API
 */
function isNonRetryableError(errorMessage: string): boolean {
  return NON_RETRYABLE_ERROR_PATTERNS.some(pattern => pattern.test(errorMessage));
}

/**
 * Check if an error is input-dependent (normal operational error)
 * These errors are due to bad input, not tool failure, and should not trigger circuit breaker
 */
function isInputDependentError(errorMessage: string): boolean {
  return INPUT_DEPENDENT_ERROR_PATTERNS.some(pattern => pattern.test(errorMessage));
}

/**
 * Check if the assistant's response is asking a question and waiting for user input
 */
function isAskingQuestion(text: string): boolean {
  const questionPatterns = [
    /would you like me to/i,
    /would you prefer/i,
    /should I/i,
    /do you want me to/i,
    /please (let me know|confirm|specify|choose)/i,
    /which (option|approach|method)/i,
    /options.*:/i,
    /\?\s*$/,  // Ends with question mark
  ];

  // Check if text contains question patterns AND doesn't also contain tool calls
  const hasQuestion = questionPatterns.some(pattern => pattern.test(text));
  const isShort = text.length < 1000; // Questions are usually concise

  return hasQuestion && isShort;
}

/**
 * Tracks tool failures to implement circuit breaker pattern
 */
class ToolFailureTracker {
  private failures: Map<string, { count: number; lastError: string }> = new Map();
  private disabledTools: Set<string> = new Set();

  /**
   * Record a tool failure
   * @returns true if the tool should be disabled (circuit broken)
   */
  recordFailure(toolName: string, errorMessage: string): boolean {
    // Input-dependent errors (file not found, etc.) should NOT count towards circuit breaker
    // These are normal operational errors, not tool failures
    if (isInputDependentError(errorMessage)) {
      console.log(`[ToolFailureTracker] Ignoring input-dependent error for ${toolName}: ${errorMessage.substring(0, 80)}`);
      return false;
    }

    // If it's a non-retryable error (quota, rate limit), disable immediately
    if (isNonRetryableError(errorMessage)) {
      this.disabledTools.add(toolName);
      console.log(`[ToolFailureTracker] Tool ${toolName} disabled due to non-retryable error: ${errorMessage.substring(0, 100)}`);
      return true;
    }

    // Track other failures (systemic issues)
    const existing = this.failures.get(toolName) || { count: 0, lastError: '' };
    existing.count++;
    existing.lastError = errorMessage;
    this.failures.set(toolName, existing);

    // If we've hit max failures for systemic issues, disable the tool
    if (existing.count >= MAX_TOOL_FAILURES) {
      this.disabledTools.add(toolName);
      console.log(`[ToolFailureTracker] Tool ${toolName} disabled after ${existing.count} consecutive systemic failures`);
      return true;
    }

    return false;
  }

  /**
   * Record a successful tool call (resets failure count)
   */
  recordSuccess(toolName: string): void {
    this.failures.delete(toolName);
  }

  /**
   * Check if a tool is disabled
   */
  isDisabled(toolName: string): boolean {
    return this.disabledTools.has(toolName);
  }

  /**
   * Get the last error for a tool
   */
  getLastError(toolName: string): string | undefined {
    return this.failures.get(toolName)?.lastError;
  }

  /**
   * Get list of disabled tools
   */
  getDisabledTools(): string[] {
    return Array.from(this.disabledTools);
  }
}

/**
 * Wrap a promise with a timeout
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${operation} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

/**
 * TaskExecutor handles the execution of a single task
 * It implements the plan-execute-observe agent loop
 * Supports both Anthropic API and AWS Bedrock
 */
export class TaskExecutor {
  private provider: LLMProvider;
  private toolRegistry: ToolRegistry;
  private sandboxRunner: SandboxRunner;
  private contextManager: ContextManager;
  private toolFailureTracker: ToolFailureTracker;
  private cancelled = false;
  private paused = false;
  private plan?: Plan;
  private modelId: string;
  private modelKey: string;
  private conversationHistory: LLMMessage[] = [];
  private systemPrompt: string = '';

  // Guardrail tracking
  private totalInputTokens: number = 0;
  private totalOutputTokens: number = 0;
  private totalCost: number = 0;
  private iterationCount: number = 0;

  constructor(
    private task: Task,
    private workspace: Workspace,
    private daemon: AgentDaemon
  ) {
    // Initialize LLM provider using factory (respects user settings)
    this.provider = LLMProviderFactory.createProvider();

    // Get the model ID from settings
    const settings = LLMProviderFactory.loadSettings();
    this.modelId = LLMProviderFactory.getModelId(
      settings.modelKey,
      settings.providerType,
      settings.ollama?.model,
      settings.gemini?.model,
      settings.openrouter?.model
    );
    this.modelKey = settings.modelKey;

    // Initialize context manager for handling long conversations
    this.contextManager = new ContextManager(settings.modelKey);

    // Initialize tool registry
    this.toolRegistry = new ToolRegistry(workspace, daemon, task.id);

    // Set up plan revision handler
    this.toolRegistry.setPlanRevisionHandler((newSteps, reason) => {
      this.handlePlanRevision(newSteps, reason);
    });

    // Initialize sandbox runner
    this.sandboxRunner = new SandboxRunner(workspace);

    // Initialize tool failure tracker for circuit breaker pattern
    this.toolFailureTracker = new ToolFailureTracker();

    console.log(`TaskExecutor initialized with ${settings.providerType} provider, model: ${this.modelId}`);
  }

  /**
   * Check guardrail budgets before making an LLM call
   * @throws Error if any budget is exceeded
   */
  private checkBudgets(): void {
    // Check iteration limit
    const iterationCheck = GuardrailManager.isIterationLimitExceeded(this.iterationCount);
    if (iterationCheck.exceeded) {
      throw new Error(
        `Iteration limit exceeded: ${iterationCheck.iterations}/${iterationCheck.limit} iterations. ` +
        `Task stopped to prevent runaway execution.`
      );
    }

    // Check token budget
    const totalTokens = this.totalInputTokens + this.totalOutputTokens;
    const tokenCheck = GuardrailManager.isTokenBudgetExceeded(totalTokens);
    if (tokenCheck.exceeded) {
      throw new Error(
        `Token budget exceeded: ${tokenCheck.used.toLocaleString()}/${tokenCheck.limit.toLocaleString()} tokens. ` +
        `Estimated cost: ${formatCost(this.totalCost)}`
      );
    }

    // Check cost budget
    const costCheck = GuardrailManager.isCostBudgetExceeded(this.totalCost);
    if (costCheck.exceeded) {
      throw new Error(
        `Cost budget exceeded: ${formatCost(costCheck.cost)}/${formatCost(costCheck.limit)}. ` +
        `Total tokens used: ${totalTokens.toLocaleString()}`
      );
    }
  }

  /**
   * Update tracking after an LLM response
   */
  private updateTracking(inputTokens: number, outputTokens: number): void {
    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;
    this.totalCost += calculateCost(this.modelId, inputTokens, outputTokens);
    this.iterationCount++;
  }

  /**
   * Get available tools, filtering out disabled ones
   * This prevents the LLM from trying to use tools that have been disabled by the circuit breaker
   */
  private getAvailableTools() {
    const allTools = this.toolRegistry.getTools();
    const disabledTools = this.toolFailureTracker.getDisabledTools();

    if (disabledTools.length === 0) {
      return allTools;
    }

    const filtered = allTools.filter(tool => !disabledTools.includes(tool.name));
    console.log(`[TaskExecutor] Filtered out ${disabledTools.length} disabled tools: ${disabledTools.join(', ')}`);
    return filtered;
  }

  /**
   * Rebuild conversation history from saved events
   * This is used when recreating an executor for follow-up messages
   */
  rebuildConversationFromEvents(events: TaskEvent[]): void {
    // Build a summary of the previous conversation
    const conversationParts: string[] = [];

    // Add the original task as context
    conversationParts.push(`Original task: ${this.task.title}`);
    conversationParts.push(`Task details: ${this.task.prompt}`);
    conversationParts.push('');
    conversationParts.push('Previous conversation summary:');

    for (const event of events) {
      switch (event.type) {
        case 'log':
          if (event.payload?.message) {
            // User messages are logged as "User: message"
            if (event.payload.message.startsWith('User: ')) {
              conversationParts.push(`User: ${event.payload.message.slice(6)}`);
            } else {
              conversationParts.push(`System: ${event.payload.message}`);
            }
          }
          break;
        case 'assistant_message':
          if (event.payload?.message) {
            // Truncate long messages in summary
            const msg = event.payload.message.length > 500
              ? event.payload.message.slice(0, 500) + '...'
              : event.payload.message;
            conversationParts.push(`Assistant: ${msg}`);
          }
          break;
        case 'tool_call':
          if (event.payload?.tool) {
            conversationParts.push(`[Used tool: ${event.payload.tool}]`);
          }
          break;
        case 'plan_created':
          if (event.payload?.plan?.description) {
            conversationParts.push(`[Created plan: ${event.payload.plan.description}]`);
          }
          break;
        case 'error':
          if (event.payload?.message || event.payload?.error) {
            conversationParts.push(`[Error: ${event.payload.message || event.payload.error}]`);
          }
          break;
      }
    }

    // Only rebuild if there's meaningful history
    if (conversationParts.length > 4) { // More than just the task header
      this.conversationHistory = [
        {
          role: 'user',
          content: conversationParts.join('\n'),
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'I understand the context from our previous conversation. How can I help you now?' }],
        },
      ];
      console.log('Rebuilt conversation history from', events.length, 'events');
    }

    // Set system prompt
    this.systemPrompt = `You are an AI assistant helping with tasks. Use the available tools to complete the work.
Workspace: ${this.workspace.path}
Always ask for approval before deleting files or making destructive changes.
Be concise in your responses. When reading files, only read what you need.

You are continuing a previous conversation. The context from the previous conversation has been provided.`;
  }

  /**
   * Update the workspace and recreate tool registry with new permissions
   * This is used when permissions change during an active task
   */
  updateWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
    // Recreate tool registry to pick up new permissions (e.g., shell enabled)
    this.toolRegistry = new ToolRegistry(workspace, this.daemon, this.task.id);
    console.log(`Workspace updated for task ${this.task.id}, permissions:`, workspace.permissions);
  }

  /**
   * Verify success criteria for Goal Mode
   * @returns Object with success status and message
   */
  private async verifySuccessCriteria(): Promise<{ success: boolean; message: string }> {
    const criteria = this.task.successCriteria;
    if (!criteria) {
      return { success: true, message: 'No criteria defined' };
    }

    this.daemon.logEvent(this.task.id, 'verification_started', { criteria });

    if (criteria.type === 'shell_command' && criteria.command) {
      try {
        // Execute verification command via tool registry
        const result = await this.toolRegistry.executeTool('run_command', {
          command: criteria.command,
        }) as { success: boolean; exitCode: number | null; stdout: string; stderr: string };

        return {
          success: result.exitCode === 0,
          message: result.exitCode === 0
            ? 'Verification command passed'
            : `Verification failed (exit code ${result.exitCode}): ${result.stderr || result.stdout || 'Command failed'}`,
        };
      } catch (error: any) {
        return {
          success: false,
          message: `Verification command error: ${error.message}`,
        };
      }
    }

    if (criteria.type === 'file_exists' && criteria.filePaths) {
      const missing = criteria.filePaths.filter(p => {
        const fullPath = path.resolve(this.workspace.path, p);
        return !fs.existsSync(fullPath);
      });
      return {
        success: missing.length === 0,
        message: missing.length === 0
          ? 'All required files exist'
          : `Missing files: ${missing.join(', ')}`,
      };
    }

    return { success: true, message: 'Unknown criteria type' };
  }

  /**
   * Reset state for retry attempt in Goal Mode
   */
  private resetForRetry(): void {
    // Reset plan steps to pending
    if (this.plan) {
      for (const step of this.plan.steps) {
        step.status = 'pending';
        step.startedAt = undefined;
        step.completedAt = undefined;
        step.error = undefined;
      }
    }

    // Reset tool failure tracker (tools might work on retry)
    this.toolFailureTracker = new ToolFailureTracker();

    // Add context for LLM about retry
    this.conversationHistory.push({
      role: 'user',
      content: `The previous attempt did not meet the success criteria. Please try a different approach. This is attempt ${this.task.currentAttempt}.`,
    });
  }

  /**
   * Handle plan revision request from the LLM
   * Adds new steps to the plan after the current step
   */
  private handlePlanRevision(newSteps: Array<{ description: string }>, reason: string): void {
    if (!this.plan) {
      console.warn('[TaskExecutor] Cannot revise plan - no plan exists');
      return;
    }

    // Create new PlanStep objects for each new step
    const newPlanSteps: PlanStep[] = newSteps.map((step, index) => ({
      id: `revised-${Date.now()}-${index}`,
      description: step.description,
      status: 'pending' as const,
    }));

    // Find the current step (in_progress) and insert new steps after it
    const currentStepIndex = this.plan.steps.findIndex(s => s.status === 'in_progress');
    if (currentStepIndex === -1) {
      // No step in progress, append to end
      this.plan.steps.push(...newPlanSteps);
    } else {
      // Insert after current step
      this.plan.steps.splice(currentStepIndex + 1, 0, ...newPlanSteps);
    }

    // Log the plan revision
    this.daemon.logEvent(this.task.id, 'plan_revised', {
      reason,
      newStepsCount: newSteps.length,
      newSteps: newSteps.map(s => s.description),
      totalSteps: this.plan.steps.length,
    });

    console.log(`[TaskExecutor] Plan revised: added ${newSteps.length} steps. Reason: ${reason}`);
  }

  /**
   * Main execution loop
   */
  async execute(): Promise<void> {
    try {
      // Phase 1: Planning
      this.daemon.updateTaskStatus(this.task.id, 'planning');
      await this.createPlan();

      if (this.cancelled) return;

      // Phase 2: Execution with Goal Mode retry loop
      const maxAttempts = this.task.maxAttempts || 1;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (this.cancelled) break;

        // Update attempt tracking
        this.task.currentAttempt = attempt;
        this.daemon.updateTask(this.task.id, { currentAttempt: attempt });

        if (attempt > 1) {
          this.daemon.logEvent(this.task.id, 'retry_started', { attempt, maxAttempts });
          this.resetForRetry();
        }

        // Execute plan
        this.daemon.updateTaskStatus(this.task.id, 'executing');
        this.daemon.logEvent(this.task.id, 'executing', {
          message: maxAttempts > 1 ? `Executing plan (attempt ${attempt}/${maxAttempts})` : 'Executing plan',
        });
        await this.executePlan();

        if (this.cancelled) break;

        // Verify success criteria if defined (Goal Mode)
        if (this.task.successCriteria) {
          const result = await this.verifySuccessCriteria();

          if (result.success) {
            this.daemon.logEvent(this.task.id, 'verification_passed', {
              attempt,
              message: result.message,
            });
            break; // Success - exit retry loop
          } else {
            this.daemon.logEvent(this.task.id, 'verification_failed', {
              attempt,
              maxAttempts,
              message: result.message,
              willRetry: attempt < maxAttempts,
            });

            if (attempt === maxAttempts) {
              throw new Error(`Failed to meet success criteria after ${maxAttempts} attempts: ${result.message}`);
            }
          }
        }
      }

      if (this.cancelled) return;

      // Phase 3: Completion
      this.daemon.completeTask(this.task.id);
    } catch (error: any) {
      console.error(`Task execution failed:`, error);
      this.daemon.updateTaskStatus(this.task.id, 'failed');
      this.daemon.logEvent(this.task.id, 'error', {
        message: error.message,
        stack: error.stack,
      });
    } finally {
      // Cleanup resources (e.g., close browser)
      await this.toolRegistry.cleanup().catch(e => {
        console.error('Cleanup error:', e);
      });
    }
  }

  /**
   * Create execution plan using LLM
   */
  private async createPlan(): Promise<void> {
    console.log(`[Task ${this.task.id}] Creating plan with model: ${this.modelId}`);
    this.daemon.logEvent(this.task.id, 'log', { message: `Creating execution plan (model: ${this.modelId})...` });

    const systemPrompt = `You are an autonomous task executor. Your job is to:
1. Analyze the user's request
2. Create a detailed, step-by-step plan
3. Execute each step using the available tools
4. Produce high-quality outputs

You have access to a workspace folder at: ${this.workspace.path}
Workspace permissions: ${JSON.stringify(this.workspace.permissions)}

Available tools:
${this.toolRegistry.getToolDescriptions()}

Create a clear, actionable plan with 3-7 steps. Each step should be specific and measurable.
Format your plan as a JSON object with this structure:
{
  "description": "Overall plan description",
  "steps": [
    {"id": "1", "description": "Step description", "status": "pending"}
  ]
}`;

    let response;
    try {
      // Check budgets before LLM call
      this.checkBudgets();

      const startTime = Date.now();
      console.log(`[Task ${this.task.id}] Calling LLM API for plan creation...`);

      response = await withTimeout(
        this.provider.createMessage({
          model: this.modelId,
          maxTokens: 4096,
          system: systemPrompt,
          messages: [
            {
              role: 'user',
              content: `Task: ${this.task.title}\n\nDetails: ${this.task.prompt}\n\nCreate an execution plan.`,
            },
          ],
        }),
        LLM_TIMEOUT_MS,
        'Plan creation'
      );

      // Update tracking after response
      if (response.usage) {
        this.updateTracking(response.usage.inputTokens, response.usage.outputTokens);
      }

      console.log(`[Task ${this.task.id}] LLM response received in ${Date.now() - startTime}ms`);
    } catch (llmError: any) {
      console.error(`[Task ${this.task.id}] LLM API call failed:`, llmError);
      this.daemon.logEvent(this.task.id, 'error', {
        message: `LLM API error: ${llmError.message}`,
        details: llmError.status ? `Status: ${llmError.status}` : undefined,
      });
      throw llmError;
    }

    // Extract plan from response
    const textContent = response.content.find(c => c.type === 'text');
    if (textContent && textContent.type === 'text') {
      try {
        // Try to extract and parse JSON from the response
        const json = this.extractJsonObject(textContent.text);
        // Validate that the JSON has a valid steps array
        if (json && Array.isArray(json.steps) && json.steps.length > 0) {
          // Ensure each step has required fields
          this.plan = {
            description: json.description || 'Execution plan',
            steps: json.steps.map((s: any, i: number) => ({
              id: s.id || String(i + 1),
              description: s.description || s.step || s.task || String(s),
              status: 'pending' as const,
            })),
          };
          this.daemon.logEvent(this.task.id, 'plan_created', { plan: this.plan });
        } else {
          // Fallback: create simple plan from text
          this.plan = {
            description: 'Execution plan',
            steps: [
              {
                id: '1',
                description: textContent.text.slice(0, 500),
                status: 'pending',
              },
            ],
          };
          this.daemon.logEvent(this.task.id, 'plan_created', { plan: this.plan });
        }
      } catch (error) {
        console.error('Failed to parse plan:', error);
        // Use fallback plan instead of throwing
        this.plan = {
          description: 'Execute task',
          steps: [
            {
              id: '1',
              description: this.task.prompt,
              status: 'pending',
            },
          ],
        };
        this.daemon.logEvent(this.task.id, 'plan_created', { plan: this.plan });
      }
    }
  }

  /**
   * Extract first valid JSON object from text
   */
  private extractJsonObject(text: string): any {
    // Find the first { and try to find matching }
    const startIndex = text.indexOf('{');
    if (startIndex === -1) return null;

    let braceCount = 0;
    let inString = false;
    let escaped = false;

    for (let i = startIndex; i < text.length; i++) {
      const char = text[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\' && inString) {
        escaped = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === '{') braceCount++;
        if (char === '}') braceCount--;

        if (braceCount === 0) {
          const jsonStr = text.slice(startIndex, i + 1);
          try {
            return JSON.parse(jsonStr);
          } catch {
            return null;
          }
        }
      }
    }

    return null;
  }

  /**
   * Execute the plan step by step
   */
  private async executePlan(): Promise<void> {
    if (!this.plan) {
      throw new Error('No plan available');
    }

    for (const step of this.plan.steps) {
      if (this.cancelled) break;

      // Wait if paused
      while (this.paused && !this.cancelled) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      await this.executeStep(step);
    }
  }

  /**
   * Execute a single plan step
   */
  private async executeStep(step: PlanStep): Promise<void> {
    this.daemon.logEvent(this.task.id, 'step_started', { step });

    step.status = 'in_progress';
    step.startedAt = Date.now();

    // Define system prompt once so we can track its token usage
    this.systemPrompt = `You are an autonomous task executor. Use the available tools to complete each step.
Workspace: ${this.workspace.path}

IMPORTANT INSTRUCTIONS:
- Always use tools to accomplish tasks. Do not just describe what you would do - actually call the tools.
- The delete_file tool has a built-in approval mechanism that will prompt the user. Just call the tool directly.
- Do NOT ask "Should I proceed?" or wait for permission in text - the tools handle approvals automatically.
- Be concise. When reading files, only read what you need.
- After completing the work, provide a brief summary of what was done.

ADAPTIVE PLANNING:
- If you discover the current plan is insufficient, encounter unexpected obstacles, or find a better approach, use the revise_plan tool to add new steps.
- Do not silently skip necessary work - if something new is needed, add it to the plan.
- The revise_plan tool lets you adapt without starting over.`;

    const systemPromptTokens = estimateTokens(this.systemPrompt);

    try {
      // Each step gets fresh context with its specific instruction
      // Build context from previous steps if any were completed
      const completedSteps = this.plan?.steps.filter(s => s.status === 'completed') || [];
      let stepContext = `Execute this step: ${step.description}\n\nTask context: ${this.task.prompt}`;

      if (completedSteps.length > 0) {
        stepContext += `\n\nPrevious steps already completed:\n${completedSteps.map(s => `- ${s.description}`).join('\n')}`;
        stepContext += `\n\nDo NOT repeat work from previous steps. Focus only on: ${step.description}`;
      }

      // Start fresh messages for this step
      let messages: LLMMessage[] = [
        {
          role: 'user',
          content: stepContext,
        },
      ];

      let continueLoop = true;
      let iterationCount = 0;
      let emptyResponseCount = 0;
      let stepFailed = false;  // Track if step failed due to all tools being disabled/erroring
      let lastFailureReason = '';  // Track the reason for failure
      const maxIterations = 10;
      const maxEmptyResponses = 3;

      while (continueLoop && iterationCount < maxIterations) {
        if (this.cancelled) break;

        iterationCount++;

        // Check for too many empty responses
        if (emptyResponseCount >= maxEmptyResponses) {
          break;
        }

        // Check guardrail budgets before each LLM call
        this.checkBudgets();

        // Compact messages if context is getting too large
        messages = this.contextManager.compactMessages(messages, systemPromptTokens);

        const response = await withTimeout(
          this.provider.createMessage({
            model: this.modelId,
            maxTokens: 4096,
            system: this.systemPrompt,
            tools: this.getAvailableTools(),
            messages,
          }),
          LLM_TIMEOUT_MS,
          'LLM execution step'
        );

        // Update tracking after response
        if (response.usage) {
          this.updateTracking(response.usage.inputTokens, response.usage.outputTokens);
        }

        // Process response - only stop if we have actual content AND it's end_turn
        // Empty responses should not terminate the loop
        if (response.stopReason === 'end_turn' && response.content && response.content.length > 0) {
          continueLoop = false;
        }

        // Log any text responses from the assistant and check if asking a question
        let assistantAskedQuestion = false;
        if (response.content) {
          for (const content of response.content) {
            if (content.type === 'text' && content.text) {
              this.daemon.logEvent(this.task.id, 'assistant_message', {
                message: content.text,
              });

              // Check if the assistant is asking a question (waiting for user input)
              if (isAskingQuestion(content.text)) {
                assistantAskedQuestion = true;
              }
            }
          }
        }

        // Add assistant response to conversation (ensure content is not empty)
        if (response.content && response.content.length > 0) {
          messages.push({
            role: 'assistant',
            content: response.content,
          });
          // Reset empty response counter on valid response
          emptyResponseCount = 0;
        } else {
          // Bedrock API requires non-empty content, add placeholder and continue
          emptyResponseCount++;
          messages.push({
            role: 'assistant',
            content: [{ type: 'text', text: 'I understand. Let me continue.' }],
          });
        }

        // Handle tool calls
        const toolResults: LLMToolResult[] = [];
        let hasDisabledToolAttempt = false;

        for (const content of response.content || []) {
          if (content.type === 'tool_use') {
            // Check if this tool is disabled (circuit breaker tripped)
            if (this.toolFailureTracker.isDisabled(content.name)) {
              const lastError = this.toolFailureTracker.getLastError(content.name);
              console.log(`[TaskExecutor] Skipping disabled tool: ${content.name}`);
              this.daemon.logEvent(this.task.id, 'tool_error', {
                tool: content.name,
                error: `Tool disabled due to repeated failures: ${lastError}`,
                skipped: true,
              });
              toolResults.push({
                type: 'tool_result',
                tool_use_id: content.id,
                content: JSON.stringify({
                  error: `Tool "${content.name}" is temporarily unavailable due to: ${lastError}. Please try a different approach or wait and try again later.`,
                  disabled: true,
                }),
                is_error: true,
              });
              hasDisabledToolAttempt = true;
              continue;
            }

            this.daemon.logEvent(this.task.id, 'tool_call', {
              tool: content.name,
              input: content.input,
            });

            try {
              const result = await this.toolRegistry.executeTool(
                content.name,
                content.input as any
              );

              // Tool succeeded - reset failure counter
              this.toolFailureTracker.recordSuccess(content.name);

              // Check if the result indicates an error (some tools return error in result)
              const resultStr = JSON.stringify(result);
              if (result && result.success === false && result.error) {
                // Check if this is a non-retryable error
                const shouldDisable = this.toolFailureTracker.recordFailure(content.name, result.error);
                if (shouldDisable) {
                  this.daemon.logEvent(this.task.id, 'tool_error', {
                    tool: content.name,
                    error: result.error,
                    disabled: true,
                  });
                }
              }

              // Truncate large tool results to avoid context overflow
              const truncatedResult = truncateToolResult(resultStr);

              this.daemon.logEvent(this.task.id, 'tool_result', {
                tool: content.name,
                result: result,
              });

              toolResults.push({
                type: 'tool_result',
                tool_use_id: content.id,
                content: truncatedResult,
              });
            } catch (error: any) {
              console.error(`Tool execution failed:`, error);

              // Track the failure
              const shouldDisable = this.toolFailureTracker.recordFailure(content.name, error.message);

              this.daemon.logEvent(this.task.id, 'tool_error', {
                tool: content.name,
                error: error.message,
                disabled: shouldDisable,
              });

              toolResults.push({
                type: 'tool_result',
                tool_use_id: content.id,
                content: JSON.stringify({
                  error: error.message,
                  ...(shouldDisable ? { disabled: true, message: 'Tool has been disabled due to repeated failures.' } : {}),
                }),
                is_error: true,
              });
            }
          }
        }

        if (toolResults.length > 0) {
          messages.push({
            role: 'user',
            content: toolResults,
          });

          // If all tool attempts were for disabled tools, don't continue looping
          // This prevents infinite retry loops
          if (hasDisabledToolAttempt && toolResults.every(r => r.is_error)) {
            console.log('[TaskExecutor] All tool calls failed or were disabled, stopping iteration');
            stepFailed = true;
            lastFailureReason = 'All required tools are unavailable or failed. Unable to complete this step.';
            continueLoop = false;
          } else {
            continueLoop = true;
          }
        }

        // If assistant asked a question and there are no tool calls, stop and wait for user
        if (assistantAskedQuestion && toolResults.length === 0) {
          console.log('[TaskExecutor] Assistant asked a question, pausing for user input');
          continueLoop = false;
        }
      }

      // Step completed or failed

      // Save conversation history for follow-up messages
      this.conversationHistory = messages;

      // Mark step as failed if all tools failed/were disabled
      if (stepFailed) {
        step.status = 'failed';
        step.error = lastFailureReason;
        step.completedAt = Date.now();
        this.daemon.logEvent(this.task.id, 'step_failed', {
          step,
          reason: lastFailureReason,
        });
      } else {
        step.status = 'completed';
        step.completedAt = Date.now();
        this.daemon.logEvent(this.task.id, 'step_completed', { step });
      }
    } catch (error: any) {
      step.status = 'failed';
      step.error = error.message;
      step.completedAt = Date.now();
      this.daemon.logEvent(this.task.id, 'error', {
        step: step.id,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Send a follow-up message to continue the conversation
   */
  async sendMessage(message: string): Promise<void> {
    this.daemon.updateTaskStatus(this.task.id, 'executing');
    this.daemon.logEvent(this.task.id, 'executing', { message: 'Processing follow-up message' });
    this.daemon.logEvent(this.task.id, 'log', { message: `User: ${message}` });

    // Ensure system prompt is set
    if (!this.systemPrompt) {
      this.systemPrompt = `You are an autonomous task executor. Use the available tools to complete each step.
Workspace: ${this.workspace.path}

IMPORTANT INSTRUCTIONS:
- Always use tools to accomplish tasks. Do not just describe what you would do - actually call the tools.
- The delete_file tool has a built-in approval mechanism that will prompt the user. Just call the tool directly.
- Do NOT ask "Should I proceed?" or wait for permission in text - the tools handle approvals automatically.
- Be concise. When reading files, only read what you need.
- After completing the work, provide a brief summary of what was done.`;
    }

    const systemPromptTokens = estimateTokens(this.systemPrompt);

    // Add user message to conversation history
    this.conversationHistory.push({
      role: 'user',
      content: message,
    });

    let messages = this.conversationHistory;
    let continueLoop = true;
    let iterationCount = 0;
    let emptyResponseCount = 0;
    const maxIterations = 10;
    const maxEmptyResponses = 3;

    try {
      while (continueLoop && iterationCount < maxIterations) {
        if (this.cancelled) break;

        iterationCount++;

        // Check for too many empty responses
        if (emptyResponseCount >= maxEmptyResponses) {
          break;
        }

        // Check guardrail budgets before each LLM call
        this.checkBudgets();

        // Compact messages if context is getting too large
        messages = this.contextManager.compactMessages(messages, systemPromptTokens);

        const response = await withTimeout(
          this.provider.createMessage({
            model: this.modelId,
            maxTokens: 4096,
            system: this.systemPrompt,
            tools: this.getAvailableTools(),
            messages,
          }),
          LLM_TIMEOUT_MS,
          'LLM message processing'
        );

        // Update tracking after response
        if (response.usage) {
          this.updateTracking(response.usage.inputTokens, response.usage.outputTokens);
        }

        // Process response
        if (response.stopReason === 'end_turn') {
          continueLoop = false;
        }

        // Log any text responses from the assistant and check if asking a question
        let assistantAskedQuestion = false;
        if (response.content) {
          for (const content of response.content) {
            if (content.type === 'text' && content.text) {
              this.daemon.logEvent(this.task.id, 'assistant_message', {
                message: content.text,
              });

              // Check if the assistant is asking a question (waiting for user input)
              if (isAskingQuestion(content.text)) {
                assistantAskedQuestion = true;
              }
            }
          }
        }

        // Add assistant response to conversation (ensure content is not empty)
        if (response.content && response.content.length > 0) {
          messages.push({
            role: 'assistant',
            content: response.content,
          });
          // Reset empty response counter on valid response
          emptyResponseCount = 0;
        } else {
          // Bedrock API requires non-empty content, add placeholder
          emptyResponseCount++;
          messages.push({
            role: 'assistant',
            content: [{ type: 'text', text: 'I understand. Let me continue.' }],
          });
        }

        // Handle tool calls
        const toolResults: LLMToolResult[] = [];
        let hasDisabledToolAttempt = false;

        for (const content of response.content || []) {
          if (content.type === 'tool_use') {
            // Check if this tool is disabled (circuit breaker tripped)
            if (this.toolFailureTracker.isDisabled(content.name)) {
              const lastError = this.toolFailureTracker.getLastError(content.name);
              console.log(`[TaskExecutor] Skipping disabled tool: ${content.name}`);
              this.daemon.logEvent(this.task.id, 'tool_error', {
                tool: content.name,
                error: `Tool disabled due to repeated failures: ${lastError}`,
                skipped: true,
              });
              toolResults.push({
                type: 'tool_result',
                tool_use_id: content.id,
                content: JSON.stringify({
                  error: `Tool "${content.name}" is temporarily unavailable due to: ${lastError}. Please try a different approach or wait and try again later.`,
                  disabled: true,
                }),
                is_error: true,
              });
              hasDisabledToolAttempt = true;
              continue;
            }

            this.daemon.logEvent(this.task.id, 'tool_call', {
              tool: content.name,
              input: content.input,
            });

            try {
              const result = await this.toolRegistry.executeTool(
                content.name,
                content.input as any
              );

              // Tool succeeded - reset failure counter
              this.toolFailureTracker.recordSuccess(content.name);

              // Check if the result indicates an error (some tools return error in result)
              const resultStr = JSON.stringify(result);
              if (result && result.success === false && result.error) {
                // Check if this is a non-retryable error
                const shouldDisable = this.toolFailureTracker.recordFailure(content.name, result.error);
                if (shouldDisable) {
                  this.daemon.logEvent(this.task.id, 'tool_error', {
                    tool: content.name,
                    error: result.error,
                    disabled: true,
                  });
                }
              }

              const truncatedResult = truncateToolResult(resultStr);

              this.daemon.logEvent(this.task.id, 'tool_result', {
                tool: content.name,
                result: result,
              });

              toolResults.push({
                type: 'tool_result',
                tool_use_id: content.id,
                content: truncatedResult,
              });
            } catch (error: any) {
              console.error(`Tool execution failed:`, error);

              // Track the failure
              const shouldDisable = this.toolFailureTracker.recordFailure(content.name, error.message);

              this.daemon.logEvent(this.task.id, 'tool_error', {
                tool: content.name,
                error: error.message,
                disabled: shouldDisable,
              });

              toolResults.push({
                type: 'tool_result',
                tool_use_id: content.id,
                content: JSON.stringify({
                  error: error.message,
                  ...(shouldDisable ? { disabled: true, message: 'Tool has been disabled due to repeated failures.' } : {}),
                }),
                is_error: true,
              });
            }
          }
        }

        if (toolResults.length > 0) {
          messages.push({
            role: 'user',
            content: toolResults,
          });

          // If all tool attempts were for disabled tools, don't continue looping
          if (hasDisabledToolAttempt && toolResults.every(r => r.is_error)) {
            console.log('[TaskExecutor] All tool calls failed or were disabled, stopping iteration');
            continueLoop = false;
          } else {
            continueLoop = true;
          }
        }

        // If assistant asked a question and there are no tool calls, stop and wait for user
        if (assistantAskedQuestion && toolResults.length === 0) {
          console.log('[TaskExecutor] Assistant asked a question, pausing for user input');
          continueLoop = false;
        }
      }

      // Save updated conversation history
      this.conversationHistory = messages;
      this.daemon.updateTaskStatus(this.task.id, 'completed');
      // Emit follow_up_completed event to signal the follow-up is done
      this.daemon.logEvent(this.task.id, 'follow_up_completed', {
        message: 'Follow-up message processed',
      });
    } catch (error: any) {
      console.error('sendMessage failed:', error);
      this.daemon.logEvent(this.task.id, 'error', {
        message: error.message,
      });
      this.daemon.updateTaskStatus(this.task.id, 'failed');
      // Emit follow_up_failed event for the gateway
      this.daemon.logEvent(this.task.id, 'follow_up_failed', {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Cancel execution
   */
  async cancel(): Promise<void> {
    this.cancelled = true;
    this.sandboxRunner.cleanup();
  }

  /**
   * Pause execution
   */
  async pause(): Promise<void> {
    this.paused = true;
  }

  /**
   * Resume execution
   */
  async resume(): Promise<void> {
    this.paused = false;
  }
}
