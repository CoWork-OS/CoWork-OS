import fs from "fs/promises";
import path from "path";

const repoRoot = process.cwd();
const latestPath = path.join(repoRoot, "data", "adoption", "public-stats-latest.json");
const outputPath = path.join(repoRoot, "docs", "public-adoption-stats.md");
const readmePath = path.join(repoRoot, "README.md");
const readmeStatsStart = "<!-- COWORK_PUBLIC_ADOPTION_STATS_START -->";
const readmeStatsEnd = "<!-- COWORK_PUBLIC_ADOPTION_STATS_END -->";

function formatNumber(value) {
  if (value == null || Number.isNaN(Number(value))) return "n/a";
  return new Intl.NumberFormat("en-US").format(Number(value));
}

function formatDate(value) {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "n/a";
  return date.toISOString().slice(0, 10);
}

function markdownEscape(value) {
  return String(value ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");
}

function renderTrafficMetric(metric, totalKey, uniquesKey) {
  if (!metric || metric.status !== "available") return "unavailable";
  const data = metric.data || {};
  return `${formatNumber(data[totalKey])} total / ${formatNumber(data[uniquesKey])} unique`;
}

function renderTopList(metric, labelKey) {
  if (!metric || metric.status !== "available") {
    return "| Rank | Item | Count | Uniques |\n|---:|---|---:|---:|\n| - | unavailable | n/a | n/a |";
  }

  const rows = Array.isArray(metric.data) ? metric.data.slice(0, 10) : [];
  if (rows.length === 0) {
    return "| Rank | Item | Count | Uniques |\n|---:|---|---:|---:|\n| - | none reported | 0 | 0 |";
  }

  return [
    "| Rank | Item | Count | Uniques |",
    "|---:|---|---:|---:|",
    ...rows.map(
      (row, index) =>
        `| ${index + 1} | ${markdownEscape(row[labelKey])} | ${formatNumber(row.count)} | ${formatNumber(row.uniques)} |`,
    ),
  ].join("\n");
}

function renderReleaseAssets(assets) {
  const rows = (assets || [])
    .filter((asset) => asset.platform !== "metadata")
    .slice(0, 20);

  if (rows.length === 0) {
    return "| Release | Asset | Platform | Downloads | Delta |\n|---|---|---|---:|---:|\n| - | none reported | - | 0 | n/a |";
  }

  return [
    "| Release | Asset | Platform | Downloads | Delta |",
    "|---|---|---|---:|---:|",
    ...rows.map((asset) => {
      const delta =
        asset.deltaSincePreviousSnapshot == null
          ? "n/a"
          : asset.deltaSincePreviousSnapshot >= 0
            ? `+${formatNumber(asset.deltaSincePreviousSnapshot)}`
            : formatNumber(asset.deltaSincePreviousSnapshot);
      return `| ${markdownEscape(asset.releaseTag)} | ${markdownEscape(asset.assetName)} | ${markdownEscape(
        asset.platform,
      )} | ${formatNumber(asset.downloadCount)} | ${delta} |`;
    }),
  ].join("\n");
}

function renderPlatformTotals(platformTotals, platformDeltas) {
  const platforms = new Set([...Object.keys(platformTotals || {}), ...Object.keys(platformDeltas || {})]);
  const rows = [...platforms].sort();

  if (rows.length === 0) {
    return "| Platform | Lifetime downloads | Delta |\n|---|---:|---:|\n| - | 0 | n/a |";
  }

  return [
    "| Platform | Lifetime downloads | Delta |",
    "|---|---:|---:|",
    ...rows.map((platform) => {
      const delta = platformDeltas?.[platform];
      const formattedDelta = delta == null ? "n/a" : delta >= 0 ? `+${formatNumber(delta)}` : formatNumber(delta);
      return `| ${markdownEscape(platform)} | ${formatNumber(platformTotals?.[platform])} | ${formattedDelta} |`;
    }),
  ].join("\n");
}

function renderReadmeStatsBlock({ stats, repo, releases, traffic, npm, npmDownloads, releaseDownloadDeltas }) {
  const releaseDelta =
    releaseDownloadDeltas.totalDeltaSincePreviousSnapshot == null
      ? "n/a"
      : releaseDownloadDeltas.totalDeltaSincePreviousSnapshot >= 0
        ? `+${formatNumber(releaseDownloadDeltas.totalDeltaSincePreviousSnapshot)}`
        : formatNumber(releaseDownloadDeltas.totalDeltaSincePreviousSnapshot);

  return `${readmeStatsStart}
### Public Adoption Signals

| Signal | Current |
|---|---:|
| GitHub stars | ${formatNumber(repo.stars)} |
| GitHub forks | ${formatNumber(repo.forks)} |
| Installer/server downloads | ${formatNumber(releases.totalInstallAssetDownloadCount)} |
| Download delta | ${releaseDelta} |
| npm downloads, last week | ${formatNumber(npmDownloads.lastWeek?.downloads)} |
| GitHub views, last 14-ish days | ${renderTrafficMetric(traffic.views, "count", "uniques")} |
| GitHub clones, last 14-ish days | ${renderTrafficMetric(traffic.clones, "count", "uniques")} |

Generated ${stats.generatedAt}. These are public GitHub/npm adoption signals, not active-user or in-app telemetry numbers. [Full report](docs/public-adoption-stats.md).
${readmeStatsEnd}`;
}

async function updateReadmeStats(block) {
  let readme = await fs.readFile(readmePath, "utf8");
  const startIndex = readme.indexOf(readmeStatsStart);
  const endIndex = readme.indexOf(readmeStatsEnd);

  if (startIndex >= 0 && endIndex > startIndex) {
    const before = readme.slice(0, startIndex).trimEnd();
    const after = readme.slice(endIndex + readmeStatsEnd.length).trimStart();
    readme = `${before}\n\n${block}\n\n${after}`;
  } else {
    const heroImageMarker = '<p align="center">\n  <img src="resources/branding/images/cowork-os-1.webp"';
    const insertIndex = readme.indexOf(heroImageMarker);
    if (insertIndex < 0) {
      throw new Error("Could not locate README insertion point for public adoption stats block.");
    }
    const before = readme.slice(0, insertIndex).trimEnd();
    const after = readme.slice(insertIndex).trimStart();
    readme = `${before}\n\n${block}\n\n${after}`;
  }

  await fs.writeFile(readmePath, readme, "utf8");
}

async function main() {
  const stats = JSON.parse(await fs.readFile(latestPath, "utf8"));
  const repo = stats.github?.repo || {};
  const releases = stats.github?.releases || {};
  const traffic = stats.github?.traffic || {};
  const npm = stats.npm || {};
  const npmDownloads = npm.downloads || {};
  const releaseDownloadDeltas = stats.deltas?.releaseDownloads || {};

  const markdown = `# Public Adoption Stats

Generated at: ${stats.generatedAt}

These numbers are acquisition and download-intent signals for CoWork OS. They do **not** measure active users, first launch, successful task completion, model configuration, retention, prompts, files, emails, or any in-app content.

## Snapshot

| Metric | Value |
|---|---:|
| GitHub stars | ${formatNumber(repo.stars)} |
| GitHub forks | ${formatNumber(repo.forks)} |
| GitHub watchers | ${formatNumber(repo.watchers)} |
| GitHub open issues | ${formatNumber(repo.openIssues)} |
| Latest release | ${markdownEscape(releases.latestRelease?.tag || "n/a")} |
| Latest release date | ${formatDate(releases.latestRelease?.publishedAt)} |
| Installer/server downloads, lifetime | ${formatNumber(releases.totalInstallAssetDownloadCount)} |
| Installer/server downloads, since previous snapshot | ${releaseDownloadDeltas.totalDeltaSincePreviousSnapshot == null ? "n/a" : formatNumber(releaseDownloadDeltas.totalDeltaSincePreviousSnapshot)} |
| npm latest version | ${markdownEscape(npm.latestVersion || "n/a")} |
| npm downloads, last day | ${formatNumber(npmDownloads.lastDay?.downloads)} |
| npm downloads, last week | ${formatNumber(npmDownloads.lastWeek?.downloads)} |
| npm downloads, last month | ${formatNumber(npmDownloads.lastMonth?.downloads)} |
| GitHub views, last 14-ish days | ${renderTrafficMetric(traffic.views, "count", "uniques")} |
| GitHub clones, last 14-ish days | ${renderTrafficMetric(traffic.clones, "count", "uniques")} |

## Release Downloads By Platform

${renderPlatformTotals(releases.platformTotals, releaseDownloadDeltas.platformDeltasSincePreviousSnapshot)}

## Recent Release Assets

${renderReleaseAssets(releases.assets)}

## Top GitHub Referrers

${renderTopList(traffic.referrers, "referrer")}

## Top GitHub Paths

${renderTopList(traffic.paths, "path")}

## Data Policy

- This report uses GitHub repository, release, traffic, and npm download APIs.
- GitHub traffic data is only available for a short rolling window and requires repository access.
- Release asset downloads are lifetime counters. The headline download totals exclude updater metadata files such as blockmaps, checksums, and YAML manifests. The delta column is computed by comparing the current snapshot with the previous committed snapshot.
- No application telemetry is collected by this report.
- No prompts, generated outputs, files, emails, workspace names, API keys, account IDs, IP addresses, or installed-app events are collected.

For website implementation work, consume \`data/adoption/public-stats-latest.json\` from this repository and combine it with website-only page-view and download-click analytics.
`;

  await fs.writeFile(outputPath, markdown, "utf8");
  console.log(`[adoption-stats] Wrote ${path.relative(repoRoot, outputPath)}.`);

  const readmeBlock = renderReadmeStatsBlock({
    stats,
    repo,
    releases,
    traffic,
    npm,
    npmDownloads,
    releaseDownloadDeltas,
  });
  await updateReadmeStats(readmeBlock);
  console.log(`[adoption-stats] Wrote ${path.relative(repoRoot, readmePath)} stats block.`);
}

main().catch((error) => {
  console.error(`[adoption-stats] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
