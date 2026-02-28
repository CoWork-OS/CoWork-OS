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
  "network": "base-mainnet"
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
  "amountPaid": "0.25"
}
```

- `status` (number): upstream HTTP status.
- `body` (string): upstream response body as text.
- `headers` (object): flattened response headers.
- `paymentMade` (boolean): whether payment/signature flow was used.
- `amountPaid` (string, optional): decimal USDC amount.

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
- `WALLET_NOT_READY`
- `X402_PRECHECK_FAILED`
- `X402_FETCH_FAILED`
- `INSUFFICIENT_FUNDS`

## Security Requirements (Recommended)

1. Require authenticated requests from CoWork OS clients:
   - mTLS, signed JWT, or short-lived bearer token.
2. Enforce server-side policy independent of desktop settings:
   - host allowlist, per-request max, per-day budget, account scoping.
3. Never expose private keys over API.
4. Log and audit all signing/payment actions with correlation IDs.
5. Add replay protection and strict request timeouts.

## CoWork OS Policy Interaction

Desktop-side policy is enforced before `x402/fetch`:
- Optional host allowlist (`payments.allowedHosts`)
- Hard payment limit (`payments.hardLimitUsd`)
- Approval gate (`payments.requireApproval`, `maxAutoApproveUsd`)

Signer-side policy should be stricter or equal. Do not rely only on desktop checks.

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
