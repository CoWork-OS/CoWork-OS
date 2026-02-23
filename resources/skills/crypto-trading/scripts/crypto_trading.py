#!/usr/bin/env python3

"""Thin ccxt wrapper for price lookup and optional trade actions."""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from typing import Any, Dict

try:
    import ccxt  # type: ignore
except Exception as exc:  # pragma: no cover
    print(
        json.dumps(
            {
                "success": False,
                "error": "Missing dependency: ccxt",
                "hint": (
                    "Install with: pip install ccxt "
                    "(or uv pip install ccxt, if you use uv)"
                ),
                "details": str(exc),
            }
        )
    )
    sys.exit(2)


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default) or default


def _json_default(value: Any) -> str:
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="crypto_trading.py",
        description="Crypto trading helper powered by ccxt",
    )
    parser.add_argument(
        "--exchange",
        default=_env("CCXT_EXCHANGE", "binance"),
        help="Exchange id supported by ccxt (default: binance)",
    )
    parser.add_argument(
        "--sandbox",
        action="store_true",
        default=_env("CCXT_SANDBOX", "").lower() in {"1", "true", "yes", "on"},
        help="Enable exchange sandbox mode when supported",
    )
    parser.add_argument(
        "--api-key",
        default=_env("CCXT_API_KEY"),
        help="Exchange API key",
    )
    parser.add_argument(
        "--api-secret",
        default=_env("CCXT_API_SECRET"),
        help="Exchange API secret",
    )
    parser.add_argument(
        "--api-password",
        default=_env("CCXT_PASSWORD"),
        help="Exchange API passphrase/password (when required)",
    )
    parser.add_argument(
        "--api-uid",
        default=_env("CCXT_UID"),
        help="Exchange UID/header value if required",
    )

    subparsers = parser.add_subparsers(dest="action", required=True)

    price_parser = subparsers.add_parser("price", help="Fetch latest ticker data")
    price_parser.add_argument("symbol", help="Trading pair, for example BTC/USDT")

    subparsers.add_parser("balance", help="Fetch balance")

    order_parser = subparsers.add_parser("order", help="Create an order (simulation or live)")
    order_parser.add_argument("symbol", help="Trading pair, for example BTC/USDT")
    order_parser.add_argument("--side", required=True, choices=["buy", "sell"])
    order_parser.add_argument("--order-type", dest="order_type", default="market", choices=["market", "limit"])
    order_parser.add_argument("--amount", type=float, required=True, help="Order size")
    order_parser.add_argument("--price", type=float, default=None, help="Price for limit orders")
    order_parser.add_argument(
        "--confirm",
        action="store_true",
        help="Place a live order. Without this flag it is dry-run only.",
    )
    order_parser.add_argument(
        "--test",
        action="store_true",
        help="Include exchange test mode flag where supported",
    )

    return parser


def require_exchange(exchange_id: str) -> Any:
    if not hasattr(ccxt, exchange_id):
        raise RuntimeError(f"Exchange not supported by ccxt: {exchange_id}")
    return getattr(ccxt, exchange_id)


def create_exchange(args: argparse.Namespace) -> Any:
    exchange_cls = require_exchange(args.exchange.lower())
    config: Dict[str, Any] = {
        "enableRateLimit": True,
    }
    if args.api_key:
        config["apiKey"] = args.api_key
    if args.api_secret:
        config["secret"] = args.api_secret
    if args.api_password:
        config["password"] = args.api_password
    if args.api_uid:
        config["uid"] = args.api_uid
    exchange = exchange_cls(config)
    if args.sandbox and hasattr(exchange, "set_sandbox_mode"):
        exchange.set_sandbox_mode(True)
    return exchange


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    result: Dict[str, Any] = {
        "success": False,
        "exchange": args.exchange,
        "action": args.action,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    try:
        exchange = create_exchange(args)

        if args.action == "price":
            ticker = exchange.fetch_ticker(args.symbol)
            result.update(
                {
                    "success": True,
                    "symbol": args.symbol,
                    "ticker": {
                        "timestamp": ticker.get("timestamp"),
                        "datetime": ticker.get("datetime"),
                        "last": ticker.get("last"),
                        "bid": ticker.get("bid"),
                        "ask": ticker.get("ask"),
                        "open": ticker.get("open"),
                        "high": ticker.get("high"),
                        "low": ticker.get("low"),
                        "close": ticker.get("close"),
                        "percentage": ticker.get("percentage"),
                        "baseVolume": ticker.get("baseVolume"),
                        "quoteVolume": ticker.get("quoteVolume"),
                    },
                }
            )
            return _print_result(result, 0)

        if args.action == "balance":
            raw_balance = exchange.fetch_balance()
            accounts = raw_balance.get("info", {})
            free = raw_balance.get("free", {})
            used = raw_balance.get("used", {})
            total = raw_balance.get("total", {})
            summary = {}
            for currency, total_value in total.items():
                summary[currency] = {
                    "free": free.get(currency),
                    "used": used.get(currency),
                    "total": total_value,
                }
            result.update(
                {
                    "success": True,
                    "source": args.exchange,
                    "balance": summary,
                    "raw": accounts,
                }
            )
            return _print_result(result, 0)

        if args.action == "order":
            if args.order_type == "limit" and args.price is None:
                return _print_result(
                    {
                        **result,
                        "error": "price is required for limit orders",
                    },
                    1,
                )
            if args.order_type == "limit" and args.price is not None and args.price <= 0:
                return _print_result(
                    {
                        **result,
                        "error": "price must be greater than zero for limit orders",
                    },
                    1,
                )

            if args.amount <= 0:
                return _print_result(
                    {
                        **result,
                        "error": "amount must be greater than zero",
                    },
                    1,
                )

            order_payload = {
                "type": args.order_type,
                "side": args.side,
                "symbol": args.symbol,
                "amount": args.amount,
                "price": args.price,
            }

            if not args.confirm:
                result.update(
                    {
                        "success": True,
                        "status": "dry_run",
                        "message": "Order prepared but not sent. Add --confirm to execute live.",
                        "order_payload": order_payload,
                    }
                )
                return _print_result(result, 0)

            order_params: Dict[str, Any] = {}
            if args.test:
                order_params["test"] = True

            if not args.api_key or not args.api_secret:
                return _print_result(
                    {
                        **result,
                        "error": "Live order requires CCXT_API_KEY and CCXT_API_SECRET (or --api-key / --api-secret)",
                    },
                    1,
                )

            response = exchange.create_order(
                args.symbol,
                args.order_type,
                args.side,
                args.amount,
                args.price if args.order_type == "limit" else None,
                order_params,
            )
            result.update(
                {
                    "success": True,
                    "status": "submitted",
                    "order_payload": order_payload,
                    "exchange_response": response,
                }
            )
            return _print_result(result, 0)

        return _print_result(
            {
                **result,
                "error": f"Unsupported action: {args.action}",
            },
            1,
        )

    except Exception as exc:  # pragma: no cover
        return _print_result(
            {
                **result,
                "error": str(exc),
            },
            1,
        )


def _print_result(payload: Dict[str, Any], status_code: int) -> int:
    print(json.dumps(payload, indent=2, default=_json_default))
    return status_code


if __name__ == "__main__":
    raise SystemExit(main())
