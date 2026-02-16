/**
 * Hook Mappings
 *
 * Resolves and applies hook mappings to incoming webhook requests.
 */

import path from 'path';
import { pathToFileURL } from 'url';
import {
  HooksConfig,
  HookMappingConfig,
  HookMappingResolved,
  HookMappingTransformResolved,
  HookMappingContext,
  HookAction,
  HookMappingResult,
  HookMessageChannel,
  HOOK_PRESET_MAPPINGS,
  DEFAULT_HOOKS_PATH,
} from './types';
import { getUserDataDir } from '../utils/user-data-dir';

const transformCache = new Map<string, HookTransformFn>();

type HookTransformResult = Partial<{
  kind: HookAction['kind'];
  text: string;
  mode: 'now' | 'next-heartbeat';
  message: string;
  wakeMode: 'now' | 'next-heartbeat';
  name: string;
  sessionKey: string;
  deliver: boolean;
  allowUnsafeExternalContent: boolean;
  channel: HookMessageChannel;
  to: string;
  model: string;
  thinking: string;
  timeoutSeconds: number;
}> | null;

type HookTransformFn = (
  ctx: HookMappingContext,
) => HookTransformResult | Promise<HookTransformResult>;

/**
 * Normalize hooks path to ensure proper format
 */
export function normalizeHooksPath(raw?: string): string {
  const base = raw?.trim() || DEFAULT_HOOKS_PATH;
  if (base === '/') return DEFAULT_HOOKS_PATH;
  const withSlash = base.startsWith('/') ? base : `/${base}`;
  return withSlash.replace(/\/+$/, '');
}

/**
 * Resolve hook mappings from configuration
 */
export function resolveHookMappings(hooks?: HooksConfig): HookMappingResolved[] {
  if (!hooks) return [];

  const presets = hooks.presets ?? [];
  const gmailAllowUnsafe = hooks.gmail?.allowUnsafeExternalContent;
  const resendAllowUnsafe = hooks.resend?.allowUnsafeExternalContent;
  const mappings: HookMappingConfig[] = [];

  // Add custom mappings first
  if (hooks.mappings) {
    mappings.push(...hooks.mappings);
  }

  // Add preset mappings
  for (const preset of presets) {
    const presetMappings = HOOK_PRESET_MAPPINGS[preset];
    if (!presetMappings) continue;

    if (preset === 'gmail' && typeof gmailAllowUnsafe === 'boolean') {
      mappings.push(
        ...presetMappings.map((mapping) => ({
          ...mapping,
          allowUnsafeExternalContent: gmailAllowUnsafe,
        })),
      );
      continue;
    }
    if (preset === 'resend' && typeof resendAllowUnsafe === 'boolean') {
      mappings.push(
        ...presetMappings.map((mapping) => ({
          ...mapping,
          allowUnsafeExternalContent: resendAllowUnsafe,
        })),
      );
      continue;
    }
    mappings.push(...presetMappings);
  }

  if (mappings.length === 0) return [];

  const configDir = getUserDataDir();
  const transformsDir = hooks.transformsDir
    ? resolvePath(configDir, hooks.transformsDir)
    : configDir;

  return mappings.map((mapping, index) => normalizeHookMapping(mapping, index, transformsDir));
}

/**
 * Apply hook mappings to a request context
 */
export async function applyHookMappings(
  mappings: HookMappingResolved[],
  ctx: HookMappingContext,
): Promise<HookMappingResult | null> {
  if (mappings.length === 0) return null;

  for (const mapping of mappings) {
    if (!mappingMatches(mapping, ctx)) continue;

    const base = buildActionFromMapping(mapping, ctx);
    if (!base.ok) return base;

    let override: HookTransformResult = null;
    if (mapping.transform) {
      const transform = await loadTransform(mapping.transform);
      override = await transform(ctx);
      if (override === null) {
        return { ok: true, action: null, skipped: true };
      }
    }

    if (!base.action) return { ok: true, action: null, skipped: true };
    const merged = mergeAction(base.action, override, mapping.action);
    if (!merged.ok) return merged;
    return merged;
  }

  return null;
}

/**
 * Normalize a hook mapping configuration
 */
function normalizeHookMapping(
  mapping: HookMappingConfig,
  index: number,
  transformsDir: string,
): HookMappingResolved {
  const id = mapping.id?.trim() || `mapping-${index + 1}`;
  const matchPath = normalizeMatchPath(mapping.match?.path);
  const matchSource = mapping.match?.source?.trim();
  const matchType = mapping.match?.type?.trim();
  const action = mapping.action ?? 'agent';
  const wakeMode = mapping.wakeMode ?? 'now';
  const transform = mapping.transform
    ? {
        modulePath: resolvePath(transformsDir, mapping.transform.module),
        exportName: mapping.transform.export?.trim() || undefined,
      }
    : undefined;

  return {
    id,
    matchPath,
    matchSource,
    matchType,
    action,
    wakeMode,
    name: mapping.name,
    sessionKey: mapping.sessionKey,
    messageTemplate: mapping.messageTemplate,
    textTemplate: mapping.textTemplate,
    deliver: mapping.deliver,
    allowUnsafeExternalContent: mapping.allowUnsafeExternalContent,
    channel: mapping.channel,
    to: mapping.to,
    model: mapping.model,
    thinking: mapping.thinking,
    timeoutSeconds: mapping.timeoutSeconds,
    transform,
  };
}

/**
 * Check if a mapping matches the request context
 */
function mappingMatches(mapping: HookMappingResolved, ctx: HookMappingContext): boolean {
  if (mapping.matchPath) {
    if (mapping.matchPath !== normalizeMatchPath(ctx.path)) return false;
  }
  if (mapping.matchSource) {
    const source = typeof ctx.payload.source === 'string' ? ctx.payload.source : undefined;
    if (!source || source !== mapping.matchSource) return false;
  }
  if (mapping.matchType) {
    const eventType = typeof ctx.payload.type === 'string' ? ctx.payload.type : undefined;
    if (!eventType || eventType !== mapping.matchType) return false;
  }
  return true;
}

/**
 * Build an action from a mapping and context
 */
function buildActionFromMapping(
  mapping: HookMappingResolved,
  ctx: HookMappingContext,
): HookMappingResult {
  if (mapping.action === 'wake') {
    const text = renderTemplate(mapping.textTemplate ?? '', ctx);
    return {
      ok: true,
      action: {
        kind: 'wake',
        text,
        mode: mapping.wakeMode ?? 'now',
      },
    };
  }

  const message = renderTemplate(mapping.messageTemplate ?? '', ctx);
  return {
    ok: true,
    action: {
      kind: 'agent',
      message,
      name: renderOptional(mapping.name, ctx),
      wakeMode: mapping.wakeMode ?? 'now',
      sessionKey: renderOptional(mapping.sessionKey, ctx),
      deliver: mapping.deliver,
      allowUnsafeExternalContent: mapping.allowUnsafeExternalContent,
      channel: mapping.channel,
      to: renderOptional(mapping.to, ctx),
      model: renderOptional(mapping.model, ctx),
      thinking: renderOptional(mapping.thinking, ctx),
      timeoutSeconds: mapping.timeoutSeconds,
    },
  };
}

/**
 * Merge base action with transform overrides
 */
function mergeAction(
  base: HookAction,
  override: HookTransformResult,
  defaultAction: 'wake' | 'agent',
): HookMappingResult {
  if (!override) {
    return validateAction(base);
  }

  const kind = (override.kind ?? base.kind ?? defaultAction) as 'wake' | 'agent';

  if (kind === 'wake') {
    const baseWake = base.kind === 'wake' ? base : undefined;
    const text = typeof override.text === 'string' ? override.text : (baseWake?.text ?? '');
    const mode = override.mode === 'next-heartbeat' ? 'next-heartbeat' : (baseWake?.mode ?? 'now');
    return validateAction({ kind: 'wake', text, mode });
  }

  const baseAgent = base.kind === 'agent' ? base : undefined;
  const message =
    typeof override.message === 'string' ? override.message : (baseAgent?.message ?? '');
  const wakeMode =
    override.wakeMode === 'next-heartbeat' ? 'next-heartbeat' : (baseAgent?.wakeMode ?? 'now');

  return validateAction({
    kind: 'agent',
    message,
    wakeMode,
    name: override.name ?? baseAgent?.name,
    sessionKey: override.sessionKey ?? baseAgent?.sessionKey,
    deliver: typeof override.deliver === 'boolean' ? override.deliver : baseAgent?.deliver,
    allowUnsafeExternalContent:
      typeof override.allowUnsafeExternalContent === 'boolean'
        ? override.allowUnsafeExternalContent
        : baseAgent?.allowUnsafeExternalContent,
    channel: override.channel ?? baseAgent?.channel,
    to: override.to ?? baseAgent?.to,
    model: override.model ?? baseAgent?.model,
    thinking: override.thinking ?? baseAgent?.thinking,
    timeoutSeconds: override.timeoutSeconds ?? baseAgent?.timeoutSeconds,
  });
}

/**
 * Validate that an action has required fields
 */
function validateAction(action: HookAction): HookMappingResult {
  if (action.kind === 'wake') {
    if (!action.text?.trim()) {
      return { ok: false, error: 'hook mapping requires text' };
    }
    return { ok: true, action };
  }

  if (!action.message?.trim()) {
    return { ok: false, error: 'hook mapping requires message' };
  }
  return { ok: true, action };
}

/**
 * Load a transform module
 */
async function loadTransform(transform: HookMappingTransformResolved): Promise<HookTransformFn> {
  const cached = transformCache.get(transform.modulePath);
  if (cached) return cached;

  const url = pathToFileURL(transform.modulePath).href;
  const mod = (await import(url)) as Record<string, unknown>;
  const fn = resolveTransformFn(mod, transform.exportName);
  transformCache.set(transform.modulePath, fn);
  return fn;
}

/**
 * Resolve the transform function from a module
 */
function resolveTransformFn(mod: Record<string, unknown>, exportName?: string): HookTransformFn {
  const candidate = exportName ? mod[exportName] : (mod.default ?? mod.transform);
  if (typeof candidate !== 'function') {
    throw new Error('hook transform module must export a function');
  }
  return candidate as HookTransformFn;
}

/**
 * Resolve a path relative to a base directory
 */
function resolvePath(baseDir: string, target: string): string {
  if (!target) return baseDir;
  if (path.isAbsolute(target)) return target;
  return path.join(baseDir, target);
}

/**
 * Normalize a match path
 */
function normalizeMatchPath(raw?: string): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Render an optional template value
 */
function renderOptional(value: string | undefined, ctx: HookMappingContext): string | undefined {
  if (!value) return undefined;
  const rendered = renderTemplate(value, ctx).trim();
  return rendered ? rendered : undefined;
}

/**
 * Render a template with context values
 */
function renderTemplate(template: string, ctx: HookMappingContext): string {
  if (!template) return '';
  return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, expr: string) => {
    const value = resolveTemplateExpr(expr.trim(), ctx);
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return JSON.stringify(value);
  });
}

/**
 * Resolve a template expression
 */
function resolveTemplateExpr(expr: string, ctx: HookMappingContext): unknown {
  if (expr === 'path') return ctx.path;
  if (expr === 'now') return new Date().toISOString();
  if (expr.startsWith('headers.')) {
    return getByPath(ctx.headers, expr.slice('headers.'.length));
  }
  if (expr.startsWith('query.')) {
    return getByPath(
      Object.fromEntries(ctx.url.searchParams.entries()),
      expr.slice('query.'.length),
    );
  }
  if (expr.startsWith('payload.')) {
    return getByPath(ctx.payload, expr.slice('payload.'.length));
  }
  return getByPath(ctx.payload, expr);
}

/**
 * Get a value by dot-notation path
 */
function getByPath(input: Record<string, unknown>, pathExpr: string): unknown {
  if (!pathExpr) return undefined;
  const parts: Array<string | number> = [];
  const re = /([^.[\]]+)|(\[(\d+)\])/g;
  let match = re.exec(pathExpr);
  while (match) {
    if (match[1]) {
      parts.push(match[1]);
    } else if (match[3]) {
      parts.push(Number(match[3]));
    }
    match = re.exec(pathExpr);
  }
  let current: unknown = input;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof part === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[part] as unknown;
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
