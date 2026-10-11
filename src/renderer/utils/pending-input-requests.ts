import type { InputRequest } from "../../shared/types";

/**
 * Open input requests after re-reading them from the main process, which is the source of
 * truth. Listed requests replace the renderer's copy, so a card answered elsewhere or missed
 * by a live event is corrected. A request the renderer learned about after the list was
 * requested is kept: the list may predate it.
 */
export function reconcilePendingInputRequests(
  listed: InputRequest[],
  current: Map<string, InputRequest>,
  listRequestedAt: number,
): Map<string, InputRequest> {
  const next = new Map<string, InputRequest>();
  for (const request of listed) {
    if (request?.id && request.status === "pending") next.set(request.id, request);
  }
  for (const [id, request] of current) {
    if (!next.has(id) && request.status === "pending" && request.requestedAt >= listRequestedAt) {
      next.set(id, request);
    }
  }
  return next;
}
