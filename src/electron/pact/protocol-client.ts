/**
 * PACT wire calls over CoWork's transport: RFC 8628 device authorization and token requests,
 * refresh, and `message:send`. The upstream client's response handling is reused from
 * ./upstream/client-delegation; only the network layer differs (policy-aware, no global fetch).
 */
import {
  DELEGATION_HEADER,
  DEVICE_CODE_GRANT_TYPE,
  REFRESH_TOKEN_GRANT_TYPE,
  formatScope,
} from "./upstream/delegation";
import {
  readBody,
  throwForOAuthResponse,
  toDelegationToken,
  toDeviceAuthorization,
  interpretSendResponse,
  type DelegatedSendResult,
  type DelegationToken,
  type DeviceAuthorization,
} from "./upstream/client-delegation";
import type { PactTransport } from "./transport";

export interface PactClientCredentials {
  /** Personal-agent JWT for this provider's audience. */
  paJwt: string;
  /** `client_id` must equal the issuer URL. */
  clientId: string;
}

async function postForm(
  transport: PactTransport,
  purpose: "device_authorization" | "token",
  url: string,
  params: Record<string, string>,
  credentials: PactClientCredentials,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await transport.request({
    purpose,
    method: "POST",
    url,
    headers: {
      Authorization: `Bearer ${credentials.paJwt}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ ...params, client_id: credentials.clientId }).toString(),
    ...(signal ? { signal } : {}),
  });
  const body = readBody(response.bodyText);
  if (response.status >= 200 && response.status < 300) return body;
  throwForOAuthResponse(response.status, body, response.headers.get("www-authenticate"));
}

export async function requestDeviceAuthorization(
  transport: PactTransport,
  input: {
    url: string;
    scopes: readonly string[];
    credentials: PactClientCredentials;
    now: number;
  },
): Promise<DeviceAuthorization> {
  const body = await postForm(
    transport,
    "device_authorization",
    input.url,
    { scope: formatScope(input.scopes) },
    input.credentials,
  );
  return toDeviceAuthorization(body, input.now);
}

export async function requestDeviceToken(
  transport: PactTransport,
  input: {
    url: string;
    deviceCode: string;
    credentials: PactClientCredentials;
    now: () => number;
    signal?: AbortSignal;
  },
): Promise<DelegationToken> {
  const body = await postForm(
    transport,
    "token",
    input.url,
    { grant_type: DEVICE_CODE_GRANT_TYPE, device_code: input.deviceCode },
    input.credentials,
    input.signal,
  );
  return toDelegationToken(body, input.now());
}

export async function refreshDelegationToken(
  transport: PactTransport,
  input: {
    url: string;
    refreshToken: string;
    credentials: PactClientCredentials;
    now: () => number;
  },
): Promise<DelegationToken> {
  const body = await postForm(
    transport,
    "token",
    input.url,
    { grant_type: REFRESH_TOKEN_GRANT_TYPE, refresh_token: input.refreshToken },
    input.credentials,
  );
  return toDelegationToken(body, input.now());
}

export interface PactWireMessage {
  messageId: string;
  contextId?: string;
  text: string;
}

/** The exact JSON CoWork sends: one text part, role user, no files or data parts. */
export function buildSendBody(message: PactWireMessage): string {
  return JSON.stringify({
    message: {
      messageId: message.messageId,
      ...(message.contextId === undefined ? {} : { contextId: message.contextId }),
      role: "ROLE_USER",
      parts: [{ text: message.text, mediaType: "text/plain" }],
    },
  });
}

export async function sendPactMessage(
  transport: PactTransport,
  input: {
    interfaceUrl: string;
    message: PactWireMessage;
    paJwt: string;
    delegationToken?: string;
    signal?: AbortSignal;
  },
): Promise<DelegatedSendResult> {
  const url = `${input.interfaceUrl.replace(/\/+$/, "")}/message:send`;
  const response = await transport.request({
    purpose: "message",
    method: "POST",
    url,
    headers: {
      Authorization: `Bearer ${input.paJwt}`,
      ...(input.delegationToken ? { [DELEGATION_HEADER]: `Bearer ${input.delegationToken}` } : {}),
    },
    body: buildSendBody(input.message),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return interpretSendResponse({
    status: response.status,
    body: readBody(response.bodyText),
    wwwAuthenticate: response.headers.get("www-authenticate"),
    sentDelegationToken: Boolean(input.delegationToken),
  });
}
