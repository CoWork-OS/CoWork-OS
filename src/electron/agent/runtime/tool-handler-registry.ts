import type { ToolExecutionContext, ToolExecutionHandler } from "./tool-middleware";
import type { RuntimeToolSchedulerSpecResolver } from "./runtime-tool-scheduler-spec";

interface PredicateHandlerEntry {
  matches: (name: string) => boolean;
  handler: ToolExecutionHandler;
  schedulerSpecResolver?: RuntimeToolSchedulerSpecResolver;
}

interface DirectHandlerEntry {
  handler: ToolExecutionHandler;
  schedulerSpecResolver?: RuntimeToolSchedulerSpecResolver;
}

export class ToolHandlerRegistry {
  private readonly handlers = new Map<string, DirectHandlerEntry>();
  private readonly predicateHandlers: PredicateHandlerEntry[] = [];

  register(
    name: string,
    handler: ToolExecutionHandler,
    schedulerSpecResolver?: RuntimeToolSchedulerSpecResolver,
  ): void {
    this.handlers.set(String(name || "").trim(), {
      handler,
      schedulerSpecResolver,
    });
  }

  registerMany(
    entries: Array<[string, ToolExecutionHandler, RuntimeToolSchedulerSpecResolver?]>,
  ): void {
    for (const [name, handler, schedulerSpecResolver] of entries) {
      this.register(name, handler, schedulerSpecResolver);
    }
  }

  registerPredicate(
    matches: (name: string) => boolean,
    handler: ToolExecutionHandler,
    schedulerSpecResolver?: RuntimeToolSchedulerSpecResolver,
  ): void {
    this.predicateHandlers.push({ matches, handler, schedulerSpecResolver });
  }

  has(name: string): boolean {
    const normalized = String(name || "").trim();
    return (
      this.handlers.has(normalized) ||
      this.predicateHandlers.some((entry) => entry.matches(normalized))
    );
  }

  listNames(): string[] {
    return Array.from(this.handlers.keys()).sort();
  }

  resolveSchedulerSpec(name: string, input: Any): ReturnType<RuntimeToolSchedulerSpecResolver> {
    const normalized = String(name || "").trim();
    const direct = this.handlers.get(normalized);
    if (direct?.schedulerSpecResolver) {
      return direct.schedulerSpecResolver({ toolName: normalized, input });
    }
    const predicate = this.predicateHandlers.find((entry) => entry.matches(normalized));
    if (predicate?.schedulerSpecResolver) {
      return predicate.schedulerSpecResolver({ toolName: normalized, input });
    }
    return undefined;
  }

  async execute(name: string, context: ToolExecutionContext): Promise<Any> {
    const normalized = String(name || "").trim();
    const handler =
      this.handlers.get(normalized)?.handler ||
      this.predicateHandlers.find((entry) => entry.matches(normalized))?.handler;
    if (!handler) {
      throw new Error(`No tool handler registered for "${name}"`);
    }
    return handler(context);
  }
}
