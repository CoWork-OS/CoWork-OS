---
name: crypto-trading
description: "Use ccxt (Python) for crypto prices, balances, and order actions across 100+ exchanges."
---

# Crypto Trading

## Purpose

Use ccxt (Python) for crypto prices, balances, and order actions across 100+ exchanges.

## Routing

- Use when: Use when users ask for live crypto prices, balances, or order placement across ccxt-supported exchanges.
- Do not use when: Do not use for non-crypto topics, legal/compliance guidance, or high-level strategy discussion without concrete execution.
- Outputs: Returns normalized JSON for price, balance, and order intent/results.
- Success criteria: Returns explicit mode-specific result plus next steps, with safe handling when order confirmation is missing.

## Trigger Examples

### Positive

- Use the crypto-trading skill for this request.
- Help me with crypto trading.
- Use when users ask for live crypto prices, balances, or order placement across ccxt-supported exchanges.
- Crypto Trading: provide an actionable result.

### Negative

- Do not use for non-crypto topics, legal/compliance guidance, or high-level strategy discussion without concrete execution.
- Do not use crypto-trading for unrelated requests.
- This request is outside crypto trading scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| mode | select | Yes | What operation to run (`price`, `balance`, or `order`). |
| exchange | string | Yes | ccxt exchange id (for example `binance`, `kraken`, `coinbase`) |
| symbol | string | No | Trading symbol (for example `BTC/USDT`) |
| side | select | No | Order direction for the order action |
| order_type | select | No | Order type for the order action |
| amount | number | No | Order quantity (base unit, required for order mode) |
| price | number | No | Order price per unit (required when order_type is limit) |

## Runtime Prompt

- Current runtime prompt length: 1747 characters.
- Runtime prompt is defined directly in `../crypto-trading.json`. 
