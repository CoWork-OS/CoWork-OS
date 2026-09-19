/** Resolve either a full endpoint or a provider base URL while retaining defaults. */
export function resolveDecisionEndpoint(
  endpoint: string | undefined,
  baseUrl: string | undefined,
  defaultEndpoint: string,
  endpointPath: string,
): string {
  const explicitEndpoint = endpoint?.trim();
  if (explicitEndpoint) return explicitEndpoint;

  const explicitBaseUrl = baseUrl?.trim().replace(/\/+$/, "");
  if (!explicitBaseUrl) return defaultEndpoint;

  const normalizedEndpointPath = endpointPath.toLowerCase();
  const normalizedBaseUrl = explicitBaseUrl.toLowerCase();
  if (normalizedBaseUrl.endsWith(normalizedEndpointPath)) return explicitBaseUrl;

  const lastSlash = endpointPath.lastIndexOf("/");
  const parentPath = endpointPath.slice(0, lastSlash).toLowerCase();
  const leafPath = endpointPath.slice(lastSlash + 1);
  if (parentPath && normalizedBaseUrl.endsWith(parentPath)) {
    return `${explicitBaseUrl}/${leafPath}`;
  }
  return `${explicitBaseUrl}${endpointPath}`;
}
