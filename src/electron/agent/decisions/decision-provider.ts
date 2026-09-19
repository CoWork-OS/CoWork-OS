import type {
  DecisionConnectionResult,
  DecisionRequestOptions,
  JevRequest,
  JevResponse,
} from "./types";
import {
  DecisionClientError,
  DecisionHttpClient,
  type DecisionHttpClientOptions,
} from "./http-client";
import { normalizeJevResponse } from "./normalization";
import { createJevRequestPayload } from "./validation";

export interface DecisionProvider {
  decide(request: JevRequest, options?: DecisionRequestOptions): Promise<JevResponse>;
  testConnection(options?: DecisionRequestOptions): Promise<DecisionConnectionResult>;
  health(options?: DecisionRequestOptions): Promise<DecisionConnectionResult>;
}

export interface HttpDecisionProviderOptions extends Omit<
  DecisionHttpClientOptions,
  "endpoint" | "providerName"
> {
  endpoint: string;
  providerName: string;
  defaultModel: string;
}

/** Base for provider-specific Jev transports using the shared HTTP behavior. */
export abstract class HttpDecisionProvider implements DecisionProvider {
  readonly defaultModel: string;
  readonly providerName: string;
  protected readonly http: DecisionHttpClient;

  protected constructor(options: HttpDecisionProviderOptions) {
    this.defaultModel = options.defaultModel;
    this.providerName = options.providerName;
    this.http = new DecisionHttpClient(options);
  }

  async decide(request: JevRequest, options?: DecisionRequestOptions): Promise<JevResponse> {
    const payload = createJevRequestPayload(request, this.defaultModel);
    const rawResponse = await this.http.post<unknown>(payload, options);
    return normalizeJevResponse(rawResponse, payload, this.providerName);
  }

  /**
   * Perform a minimal live decision request through the configured transport.
   * This is intentionally a request-level health check because neither endpoint
   * exposes a provider-independent unauthenticated health route.
   */
  async testConnection(options?: DecisionRequestOptions): Promise<DecisionConnectionResult> {
    try {
      const response = await this.decide(
        {
          state: "CoWork Jev transport connection test",
          questions: {
            connection: {
              type: "noul",
              instructions: "Is this a connection test?",
            },
          },
        },
        options,
      );
      return {
        success: true,
        model: response.model,
        provider: response.provider,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "The decision provider connection failed.",
        status: error instanceof DecisionClientError ? error.status : undefined,
      };
    }
  }

  async health(options?: DecisionRequestOptions): Promise<DecisionConnectionResult> {
    return this.testConnection(options);
  }
}
