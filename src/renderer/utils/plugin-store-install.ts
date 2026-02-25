export function isGitPluginUrl(rawUrl: string): boolean {
  const trimmedUrl = rawUrl.trim();
  if (!trimmedUrl) {
    return false;
  }

  if (/^git@/i.test(trimmedUrl) || /^github:/i.test(trimmedUrl)) {
    return true;
  }

  if (/^https?:\/\//i.test(trimmedUrl)) {
    try {
      const parsed = new URL(trimmedUrl);
      const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
      const pathParts = parsed.pathname.replace(/\/+$/g, "").split("/").filter(Boolean);
      const lastSegment = pathParts[pathParts.length - 1]?.toLowerCase() || "";
      const hasGitExtension = lastSegment.endsWith(".git");
      const isGitHubRepoPath =
        (host === "github.com" || host.endsWith(".github.com")) && pathParts.length === 2;
      return hasGitExtension || isGitHubRepoPath;
    } catch {
      return false;
    }
  }

  return false;
}
