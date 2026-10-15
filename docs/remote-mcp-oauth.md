# Remote MCP servers with OAuth (Workday and others)

CoWork can connect to remote MCP servers that require an OAuth 2.1 sign-in, such as Workday Agent-Ready Tools. Their tools then work like any other connector: in desktop tasks, in headless runs, and under the same tool policy and approvals.

## Add a server

**Settings > MCP Servers > + Add Server > Remote (OAuth)**

- **Workday Agent-Ready Tools:** enter the agent gateway region (for example `us` for `us.agent.workday.com`; Workday Developer Program tenants use `odp`) and your tenant name. CoWork derives:
  - MCP endpoint: `https://{region}.agent.workday.com/{tenant}/mcp`
  - Authorize endpoint: `/auth/authorize/{tenant}`
  - Token endpoint: `/auth/oauth2/{tenant}/token`
- **Other OAuth 2.1 MCP servers:** enter the MCP URL, authorization URL and token URL. **Discover from server** fills them in when the server publishes RFC 9728 protected-resource metadata and RFC 8414 or OpenID authorization-server metadata.

Then choose an identity:

| Identity | How it signs in | When to use it |
| --- | --- | --- |
| **Sign in as a person** (delegate) | Authorization code with PKCE (S256). A browser opens once; the provider redirects to a loopback address on this Mac. | The agent acts with that person's permissions and never more. Refresh tokens keep it working without further prompts. |
| **Agent key** (ambient) | JWT bearer assertion (RFC 7523), signed RS256 or ES256 with the agent's private key. | Fully headless: no person and no browser. |

For delegate sign-in, register the redirect URI with the provider exactly as shown: `http://127.0.0.1:18768/oauth/callback` for custom servers, or `https://127.0.0.1:18768/oauth/callback` for Workday. You can enter a different `http` or `https` loopback address (`127.0.0.1`, `[::1]` or `localhost`) with an explicit port if you need one. An https redirect is served with a self-signed certificate generated in memory for each sign-in and never saved, so the browser shows a certificate warning for 127.0.0.1 once per sign-in; accept it to finish signing in. Client secrets, private keys and tokens are stored encrypted.

**Add and sign in** saves the server, signs it in, and connects it. **Sign in** on a server row signs in again, for example after a refresh token expires.

**Edit** on a server row opens the same form with the saved settings. Secret fields start empty: leave a client secret or private key blank to keep the saved one, or type a new one to replace it. Changing the identity, endpoints, client ID, secret, redirect URI or scopes signs the server out (its tokens are deleted and it disconnects), so the next sign-in uses the new settings and earlier tool-call approvals are asked again. A rename keeps the sign-in. **Save and sign in** saves and starts the sign-in straight away.

While a sign-in waits for the browser, **Cancel** next to **Signing in...** stops it and frees the redirect port. Starting a new sign-in on the same redirect port replaces CoWork's own pending one; only a port held by another app reports "port is in use". A cancelled or replaced sign-in ends quietly, without an error.

## Runtime behavior

- **Token lifetime:** access tokens are renewed shortly before they expire, either from the refresh token or by signing a new assertion. `expires_in` is accepted as a number or a numeric string.
- **401 handling:** after a 401 the token is renewed once and the request is resent. A 401 means the server ran nothing, so this applies to tool calls too.
- **Sign-in required:** a credential that can't be renewed (no token, refresh token rejected or expired) stops with "needs authorization", and the server row shows the error. No request is sent without a credential.
- **Authorized calls only:** every renewal is recorded as a refresh proof, so a tool call approved under one token continues with the renewed token. A manual edit to the server's settings still invalidates earlier approvals.
- **Rate limits:** a 429 response is retried after `Retry-After` (at most 30 s, at most two retries). A 503 is retried for discovery and listing, but a tool call is never resent after a 503, because the server may already have acted.
- **Large catalogs:** a server with more than 25 tools (Workday has 400+) doesn't add every schema to every request. Its tools load on demand through `tool_search`, and `tool_search` lists such servers so the agent knows to search by business task.
- **Tool names across servers:** a tool name offered by one server keeps its plain name (`mcp_<tool>`). A name that several connected servers offer is namespaced on every one of them (`mcp_<server>__<tool>`), so calls never depend on which server connected first, and calling the bare name returns the namespaced options. Per-tool approval settings stay keyed by the server's own tool name.
- **Legacy SSE servers:** credentials are sent as `Authorization` or API-key headers on the event stream and on every message, never in the URL. A redirect is followed only within the configured origin. A server that can only read a query token can opt in with `auth.sendTokenInQuery`; this applies to the stream request only and is off by default, because proxies and server logs record URLs.
- **Write approvals:** new remote OAuth servers default to running read-only tools without prompts and asking before any tool that can change data. The approval card names the server and shows the call's arguments exactly as they will be sent, so you decide on the actual change. Approval needs an access profile that asks (**Ask for approval** or **Approve for me**): under **Full access**, which never asks, a tool that requires consent is blocked instead of prompted.

## Headless use

Token renewal is plain Node and needs neither Electron nor a browser, so it runs in the desktop app, in `--headless` runs and in the daemon. An agent-key identity works entirely without a person. A delegate identity needs one sign-in in the desktop app; after that the stored refresh token keeps it working headless until the refresh token expires (24 hours for Workday unless it is used).

## In-app Workday agent setup

A Workday server signs in as an external agent, and that agent's skills decide which Workday tools CoWork can use. **Agent setup** on a Workday server row (servers added with the Workday preset) registers or updates the agent in the tenant's Agent System of Record (ASOR) without scripts.

**Admin client.** Agent setup signs in with a separate Workday admin API client, not the agent's own client. In Workday, run **Register API Client** with:

- Grant type: Authorization Code.
- Scopes: **Agent System of Record** and **Workday Owned Scope**.
- Redirect URI: `https://127.0.0.1:18768/oauth/callback`.
- PKCE: optional. Tick **Use PKCE** in CoWork only if the client has PKCE enabled.

**Hosts.** Enter the tenant host you sign in to Workday at, for example `impl.wd5.myworkday.com`. CoWork derives the services host by adding `-services1` to its first label (`impl-services1.wd5.myworkday.com`); change it only if your tenant uses another one. Both must be https hosts under `myworkday.com` or `workday.com`. The agent gateway (`<region>.agent.workday.com`) is refused here, because it rejects tenant-issued tokens.

**What it does.**

1. **Sign in** saves the connection and opens the tenant's `/<tenant>/authorize` page; the code is exchanged at `https://<services host>/ccx/oauth2/<tenant>/token`. The admin token stays in memory only, for this session, and is never saved, logged or shown. The admin client secret is stored encrypted with the server's settings; leave the field blank to keep it.
2. The panel lists the tenant's agent definitions. Pick one, or **New agent** (named CoWork by default).
3. Search the tool catalog. MCP tools (snake_case names such as `find_absence_balances`) are shown by default; **Include SOAP and REST operations** shows the rest of the catalog. **Add** grants a tool to the chosen skill; skills have an ID, a name, a description and an execution mode (Delegate by default, or Ambient).
4. **Save agent** first checks every tool's WID against the tenant's catalog. If any is missing, nothing is saved and the panel lists them. Otherwise CoWork posts the definition to `https://<services host>/ccx/api/asor/v1/<tenant>/agentDefinition`, which creates it or updates the one with the same name and version, and shows Workday's agent ID and tool count.

Tools whose names start with `create_`, `update_`, `delete_`, `submit_` or `request_` change Workday data; CoWork asks for approval before running them.

**Sign in again after changing tools.** A Workday token carries the tools the agent had when it was issued. After a save, sign the Workday server in again (the panel has a button for it) so CoWork sees the new tools.

## Workday setup checklist

1. Join the Workday Developer Program and submit **Request Tenant Access** for a personal development tenant. Workday reviews the request and emails the tenant's sign-in details when it is ready; change the temporary password promptly (Workday asks for it within 72 hours).
2. Create the external agent's credentials in the tenant (Workday documents this under **Agents > External Agents**) and copy its client ID and secret from **View External Agent Credentials**. For a delegate identity, register `https://127.0.0.1:18768/oauth/callback`; Workday rejects `http://` redirect URIs for authorization-code clients.
3. In CoWork, add a **Remote (OAuth)** server with the Workday preset. Developer Program tenants are served by `odp.agent.workday.com` (region `odp`), even when the agent's Credentials tab lists `us.agent.workday.com`. The wrong region answers every request for the tenant with `{"error":"Invalid request"}`; a quick check is `https://<region>.agent.workday.com/.well-known/oauth-authorization-server/<tenant>`, which returns metadata only on the right region.
4. Open **Agent setup** on the server row, sign in with an admin API client, and give the agent its skills and tools (see [In-app Workday agent setup](#in-app-workday-agent-setup)). If a skill needs a worker ID, add a tool that resolves the signed-in worker too (for example, `create_worker_preferred_name_change` requires `workersId`).
5. **Sign in** on the server row. Expect a certificate warning for 127.0.0.1 in the browser on each sign-in; accept it to finish.
6. Ask CoWork for something that needs Workday data, for example "What is my time off balance?". The agent finds the right Workday tool through `tool_search`.
7. To try a write, set the task's Access to **Ask for approval** and ask for a change, for example a preferred-name change. Workday validates the whole proposed name, not only the field you change: `create_worker_preferred_name_change` needs `proposedName.firstName`, `proposedName.lastName` and `proposedName.country` as a reference with an `id` (the country's WID; an ISO code alone is rejected with `S25`, and a missing field with `A6`). A request that worked on a Developer tenant:

   ```json
   {
     "workersId": "<worker WID from find_staffing_workers>",
     "proposedName": {
       "firstName": "Logan Test",
       "lastName": "McNeil",
       "country": { "id": "bc33aa3152ec42d4995f4791a106ed09" }
     }
   }
   ```

   `bc33aa3152ec42d4995f4791a106ed09` is the United States in Workday's demo data; check the country WID in your own tenant. Workday answers with the business process and its status (`Successfully Completed`).

Implementation: `src/electron/mcp/oauth/mcp-oauth.ts` (flows, loopback listener, renewal, discovery), `src/electron/mcp/oauth/mcp-server-authorization.ts` (server setup, edit, sign-in and cancel), `src/electron/mcp/oauth/workday-agent-setup.ts` (admin sign-in and ASOR agent setup), `src/electron/ipc/mcp-oauth-handlers.ts` and `src/electron/ipc/workday-agent-handlers.ts` (IPC), and `src/electron/mcp/client/transports/StreamableHttpTransport.ts` (renewal, 401 and rate-limit handling).
