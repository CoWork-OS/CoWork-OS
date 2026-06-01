# Coinbase Agentic Signer Contract

This document defines the HTTP contract expected by CoWork OS when `wallet.provider = "coinbase_agentic"`.

Implementation reference:
- `src/electron/infra/providers/coinbase-agentic-wallet-provider.ts`

## Purpose

CoWork OS delegates wallet operations and x402 signing to a remote signer service instead of storing private keys locally in the desktop app.

## Base URL

Configure in **Settings > Infrastructure > Wallet > Signer Endpoint**.

Example:
- `https://signer.example.com`

CoWork OS will call:
- `POST /wallet/status`
- `POST /wallet/ensure`
- `POST /x402/check`
- `POST /x402/fetch`

## Common Request Fields

Most signer requests include:

```json
{
  "accountId": "agent-wallet-prod",
  "network": "base-mainnet"
}
```

- `accountId` (string, optional): tenant/account selector on signer side.
- `network` (`"base-mainnet" | "base-sepolia"`): target chain context.

## 1) Wallet Status

`POST /wallet/status`

### Request

```json
{
  "accountId": "agent-wallet-prod",
  "network": "base-mainnet"
}
```

- `paymentPolicy` (object, optional but strongly recommended): desktop-side
  policy and any user-approved preflight requirement. If present, the signer must
  enforce it before signing the real upstream payment challenge.

### Response

```json
{
  "connected": true,
  "address": "0xabc123...",
  "network": "base-mainnet",
  "balanceUsdc": "42.10"
}
```

- `connected` (boolean): signer account is healthy/usable.
- `address` (string, optional): public wallet address.
- `balanceUsdc` (string, optional): decimal USDC balance.

## 2) Wallet Ensure

`POST /wallet/ensure`

Ensures the signer has a wallet/account provisioned for the request context.

### Request

```json
{
  "accountId": "agent-wallet-prod",
  "network": "base-mainnet"
}
```

### Response

Any JSON object is accepted by CoWork OS (result is not parsed deeply), but recommended:

```json
{
  "ok": true,
  "address": "0xabc123..."
}
```

## 3) x402 Check

`POST /x402/check`

Checks whether a URL requires x402 payment and returns payment metadata if required.

### Request

```json
{
  "url": "https://paid-api.example.com/data",
  "accountId": "agent-wallet-prod",
  "network": "base-mainnet"
}
```

### Response (no payment required)

```json
{
  "requires402": false,
  "url": "https://paid-api.example.com/data"
}
```

### Response (payment required)

```json
{
  "requires402": true,
  "url": "https://paid-api.example.com/data",
  "paymentDetails": {
    "payTo": "0xmerchant...",
    "amount": "0.25",
    "currency": "USDC",
    "network": "base",
    "resource": "/data",
    "description": "Premium endpoint access",
    "expires": 1735689600
  }
}
```

## 4) x402 Fetch

`POST /x402/fetch`

Performs the request with signing/payment flow handled server-side.
The signer must treat any desktop preflight result as advisory only. The real
upstream `402 Payment Required` response from this fetch is the authoritative
payment challenge and must be checked against the policy envelope before signing.

### Request

```json
{
  "url": "https://paid-api.example.com/data",
  "method": "GET",
  "body": "",
  "headers": {
    "accept": "application/json"
  },
  "accountId": "agent-wallet-prod",
  "network": "base-mainnet",
  "paymentPolicy": {
    "policyVersion": 1,
    "effectiveHardLimitUsd": 100,
    "maxAutoApproveUsd": 1,
    "requireApproval": true,
    "allowedHosts": ["paid-api.example.com"],
    "preflight": {
      "requires402": true,
      "url": "https://paid-api.example.com/data",
      "paymentDetails": {
        "scheme": "exact",
        "payTo": "0xmerchant...",
        "maxAmountRequired": "250000",
        "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "network": "eip155:8453",
        "resource": "/data"
      }
    },
    "approvedPaymentDetails": {
      "scheme": "exact",
      "payTo": "0xmerchant...",
      "maxAmountRequired": "250000",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "network": "eip155:8453",
      "resource": "/data"
    },
    "approvedAt": "2026-06-01T10:00:00.000Z"
  }
}
```

### Response

```json
{
  "status": 200,
  "body": "{\"result\":\"ok\"}",
  "headers": {
    "content-type": "application/json"
  },
  "paymentMade": true,
  "amountPaid": "0.25",
  "paymentPolicyEnforced": true,
  "paymentDetails": {
    "scheme": "exact",
    "payTo": "0xmerchant...",
    "maxAmountRequired": "250000",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "network": "eip155:8453",
    "resource": "/data"
  }
}
```

- `status` (number): upstream HTTP status.
- `body` (string): upstream response body as text.
- `headers` (object): flattened response headers.
- `paymentMade` (boolean): whether payment/signature flow was used.
- `amountPaid` (string, optional): decimal USDC amount.
- `paymentPolicyEnforced` (boolean, required when `paymentMade=true`): signer
  confirmed it enforced the supplied policy envelope before signing.
- `paymentDetails` (object, required when `paymentMade=true`): exact upstream
  challenge details that were signed.

## Error Handling

- Return non-2xx for operational errors; CoWork OS surfaces response text.
- Prefer JSON error body with stable codes:

```json
{
  "error": {
    "code": "SIGNER_POLICY_BLOCKED",
    "message": "Host not allowed"
  }
}
```

Suggested codes:
- `SIGNER_UNAUTHORIZED`
- `SIGNER_POLICY_BLOCKED`
- `X402_PAYMENT_REQUIREMENT_CHANGED`
- `WALLET_NOT_READY`
- `X402_PRECHECK_FAILED`
- `X402_FETCH_FAILED`
- `INSUFFICIENT_FUNDS`

## Security Requirements (Recommended)

1. Require authenticated requests from CoWork OS clients:
   - mTLS, signed JWT, or short-lived bearer token.
2. Enforce server-side policy independent of desktop settings:
   - host allowlist, per-request max, per-day budget, account scoping.
3. Enforce the desktop `paymentPolicy` envelope before signing:
   - reject missing or unsupported `policyVersion`
   - reject if the real upstream payment amount exceeds `effectiveHardLimitUsd`
   - reject unsupported asset/currency/network combinations. Supported USDC
     assets are Base mainnet `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
     and Base Sepolia `0x036CbD53842c5426634e7929541eC2318f3dCF7e`
   - reject resources that do not match the requested URL
   - when `approvedPaymentDetails` is present, reject if the real upstream
     challenge differs in `scheme`, `payTo`, `amount`, `maxAmountRequired`,
     `asset`, `currency`, `network`, `resource`, or `expires`
   - when `requireApproval` is true and no exact approved payment details are
     present, reject instead of signing silently
4. Never expose private keys over API.
5. Log and audit all signing/payment actions with correlation IDs.
6. Add replay protection and strict request timeouts.

## CoWork OS Policy Interaction

Desktop-side policy is enforced at two points:
- Optional host allowlist (`payments.allowedHosts`)
- Advisory preflight estimate (`/x402/check`), when available
- Final policy/approval gate on the real upstream `402` challenge
  (`payments.hardLimitUsd`, `payments.requireApproval`, `maxAutoApproveUsd`)

The final signer-side check is mandatory because HEAD preflight is not
authoritative. If `/x402/check` returns no payment but `/x402/fetch` receives a
real upstream `402`, the signer must still apply the policy envelope before
signing.

## Quick Smoke Test

```bash
curl -sS -X POST "$SIGNER_ENDPOINT/wallet/status" \
  -H "content-type: application/json" \
  -d '{"accountId":"agent-wallet-prod","network":"base-mainnet"}'
```

```bash
curl -sS -X POST "$SIGNER_ENDPOINT/x402/check" \
  -H "content-type: application/json" \
  -d '{"url":"https://paid-api.example.com/data","accountId":"agent-wallet-prod","network":"base-mainnet"}'
```
