/** Shared consent classification for the registry and permission engine. */
export function httpPermissionContext(input: unknown) {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const method =
    obj.method !== undefined && typeof obj.method !== "string"
      ? "__invalid_method__"
      : typeof obj.method === "string" && obj.method.trim()
        ? obj.method.trim().toUpperCase()
        : "GET";
  const hasBody = obj.body !== undefined && obj.body !== null && obj.body !== "";
  // The HTTP sink spreads headers into an object. Mirror that representation
  // even for malformed arrays/strings so their enumerable keys cannot become
  // unapproved outbound headers.
  const headers = obj.headers == null ? [] : Object.keys(Object(obj.headers));
  const hasCustomHeaders = headers.some(
    (key) => !["accept", "accept-language", "user-agent"].includes(key.toLowerCase()),
  );
  const credentialId = typeof obj.credentialId === "string" ? obj.credentialId.trim() : "";
  return { method, hasBody, hasCustomHeaders, ...(credentialId ? { credentialId } : {}) };
}

export function isReadOnlyHttpRequestInput(input: unknown): boolean {
  const context = httpPermissionContext(input);
  return (
    (context.method === "GET" || context.method === "HEAD") &&
    !context.hasBody &&
    !context.hasCustomHeaders
  );
}
