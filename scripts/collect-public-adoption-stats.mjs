import fs from "fs/promises";
import path from "path";
import { spawnSync } from "child_process";
import { buildNpmAllTimeMetric, getNpmFirstPublishedDay } from "./public-adoption-stats-utils.mjs";

const repoOwner = process.env.ADOPTION_STATS_REPO_OWNER || "CoWork-OS";
const repoName = process.env.ADOPTION_STATS_REPO_NAME || "CoWork-OS";
const npmPackage = process.env.ADOPTION_STATS_NPM_PACKAGE || "cowork-os";
const args = new Set(process.argv.slice(2));
const resetBaseline = args.has("--reset-baseline") || process.env.ADOPTION_STATS_RESET_BASELINE === "1";
const repoRoot = process.cwd();
const dataDir = path.join(repoRoot, "data", "adoption");
const latestPath = path.join(dataDir, "public-stats-latest.json");
const historyPath = path.join(dataDir, "public-stats-history.jsonl");
const token = process.env.ADOPTION_STATS_GITHUB_TOKEN || process.env.GITHUB_TOKEN || readGhToken();

const userAgent = "cowork-os-public-adoption-stats";

function readGhToken() {
  if (process.env.ADOPTION_STATS_SKIP_GH_CLI_TOKEN === "1") return "";
  const result = spawnSync("gh", ["auth", "token"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

function isoNow() {
  return new Date().toISOString();
}

function dayKey(iso) {
  return String(iso || "").slice(0, 10);
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function pickAssetPlatform(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".sha256") || lower.endsWith(".blockmap") || lower.endsWith(".yml")) return "metadata";
  if (lower.includes("server") || lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "server";
  if (lower.includes("mac") || lower.endsWith(".dmg")) return "macos";
  if (lower.includes("win") || lower.endsWith(".exe") || lower.endsWith(".msi")) return "windows";
  if (lower.includes("linux") || lower.endsWith(".appimage") || lower.endsWith(".deb") || lower.endsWith(".rpm")) {
    return "linux";
  }
  if (lower.endsWith(".zip")) return "archive";
  return "other";
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function fetchJson(url, options = {}) {
  const headers = {
    "User-Agent": userAgent,
    Accept: "application/vnd.github+json",
    ...options.headers,
  };
  if (token && url.includes("api.github.com")) {
    headers.Authorization = `Bearer ${token}`;
    headers["X-GitHub-Api-Version"] = "2022-11-28";
  }

  const response = await fetch(url, { ...options, headers });
  const text = await response.text();
  let body = null;
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }

  if (!response.ok) {
    const message = body?.message || text || response.statusText;
    const error = new Error(`${response.status} ${response.statusText}: ${message}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

async function fetchGitHubRepo() {
  const repo = await fetchJson(`https://api.github.com/repos/${repoOwner}/${repoName}`);
  return {
    fullName: repo.full_name,
    htmlUrl: repo.html_url,
    defaultBranch: repo.default_branch,
    stars: numberOrNull(repo.stargazers_count),
    forks: numberOrNull(repo.forks_count),
    watchers: numberOrNull(repo.subscribers_count),
    openIssues: numberOrNull(repo.open_issues_count),
    archived: Boolean(repo.archived),
    pushedAt: repo.pushed_at,
    updatedAt: repo.updated_at,
  };
}

async function fetchGitHubReleases() {
  const fetchedReleases = [];
  for (let page = 1; page <= 20; page += 1) {
    const pageRows = await fetchJson(
      `https://api.github.com/repos/${repoOwner}/${repoName}/releases?per_page=100&page=${page}`,
    );
    fetchedReleases.push(...(pageRows || []));
    if (!Array.isArray(pageRows) || pageRows.length < 100) break;
  }
  const releases = (fetchedReleases || []).filter((release) => !release.draft && release.published_at);
  const assetRows = [];
  let totalAssetDownloadCount = 0;
  let totalInstallAssetDownloadCount = 0;
  let metadataAssetDownloadCount = 0;

  for (const release of releases || []) {
    for (const asset of release.assets || []) {
      const downloadCount = numberOrNull(asset.download_count) ?? 0;
      const platform = pickAssetPlatform(asset.name);
      totalAssetDownloadCount += downloadCount;
      if (platform === "metadata") {
        metadataAssetDownloadCount += downloadCount;
      } else {
        totalInstallAssetDownloadCount += downloadCount;
      }
      assetRows.push({
        releaseTag: release.tag_name,
        releaseName: release.name || release.tag_name,
        releasePublishedAt: release.published_at,
        assetName: asset.name,
        platform,
        sizeBytes: numberOrNull(asset.size),
        downloadCount,
        browserDownloadUrl: asset.browser_download_url,
      });
    }
  }

  assetRows.sort((a, b) => {
    const releaseSort = String(b.releasePublishedAt || "").localeCompare(String(a.releasePublishedAt || ""));
    if (releaseSort !== 0) return releaseSort;
    return String(a.assetName).localeCompare(String(b.assetName));
  });

  const platformTotals = {};
  for (const asset of assetRows) {
    if (asset.platform === "metadata") continue;
    platformTotals[asset.platform] = (platformTotals[asset.platform] || 0) + asset.downloadCount;
  }

  return {
    releaseCount: releases?.length ?? 0,
    latestRelease: releases?.[0]
      ? {
          tag: releases[0].tag_name,
          name: releases[0].name || releases[0].tag_name,
          publishedAt: releases[0].published_at,
          htmlUrl: releases[0].html_url,
        }
      : null,
    totalAssetDownloadCount,
    totalInstallAssetDownloadCount,
    metadataAssetDownloadCount,
    platformTotals,
    assets: assetRows,
  };
}

async function fetchTrafficMetric(pathname) {
  try {
    return {
      status: "available",
      data: await fetchJson(`https://api.github.com/repos/${repoOwner}/${repoName}/traffic/${pathname}`),
    };
  } catch (error) {
    return {
      status: "unavailable",
      reason: error?.message || String(error),
    };
  }
}

async function fetchGitHubTraffic() {
  const [views, clones, referrers, paths] = await Promise.all([
    fetchTrafficMetric("views"),
    fetchTrafficMetric("clones"),
    fetchTrafficMetric("popular/referrers"),
    fetchTrafficMetric("popular/paths"),
  ]);

  return {
    note: "GitHub traffic endpoints expose roughly the last 14 days and require repository access.",
    views,
    clones,
    referrers,
    paths,
  };
}

async function fetchNpmPoint(period) {
  try {
    const data = await fetchJson(`https://api.npmjs.org/downloads/point/${period}/${npmPackage}`, {
      headers: { Accept: "application/json" },
    });
    return { period, downloads: numberOrNull(data.downloads), start: data.start, end: data.end };
  } catch (error) {
    return { period, downloads: null, error: error?.message || String(error) };
  }
}

async function fetchNpmStats(generatedDay) {
  const [metadata, lastDay, lastWeek, lastMonth, allTimeRange] = await Promise.all([
    fetchJson(`https://registry.npmjs.org/${npmPackage}`, { headers: { Accept: "application/json" } }).catch((error) => ({
      error: error?.message || String(error),
    })),
    fetchNpmPoint("last-day"),
    fetchNpmPoint("last-week"),
    fetchNpmPoint("last-month"),
    fetchJson(`https://api.npmjs.org/downloads/range/2010-01-01:${generatedDay}/${npmPackage}`, {
      headers: { Accept: "application/json" },
    }).catch((error) => ({ error: error?.message || String(error) })),
  ]);

  const packageFirstPublishedDay = getNpmFirstPublishedDay(metadata);

  return {
    package: npmPackage,
    latestVersion: metadata?.["dist-tags"]?.latest || null,
    packageUrl: `https://www.npmjs.com/package/${npmPackage}`,
    downloads: {
      lastDay,
      lastWeek,
      lastMonth,
      allTime: buildNpmAllTimeMetric(allTimeRange, packageFirstPublishedDay),
    },
  };
}

function buildAssetDownloadDelta(previous, current) {
  const previousByKey = new Map();
  for (const asset of previous?.github?.releases?.assets || []) {
    previousByKey.set(`${asset.releaseTag}::${asset.assetName}`, asset.downloadCount || 0);
  }

  return current.github.releases.assets.map((asset) => {
    const key = `${asset.releaseTag}::${asset.assetName}`;
    const previousDownloadCount = previousByKey.get(key);
    const deltaSincePreviousSnapshot =
      typeof previousDownloadCount === "number" ? asset.downloadCount - previousDownloadCount : null;
    return {
      ...asset,
      previousDownloadCount: previousDownloadCount ?? null,
      deltaSincePreviousSnapshot,
    };
  });
}

function summarizeReleaseDownloadDeltas(assets) {
  const byPlatform = {};
  let totalDelta = 0;
  let hasDelta = false;

  for (const asset of assets) {
    if (asset.platform === "metadata") continue;
    if (asset.deltaSincePreviousSnapshot == null) continue;
    hasDelta = true;
    totalDelta += asset.deltaSincePreviousSnapshot;
    byPlatform[asset.platform] = (byPlatform[asset.platform] || 0) + asset.deltaSincePreviousSnapshot;
  }

  return {
    totalDeltaSincePreviousSnapshot: hasDelta ? totalDelta : null,
    platformDeltasSincePreviousSnapshot: hasDelta ? byPlatform : {},
  };
}

function buildHistoryEntry(current) {
  return {
    schemaVersion: current.schemaVersion,
    generatedAt: current.generatedAt,
    generatedDay: current.generatedDay,
    github: {
      repo: {
        stars: current.github.repo.stars,
        forks: current.github.repo.forks,
        watchers: current.github.repo.watchers,
        openIssues: current.github.repo.openIssues,
      },
      releases: {
        latestRelease: current.github.releases.latestRelease,
        releaseCount: current.github.releases.releaseCount,
        totalAssetDownloadCount: current.github.releases.totalAssetDownloadCount,
        totalInstallAssetDownloadCount: current.github.releases.totalInstallAssetDownloadCount,
        metadataAssetDownloadCount: current.github.releases.metadataAssetDownloadCount,
        platformTotals: current.github.releases.platformTotals,
      },
      traffic: {
        views:
          current.github.traffic.views?.status === "available"
            ? {
                status: "available",
                count: current.github.traffic.views.data?.count ?? null,
                uniques: current.github.traffic.views.data?.uniques ?? null,
              }
            : { status: "unavailable" },
        clones:
          current.github.traffic.clones?.status === "available"
            ? {
                status: "available",
                count: current.github.traffic.clones.data?.count ?? null,
                uniques: current.github.traffic.clones.data?.uniques ?? null,
              }
            : { status: "unavailable" },
      },
    },
    npm: {
      latestVersion: current.npm.latestVersion,
      downloads: current.npm.downloads,
    },
    deltas: current.deltas,
  };
}

async function main() {
  await fs.mkdir(dataDir, { recursive: true });
  const generatedAt = isoNow();
  const previous = resetBaseline ? null : await readJsonIfExists(latestPath);

  const [repo, releases, traffic, npm] = await Promise.all([
    fetchGitHubRepo(),
    fetchGitHubReleases(),
    fetchGitHubTraffic(),
    fetchNpmStats(dayKey(generatedAt)),
  ]);

  const current = {
    schemaVersion: 1,
    generatedAt,
    generatedDay: dayKey(generatedAt),
    privacy: {
      source: "Public GitHub/npm APIs plus owner-only GitHub traffic APIs when available.",
      appTelemetry: false,
      contentTelemetry: false,
      note: "These are acquisition and download-intent signals, not active-user or in-app activation metrics.",
    },
    github: {
      repo,
      releases,
      traffic,
    },
    npm,
    deltas: {},
  };

  current.github.releases.assets = buildAssetDownloadDelta(previous, current);
  current.deltas.releaseDownloads = summarizeReleaseDownloadDeltas(current.github.releases.assets);
  current.deltas.previousSnapshotGeneratedAt = previous?.generatedAt || null;

  await fs.writeFile(latestPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  const historyEntry = buildHistoryEntry(current);
  if (resetBaseline) {
    await fs.writeFile(historyPath, `${JSON.stringify(historyEntry)}\n`, "utf8");
  } else {
    await fs.appendFile(historyPath, `${JSON.stringify(historyEntry)}\n`, "utf8");
  }

  console.log(
    `[adoption-stats] Wrote ${path.relative(repoRoot, latestPath)} and ${
      resetBaseline ? "reset" : "appended"
    } ${path.relative(repoRoot, historyPath)}.`,
  );
}

main().catch((error) => {
  console.error(`[adoption-stats] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
