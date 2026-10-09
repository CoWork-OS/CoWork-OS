# PACT Business Agents

CoWork OS can act as a **PACT personal agent**: when you ask CoWork to do something with a
business (check an order, cancel a booking), it can talk to that business's own agent, with your
identity and, when the business offers it, only the account permissions you approve on the
business's own sign-in page.

PACT is an open protocol on top of A2A 1.0 ([specification](https://github.com/openpactprotocol/openpactprotocol/blob/838c6bd1da9be39da04264e8b156dbb4e848a208/docs/spec.md)).
CoWork implements PACT 1.0, Identity and Delegated profiles, pinned to upstream commit
`838c6bd1da9be39da04264e8b156dbb4e848a208`. The vendored schemas live in
`src/electron/pact/upstream/` with their Apache-2.0 license and NOTICE.

Preference is never permission: routing a request to PACT does not authorize it. Every operation is
admitted locally, approved when it changes something, consented to at the business, and its reply
is checked for a signed receipt.

## What happens during a request

1. **Discovery.** CoWork fetches `https://{business domain}/.well-known/agent-card.json` (or a
   card URL you provide), following redirects to the business's provider. Every hop passes network
   policy and DNS pinning. CoWork records the full origin chain; the card's display name proves
   nothing. Discovery sends nothing about you.
2. **Local admission.** CoWork decides the effect class of the request (`inspect`, `change` or
   `unknown`) from the declared intent, the message text and the business's scope descriptions,
   taking the strongest. Every change, unknown effect, or use of a permission broader than the
   request needs your explicit approval of the full message, one request at a time: remembered
   rules, recurring approvals and permission modes never approve it. On the desktop, a request you
   start outside a task is confirmed in a native dialog; the browser and remote clients cannot
   pre-confirm it. Messages containing credentials, secrets or card numbers are refused. Only your
   own tasks can use PACT: sub-agents, bots, channel users, event hooks, API-created tasks and
   scheduled work cannot act with your identity or permissions.
3. **Business consent.** When the request needs account access, CoWork asks the business for only
   the scopes it needs. The task shows a **Sign in** card: **Open sign-in** opens the business's own
   login in your browser (CoWork never proxies, frames or watches it), and you can uncheck any
   permission there. **Cancel sign-in** stops the request. The task waits durably: a restart resumes
   the wait if it is still valid.
4. **Send.** Effectful requests go only into an established conversation (CoWork opens it with a
   neutral introduction), with the business permission attached. Every attempt is recorded before
   it is sent. The sign-in, token and refresh endpoints must be on the same origin as the business's
   agent, and the authorization server's issuer and keys on its metadata's origin; any change to
   them, or to the permission descriptions, ends the stored permissions for that business. Outside
   development, PACT never connects to loopback or private addresses.
5. **Evidence.** A reply sent under a business permission must carry a signed receipt. CoWork
   checks the signature against the business's published keys, that the receipt names your grant,
   account, CoWork's issuer and the business, that the permissions it reports are within what you
   granted, and that its timestamp is plausible. A missing or invalid receipt is reported as an
   unverified outcome and blocks further changes until you review it.

A verified receipt proves what the business reported, not that a refund settled.

## Outcomes you may see

| Outcome | Meaning |
| --- | --- |
| `replied` | The business answered; `evidence` tells you whether a receipt was verified |
| `needs_user_action` | Sign in with the business to continue |
| `denied` | You declined at the business, declined the local approval, or approved fewer permissions than needed |
| `outcome_unknown` | The request reached the business but the reply was lost. CoWork does not retry it another way; it can be reconciled later with the same message id |
| `blocked` | Policy, identity, provider readiness or a revoked permission stopped the request |
| `unsupported` | The business does not advertise a supported PACT 1.0 agent |

## Setting it up

Open **Settings > Connectors > PACT business agents**.

1. Turn on **Use PACT for business interactions**. This also sets the preference to
   **Prefer PACT** if you had not chosen one.
2. **Identity**: choose the signer deployment and enter the issuer URL and signer URL (see the
   [signer contract](pact-signer.md)). The signer credential is stored encrypted.
3. **Providers**: add each provider's origin and the **audience** it assigned to CoWork's issuer
   when you registered with it. A business card can never supply an audience.

`cowork pact status` shows the same readiness from the terminal.

### Preferences

| Preference | Behaviour |
| --- | --- |
| Prefer PACT | Use PACT when the business supports it and identity is ready; otherwise another route may be used within the task's existing authority |
| Require PACT | Business interactions use PACT or stop |
| Do not use PACT | PACT tools are not offered |

## Permissions and disconnect

Connected businesses and their permissions are listed in Settings and with `cowork pact grants`.
When a business asks for more permissions and you approve them for the same account, the new
permission replaces the narrower one (shown as `superseded` in `cowork pact grants`).
**Disconnect** deletes the stored permission immediately. PACT 1.0 has no revocation endpoint, so
the business is not notified; revoke it in the business's own account settings if you want the
business to forget it too. Grants expire (30 days at the reference provider); CoWork asks you to
sign in again when that happens.

## Administrators

Admin policy (`policies.json`):

```json
{
  "pact": {
    "enabled": true,
    "autoRoute": true,
    "blockedProviders": ["https://provider.example.com", "*.untrusted.example"]
  }
}
```

| Key | Effect |
| --- | --- |
| `pact.enabled` | `false` turns the adapter off for every profile |
| `pact.autoRoute` | `false` offers PACT tools only when a task mentions PACT or a business agent explicitly |
| `pact.blockedProviders` | Origins or host patterns CoWork never contacts over PACT, enforced on every send, poll and refresh |

Network policy (`runtime.network.*`), access-profile domain rules and the internal-address boundary
apply to every PACT request, including discovery redirects, provider metadata, JWKS and the signer.
Signer calls use the rules of the request they serve: the task's workspace, or the default access
profile for calls outside a task (Settings, the CLI, the Control Plane).

Support switch: `COWORK_PACT_DISABLED=1` disables the adapter for a process. The managed signer has
its own server-side disable, which works without a client release.

Disabling PACT keeps conversation history and receipts readable and leaves grants unusable until it
is turned on again or they are disconnected. CoWork never falls back to a weaker channel for an
action whose outcome is unknown.

## Control Plane

Methods (both the desktop and the Node daemon):

| Method | Scope |
| --- | --- |
| `pact.status`, `pact.settings.get`, `pact.business.list`, `pact.conversation.get`, `pact.conversation.list`, `pact.authorization.get`, `pact.authorization.list`, `pact.grant.list`, `pact.receipt.get` | `read` |
| `pact.business.discover` | `write` |
| `pact.conversation.send`, `pact.conversation.acknowledgeEvidence`, `pact.authorization.start`, `pact.authorization.signIn`, `pact.authorization.cancel`, `pact.grant.disconnect` | `operator` |
| `pact.settings.update`, `pact.identity.setCredential`, `pact.identity.deviceKey` | `admin` |

Results never contain tokens, device codes or signer credentials. `pact.authorization.signIn` is
the only method that returns a sign-in link. A send's `confirmed` flag is honoured only from an
`admin` client (the owner's own token). Remote callers act as the profile owner (the Control
Plane token is the owner's) and are recorded as the actor. Calls use the default access profile's
network rules; only an `admin` client may pass `workspaceId` to use a workspace's rules instead.
A paused sign-in that resumes after a restart keeps its task's own access-profile rules.

## CLI

```bash
cowork pact status
cowork pact discover example.com
cowork pact send --business <id> --message "Where is order A-1?" --effect inspect
cowork pact send --business <id> --message "Cancel order A-1" --effect change --scope orders:cancel,orders:read --yes
cowork pact grants
cowork pact disconnect <grantId>
cowork pact authorization wait <authorizationId>
```

`cowork run` prints the sign-in link when a task needs one and keeps waiting in an interactive
terminal. The link is printed only to an interactive terminal (anyone holding it could finish the
sign-in with their own account), never into piped output or logs. With `--exit-on-input`, or when output is not a terminal, it exits with code **3**
(`needs user action`); resume with `cowork pact authorization wait <id>`. Add `--remote` to any
`cowork pact` command to use the Control Plane.

## Operations

- **Receipts and history**: receipts are stored encrypted (they contain the business's id for
  you); the timeline and Settings show summaries.
- **Restart**: interrupted sends become `outcome_unknown` and are never resent automatically.
  Pending sign-ins resume only if unexpired and the owner, task, provider and policy still
  validate; otherwise they expire with a visible reason.
- **Two CoWork processes on one profile**: each sign-in and each send holds a lease in the
  database, so the same device code is never polled twice and the same turn is never sent twice.
- **Keychain changes**: pending sign-ins and grant tokens may be reset (you sign in again); signer
  configuration is not reset silently.
- **Rotation**: providers verify CoWork's tokens against the issuer's JWKS, so the signer must
  publish new keys before using them and keep old ones during the overlap.
- **Rollback**: turn off `pact.enabled` (or set `COWORK_PACT_DISABLED=1`). PACT tables are additive
  and an older build ignores them.

## Not covered by PACT 1.0

- Remote cancellation of an action the business already took.
- Revocation at the business from CoWork.
- `tasks/{id}` lookups: only `message:send` is required, so CoWork never depends on task
  retrieval for reconciliation.

## Related

- [PACT signer contract](pact-signer.md)
- [Access profiles](access-profiles.md)
- [Admin policies](admin-policies.md)
- [CoWork CLI](cli.md)
