# PACT Signer Contract

This document defines the HTTP contract CoWork OS uses to obtain personal-agent JWTs for
[PACT](pact.md), and records the identity enrollment decision.

Implementation reference:

- `src/electron/pact/signer-client.ts` (contract client and token cache)
- `src/electron/pact/development-signer.ts` (development deployment)

## Purpose

Every PACT request except card retrieval carries `Authorization: Bearer <pa-jwt>`, a JWT signed
by the personal agent's issuer and verified by the business's provider against the issuer's JWKS.
CoWork never holds the issuer's private key on the desktop. It asks a signer for a short-lived
token for its own subject and a provider-assigned audience, checks the claims locally, and caches
one token per audience for under 240 seconds.

Signer configuration is separate from task authority. A signed token proves only that a known
personal agent is calling for someone it calls `sub`. The task's access profile, network policy,
PACT admission, local approval and the business's own consent still decide every operation.

## Token rules (PACT 1.0, spec §3.2)

| Claim | Rule |
| --- | --- |
| `alg` | `ES256` or `RS256` only |
| `kid` | Matches a key in `{issuer}/.well-known/jwks.json` |
| `iss` | Exactly the configured issuer (an HTTPS origin) |
| `sub` | Stable, opaque, per user; never personal data |
| `aud` | The single audience string the provider assigned |
| `iat` | At most 30 s in the future |
| `exp` | At most 300 s after `iat` |
| `jti` | Recommended; providers need not track replay |

CoWork rejects a signer response whose token breaks any of these, has a different issuer,
audience or subject, or is already expired.

## Deployments

| Deployment | Who runs it | Enrollment | Use |
| --- | --- | --- | --- |
| Managed | CoWork-operated service | Device-key enrollment (below) | Mainstream desktop users, in a later release |
| Self-hosted | The customer's own issuer host | Credential configured in Settings | Enterprise and advanced personal deployments |
| Development | In-process, disposable keys, loopback issuer | None (`COWORK_PACT_DEVELOPMENT=1`) | Tests and local interoperability runs only |

The development signer is never used as a fallback for another deployment.

## Base URL

Configure in **Settings > Connectors > PACT business agents > Identity** (signer URL and issuer),
or with `pact.settings.update` over the Control Plane (admin scope).

CoWork calls:

- `POST /pact/sign`
- `POST /pact/status`
- `POST /pact/enroll` (device-key deployments only)

Requests go through CoWork's policy-aware client (network policy, DNS pinning, no redirects).

## Authentication

One of:

- `Authorization: Bearer <signer credential>`: the self-hosted credential, stored in the
  `pact:signer` secure-settings category (safeStorage). Never logged.
- `Authorization: PACT-Device <assertion>`: a compact JWS (`typ: pact-device+jwt`, ES256) signed
  with the install's device key, with `iss` = the device key thumbprint, `aud` = the endpoint URL,
  `iat`, `exp` (60 s) and a `jti`. The signer maps the enrolled key to the install's subject.

## 1) Sign

`POST /pact/sign`

```json
{ "audience": "aud-assigned-by-provider", "nonce": "3f1c…" }
```

Response:

```json
{ "token": "eyJ…", "nonce": "3f1c…" }
```

- The signer MUST reject a caller-supplied `iss` or `sub`; it signs only for the caller's own
  subject.
- The signer MUST reject audiences it has no registration for with `422`
  `{ "error": "audience_not_registered" }`.
- `nonce` MUST be echoed. CoWork refuses a response that does not echo it.
- `403` means the signer is disabled (the emergency switch); `401` means the device or credential
  is not accepted.

## 2) Status

`POST /pact/status` with an empty JSON body.

```json
{
  "issuer": "https://pa.example.com",
  "subject": "opaque-subject-123",
  "disabled": false,
  "audiences": { "https://provider.example.com": "aud-assigned-by-provider" }
}
```

- `issuer` must equal the configured issuer, or CoWork reports identity as not ready.
- `audiences` lists the provider registrations the signer holds. CoWork also accepts audiences an
  owner typed in Settings; a business card can never supply one.

## 3) Enroll (device key)

`POST /pact/enroll`

```json
{ "publicJwk": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…", "kid": "…" }, "proof": "<device assertion>" }
```

Response: `{ "subject": "opaque-subject-123", "issuer": "https://pa.example.com" }`.

The proof is a device assertion signed by the same key, which shows possession of the private key.
The key pair is generated once per install (`pact.identity.deviceKey`) and its private half stays in
safeStorage.

## Signer obligations

- Serve JWKS at `{issuer}/.well-known/jwks.json`; keep old keys published while rotating (overlap).
- Rate-limit per device or credential, support device invalidation, and keep an emergency disable.
- Log only operational identifiers (device id, audience, time), never tokens.
- Keep signing keys in a KMS or the platform's secret store with rotation; never in a repository.

## Enrollment decision (ADR)

Status: accepted for 1.0 planning, 8 October 2026.

Context: managed identity needs a stable subject per user, but CoWork has no user accounts and
its only hosted service (Pulse) is anonymous.

Decision:

1. Managed enrollment uses **device keys** (account-free): each install generates a key pair,
   enrolls by proof of possession and receives an opaque per-install subject. One person on two
   devices is two subjects and consents separately per business; a lost device needs no recovery
   because its grants are local to it. Abuse is limited by rate limits and optional platform
   attestation.
2. CoWork **does not operate the managed signer in this release**. The client implements the full
   contract (credential and device-key auth), so the managed service can ship later without a
   client change. This release supports self-hosted and development signers.
3. JWS handling uses **Node's crypto module**, not `jose`: ES256 and RS256 only, strict JWK
   parsing (no private members, RSA ≥ 2048 bits), and a bounded, policy-aware JWKS cache.
4. `pact:grants` may be reset when the keychain identity changes (grants can be re-consented);
   `pact:signer` is never reset silently.
5. The `prefer-pact` default ships **one release after the adapter**, after the live pilot.
   Until then, enabling PACT in Settings opts that profile into `prefer-pact`.

Consequences: there is no cross-device grant sharing; an accounts product would be needed to add
it later, and it would change subjects (and therefore require new consent).
