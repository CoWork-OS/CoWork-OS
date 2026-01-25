import { Task, Workspace, Plan, PlanStep, TaskEvent } from '../../shared/types';
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
  private cancelled = false;
  private paused = false;
  private plan?: Plan;
  private modelId: string;
  private modelKey: string;
  private conversationHistory: LLMMessage[] = [];
  private systemPrompt: string = '';

  constructor(
    private task: Task,
    private workspace: Workspace,
    private daemon: AgentDaemon
  ) {
    // Initialize LLM provider using factory (respects user settings)
    this.provider = LLMProviderFactory.createProvider();

    // Get the model ID from settings
    const settings = LLMProviderFactory.loadSettings();
    this.modelId = LLMProviderFactory.getModelId(settings.modelKey, settings.providerType, settings.ollama?.model);
    this.modelKey = settings.modelKey;

    // Initialize context manager for handling long conversations
    this.contextManager = new ContextManager(settings.modelKey);

    // Initialize tool registry
    this.toolRegistry = new ToolRegistry(workspace, daemon, task.id);

    // Initialize sandbox runner
    this.sandboxRunner = new SandboxRunner(workspace);

    console.log(`TaskExecutor initialized with ${settings.providerType} provider, model: ${this.modelId}`);
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
   * Main execution loop
   */
  async execute(): Promise<void> {
    try {
      // Phase 1: Planning
      this.daemon.updateTaskStatus(this.task.id, 'planning');
      await this.createPlan();

      if (this.cancelled) return;

      // Phase 2: Execution
      this.daemon.updateTaskStatus(this.task.id, 'executing');
      await this.executePlan();

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
    }
  }

  /**
   * Create execution plan using LLM
   */
  private async createPlan(): Promise<void> {
    this.daemon.logEvent(this.task.id, 'log', { message: 'Creating execution plan...' });

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

    const response = await this.provider.createMessage({
      model: this.modelId,
      maxTokens: 4096,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Task: ${this.task.title}\n\nDetails: ${this.task.prompt}\n\nCreate an execution plan.`,
        },
      ],
    });

    // Extract plan from response
    const textContent = response.content.find(c => c.type === 'text');
    if (textContent && textContent.type === 'text') {
      try {
        // Try to extract and parse JSON from the response
        const json = this.extractJsonObject(textContent.text);
        if (json) {
          this.plan = json;
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
- After completing the work, provide a brief summary of what was done.`;

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
      const maxIterations = 10;
      const maxEmptyResponses = 3;

      while (continueLoop && iterationCount < maxIterations) {
        if (this.cancelled) break;

        iterationCount++;

        // Check for too many empty responses
        if (emptyResponseCount >= maxEmptyResponses) {
          break;
        }

        // Compact messages if context is getting too large
        messages = this.contextManager.compactMessages(messages, systemPromptTokens);

        const response = await this.provider.createMessage({
          model: this.modelId,
          maxTokens: 4096,
          system: this.systemPrompt,
          tools: this.toolRegistry.getTools(),
          messages,
        });

        // Process response - only stop if we have actual content AND it's end_turn
        // Empty responses should not terminate the loop
        if (response.stopReason === 'end_turn' && response.content && response.content.length > 0) {
          continueLoop = false;
        }

        // Log any text responses from the assistant
        if (response.content) {
          for (const content of response.content) {
            if (content.type === 'text' && content.text) {
              this.daemon.logEvent(this.task.id, 'assistant_message', {
                message: content.text,
              });
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
        for (const content of response.content || []) {
          if (content.type === 'tool_use') {
            this.daemon.logEvent(this.task.id, 'tool_call', {
              tool: content.name,
              input: content.input,
            });

            try {
              const result = await this.toolRegistry.executeTool(
                content.name,
                content.input as any
              );

              // Truncate large tool results to avoid context overflow
              const resultStr = JSON.stringify(result);
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
              this.daemon.logEvent(this.task.id, 'tool_error', {
                tool: content.name,
                error: error.message,
              });
              toolResults.push({
                type: 'tool_result',
                tool_use_id: content.id,
                content: JSON.stringify({ error: error.message }),
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
          continueLoop = true;
        }
      }

      // Step completed

      // Save conversation history for follow-up messages
      this.conversationHistory = messages;

      step.status = 'completed';
      step.completedAt = Date.now();
      this.daemon.logEvent(this.task.id, 'step_completed', { step });
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

        // Compact messages if context is getting too large
        messages = this.contextManager.compactMessages(messages, systemPromptTokens);

        const response = await this.provider.createMessage({
          model: this.modelId,
          maxTokens: 4096,
          system: this.systemPrompt,
          tools: this.toolRegistry.getTools(),
          messages,
        });

        // Process response
        if (response.stopReason === 'end_turn') {
          continueLoop = false;
        }

        // Log any text responses from the assistant
        if (response.content) {
          for (const content of response.content) {
            if (content.type === 'text' && content.text) {
              this.daemon.logEvent(this.task.id, 'assistant_message', {
                message: content.text,
              });
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
        for (const content of response.content || []) {
          if (content.type === 'tool_use') {
            this.daemon.logEvent(this.task.id, 'tool_call', {
              tool: content.name,
              input: content.input,
            });

            try {
              const result = await this.toolRegistry.executeTool(
                content.name,
                content.input as any
              );

              const resultStr = JSON.stringify(result);
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
              this.daemon.logEvent(this.task.id, 'tool_error', {
                tool: content.name,
                error: error.message,
              });
              toolResults.push({
                type: 'tool_result',
                tool_use_id: content.id,
                content: JSON.stringify({ error: error.message }),
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
          continueLoop = true;
        }
      }

      // Save updated conversation history
      this.conversationHistory = messages;
      this.daemon.updateTaskStatus(this.task.id, 'completed');
    } catch (error: any) {
      console.error('sendMessage failed:', error);
      this.daemon.logEvent(this.task.id, 'error', {
        message: error.message,
      });
      this.daemon.updateTaskStatus(this.task.id, 'failed');
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
