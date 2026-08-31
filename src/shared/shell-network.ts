/**
 * Conservative classifier for commands that can initiate network egress.
 *
 * This is intentionally a boundary classifier, not a shell parser. A false
 * positive causes an approval prompt; a false negative would let a command
 * bypass a profile's network policy. Commands that are not recognized remain
 * subject to the normal shell approval and sandbox controls.
 */
const NETWORK_COMMAND_PATTERNS: readonly RegExp[] = [
  /(?:^|[\s;&|()])(?:curl|wget|httpie|aria2c|axel|ftp|sftp|scp|ssh|telnet|nc|netcat)(?:$|[\s;&|()])/i,
  /(?:^|[\s;&|()])git\s+(?:clone|fetch|pull|push|ls-remote|submodule)(?:$|[\s;&|()])/i,
  /(?:^|[\s;&|()])(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|update|upgrade|publish|pack|view|search|outdated)(?:$|[\s;&|()])/i,
  /(?:^|[\s;&|()])(?:pip|pip3)\s+(?:install|download|index)(?:$|[\s;&|()])/i,
  /(?:^|[\s;&|()])(?:cargo|go)\s+(?:install|get)(?:$|[\s;&|()])/i,
  /\bhttps?:\/\//i,
  /\b(?:fetch|axios|urllib|requests|socket|http\.client|net\.http)\b/i,
  /\b(?:resolvectl|nslookup|dig|host)\b/i,
];

/**
 * Hide literal payloads that are only being written to a local file. URLs in
 * documentation text are data, not evidence that the shell will open a
 * socket. Executable heredocs (python/node/sh), pipelines, and special
 * /dev/tcp redirections intentionally remain unmasked and fail closed.
 */
function maskLocalFilePayloads(command: string): string {
  const lines = command.split(/\r?\n/);
  let dataOnlyDelimiter: string | null = null;
  const maskedLines: string[] = [];

  for (const line of lines) {
    if (dataOnlyDelimiter) {
      if (line.trim() === dataOnlyDelimiter) {
        maskedLines.push(line);
        dataOnlyDelimiter = null;
      } else {
        maskedLines.push("<local-file-payload>");
      }
      continue;
    }

    const catIndex = line.search(/\bcat\b/);
    const catSegment = catIndex >= 0 ? line.slice(catIndex) : "";
    const delimiterMatch = catSegment.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_-]*)\1/);
    const redirectionWithoutHeredoc = delimiterMatch
      ? catSegment.replace(delimiterMatch[0], "")
      : "";
    const hasLocalFileRedirection = /(?:^|\s)>>?\s*[^\s;&|]+/.test(redirectionWithoutHeredoc);
    const unsafeDataSink =
      !delimiterMatch ||
      !hasLocalFileRedirection ||
      /[|`]|\$\(/.test(catSegment) ||
      /\/dev\/(?:tcp|udp)\//i.test(catSegment);
    if (!unsafeDataSink) {
      dataOnlyDelimiter = delimiterMatch[2];
    }
    maskedLines.push(line);
  }

  const withoutDataOnlyHeredocs = maskedLines.join("\n");
  return withoutDataOnlyHeredocs.replace(
    /(\.write_text\(\s*)([rub]*)("""|''')[\s\S]*?\3(\s*\))/gi,
    "$1$2$3<local-file-payload>$3$4",
  );
}

export function isLikelyNetworkShellCommand(command: string | undefined | null): boolean {
  const normalized = typeof command === "string" ? command.trim() : "";
  if (!normalized) return false;
  const executableText = maskLocalFilePayloads(normalized);
  return NETWORK_COMMAND_PATTERNS.some((pattern) => pattern.test(executableText));
}
