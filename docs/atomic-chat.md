# Atomic Chat inference backend

CoWork OS can optionally use an already-running [Atomic Chat](https://atomic.chat/)
instance as an inference backend. This is an inference adapter, not an Atomic
agent integration.

## What CoWork owns

CoWork continues to own the task loop, system prompt, tool visibility,
permissions, approvals, network/file restrictions, tool scheduling, evidence,
cancellation, retries, and task persistence. Atomic Chat only receives the
OpenAI-compatible model request and returns a completion.

CoWork does not start or stop Atomic Chat, install models, manage its model
picker, or import Atomic Agent's tool loop.

## Setup

1. Start Atomic Chat and load a model.
2. In CoWork Settings, select **Atomic Chat (local)**.
3. Leave the API key empty unless Atomic Chat proxy authentication is enabled.
4. Keep the default endpoint `http://127.0.0.1:1337/v1`, or enter the endpoint
   exposed by the running instance.
5. Refresh models and select the exact model ID returned by Atomic Chat.

The adapter probes `GET /v1/models` with a five-second discovery deadline. The
Settings refresh action preserves the saved model selection and reports whether
the endpoint is unreachable, rejected authentication, returned a valid empty
catalogue, returned an incompatible payload, timed out, or returned exact model
IDs. An `auto` selection is resolved to the first reported loaded model
immediately before inference. Inference requests are non-streaming for this
initial integration and have a 60-second deadline. These defaults can be
overridden by the provider implementation in tests; they are not a
model-installation or server-startup timeout.

Refresh Models updates the draft model list only after a valid response. If the
endpoint is unavailable or returns an empty/incompatible catalogue, CoWork
keeps the existing saved model selection instead of silently replacing it.
Test Connection performs a small non-streaming request against the selected
model, so it can reach the server successfully while still reporting that the
server is temporarily busy or that the model is unavailable.

## Compatibility and failure behavior

Atomic Chat exposes an OpenAI-compatible `/v1/chat/completions` endpoint. CoWork
reuses its existing message and tool-call translation, then sends `stream: false`.
Tool arguments remain subject to CoWork's normal validation and permission
pipeline; malformed arguments become rejected tool results and are never
dispatched.

Discovery reports distinct outcomes for success, valid empty responses,
authentication rejection, invalid payloads, offline endpoints, cancellation,
and timeout. Inference errors are typed as cancellation, timeout,
unreachable, authentication, model unavailable, context limit, unsupported
parameter, invalid response/tool call, or temporary busy state. Cancellation is
terminal for the request and is not silently replaced with a fallback answer.

Atomic Chat's API surface can change between releases. Treat the selected
Atomic Chat version as part of qualification and re-run the local fixture/live
probe before enabling it for unattended tasks.

## Troubleshooting

- **No models or endpoint unavailable**: start Atomic Chat, confirm its local
  API port, then use **Refresh Models**. CoWork does not start the server or
  install a model for you.
- **Authentication rejected**: leave the key empty for an unauthenticated local
  server, or configure the proxy key in CoWork. The adapter sends the key as
  both bearer and `X-Api-Key` authentication.
- **Temporarily busy**: the server was reachable but could not accept the
  inference probe at that moment. Retry after the active generation finishes.
- **Invalid response or tool call**: the response did not match the
  OpenAI-compatible contract. CoWork rejects malformed tool arguments rather
  than dispatching them.

The initial integration has been validated for model discovery and typed
connection errors. A successful full-generation benchmark, streaming support,
and universal tool/model compatibility remain qualification work; do not infer
those guarantees from a successful `/v1/models` response alone.
