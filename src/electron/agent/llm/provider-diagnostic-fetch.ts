import { fetchWithPolicyCheckedRedirects } from "../../security/policy-checked-fetch";
import { readBoundedResponse } from "../../security/bounded-response";

export type ProviderDiagnosticFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Browser diagnostics keep their stricter address policy at the actual connection. */
export function browserProviderDiagnosticFetch(allowLoopback: boolean): ProviderDiagnosticFetch {
  return async (url, init = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new DOMException("Provider diagnostic timed out", "TimeoutError")),
      30_000,
    );
    const signal = init.signal
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal;
    try {
      const { response } = await fetchWithPolicyCheckedRedirects(
        url,
        { ...init, signal },
        {
          toolName: "provider_diagnostic",
          networkContext: { networkEnabled: true },
          allowLoopback,
          requirePinnedDestination: true,
        },
      );
      const body = await readBoundedResponse(
        response,
        4 * 1024 * 1024,
        "Provider diagnostic",
        signal,
      );
      return new Response([204, 205, 304].includes(response.status) ? null : new Uint8Array(body), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } finally {
      clearTimeout(timeout);
    }
  };
}
