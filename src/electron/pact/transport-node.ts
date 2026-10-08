/**
 * The production PolicyCheckedHttp: the shared policy-aware client (network policy and a pinned,
 * internal-address-checked socket per hop) plus a deadline and a bounded body read.
 */
import { readBoundedResponse } from "../security/bounded-response";
import {
  fetchWithPolicyCheckedRedirects,
  PolicyCheckedFetchError,
  type NetworkPolicyContext,
} from "../security/policy-checked-fetch";
import type { NetworkPolicyDecision } from "../security/network-policy";
import { PactTransport, PactTransportError, type PactHttpResponse, type PolicyCheckedHttp } from "./transport";

const PACT_TOOL_NAME = "pact";

const DESTINATION_REFUSED = [
  /Refusing to connect/i,
  /Internal destination refused/i,
  /resolves to an internal or missing address/i,
  /environment proxies/i,
  /ENOTFOUND|EAI_AGAIN|ENODATA/,
  /Only HTTP and HTTPS URLs are supported/i,
];

function mapError(error: unknown, timedOut: boolean, callerAborted: boolean): PactTransportError {
  if (error instanceof PactTransportError) return error;
  if (error instanceof PolicyCheckedFetchError) {
    switch (error.code) {
      case "policy_denied":
        return new PactTransportError("policy_denied", error.message);
      case "unsupported_scheme":
        return new PactTransportError("invalid_url", error.message);
      case "too_many_redirects":
        return new PactTransportError("too_many_redirects", error.message);
      case "cross_origin_body":
        return new PactTransportError("redirect_not_allowed", error.message);
    }
  }
  if (timedOut) return new PactTransportError("timeout", "The request timed out");
  if (callerAborted) return new PactTransportError("aborted", "The request was cancelled");
  const message = error instanceof Error ? error.message : String(error);
  if (/exceeds the \d+-byte limit/.test(message)) {
    return new PactTransportError("too_large", "The response is larger than CoWork accepts");
  }
  if (error instanceof TypeError && /Invalid URL/i.test(message)) {
    return new PactTransportError("invalid_url", "The URL is not valid");
  }
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && /^(ENOTFOUND|EAI_AGAIN|ENODATA)$/.test(code)) {
    return new PactTransportError("destination_refused", "The destination could not be resolved");
  }
  if (DESTINATION_REFUSED.some((pattern) => pattern.test(message))) {
    return new PactTransportError("destination_refused", "The destination is not allowed");
  }
  return new PactTransportError("network", "The network request failed");
}

export function createPolicyCheckedHttp(options: {
  networkContext: NetworkPolicyContext;
  onDecision?: (decision: NetworkPolicyDecision) => void;
}): PolicyCheckedHttp {
  return {
    async fetch(input): Promise<PactHttpResponse> {
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error("timeout"));
      }, input.timeoutMs);
      const onAbort = () => controller.abort(input.signal?.reason);
      if (input.signal?.aborted) controller.abort(input.signal.reason);
      input.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const { response, finalUrl, chain } = await fetchWithPolicyCheckedRedirects(
          input.url,
          {
            method: input.method,
            headers: input.headers,
            ...(input.body === undefined ? {} : { body: input.body }),
            signal: controller.signal,
          },
          {
            toolName: PACT_TOOL_NAME,
            networkContext: options.networkContext,
            followRedirects: input.maxRedirects > 0,
            maxRedirects: input.maxRedirects,
            // A cross-origin GET redirect keeps no caller header except Accept.
            publicHeaders: { Accept: input.headers.Accept ?? "application/json" },
            ...(options.onDecision ? { onDecision: options.onDecision } : {}),
          },
        );
        const bytes = await readBoundedResponse(response, input.maxBytes, "PACT response", controller.signal);
        return {
          status: response.status,
          headers: { get: (name: string) => response.headers.get(name) },
          bodyText: new TextDecoder().decode(bytes),
          url: finalUrl,
          chain,
        };
      } catch (error) {
        throw mapError(error, timedOut, Boolean(input.signal?.aborted));
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

export function createPactTransport(options: {
  networkContext: NetworkPolicyContext;
  onDecision?: (decision: NetworkPolicyDecision) => void;
}): PactTransport {
  return new PactTransport(createPolicyCheckedHttp(options));
}
