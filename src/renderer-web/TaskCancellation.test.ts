import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserHostTransport, WebTransportError } from "./transport";
import { readPendingCancellation, requestTaskCancellation } from "./TaskCancellation";

afterEach(() => vi.unstubAllGlobals());

describe("browser task cancellation recovery", () => {
  it("reuses the saved key after an uncertain reply and retains it after stale state", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });

    const storageKey = "cowork:web:task-cancel:install:profile:workspace:task-1";
    const saved = {
      key: "cancel-stable-request-1",
      expectedStatus: "executing",
      expectedUpdatedAt: 42,
      submitted: true,
    };
    values.set(storageKey, JSON.stringify(saved));

    const request = vi.fn();
    request.mockRejectedValueOnce(
      new WebTransportError({
        code: "OUTCOME_UNKNOWN",
        message: "The reply was lost.",
        retryable: true,
      }),
    );
    request.mockResolvedValueOnce({
      taskId: "task-1",
      workspaceId: "workspace",
      operationKey: saved.key,
      outcome: "pending",
      status: "executing",
      updatedAt: 42,
    });
    request.mockRejectedValueOnce(
      new WebTransportError({
        code: "STALE_STATE",
        message: "The task changed.",
        retryable: false,
      }),
    );
    const transport = { request } as unknown as BrowserHostTransport;

    const firstAttempt = readPendingCancellation(storageKey);
    expect(firstAttempt).toEqual(saved);
    await expect(
      requestTaskCancellation(transport, "task-1", "workspace", firstAttempt!),
    ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });

    const retryAttempt = readPendingCancellation(storageKey);
    expect(retryAttempt).toEqual(saved);
    await requestTaskCancellation(transport, "task-1", "workspace", retryAttempt!);

    const staleAttempt = readPendingCancellation(storageKey);
    expect(staleAttempt).toEqual(saved);
    await expect(
      requestTaskCancellation(transport, "task-1", "workspace", staleAttempt!),
    ).rejects.toMatchObject({ code: "STALE_STATE" });
    expect(readPendingCancellation(storageKey)).toEqual(saved);

    expect(request.mock.calls.map(([, params, options]) => ({ params, options }))).toEqual(
      Array.from({ length: 3 }, () => ({
        params: {
          taskId: "task-1",
          workspaceId: "workspace",
          expectedStatus: "executing",
          expectedUpdatedAt: 42,
        },
        options: {
          operationKey: saved.key,
          mutation: true,
          timeoutMs: 120_000,
        },
      })),
    );
  });
});
