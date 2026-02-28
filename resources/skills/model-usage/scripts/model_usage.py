#!/usr/bin/env python3
"""Summarize CodexBar cost JSON by model."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import subprocess
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Summarize CodexBar per-model usage.")
    parser.add_argument("--provider", choices=["codex", "claude"], default="codex")
    parser.add_argument("--mode", choices=["current", "all"], default="current")
    parser.add_argument("--model", help="Specific model for current mode.")
    parser.add_argument("--input", help="Input JSON path, or '-' for stdin.")
    parser.add_argument("--format", choices=["text", "json"], default="text")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output.")
    return parser.parse_args()


def load_json(args: argparse.Namespace) -> Any:
    if args.input:
        if args.input == "-":
            raw = sys.stdin.read()
        else:
            raw = Path(args.input).read_text(encoding="utf-8")
    else:
        cmd = [
            "codexbar",
            "cost",
            "--format",
            "json",
            "--provider",
            args.provider,
        ]
        try:
            proc = subprocess.run(cmd, check=True, capture_output=True, text=True)
        except FileNotFoundError as exc:
            raise SystemExit("codexbar CLI not found; install it or provide --input <file>") from exc
        except subprocess.CalledProcessError as exc:
            stderr = (exc.stderr or "").strip()
            raise SystemExit(f"codexbar command failed: {stderr or exc}") from exc
        raw = proc.stdout

    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"invalid JSON input: {exc}") from exc


def get_rows(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict)]
    if isinstance(data, dict):
        for key in (
            "rows",
            "daily",
            "entries",
            "data",
            "history",
            "costByDay",
            "days",
        ):
            value = data.get(key)
            if isinstance(value, list):
                return [x for x in value if isinstance(x, dict)]
        return [data]
    return []


def parse_iso_date(raw: Any) -> dt.datetime | None:
    if not isinstance(raw, str) or not raw:
        return None
    value = raw.strip()
    for candidate in (
        value,
        value.replace("Z", "+00:00"),
    ):
        try:
            return dt.datetime.fromisoformat(candidate)
        except ValueError:
            continue
    return None


def row_datetime(row: dict[str, Any], fallback_idx: int) -> tuple[dt.datetime, int]:
    for key in ("date", "day", "timestamp", "createdAt", "updatedAt"):
        parsed = parse_iso_date(row.get(key))
        if parsed:
            return parsed, fallback_idx
    return dt.datetime.min, fallback_idx


def to_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def parse_breakdown_map(row: dict[str, Any]) -> dict[str, float]:
    for key in ("modelBreakdowns", "breakdowns", "models", "modelCosts"):
        raw = row.get(key)
        if not raw:
            continue
        if isinstance(raw, dict):
            return {str(k): to_float(v) for k, v in raw.items() if str(k).strip()}
        if isinstance(raw, list):
            out: dict[str, float] = {}
            for item in raw:
                if not isinstance(item, dict):
                    continue
                name = item.get("model") or item.get("name") or item.get("id")
                if not isinstance(name, str) or not name.strip():
                    continue
                cost = (
                    item.get("cost")
                    or item.get("value")
                    or item.get("amount")
                    or item.get("usd")
                    or item.get("total")
                )
                out[name] = to_float(cost)
            if out:
                return out
    return {}


def fallback_models_used(row: dict[str, Any]) -> list[str]:
    raw = row.get("modelsUsed")
    if isinstance(raw, list):
        return [str(x) for x in raw if str(x).strip()]
    return []


def summarize_current(rows: list[dict[str, Any]], forced_model: str | None) -> dict[str, Any]:
    if not rows:
        return {"model": None, "cost": 0.0, "date": None, "fallback": "no rows"}

    ordered = sorted(
        enumerate(rows),
        key=lambda item: row_datetime(item[1], item[0]),
    )
    idx, row = ordered[-1]

    breakdowns = parse_breakdown_map(row)
    date = row.get("date") or row.get("day") or row.get("timestamp")

    if forced_model:
        return {
            "model": forced_model,
            "cost": breakdowns.get(forced_model, 0.0),
            "date": date,
            "fallback": None,
            "rowIndex": idx,
        }

    if breakdowns:
        model, cost = max(breakdowns.items(), key=lambda kv: kv[1])
        return {
            "model": model,
            "cost": cost,
            "date": date,
            "fallback": None,
            "rowIndex": idx,
        }

    models = fallback_models_used(row)
    if models:
        return {
            "model": models[-1],
            "cost": 0.0,
            "date": date,
            "fallback": "modelsUsed",
            "rowIndex": idx,
        }

    return {"model": None, "cost": 0.0, "date": date, "fallback": "no model data", "rowIndex": idx}


def summarize_all(rows: list[dict[str, Any]]) -> dict[str, Any]:
    costs: dict[str, float] = defaultdict(float)
    with_breakdowns = 0
    for row in rows:
        breakdowns = parse_breakdown_map(row)
        if breakdowns:
            with_breakdowns += 1
            for model, cost in breakdowns.items():
                costs[model] += cost

    models_used: dict[str, int] = defaultdict(int)
    for row in rows:
        for model in fallback_models_used(row):
            models_used[model] += 1

    return {
        "rows": len(rows),
        "rowsWithBreakdowns": with_breakdowns,
        "models": [
            {
                "model": model,
                "cost": round(cost, 8),
                "modelsUsedCount": int(models_used.get(model, 0)),
            }
            for model, cost in sorted(costs.items(), key=lambda kv: kv[1], reverse=True)
        ],
        "modelsUsedOnly": [
            {"model": model, "count": count}
            for model, count in sorted(models_used.items())
            if model not in costs
        ],
    }


def main() -> int:
    args = parse_args()
    data = load_json(args)
    rows = get_rows(data)

    if args.mode == "current":
        summary = summarize_current(rows, args.model)
        result = {"provider": args.provider, "mode": args.mode, **summary}
        if args.format == "json":
            print(json.dumps(result, indent=2 if args.pretty else None))
            return 0

        print(f"Provider: {args.provider}")
        print(f"Mode: {args.mode}")
        print(f"Date: {result.get('date') or 'unknown'}")
        print(f"Model: {result.get('model') or 'unknown'}")
        print(f"Cost: ${to_float(result.get('cost')):.6f}")
        if result.get("fallback"):
            print(f"Fallback: {result['fallback']}")
        return 0

    summary = summarize_all(rows)
    result = {"provider": args.provider, "mode": args.mode, **summary}
    if args.format == "json":
        print(json.dumps(result, indent=2 if args.pretty else None))
        return 0

    print(f"Provider: {args.provider}")
    print(f"Mode: {args.mode}")
    print(f"Rows: {summary['rows']} (with model breakdowns: {summary['rowsWithBreakdowns']})")
    if not summary["models"]:
        print("No model-level cost breakdowns found.")
    else:
        for item in summary["models"]:
            print(f"- {item['model']}: ${item['cost']:.6f}")
    if summary["modelsUsedOnly"]:
        print("Models seen in modelsUsed only:")
        for item in summary["modelsUsedOnly"]:
            print(f"- {item['model']} ({item['count']} rows)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
