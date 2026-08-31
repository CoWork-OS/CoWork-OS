import { AgentMailSettingsData } from "../../shared/types";

type AgentMailRequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
};

const DEFAULT_TIMEOUT_MS = 20000;

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export class AgentMailClient {
  readonly baseUrl: string;
  readonly websocketUrl: string;
  readonly timeoutMs: number;

  constructor(private readonly settings: AgentMailSettingsData) {
    this.baseUrl = stripTrailingSlash(settings.baseUrl || "https://api.agentmail.to/v0");
    this.websocketUrl = settings.websocketUrl || "wss://api.agentmail.to/v0/websocket";
    this.timeoutMs = settings.timeoutMs || DEFAULT_TIMEOUT_MS;
  }

  get apiKey(): string | undefined {
    return this.settings.apiKey;
  }

  private buildUrl(pathname: string, query?: AgentMailRequestOptions["query"]): string {
    const url = new URL(`${this.baseUrl}${pathname.startsWith("/") ? pathname : `/${pathname}`}`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value === null || value === undefined || value === "") continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async request<T>(pathname: string, options: AgentMailRequestOptions = {}): Promise<T> {
    if (!this.settings.apiKey) {
      throw new Error("AgentMail API key is not configured");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.buildUrl(pathname, options.query), {
        method: options.method || "GET",
        headers: {
          Authorization: `Bearer ${this.settings.apiKey}`,
          "Content-Type": "application/json",
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });

      const raw = await response.text();
      const payload = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;

      if (!response.ok) {
        const message =
          (payload && typeof payload.error === "string" && payload.error) ||
          (payload && typeof payload.message === "string" && payload.message) ||
          `${response.status} ${response.statusText}`;
        throw new Error(`AgentMail request failed: ${message}`);
      }

      return (payload || {}) as T;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`AgentMail request timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  listPods(limit = 100, pageToken?: string) {
    return this.request<{ pods?: unknown[]; count?: number; next_page_token?: string }>("/pods", {
      query: {
        limit,
        page_token: pageToken,
      },
    });
  }

  getPod(podId: string) {
    return this.request<Record<string, unknown>>(`/pods/${encodeURIComponent(podId)}`);
  }

  createPod(input: { name?: string; clientId?: string }) {
    return this.request<Record<string, unknown>>("/pods", {
      method: "POST",
      body: {
        name: input.name,
        client_id: input.clientId,
      },
    });
  }

  deletePod(podId: string) {
    return this.request<Record<string, unknown>>(`/pods/${encodeURIComponent(podId)}`, {
      method: "DELETE",
    });
  }

  listPodInboxes(podId: string, limit = 100, pageToken?: string) {
    return this.request<{ inboxes?: unknown[]; count?: number; next_page_token?: string }>(
      `/pods/${encodeURIComponent(podId)}/inboxes`,
      {
        query: {
          limit,
          page_token: pageToken,
        },
      },
    );
  }

  createPodInbox(
    podId: string,
    input: { username?: string; domain?: string; displayName?: string; clientId?: string },
  ) {
    return this.request<Record<string, unknown>>(`/pods/${encodeURIComponent(podId)}/inboxes`, {
      method: "POST",
      body: {
        username: input.username,
        domain: input.domain,
        display_name: input.displayName,
        client_id: input.clientId,
      },
    });
  }

  updateInbox(inboxId: string, input: { displayName: string }) {
    return this.request<Record<string, unknown>>(`/inboxes/${encodeURIComponent(inboxId)}`, {
      method: "PATCH",
      body: {
        display_name: input.displayName,
      },
    });
  }

  deleteInbox(inboxId: string) {
    return this.request<Record<string, unknown>>(`/inboxes/${encodeURIComponent(inboxId)}`, {
      method: "DELETE",
    });
  }

  listPodDomains(podId: string, limit = 100, pageToken?: string) {
    return this.request<{ domains?: unknown[]; count?: number; next_page_token?: string }>(
      `/pods/${encodeURIComponent(podId)}/domains`,
      {
        query: {
          limit,
          page_token: pageToken,
        },
      },
    );
  }

  createPodDomain(podId: string, input: { domain: string; feedbackEnabled: boolean }) {
    return this.request<Record<string, unknown>>(`/pods/${encodeURIComponent(podId)}/domains`, {
      method: "POST",
      body: {
        domain: input.domain,
        feedback_enabled: input.feedbackEnabled,
      },
    });
  }

  verifyPodDomain(podId: string, domainId: string) {
    return this.request<Record<string, unknown>>(
      `/pods/${encodeURIComponent(podId)}/domains/${encodeURIComponent(domainId)}/verify`,
      {
        method: "POST",
      },
    );
  }

  deletePodDomain(podId: string, domainId: string) {
    return this.request<Record<string, unknown>>(
      `/pods/${encodeURIComponent(podId)}/domains/${encodeURIComponent(domainId)}`,
      {
        method: "DELETE",
      },
    );
  }

  listPodThreads(
    podId: string,
    input: {
      limit?: number;
      pageToken?: string;
      after?: string;
      includeSpam?: boolean;
      includeBlocked?: boolean;
      includeTrash?: boolean;
    } = {},
  ) {
    return this.request<{ threads?: unknown[]; count?: number; next_page_token?: string }>(
      `/pods/${encodeURIComponent(podId)}/threads`,
      {
        query: {
          limit: input.limit ?? 50,
          page_token: input.pageToken,
          after: input.after,
          include_spam: input.includeSpam,
          include_blocked: input.includeBlocked,
          include_trash: input.includeTrash,
        },
      },
    );
  }

  getPodThread(podId: string, threadId: string) {
    return this.request<Record<string, unknown>>(
      `/pods/${encodeURIComponent(podId)}/threads/${encodeURIComponent(threadId)}`,
    );
  }

  getAttachment(inboxId: string, messageId: string, attachmentId: string) {
    return this.request<Record<string, unknown>>(
      `/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    );
  }

  updateMessage(
    inboxId: string,
    messageId: string,
    input: { addLabels?: string[]; removeLabels?: string[] },
  ) {
    return this.request<Record<string, unknown>>(
      `/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}`,
      {
        method: "PATCH",
        body: {
          add_labels: input.addLabels,
          remove_labels: input.removeLabels,
        },
      },
    );
  }

  replyAllMessage(
    inboxId: string,
    messageId: string,
    input: { text?: string; html?: string; subject?: string; labels?: string[] },
  ) {
    return this.request<Record<string, unknown>>(
      `/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}/reply-all`,
      {
        method: "POST",
        body: {
          text: input.text,
          html: input.html,
          subject: input.subject,
          reply_all: true,
          labels: input.labels,
        },
      },
    );
  }

  listLists(direction: "send" | "receive" | "reply", listType: "allow" | "block", limit = 100) {
    return this.request<{ entries?: unknown[]; count?: number }>(
      `/lists/${direction}/${listType}`,
      {
        query: {
          limit,
        },
      },
    );
  }

  createListEntry(
    direction: "send" | "receive" | "reply",
    listType: "allow" | "block",
    input: { entry: string; reason?: string },
  ) {
    return this.request<Record<string, unknown>>(`/lists/${direction}/${listType}`, {
      method: "POST",
      body: {
        entry: input.entry,
        reason: input.reason,
      },
    });
  }

  deleteListEntry(
    direction: "send" | "receive" | "reply",
    listType: "allow" | "block",
    entry: string,
  ) {
    return this.request<Record<string, unknown>>(`/lists/${direction}/${listType}`, {
      method: "DELETE",
      body: {
        entry,
      },
    });
  }

  listInboxLists(
    inboxId: string,
    direction: "send" | "receive" | "reply",
    listType: "allow" | "block",
    limit = 100,
  ) {
    return this.request<{ entries?: unknown[]; count?: number }>(
      `/inboxes/${encodeURIComponent(inboxId)}/lists/${direction}/${listType}`,
      {
        query: {
          limit,
        },
      },
    );
  }

  createInboxListEntry(
    inboxId: string,
    direction: "send" | "receive" | "reply",
    listType: "allow" | "block",
    input: { entry: string; reason?: string },
  ) {
    return this.request<Record<string, unknown>>(
      `/inboxes/${encodeURIComponent(inboxId)}/lists/${direction}/${listType}`,
      {
        method: "POST",
        body: {
          entry: input.entry,
          reason: input.reason,
        },
      },
    );
  }

  deleteInboxListEntry(
    inboxId: string,
    direction: "send" | "receive" | "reply",
    listType: "allow" | "block",
    entry: string,
  ) {
    return this.request<Record<string, unknown>>(
      `/inboxes/${encodeURIComponent(inboxId)}/lists/${direction}/${listType}`,
      {
        method: "DELETE",
        body: {
          entry,
        },
      },
    );
  }

  listInboxApiKeys(inboxId: string) {
    return this.request<{ api_keys?: unknown[]; count?: number }>(
      `/inboxes/${encodeURIComponent(inboxId)}/api-keys`,
    );
  }

  createInboxApiKey(
    inboxId: string,
    input: { name?: string; permissions?: Record<string, boolean> },
  ) {
    return this.request<Record<string, unknown>>(
      `/inboxes/${encodeURIComponent(inboxId)}/api-keys`,
      {
        method: "POST",
        body: {
          name: input.name,
          permissions: input.permissions,
        },
      },
    );
  }

  deleteInboxApiKey(inboxId: string, apiKeyId: string) {
    return this.request<Record<string, unknown>>(
      `/inboxes/${encodeURIComponent(inboxId)}/api-keys/${encodeURIComponent(apiKeyId)}`,
      {
        method: "DELETE",
      },
    );
  }
}
