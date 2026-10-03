/**
 * "Open in Memory Hub" from elsewhere in the app (the per-reply "Memory used" list): the
 * caller records which item to show, then opens Settings > Memory; the Hub selects the
 * request's workspace (the task's), and the "What CoWork knows" tab takes the request when
 * it loads and filters to that item.
 */
export interface MemoryHubFocusRequest {
  itemId: string;
  /** Text the tab's search is set to, so the item is in the first page. */
  query: string;
  /** The workspace the Hub should show (the task's workspace). */
  workspaceId?: string;
}

let pending: MemoryHubFocusRequest | null = null;

export function requestMemoryHubFocus(request: MemoryHubFocusRequest): void {
  const workspaceId = request.workspaceId?.trim();
  pending = {
    itemId: request.itemId,
    query: request.query.replace(/\s+/g, " ").trim().slice(0, 80),
    ...(workspaceId ? { workspaceId } : {}),
  };
}

/** The workspace a pending request wants the Hub to show, without taking the request. */
export function peekMemoryHubFocusWorkspace(): string | null {
  return pending?.workspaceId ?? null;
}

/**
 * The pending request, once (the tab clears it as it applies it). A request for another
 * workspace is dropped rather than applied to the wrong list.
 */
export function takeMemoryHubFocus(workspaceId?: string): MemoryHubFocusRequest | null {
  const request = pending;
  pending = null;
  if (request?.workspaceId && workspaceId && request.workspaceId !== workspaceId) return null;
  return request;
}
