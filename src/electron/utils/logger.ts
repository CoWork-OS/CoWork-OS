export type LogLevel = "error" | "warn" | "info" | "debug";

type LogMethod = (...args: unknown[]) => void;

const LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const VALID_LEVELS = new Set<LogLevel>(["error", "warn", "info", "debug"]);

function normalizeLevel(raw: string | undefined): LogLevel {
  if (!raw) return "info";
  const normalized = raw.trim().toLowerCase();
  if (VALID_LEVELS.has(normalized as LogLevel)) {
    return normalized as LogLevel;
  }
  return "info";
}

function parseComponentFilter(raw: string | undefined): Set<string> | null {
  if (!raw) return null;
  const tokens = raw
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return null;
  return new Set(tokens);
}

const configuredLevel = normalizeLevel(process.env.COWORK_LOG_LEVEL);
const componentFilter = parseComponentFilter(process.env.COWORK_LOG_COMPONENTS);

function shouldLog(component: string, level: LogLevel): boolean {
  if (LEVEL_ORDER[level] > LEVEL_ORDER[configuredLevel]) {
    return false;
  }

  if (!componentFilter) {
    return true;
  }

  return componentFilter.has(component.toLowerCase());
}

function prefixComponent(component: string, args: unknown[]): unknown[] {
  if (args.length === 0) {
    return [`[${component}]`];
  }

  const [first, ...rest] = args;
  if (typeof first === "string") {
    if (first.startsWith(`[${component}]`)) {
      return [first, ...rest];
    }
    return [`[${component}] ${first}`, ...rest];
  }

  return [`[${component}]`, first, ...rest];
}

function emit(component: string, level: LogLevel, method: LogMethod, args: unknown[]): void {
  if (!shouldLog(component, level)) {
    return;
  }
  method(...prefixComponent(component, args));
}

export interface ComponentLogger {
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  isDebugEnabled: () => boolean;
}

export function createLogger(component: string): ComponentLogger {
  return {
    error: (...args: unknown[]) => emit(component, "error", console.error, args),
    warn: (...args: unknown[]) => emit(component, "warn", console.warn, args),
    info: (...args: unknown[]) => emit(component, "info", console.log, args),
    debug: (...args: unknown[]) => emit(component, "debug", console.log, args),
    isDebugEnabled: () => shouldLog(component, "debug"),
  };
}
