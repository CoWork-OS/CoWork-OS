export interface RendererLogger {
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
}

function prefix(component: string, args: unknown[]): unknown[] {
  if (args.length === 0) {
    return [`[${component}]`];
  }

  const [first, ...rest] = args;
  if (typeof first === "string") {
    return [`[${component}] ${first}`, ...rest];
  }

  return [`[${component}]`, first, ...rest];
}

export function createRendererLogger(component: string): RendererLogger {
  return {
    error: (...args: unknown[]) => console.error(...prefix(component, args)),
    warn: (...args: unknown[]) => console.warn(...prefix(component, args)),
    info: (...args: unknown[]) => console.log(...prefix(component, args)),
    debug: (...args: unknown[]) => console.debug(...prefix(component, args)),
  };
}
