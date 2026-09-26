import * as fs from "fs";
import * as path from "path";
import { buildModelMetadata, MODELS_DEV_URL } from "../../../shared/model-metadata-build";
import { setRefreshedModelMetadata, type ModelMetadataEntry } from "../../../shared/model-metadata";
import { createLogger } from "../../utils/logger";
import { getUserDataDir } from "../../utils/user-data-dir";

/**
 * Opt-in daily refresh of model prices and context limits from models.dev.
 *
 * Off by default (Settings → AI & Models → "Refresh model prices and context limits daily"). When on, CoWork
 * sends one anonymous GET to https://models.dev/api.json per day: no identifiers,
 * cookies, prompts or usage. The result is cached in the user-data folder and
 * layered over the snapshot bundled with the app; the bundled snapshot is used
 * whenever the refresh is off, offline or fails.
 */

const logger = createLogger("ModelMetadataRefresh");
const CACHE_FILE = "model-metadata-cache.json";
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20 * 1000;
/** Reject truncated or unexpected responses instead of replacing good data with them. */
const MIN_EXPECTED_MODELS = 200;

interface CachedMetadata {
  fetchedAt: number;
  models: Record<string, ModelMetadataEntry>;
}

function cachePath(): string {
  return path.join(getUserDataDir(), CACHE_FILE);
}

function readCache(): CachedMetadata | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(), "utf8")) as CachedMetadata;
    if (
      typeof parsed?.fetchedAt === "number" &&
      parsed.models &&
      typeof parsed.models === "object"
    ) {
      return parsed;
    }
  } catch {
    // No cache yet, or unreadable: the bundled snapshot is used.
  }
  return null;
}

function refreshDisabledByEnvironment(): boolean {
  return (
    Boolean(process.env.CI) ||
    process.env.NODE_ENV === "test" ||
    process.env.COWORK_DISABLE_MODEL_METADATA_REFRESH === "1"
  );
}

export async function refreshModelMetadataNow(
  fetchImpl: typeof fetch = fetch,
): Promise<{ updated: boolean; modelCount: number }> {
  const response = await fetchImpl(MODELS_DEV_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
  const models = buildModelMetadata(await response.json());
  const modelCount = Object.keys(models).length;
  if (modelCount < MIN_EXPECTED_MODELS) {
    throw new Error(`models.dev returned only ${modelCount} usable models; keeping current data`);
  }
  const cached: CachedMetadata = { fetchedAt: Date.now(), models };
  fs.writeFileSync(cachePath(), JSON.stringify(cached));
  setRefreshedModelMetadata(models);
  return { updated: true, modelCount };
}

export class ModelMetadataRefresher {
  private timer: NodeJS.Timeout | null = null;
  private applied = false;

  constructor(private readonly isEnabled: () => boolean) {}

  /** Apply the cached catalogue (if enabled) and check hourly whether a refresh is due. */
  start(): void {
    this.applySetting();
    if (refreshDisabledByEnvironment()) return;
    this.timer = setTimeout(() => void this.tick(), FIRST_CHECK_DELAY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Layer the cached catalogue when enabled; drop it when disabled (no restart needed). */
  private applySetting(): boolean {
    const enabled = this.isEnabled();
    if (enabled && !this.applied) {
      const cached = readCache();
      if (cached) setRefreshedModelMetadata(cached.models);
      this.applied = true;
    } else if (!enabled && this.applied) {
      setRefreshedModelMetadata(null);
      this.applied = false;
    }
    return enabled;
  }

  private async tick(): Promise<void> {
    try {
      const cached = readCache();
      const due = !cached || Date.now() - cached.fetchedAt >= REFRESH_INTERVAL_MS;
      if (this.applySetting() && due) {
        const result = await refreshModelMetadataNow();
        this.applied = true;
        logger.info(`Refreshed model prices and limits (${result.modelCount} models)`);
      }
    } catch (error) {
      logger.warn("Model metadata refresh failed; using bundled data", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.timer = setTimeout(() => void this.tick(), CHECK_INTERVAL_MS);
      this.timer.unref?.();
    }
  }
}
