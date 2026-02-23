#!/usr/bin/env python3

"""Phase 1/2/3 trading foundation workflow.

Commands:
  - fetch: download OHLCV data from ccxt
  - backtest: run paper strategy simulation (single strategy)
  - paper-run: same engine as backtest, intended for forward paper usage
  - portfolio-run: adaptive strategy routing between mean-reversion and momentum
  - ml-run: portfolio routing plus ML + sentiment overlay
  - execute: place one market/limit order (ccxt dry-run by default)
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import subprocess
import sys
import venv
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
import importlib

ccxt = None
np = None
pd = None

_SKILL_VENV_DIR = Path(__file__).resolve().parent / ".trading-foundation-venv"
_BOOTSTRAP_REENTRANT = "TRADING_FOUNDATION_BOOTSTRAPPED"
_HUMAN_MODES = {
    "fetch": "fetch",
    "backtest": "backtest",
    "paper run": "paper-run",
    "paper-run": "paper-run",
    "paper": "paper-run",
    "portfolio": "portfolio-run",
    "portfolio run": "portfolio-run",
    "portfolio-run": "portfolio-run",
    "ml run": "ml-run",
    "ml-run": "ml-run",
    "ml": "ml-run",
    "execute": "execute",
    "trade": "execute",
}
_KNOWN_MODES = set(_HUMAN_MODES.values())


def _bootstrap_progress(message: str) -> None:
    print(f"[trading-foundation] {message}", file=sys.stderr, flush=True)


def _venv_python() -> str:
    if os.name == "nt":
        return str(_SKILL_VENV_DIR / "Scripts" / "python.exe")
    return str(_SKILL_VENV_DIR / "bin" / "python")


def _is_module_available(module_name: str) -> bool:
    try:
        importlib.import_module(module_name)
        return True
    except Exception:
        return False


def _ensure_dependency_venv() -> None:
    missing = [name for name in ("ccxt", "numpy", "pandas") if not _is_module_available(name)]
    if not missing:
        return

    if os.environ.get(_BOOTSTRAP_REENTRANT) == "1":
        return

    _bootstrap_progress("Step 1/5: First-run dependency bootstrap started; missing required packages detected.")

    if not _SKILL_VENV_DIR.exists():
        _bootstrap_progress(f"Step 2/5: Creating local skill environment at {_SKILL_VENV_DIR}")
        try:
            venv.EnvBuilder(with_pip=True).create(str(_SKILL_VENV_DIR))
        except Exception as exc:
            _bootstrap_progress("Failed to create local skill environment.")
            print(
                json.dumps(
                    {
                        "success": False,
                        "status": "bootstrap_failed",
                        "error": "Could not create local dependency environment.",
                        "details": str(exc),
                        "hint": "Check write permission on the skill directory and retry.",
                    },
                    indent=2,
                ),
                file=sys.stderr,
            )
            raise SystemExit(2)
    else:
        _bootstrap_progress(f"Step 2/5: Reusing existing local skill environment at {_SKILL_VENV_DIR}")

    python_path = _venv_python()
    if not os.path.exists(python_path):
        _bootstrap_progress("Unable to locate python in local skill environment.")
        print(
            json.dumps(
                {
                    "success": False,
                    "status": "bootstrap_failed",
                    "error": "Local skill environment is missing its python executable.",
                    "details": f"Expected executable at {python_path}.",
                    "hint": "Delete the environment folder and rerun the command.",
                },
                indent=2,
            ),
            file=sys.stderr,
        )
        raise SystemExit(2)
    _bootstrap_progress("Step 3/5: Installing required Python packages into local environment.")
    for package in ("ccxt", "numpy", "pandas"):
        if package in missing:
            _bootstrap_progress(f"Step 4/5: Installing {package} ...")
            install = subprocess.run(
                [python_path, "-m", "pip", "install", "--disable-pip-version-check", package],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            if install.returncode != 0:
                _bootstrap_progress(f"Failed to install {package}.")
                details = install.stderr.strip() or install.stdout.strip() or "No pip output."
                print(
                    json.dumps(
                        {
                            "success": False,
                            "status": "bootstrap_failed",
                            "error": f"Dependency install failed for {package}",
                            "details": details,
                            "hint": "Verify network access and rerun command.",
                            "package": package,
                        },
                        indent=2,
                    ),
                    file=sys.stderr,
                )
                raise SystemExit(2)
            _bootstrap_progress(f"Installed {package}.")
        else:
            _bootstrap_progress(f"{package} already installed; skipping.")

    os.environ[_BOOTSTRAP_REENTRANT] = "1"
    _bootstrap_progress("Step 5/5: Restarting command inside dedicated skill environment.")
    os.execv(python_path, [python_path, str(Path(__file__).resolve()), *sys.argv[1:]])


def _load_runtime_deps() -> None:
    global ccxt
    global np
    global pd

    try:
        importlib.import_module("ccxt")
        importlib.import_module("numpy")
        importlib.import_module("pandas")
    except Exception as exc:
        _bootstrap_progress("Dependency check failed after bootstrap.")
        print(
            json.dumps(
                {
                    "success": False,
                    "status": "dependencies_missing",
                    "error": "Could not load required Python dependencies.",
                    "details": str(exc),
                    "hint": "Run 'python3 -m pip install ccxt pandas numpy' manually or retry.",
                },
                indent=2,
            ),
            file=sys.stderr,
        )
        raise SystemExit(2)

    ccxt = importlib.import_module("ccxt")
    np = importlib.import_module("numpy")
    pd = importlib.import_module("pandas")

    if ccxt is None:
        raise RuntimeError("Failed to import ccxt dependency after bootstrap.")


def _looks_like_known_mode(candidate: str) -> bool:
    if not candidate:
        return False
    normalized = candidate.lower().replace("_", "-")
    return normalized in _KNOWN_MODES


def _normalize_mode_from_prompt(prompt: str) -> Optional[str]:
    lower = prompt.lower()
    for phrase, mode in _HUMAN_MODES.items():
        pattern = rf"\b{re.escape(phrase)}\b"
        if re.search(pattern, lower):
            return mode
    return None


def _extract_float(prompt: str, keys: List[str]) -> Optional[float]:
    for key in keys:
        match = re.search(rf"{re.escape(key)}[^0-9\\-+.]*([-+]?(?:\\d+(?:\\.\\d+)?|\\.\\d+))", prompt, flags=re.IGNORECASE)
        if match:
            try:
                return float(match.group(1))
            except Exception:
                continue
    return None


def _extract_int(prompt: str, keys: List[str]) -> Optional[int]:
    value = _extract_float(prompt, keys)
    if value is None:
        return None
    return int(value)


def _extract_csv_paths(prompt: str) -> List[str]:
    matches = re.findall(r"(?:[\"'])([^\"']+\\.csv)|([^\\s]+\\.csv)", prompt, flags=re.IGNORECASE)
    return [match[0] if match[0] else match[1] for match in matches]


def _extract_side(prompt: str) -> Optional[str]:
    lower = prompt.lower()
    if re.search(r"\bsell\b", lower):
        return "sell"
    if re.search(r"\bbuy\b", lower):
        return "buy"
    return None


def _extract_order_type(prompt: str) -> Optional[str]:
    lower = prompt.lower()
    if re.search(r"\blimit\b", lower):
        return "limit"
    if re.search(r"\bmarket\b", lower):
        return "market"
    return None


def _infer_mode_from_prompt(prompt: str, csv_paths: List[str]) -> Optional[str]:
    lower = prompt.lower()
    if re.search(r"\b(fetch|download|get|ohlcv|candles?)\b", lower):
        return "fetch"
    if re.search(r"\b(execute|buy|sell|trade)\b", lower):
        return "execute"
    if re.search(r"\bstatarb|stat[-\s]?arb|spread\b", lower):
        return "portfolio-run"
    if re.search(r"\badaptive\b|\bmomentum\b|\bmean[-\s]?reversion\b|\brsi\b|\bbollinger\b", lower):
        if csv_paths:
            return "portfolio-run"
    if re.search(r"\bportfolio\b|\bpaper\b|\bbacktest\b|\bsimulate", lower):
        return "portfolio-run" if csv_paths else None
    if csv_paths:
        return "portfolio-run"
    return None


def _extract_symbol(prompt: str) -> Optional[str]:
    match = re.search(r"\b([A-Za-z0-9]{2,10}/[A-Za-z0-9]{2,10})\b", prompt)
    if match:
        return match.group(1).upper()
    return None


def _build_human_mode_args(prompt: str) -> Optional[List[str]]:
    raw = prompt.strip().strip('"\'')
    if not raw:
        return None

    mode = _normalize_mode_from_prompt(raw)
    csv_paths = _extract_csv_paths(raw)
    if mode is None:
        mode = _infer_mode_from_prompt(raw, csv_paths)
        if mode is None:
            return None

    args: List[str] = [mode]
    if mode in {"backtest", "paper-run", "portfolio-run", "ml-run"}:
        if not csv_paths:
            return None
        args.extend(["--data-csv", csv_paths[0]])
        if mode in {"portfolio-run", "ml-run"}:
            if re.search(r"\bstatarb|stat[-\s]?arb|pair", raw, flags=re.IGNORECASE):
                if len(csv_paths) > 1:
                    args.extend(["--secondary-data-csv", csv_paths[1]])
                else:
                    return None
        if (value := _extract_float(raw, ["cash", "initial cash", "starting cash", "initial-cash"])) is not None:
            args.extend(["--initial-cash", str(value)])
        if (value := _extract_float(raw, ["position size", "position-size", "size"])) is not None:
            args.extend(["--position-size", str(value)])
        if (value := _extract_float(raw, ["bb window", "bb_window", "bollinger window"])) is not None:
            args.extend(["--bb-window", str(int(value))])
        if (value := _extract_float(raw, ["bb std", "bollinger std"])) is not None:
            args.extend(["--bb-std", str(value)])
        if (value := _extract_float(raw, ["rsi period", "rsi_period"])) is not None:
            args.extend(["--rsi-period", str(int(value))])
        if (value := _extract_float(raw, ["rsi buy", "rsi_buy"])) is not None:
            args.extend(["--rsi-buy", str(value)])
        if (value := _extract_float(raw, ["rsi sell", "rsi_sell"])) is not None:
            args.extend(["--rsi-sell", str(value)])
        if (value := _extract_float(raw, ["statarb window", "statarb-window", "pair window"])) is not None:
            args.extend(["--statarb-window", str(int(value))])
        if (value := _extract_float(raw, ["entry z", "z entry", "statarb entry", "statarb z entry"])) is not None:
            args.extend(["--statarb-z-entry", str(value)])
        if (value := _extract_float(raw, ["exit z", "z exit", "statarb exit", "statarb z exit"])) is not None:
            args.extend(["--statarb-z-exit", str(value)])
        if (value := _extract_float(raw, ["stop z", "z stop", "statarb stop", "statarb z stop"])) is not None:
            args.extend(["--statarb-z-stop", str(value)])
        if re.search(r"\bstatarb\b", raw, flags=re.IGNORECASE):
            args.extend(["--strategy-mode", "stat-arb"])
        elif re.search(r"\bmomentum-only\b|\bonly momentum\b", raw, flags=re.IGNORECASE):
            args.extend(["--strategy-mode", "momentum-only"])
        elif re.search(r"\bmomentum\b", raw, flags=re.IGNORECASE):
            args.extend(["--strategy-mode", "momentum"])
        elif re.search(r"\bmean reversion\b|\bmean-reversion\b", raw, flags=re.IGNORECASE):
            args.extend(["--strategy-mode", "mean-reversion"])
        elif re.search(r"\badaptive\b", raw, flags=re.IGNORECASE):
            args.extend(["--strategy-mode", "adaptive"])
    elif mode == "fetch":
        if csv_paths:
            args.extend(["--output-path", csv_paths[0]])
        if re.search(r"\bstock\b", raw, flags=re.IGNORECASE):
            args.extend(["--market", "stock"])
            if (value := re.search(r"\b([A-Za-z]{1,5})\b", raw)):
                args.extend(["--symbol", value.group(1)])
        else:
            args.extend(["--market", "crypto"])
            if (value := re.search(r"\b([A-Za-z]{3,6}/[A-Za-z]{3,6})\b", raw)):
                args.extend(["--symbol", value.group(1).upper()])
            elif (value := re.search(r"\bbybit|binance|coinbase\b", raw, flags=re.IGNORECASE)):
                args.extend(["--exchange", value.group(0).lower()])
        if (value := re.search(r"\b([1-9][0-9]*[mhd])\b", raw)):
            args.extend(["--timeframe", value.group(1)])
        if (value := _extract_int(raw, ["days", "past days", "for"])) is not None:
            args.extend(["--days", str(value)])
    elif mode == "execute":
        if (value := _extract_side(raw)) is not None:
            args.extend(["--side", value])
        if (order_type := _extract_order_type(raw)) is not None:
            args.extend(["--order-type", order_type])
        if (value := _extract_float(raw, ["amount", "size", "qty", "quantity"])) is not None:
            args.extend(["--amount", str(value)])
        if (value := _extract_float(raw, ["price", "limit price"])) is not None:
            args.extend(["--price", str(value)])
        if (value := _extract_symbol(raw)) is not None:
            args.extend(["--symbol", value])
        if (value := re.search(r"\b(bybit|binance|coinbase)\b", raw, flags=re.IGNORECASE)):
            args.extend(["--exchange", value.group(0).lower()])

    if mode in {"fetch", "backtest", "paper-run", "portfolio-run", "ml-run", "execute"}:
        if not args:
            return None
    return args


_ensure_dependency_venv()
_load_runtime_deps()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Phase 1 trading foundation workflow")
    subparsers = parser.add_subparsers(dest="mode", required=True)

    fetch_parser = subparsers.add_parser("fetch", help="Fetch historical OHLCV and save CSV")
    fetch_parser.add_argument("--exchange", default="binance")
    fetch_parser.add_argument("--symbol", default="BTC/USDT")
    fetch_parser.add_argument(
        "--market",
        default="crypto",
        choices=["crypto", "stock"],
        help="Select data source family",
    )
    fetch_parser.add_argument(
        "--provider",
        default="yfinance",
        choices=["yfinance"],
        help="Stock data provider (crypto always uses ccxt)",
    )
    fetch_parser.add_argument("--timeframe", default="1h")
    fetch_parser.add_argument("--days", type=int, default=400)
    fetch_parser.add_argument("--limit", type=int, default=1000)
    fetch_parser.add_argument("--max-pages", type=int, default=1000)
    fetch_parser.add_argument("--output-path", "--output", dest="output", required=True)

    backtest_parser = subparsers.add_parser("backtest", help="Run backtest simulation")
    paper_parser = subparsers.add_parser("paper-run", help="Run paper simulation")
    portfolio_parser = subparsers.add_parser("portfolio-run", help="Run adaptive multi-strategy paper simulation")
    ml_parser = subparsers.add_parser("ml-run", help="Run adaptive + ML + sentiment paper simulation")
    execute_parser = subparsers.add_parser("execute", help="Place a dry-run or live ccxt market/limit order")

    for p in (backtest_parser, paper_parser, portfolio_parser, ml_parser):
        p.add_argument("--data-csv", required=True, dest="data_csv")
        p.add_argument("--initial-cash", type=float, default=10000.0)
        p.add_argument("--position-size", type=float, default=0.02)
        p.add_argument("--bb-window", type=int, default=20)
        p.add_argument("--bb-std", type=float, default=2.0)
        p.add_argument("--rsi-period", type=int, default=14)
        p.add_argument("--rsi-buy", type=float, default=30.0)
        p.add_argument("--rsi-sell", type=float, default=70.0)
        p.add_argument(
            "--strategy-mode",
            default="adaptive",
            choices=["adaptive", "mean-reversion", "momentum", "momentum-only", "stat-arb"],
            help="Strategy mode",
        )
        p.add_argument(
            "--strategy-correlation-cap",
            type=float,
            default=0.70,
            help="Portfolio signal correlation cap; block new entries when exceeded",
        )
        p.add_argument(
            "--strategy-correlation-window",
            type=int,
            default=120,
            help="Rolling correlation window for strategy signal diversification guard",
        )
        p.add_argument("--momentum-fast", type=int, default=50)
        p.add_argument("--momentum-slow", type=int, default=200)
        p.add_argument("--trend-threshold", type=float, default=0.0025)
        p.add_argument(
            "--use-regime",
            dest="use_regime",
            action="store_true",
            default=True,
            help="Enable adaptive regime routing between momentum and mean-reversion",
        )
        p.add_argument(
            "--disable-regime",
            dest="use_regime",
            action="store_false",
            help="Disable adaptive regime routing",
        )
        p.add_argument("--max-portfolio-risk", type=float, default=0.05)
        p.add_argument("--atr-window", type=int, default=14)
        p.add_argument("--fee-rate", type=float, default=0.0004)
        p.add_argument("--stop-atr-mult", type=float, default=2.0)
        p.add_argument("--statarb-window", type=int, default=100)
        p.add_argument("--statarb-z-entry", type=float, default=2.0)
        p.add_argument("--statarb-z-exit", type=float, default=0.0)
        p.add_argument("--statarb-z-stop", type=float, default=3.5)
        p.add_argument("--secondary-data-csv", default=None, dest="secondary_data_csv")
        p.add_argument("--pair-symbol", default=None)
        p.add_argument("--max-drawdown", type=float, default=0.10)
        p.add_argument("--timeframe", default="1h")
        p.add_argument("--trades-csv", default=None)
        p.add_argument(
            "--ml-enabled",
            dest="ml_enabled",
            action="store_true",
            default=False,
            help="Enable ML and sentiment hybrid signal",
        )
        p.add_argument(
            "--disable-ml",
            dest="ml_enabled",
            action="store_false",
            help="Disable ML and sentiment hybrid signal",
        )
        p.add_argument(
            "--model-type",
            choices=["random_forest", "xgboost", "logistic"],
            default="random_forest",
            help="ML model type",
        )
        p.add_argument("--ml-horizon", type=int, default=4)
        p.add_argument("--ml-train-ratio", type=float, default=0.70)
        p.add_argument("--ml-confidence", type=float, default=0.55)
        p.add_argument("--sentiment-csv", default=None)
        p.add_argument("--sentiment-threshold", type=float, default=0.0)
        p.add_argument("--sentiment-weight", type=float, default=1.0)

    execute_parser.add_argument(
        "--exchange",
        default="binance",
        help="Exchange id supported by ccxt (for order placement)",
    )
    execute_parser.add_argument(
        "--sandbox",
        action="store_true",
        default=os.environ.get("CCXT_SANDBOX", "").lower() in {"1", "true", "yes", "on"},
        help="Enable exchange sandbox/testnet mode when supported",
    )
    execute_parser.add_argument(
        "--api-key",
        default=os.environ.get("CCXT_API_KEY"),
        help="Exchange API key for live execution",
    )
    execute_parser.add_argument(
        "--api-secret",
        default=os.environ.get("CCXT_API_SECRET"),
        help="Exchange API secret for live execution",
    )
    execute_parser.add_argument(
        "--api-password",
        default=os.environ.get("CCXT_PASSWORD"),
        help="Exchange passphrase (when required)",
    )
    execute_parser.add_argument(
        "--api-uid",
        default=os.environ.get("CCXT_UID"),
        help="Exchange UID/header value when required",
    )
    execute_parser.add_argument(
        "--symbol",
        default="BTC/USDT",
        help="Trading pair, for example BTC/USDT",
    )
    execute_parser.add_argument(
        "--side",
        required=True,
        choices=["buy", "sell"],
        help="Order direction",
    )
    execute_parser.add_argument(
        "--order-type",
        dest="order_type",
        default="market",
        choices=["market", "limit"],
        help="Order type",
    )
    execute_parser.add_argument(
        "--amount",
        type=float,
        required=True,
        help="Order amount in base currency",
    )
    execute_parser.add_argument(
        "--price",
        type=float,
        default=None,
        help="Price for limit orders",
    )
    execute_parser.add_argument(
        "--confirm",
        action="store_true",
        help="Place live order. Without this flag, run as dry-run only",
    )
    execute_parser.add_argument(
        "--test",
        action="store_true",
        help="Ask exchange for test mode order when supported",
    )
    execute_parser.add_argument(
        "--max-order-notional",
        type=float,
        default=0.0,
        help="Soft risk cap for live orders (0 disables check)",
    )
    execute_parser.add_argument(
        "--max-account-fraction",
        type=float,
        default=0.20,
        help="Cap order notional as fraction of quote-balance (0-1), if balances can be read",
    )
    execute_parser.add_argument(
        "--skip-balance-check",
        action="store_true",
        help="Skip available balance guardrail (not recommended)",
    )

    return parser


def require_exchange(exchange_id: str):
    if ccxt is None:
        raise RuntimeError("Missing dependency: ccxt")
    exchange_id = exchange_id.lower()
    if not hasattr(ccxt, exchange_id):
        raise RuntimeError(f"Unsupported exchange: {exchange_id}")
    return getattr(ccxt, exchange_id)


def create_exchange(args: argparse.Namespace) -> Any:
    exchange_cls = require_exchange(args.exchange)
    config: Dict[str, Any] = {"enableRateLimit": True}
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


def _to_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except Exception:
        return default


def _safe_position_size(value: float) -> float:
    if value <= 0:
        return 0.01
    if value > 1:
        return 1.0
    return value


def _safe_correlation(left: List[float], right: List[float]) -> Optional[float]:
    if len(left) < 2 or len(left) != len(right):
        return None
    s1 = pd.Series(left, dtype=float)
    s2 = pd.Series(right, dtype=float)
    if s1.nunique() < 2 or s2.nunique() < 2:
        return None
    corr = s1.corr(s2)
    if pd.isna(corr):
        return None
    return float(corr)


def _build_stat_arb_df(
    primary: pd.DataFrame,
    secondary: pd.DataFrame,
    pair_symbol: str,
    hedge_window: int,
) -> pd.DataFrame:
    base = primary[["timestamp", "open", "high", "low", "close", "volume"]].copy()
    pair = secondary[["timestamp", "open", "high", "low", "close", "volume"]].copy()
    base["timestamp"] = pd.to_datetime(base["timestamp"], utc=True, errors="coerce")
    pair["timestamp"] = pd.to_datetime(pair["timestamp"], utc=True, errors="coerce")
    base = base.dropna(subset=["timestamp"]).sort_values("timestamp").drop_duplicates("timestamp")
    pair = pair.dropna(subset=["timestamp"]).sort_values("timestamp").drop_duplicates("timestamp")

    def _median_step_ns(ts: pd.Series) -> Optional[int]:
        deltas = pd.to_datetime(ts, utc=True, errors="coerce").sort_values().diff().dropna()
        if deltas.empty:
            return None
        ns = pd.to_numeric(deltas.dt.total_seconds(), errors="coerce") * 1_000_000_000
        ns = ns.dropna()
        if ns.empty:
            return None
        step = int(ns.median())
        return step if step > 0 else None

    base_step = _median_step_ns(base["timestamp"])
    pair_step = _median_step_ns(pair["timestamp"])
    candidate_steps = [step for step in [base_step, pair_step] if isinstance(step, int) and step > 0]
    step_ns = min(candidate_steps) if candidate_steps else (3600 * 1_000_000_000)
    tolerance = pd.Timedelta(int(step_ns * 1.5), unit="ns")

    merged = pd.merge_asof(
        base,
        pair,
        on="timestamp",
        direction="nearest",
        tolerance=tolerance,
        suffixes=("_base", "_pair"),
    ).dropna(subset=["open_pair", "high_pair", "low_pair", "close_pair", "volume_pair"])
    if merged.empty:
        raise ValueError("No overlapping timestamps for pair dataset; try matching ranges and timeframe.")

    merged["hedge_ratio"] = (merged["close_base"] / merged["close_pair"]).replace([0, np.inf, -np.inf], np.nan)
    merged["hedge_ratio"] = merged["hedge_ratio"].rolling(hedge_window).mean()
    merged["hedge_ratio"] = merged["hedge_ratio"].replace([0, np.inf, -np.inf], np.nan).bfill().ffill().fillna(1.0)
    merged["pair_spread"] = merged["close_base"] - (merged["hedge_ratio"] * merged["close_pair"])
    spread_min = merged["pair_spread"].min()
    spread_shift = abs(spread_min) + 1e-8 if pd.notna(spread_min) and spread_min <= 0 else 0.0
    merged["pair_spread"] = merged["pair_spread"] + spread_shift

    merged["spread_open"] = merged["pair_spread"].shift(1).fillna(merged["pair_spread"])
    merged["spread_high"] = merged[["pair_spread", "spread_open"]].max(axis=1)
    merged["spread_low"] = merged[["pair_spread", "spread_open"]].min(axis=1)
    merged["spread_volume"] = merged["volume_base"].fillna(0.0) + merged["volume_pair"].fillna(0.0)

    return pd.DataFrame(
        {
            "timestamp": merged["timestamp"],
            "open": merged["spread_open"].astype(float),
            "high": merged["spread_high"].astype(float),
            "low": merged["spread_low"].astype(float),
            "close": merged["pair_spread"].astype(float),
            "volume": merged["spread_volume"].astype(float),
            "pair_symbol": pair_symbol,
            "hedge_ratio": merged["hedge_ratio"].astype(float),
        }
    ).dropna(subset=["open", "high", "low", "close", "volume"])


def _annualization_factor(timeframe: str) -> float:
    mapping = {
        "1m": 365 * 24 * 60,
        "5m": 365 * 24 * 12,
        "15m": 365 * 24 * 4,
        "30m": 365 * 24 * 2,
        "1h": 365 * 24,
        "2h": 365 * 12,
        "4h": 365 * 6,
        "1d": 365,
    }
    return float(mapping.get(timeframe, 252))


def fetch_ohlcv(args: argparse.Namespace) -> Dict[str, Any]:
    if args.days <= 0:
        raise ValueError("--days must be > 0")
    if args.limit <= 0:
        raise ValueError("--limit must be > 0")
    if args.max_pages <= 0:
        raise ValueError("--max-pages must be > 0")

    exchange = require_exchange(args.exchange)({"enableRateLimit": True})
    since = int((datetime.now(timezone.utc) - timedelta(days=args.days)).timestamp() * 1000)
    all_rows: List[List[Any]] = []

    for _ in range(args.max_pages):
        rows = exchange.fetch_ohlcv(args.symbol, timeframe=args.timeframe, since=since, limit=args.limit)
        if not rows:
            break
        all_rows.extend(rows)
        if len(rows) < args.limit:
            break
        since = int(rows[-1][0]) + 1
        if len(all_rows) >= 50000:
            break

    if not all_rows:
        return {
            "success": False,
            "error": "No OHLCV data returned",
            "exchange": args.exchange,
            "symbol": args.symbol,
            "timeframe": args.timeframe,
        }

    df = pd.DataFrame(all_rows, columns=["timestamp", "open", "high", "low", "close", "volume"])
    df = df.sort_values("timestamp").drop_duplicates("timestamp")
    output = Path(args.output).expanduser()
    output.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(output, index=False)

    return {
        "success": True,
        "mode": "fetch",
        "exchange": args.exchange,
        "symbol": args.symbol,
        "timeframe": args.timeframe,
        "rows": int(len(df)),
        "from": int(df["timestamp"].min()),
        "to": int(df["timestamp"].max()),
        "output": str(output),
    }


def _load_ohlcv_csv(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path)
    required = {"timestamp", "open", "high", "low", "close", "volume"}
    missing = sorted(required - set(df.columns))
    if missing:
        raise ValueError(f"Missing required columns in CSV: {', '.join(missing)}")
    df["timestamp"] = pd.to_datetime(df["timestamp"], unit="ms", utc=True, errors="coerce")
    for col in ("open", "high", "low", "close", "volume"):
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df.dropna(subset=["timestamp", "open", "high", "low", "close", "volume"]).sort_values("timestamp")
    return df


def _map_stock_timeframe(timeframe: str) -> str:
    timeframe = str(timeframe).lower()
    mapping = {
        "1m": "1m",
        "5m": "5m",
        "15m": "15m",
        "30m": "30m",
        "1h": "1h",
        "2h": "2h",
        "4h": "4h",
        "1d": "1d",
        "1w": "1wk",
        "1mth": "1mo",
        "1mo": "1mo",
    }
    return mapping.get(timeframe, timeframe)


def fetch_stock_ohlcv(args: argparse.Namespace) -> Dict[str, Any]:
    provider = str(getattr(args, "provider", "yfinance")).lower()
    if provider != "yfinance":
        return {
            "success": False,
            "error": f"Unsupported stock provider: {provider}",
            "hint": "Install yfinance and use --provider yfinance",
        }

    try:
        import yfinance as yf
    except Exception as exc:
        return {
            "success": False,
            "error": "Missing dependency: yfinance",
            "hint": "Install with: pip install yfinance",
            "details": str(exc),
        }

    interval = _map_stock_timeframe(args.timeframe)
    timeframe_days = int(_to_float(getattr(args, "days", 400), 400))
    if timeframe_days <= 0:
        return {"success": False, "error": "--days must be greater than 0"}

    try:
        if interval in {"1m", "5m", "15m", "30m"} and timeframe_days > 60:
            timeframe_days = 60
        bars = yf.download(
            args.symbol,
            period=f"{timeframe_days}d",
            interval=interval,
            auto_adjust=False,
            progress=False,
        )
    except Exception as exc:
        return {
            "success": False,
            "error": "Failed to fetch stock OHLCV",
            "details": str(exc),
            "symbol": args.symbol,
            "provider": provider,
            "timeframe": interval,
        }

    if bars is None or len(bars) == 0:
        return {
            "success": False,
            "error": "No stock OHLCV data returned",
            "symbol": args.symbol,
            "provider": provider,
            "timeframe": interval,
        }

    if isinstance(bars.columns, pd.MultiIndex):
        if args.symbol in bars.columns.get_level_values(0):
            bars = bars[args.symbol]
        else:
            bars = bars.droplevel(1, axis=1)

    bars = bars.rename(columns=str.lower)
    if "adj close" in bars.columns:
        bars = bars.rename(columns={"adj close": "close"})
    required = {"open", "high", "low", "close", "volume"}
    missing = sorted(required - set(bars.columns))
    if missing:
        return {
            "success": False,
            "error": f"Provider returned incomplete columns: {', '.join(missing)}",
            "provider": provider,
            "symbol": args.symbol,
        }

    output = Path(args.output).expanduser()
    output.parent.mkdir(parents=True, exist_ok=True)
    columns = ["open", "high", "low", "close", "volume"]
    out = bars[columns].copy()
    out = out.sort_index()
    out["timestamp"] = pd.to_datetime(out.index, utc=True, errors="coerce")
    out = out.dropna(subset=["timestamp", "open", "high", "low", "close", "volume"])
    if out.empty:
        return {
            "success": False,
            "error": "Could not normalize stock data timestamps.",
            "symbol": args.symbol,
            "provider": provider,
        }
    out["timestamp"] = (pd.to_datetime(out["timestamp"], utc=True).astype("int64") // 1_000_000)
    out = out[["timestamp", "open", "high", "low", "close", "volume"]].reset_index(drop=True)
    out = out.astype({"timestamp": "int64", "open": "float64", "high": "float64", "low": "float64", "close": "float64", "volume": "float64"})

    out.to_csv(output, index=False)
    return {
        "success": True,
        "mode": "fetch",
        "market": "stock",
        "provider": provider,
        "symbol": args.symbol,
        "timeframe": str(args.timeframe),
        "rows": int(len(out)),
        "from": int(out["timestamp"].min()),
        "to": int(out["timestamp"].max()),
        "output": str(output),
    }


def _score_text_sentiment(text: Any) -> float:
    if not isinstance(text, str):
        return 0.0
    words = re.findall(r"[a-zA-Z]+", text.lower())
    if not words:
        return 0.0

    positive = {
        "bullish",
        "surge",
        "rally",
        "up",
        "gain",
        "gains",
        "growth",
        "adopt",
        "adoption",
        "breakout",
        "upgrade",
        "partnership",
        "approval",
        "profit",
        "long",
        "strong",
        "positive",
    }
    negative = {
        "bearish",
        "crash",
        "dump",
        "drop",
        "loss",
        "losses",
        "hack",
        "hackers",
        "scam",
        "ban",
        "regulation",
        "lawsuit",
        "delist",
        "liquidation",
        "short",
        "down",
        "weak",
        "negative",
        "fear",
    }

    score = 0
    for word in words:
        if word in positive:
            score += 1
        if word in negative:
            score -= 1
    if score > 0:
        return 1.0
    if score < 0:
        return -1.0
    return 0.0


def _load_sentiment_series(
    df: pd.DataFrame,
    sentiment_csv: Optional[str],
    *,
    sentiment_weight: float = 1.0,
) -> pd.Series:
    if not sentiment_csv:
        return pd.Series([0.0] * len(df), index=df.index)

    sentiment_path = Path(sentiment_csv).expanduser()
    if not sentiment_path.exists():
        return pd.Series([0.0] * len(df), index=df.index)

    try:
        raw = pd.read_csv(sentiment_path)
    except Exception:
        return pd.Series([0.0] * len(df), index=df.index)

    timestamp_cols = [col for col in ["timestamp", "time", "datetime", "date"] if col in raw.columns]
    if not timestamp_cols:
        return pd.Series([0.0] * len(df), index=df.index)

    score_col = None
    for candidate in ["sentiment", "score", "sentiment_score", "value"]:
        if candidate in raw.columns:
            score_col = candidate
            break

    if score_col is None:
        for candidate in ["headline", "title", "text"]:
            if candidate in raw.columns:
                raw["sentiment_score"] = raw[candidate].apply(_score_text_sentiment)
                score_col = "sentiment_score"
                break

    if score_col is None:
        return pd.Series([0.0] * len(df), index=df.index)

    ts_col = timestamp_cols[0]
    raw["timestamp"] = pd.to_datetime(raw[ts_col], utc=True, errors="coerce")
    raw["score"] = pd.to_numeric(raw[score_col], errors="coerce").fillna(0.0)
    raw = raw.dropna(subset=["timestamp"]).sort_values("timestamp")
    if raw.empty:
        return pd.Series([0.0] * len(df), index=df.index)

    sentiment = raw.loc[:, ["timestamp", "score"]].copy()
    sentiment["score"] = sentiment["score"] * float(sentiment_weight)

    merged = pd.merge_asof(
        df[["timestamp"]],
        sentiment,
        on="timestamp",
        direction="nearest",
        tolerance=pd.Timedelta("2H"),
    )
    series = merged["score"].fillna(0.0).clip(-1.0, 1.0)
    return pd.Series(series.to_numpy(), index=df.index)


def run_execute(args: argparse.Namespace) -> Dict[str, Any]:
    symbol = str(args.symbol).upper()
    symbol_parts = symbol.split("/")
    timestamp = datetime.now(timezone.utc).isoformat()
    risk_blocks: List[Dict[str, Any]] = []
    risk_summary = {"pass": 0, "skip": 0, "blocked": 0, "fail": 0}

    def _add_risk_block(name: str, status: str, message: Optional[str] = None, details: Optional[Dict[str, Any]] = None) -> None:
        block: Dict[str, Any] = {"name": name, "status": status}
        if message:
            block["message"] = message
        if details:
            block["details"] = details
        risk_blocks.append(block)
        if status in risk_summary:
            risk_summary[status] += 1

    def _normalize_fills(raw_fills: Any) -> List[Dict[str, Any]]:
        if not isinstance(raw_fills, list):
            return []
        normalized_fills: List[Dict[str, Any]] = []
        for item in raw_fills:
            if not isinstance(item, dict):
                continue
            normalized_fills.append(
                {
                    "trade_id": item.get("tradeId"),
                    "fill_id": item.get("id"),
                    "timestamp": item.get("timestamp"),
                    "price": _to_float(item.get("price"), 0.0),
                    "amount": _to_float(item.get("amount"), 0.0),
                    "cost": _to_float(item.get("cost"), 0.0),
                    "fee": item.get("fee"),
                }
            )
        return normalized_fills

    def _normalize_fill(response: Dict[str, Any]) -> Dict[str, Any]:
        fee = response.get("fee")
        if isinstance(fee, dict):
            fee = {
                "cost": _to_float(fee.get("cost"), 0.0),
                "currency": fee.get("currency"),
            }
        return {
            "order_id": str(response.get("id")) if response.get("id") is not None else None,
            "client_order_id": response.get("clientOrderId"),
            "status": response.get("status"),
            "symbol": response.get("symbol"),
            "requested_amount": _to_float(args.amount, 0.0),
            "filled": _to_float(response.get("filled"), _to_float(response.get("amount"), 0.0)),
            "remaining": _to_float(response.get("remaining"), 0.0),
            "avg_price": _to_float(response.get("average"), _to_float(response.get("price"), 0.0)),
            "requested_price": _to_float(args.price, None),
            "cost": _to_float(response.get("cost"), 0.0),
            "fee": fee,
            "fees": response.get("fees"),
            "fills": _normalize_fills(response.get("fills")),
            "trades": _normalize_fills(response.get("trades")),
            "timestamp": response.get("timestamp"),
            "datetime": response.get("datetime"),
        }

    def _market_price_from_exchange(exchange: Any) -> Optional[float]:
        ticker = exchange.fetch_ticker(symbol)
        if not isinstance(ticker, dict):
            return None
        return (
            _to_float(ticker.get("last"), None)
            or _to_float(ticker.get("close"), None)
            or _to_float(ticker.get("mark"), None)
            or _to_float(ticker.get("bid"), None)
        )

    def _build_execution_report(fill: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return {
            "timestamp": timestamp,
            "exchange": args.exchange,
            "symbol": symbol,
            "requested_order": {
                "type": args.order_type,
                "side": args.side,
                "symbol": symbol,
                "amount": args.amount,
                "price": args.price,
                "test_mode": bool(args.test),
            },
            "risk_blocks": risk_blocks,
            "risk_summary": risk_summary,
            "fill": fill,
        }

    order_payload = {
        "type": args.order_type,
        "side": args.side,
        "symbol": symbol,
        "amount": args.amount,
        "price": args.price,
    }

    base_response: Dict[str, Any] = {
        "success": False,
        "mode": "execute",
        "exchange": args.exchange,
        "symbol": symbol,
        "order_payload": order_payload,
        "timestamp": timestamp,
        "risk_checks": {
            "notional_cap": float(args.max_order_notional),
            "account_fraction_cap": float(args.max_account_fraction),
            "skip_balance_check": bool(args.skip_balance_check),
        },
        "risk_blocks": risk_blocks,
        "risk_summary": risk_summary,
    }

    if args.amount is None or args.amount <= 0:
        _add_risk_block("order_amount", "blocked", "Amount must be greater than 0.")
        base_response.update(
            {
                "error": "--amount must be greater than 0",
                "status": "invalid_input",
                "execution_report": _build_execution_report(),
            }
        )
        return base_response
    _add_risk_block("order_amount", "pass", "Validated amount.")

    if args.order_type == "limit" and (args.price is None or args.price <= 0):
        _add_risk_block("order_price", "blocked", "Limit orders require --price > 0.")
        base_response.update(
            {
                "error": "limit orders require --price > 0",
                "status": "invalid_input",
                "execution_report": _build_execution_report(),
            }
        )
        return base_response
    if args.order_type == "limit":
        _add_risk_block("order_price", "pass", "Limit order price present.")
    else:
        _add_risk_block("order_price", "skip", "Market order uses live ticker for pre-flight checks.")

    if len(symbol_parts) != 2:
        _add_risk_block("symbol_format", "blocked", "Expected BASE/QUOTE format.")
        base_response.update(
            {
                "error": "Execution only supports pair format BASE/QUOTE, for example BTC/USDT",
                "status": "symbol_blocked",
                "execution_report": _build_execution_report(),
            }
        )
        return base_response
    _add_risk_block("symbol_format", "pass", "Accepted BASE/QUOTE format.")
    base_currency = symbol_parts[0].strip()
    quote_currency = symbol_parts[1].strip()

    if not args.confirm:
        _add_risk_block("execution_confirmation", "skip", "Dry-run mode enabled (no live execution).")

        notional_cap = _to_float(args.max_order_notional, 0.0)
        if notional_cap > 0:
            if args.order_type == "limit":
                estimated_notional = args.amount * _to_float(args.price, 0.0)
                if estimated_notional > notional_cap:
                    _add_risk_block(
                        "notional_cap",
                        "blocked",
                        f"Estimated notional {estimated_notional} exceeds cap {notional_cap}.",
                    )
                    base_response.update(
                        {
                            "error": f"Order notional {estimated_notional:.8f} exceeds max-order-notional {notional_cap:.8f}",
                            "status": "risk_limit_blocked",
                            "estimated_notional": float(estimated_notional),
                            "cap_notional": float(notional_cap),
                            "execution_report": _build_execution_report(),
                        }
                    )
                    return base_response
                _add_risk_block(
                    "notional_cap",
                    "pass",
                    {
                        "estimated_notional": float(estimated_notional),
                        "max_order_notional": float(notional_cap),
                    },
                )
            else:
                if args.price is not None and args.price > 0:
                    estimated_notional = args.amount * args.price
                    if estimated_notional > notional_cap:
                        _add_risk_block(
                            "notional_cap",
                            "blocked",
                            f"Estimated notional {estimated_notional} exceeds cap {notional_cap}.",
                        )
                        base_response.update(
                            {
                                "error": f"Order notional {estimated_notional:.8f} exceeds max-order-notional {notional_cap:.8f}",
                                "status": "risk_limit_blocked",
                                "estimated_notional": float(estimated_notional),
                                "cap_notional": float(notional_cap),
                                "execution_report": _build_execution_report(),
                            }
                        )
                        return base_response
                    _add_risk_block(
                        "notional_cap",
                        "pass",
                        {
                            "estimated_notional": float(estimated_notional),
                            "max_order_notional": float(notional_cap),
                            "source": "provided_price",
                        },
                    )
                else:
                    _add_risk_block(
                        "notional_cap",
                        "skip",
                        "Market order notional unavailable in dry-run mode without --price or live ticker.",
                    )
        else:
            _add_risk_block("notional_cap", "skip", "No notional cap configured (0).")

        if args.max_account_fraction > 0 and not args.skip_balance_check:
            _add_risk_block(
                "balance_cap",
                "skip",
                "Balance check skipped for dry-run mode.",
            )
        else:
            _add_risk_block("balance_cap", "skip", "Balance guard disabled for dry-run or max-account-fraction.")

        base_response.update(
            {
                "success": True,
                "status": "dry_run",
                "message": "Order prepared but not sent. Add --confirm to execute live.",
                "execution_report": _build_execution_report(),
            }
        )
        return base_response

    _add_risk_block("execution_confirmation", "pass", "Live execution requested.")

    if not args.api_key or not args.api_secret:
        _add_risk_block("exchange_credentials", "blocked", "Exchange API credentials missing.")
        base_response.update(
            {
                "error": "Live order requires --api-key and --api-secret (or CCXT_API_KEY / CCXT_API_SECRET)",
                "status": "live_blocked",
                "missing_credentials": True,
                "missing_exchange_key": bool(not args.api_key),
                "missing_exchange_secret": bool(not args.api_secret),
                "execution_report": _build_execution_report(),
            }
        )
        return base_response
    _add_risk_block("exchange_credentials", "pass")

    try:
        exchange = create_exchange(args)
        _add_risk_block("exchange_connection", "pass", "Exchange initialized.")
    except Exception as exc:
        _add_risk_block("exchange_connection", "fail", f"Failed to initialize exchange: {exc}")
        base_response.update(
            {
                "error": f"Exchange initialization failed: {exc}",
                "status": "live_blocked",
                "execution_report": _build_execution_report(),
            }
        )
        return base_response

    order_params: Dict[str, Any] = {"test": True} if args.test else {}

    notional_cap = _to_float(args.max_order_notional, 0.0)
    if notional_cap > 0:
        if args.order_type == "market":
            market_price = _market_price_from_exchange(exchange)
            if market_price is None or market_price <= 0:
                _add_risk_block("notional_cap", "fail", "Unable to read market price for notional estimation.")
                base_response.update(
                    {
                        "error": "Live market order requires live price for guardrail evaluation. Provide --price or enable exchange ticker support.",
                        "status": "live_blocked",
                        "execution_report": _build_execution_report(),
                    }
                )
                return base_response
            notional_estimate = args.amount * market_price
        else:
            notional_estimate = args.amount * _to_float(args.price, 0.0)
        if notional_estimate <= 0:
            _add_risk_block("notional_cap", "fail", "Notional estimate could not be computed.")
            base_response.update(
                {
                    "error": "Could not evaluate order notional; aborting live execution.",
                    "status": "live_blocked",
                    "execution_report": _build_execution_report(),
                }
            )
            return base_response
        if notional_estimate > notional_cap:
            _add_risk_block(
                "notional_cap",
                "blocked",
                f"Estimated notional {notional_estimate} exceeds cap {notional_cap}.",
            )
            base_response.update(
                {
                    "error": f"Order notional {notional_estimate:.8f} exceeds max-order-notional {notional_cap}",
                    "status": "risk_limit_blocked",
                    "estimated_notional": float(notional_estimate),
                    "cap_notional": float(notional_cap),
                    "execution_report": _build_execution_report(),
                }
            )
            return base_response
        _add_risk_block(
            "notional_cap",
            "pass",
            {"estimated_notional": float(notional_estimate), "max_order_notional": float(notional_cap)},
        )
    else:
        _add_risk_block("notional_cap", "skip", "No notional cap configured (0).")

    if (not args.skip_balance_check) and args.max_account_fraction and 0 < args.max_account_fraction <= 1:
        try:
            balances = exchange.fetch_balance()
            free_funds = balances.get("free", {})
            if args.side == "buy":
                available_quote = free_funds.get(quote_currency)
                if available_quote is not None:
                    available_quote = _to_float(available_quote, 0.0)
                    cap_quote = available_quote * args.max_account_fraction
                    notional_estimate = None
                    if args.order_type == "market":
                        market_price = _market_price_from_exchange(exchange)
                        if market_price is not None and market_price > 0:
                            notional_estimate = args.amount * market_price
                    else:
                        notional_estimate = args.amount * _to_float(args.price, 0.0)
                    if notional_estimate is not None and notional_estimate > cap_quote:
                        _add_risk_block(
                            "balance_cap",
                            "blocked",
                            (
                                f"Estimated notional {notional_estimate:.8f} exceeds "
                                f"{args.max_account_fraction:.2%} of available quote ({cap_quote:.8f})."
                            ),
                        )
                        base_response.update(
                            {
                                "error": (
                                    f"Live order exceeds account cap: estimated notional {notional_estimate:.8f} > "
                                    f"{args.max_account_fraction:.2%} of available quote ({cap_quote:.8f})"
                                ),
                                "status": "risk_limit_blocked",
                                "estimated_notional": float(notional_estimate),
                                "max_account_fraction": float(args.max_account_fraction),
                                "available_quote": float(available_quote),
                                "execution_report": _build_execution_report(),
                            }
                        )
                        return base_response
                    if notional_estimate is not None:
                        _add_risk_block(
                            "balance_cap",
                            "pass",
                            {
                                "quote_available": float(available_quote),
                                "account_fraction": float(args.max_account_fraction),
                                "account_quote_cap": float(cap_quote),
                                "estimated_notional": float(notional_estimate),
                            },
                        )
                    else:
                        _add_risk_block(
                            "balance_cap",
                            "skip",
                            "Market price unavailable for live notional cap validation; balance check cannot be completed.",
                        )
                else:
                    _add_risk_block(
                        "balance_cap",
                        "skip",
                        f"Quote balance unavailable for {quote_currency}.",
                    )
            else:
                available_base = free_funds.get(base_currency)
                if available_base is not None and args.amount > _to_float(available_base, 0.0):
                    _add_risk_block(
                        "balance_cap",
                        "blocked",
                        f"Sell amount {args.amount} exceeds available base {available_base}.",
                    )
                    base_response.update(
                        {
                            "error": f"Sell amount {args.amount} exceeds available base balance {available_base}",
                            "status": "risk_limit_blocked",
                            "available_base": float(available_base),
                            "request_amount": float(args.amount),
                            "execution_report": _build_execution_report(),
                        }
                    )
                    return base_response
                _add_risk_block(
                    "balance_cap",
                    "pass",
                    {"base_available": float(available_base) if available_base is not None else None},
                )
        except Exception as exc:
            _add_risk_block("balance_cap", "fail", f"Balance check failed: {exc}")
            base_response.update(
                {
                    "error": f"Balance check failed, set --skip-balance-check to bypass: {exc}",
                    "status": "risk_check_failed",
                    "execution_report": _build_execution_report(),
                }
            )
            return base_response
    else:
        _add_risk_block(
            "balance_cap",
            "skip",
            "Balance guard disabled by --skip-balance-check or max-account-fraction config.",
        )

    try:
        response = exchange.create_order(
            symbol,
            args.order_type,
            args.side,
            args.amount,
            args.price if args.order_type == "limit" else None,
            order_params,
        )
    except Exception as exc:
        _add_risk_block("order_submission", "fail", f"exchange.create_order raised: {exc}")
        base_response.update(
            {
                "error": f"Order submission failed: {exc}",
                "status": "execution_failed",
                "execution_report": _build_execution_report(),
            }
        )
        return base_response

    _add_risk_block("order_submission", "pass", "Exchange accepted order.")
    fill_report = _normalize_fill(response) if isinstance(response, dict) else None
    base_response.update(
        {
            "success": True,
            "status": "submitted",
            "exchange_response": response,
            "message": "Order submitted to exchange.",
            "execution_report": _build_execution_report(fill=fill_report),
        }
    )
    return base_response


def _build_ml_features(
    df: pd.DataFrame,
    sentiment: pd.Series,
) -> pd.DataFrame:
    close = df["close"].astype(float)
    features = pd.DataFrame(index=df.index)
    features["ret_1"] = close.pct_change()
    features["ret_3"] = close.pct_change(3)
    features["ret_8"] = close.pct_change(8)
    features["vol_8"] = features["ret_1"].rolling(8).std()
    features["vol_24"] = features["ret_1"].rolling(24).std()
    features["rsi"] = df["rsi"]
    features["rsi_below_30"] = (features["rsi"] < 30.0).astype(float)
    features["bb_width"] = (df["bb_upper"] - df["bb_lower"]) / df["sma"].replace(0, 1.0)
    features["ma_spread"] = (df["ma_fast"] - df["ma_slow"]).replace([np.inf, -np.inf], 0.0)
    features["trend_strength"] = df["trend_strength"]
    features["atr_pct"] = df["atr"] / close.replace(0, 1.0)
    features["volume_change"] = df["volume"].astype(float).pct_change()
    features["sentiment"] = sentiment.fillna(0.0)
    return features.replace([np.inf, -np.inf], np.nan).dropna()


def _build_ml_probabilities(
    df: pd.DataFrame,
    sentiment: pd.Series,
    args: argparse.Namespace,
) -> Dict[str, Any]:
    result: Dict[str, Any] = {
        "enabled": bool(getattr(args, "ml_enabled", False)),
        "model_type": str(getattr(args, "model_type", "random_forest")),
        "horizon": max(1, int(_to_float(getattr(args, "ml_horizon", 4), 4))),
        "train_ratio": _to_float(getattr(args, "ml_train_ratio", 0.70), 0.70),
        "confidence": _to_float(getattr(args, "ml_confidence", 0.55), 0.55),
        "rows": len(df),
        "train_rows": 0,
        "test_rows": 0,
        "accuracy": 0.0,
        "prediction_available": False,
        "model_fit": "not_trained",
        "eval_rows": 0,
    }

    if not result["enabled"]:
        result["probability"] = pd.Series([0.5] * len(df), index=df.index)
        return result

    if result["rows"] < 120:
        result["model_fit"] = "insufficient_data"
        result["probability"] = pd.Series([0.5] * len(df), index=df.index)
        return result

    features = _build_ml_features(df, sentiment)
    if len(features) < 100:
        result["model_fit"] = "insufficient_features"
        result["probability"] = pd.Series([0.5] * len(df), index=df.index)
        return result

    close = df["close"].astype(float)
    horizon = int(result["horizon"])
    target = (close.shift(-horizon) > close).astype(float)
    target = target.reindex(features.index)
    data = features.join(target.rename("target")).dropna()
    if len(data) < 100:
        result["model_fit"] = "insufficient_training_rows"
        result["probability"] = pd.Series([0.5] * len(df), index=df.index)
        return result

    model_target = data["target"].astype(int)
    model_features = data.drop(columns=["target"])
    if model_target.nunique() < 2:
        result["model_fit"] = "single_class_target"
        result["probability"] = pd.Series([0.5] * len(df), index=df.index)
        return result

    split = int(len(data) * result["train_ratio"])
    if split < 40 or split >= len(data):
        result["model_fit"] = "invalid_train_split"
        result["probability"] = pd.Series([0.5] * len(df), index=df.index)
        return result

    x_train = model_features.iloc[:split]
    y_train = model_target.iloc[:split]
    x_test = model_features.iloc[split:]
    y_test = model_target.iloc[split:]
    if len(y_test) == 0:
        result["model_fit"] = "empty_test_window"
        result["probability"] = pd.Series([0.5] * len(df), index=df.index)
        return result

    model_type = result["model_type"]
    model = None
    if model_type == "xgboost":
        try:
            from xgboost import XGBClassifier  # type: ignore

            model = XGBClassifier(
                n_estimators=120,
                max_depth=3,
                learning_rate=0.08,
                subsample=0.9,
                colsample_bytree=0.9,
                objective="binary:logistic",
                use_label_encoder=False,
                eval_metric="logloss",
                verbosity=0,
                random_state=42,
            )
        except Exception:
            model = None

    if model is None:
        if model_type in {"xgboost", "logistic"}:
            try:
                from sklearn.linear_model import LogisticRegression

                model = LogisticRegression(max_iter=300)
            except Exception:
                model = None
        else:
            try:
                from sklearn.ensemble import RandomForestClassifier

                model = RandomForestClassifier(
                    n_estimators=250,
                    max_depth=8,
                    random_state=42,
                    n_jobs=1,
                )
            except Exception:
                model = None

    if model is None:
        result["model_fit"] = "missing_ml_dependency"
        result["probability"] = pd.Series([0.5] * len(df), index=df.index)
        return result

    model.fit(x_train, y_train)
    proba = model.predict_proba(x_test)[:, 1]
    pred = (proba >= result["confidence"]).astype(int)
    accuracy = float((pred == y_test.to_numpy()).mean()) if len(y_test) > 0 else 0.0

    probability = pd.Series([0.5] * len(df), index=df.index)
    probability.loc[x_test.index] = proba
    result.update(
        {
            "prediction_available": True,
            "model_fit": "trained",
            "probability": probability,
            "train_rows": int(len(x_train)),
            "test_rows": int(len(x_test)),
            "eval_rows": int(len(y_test)),
            "accuracy": round(accuracy, 6),
        }
    )
    return result


def _rsi(series: pd.Series, period: int) -> pd.Series:
    delta = series.diff()
    up = delta.clip(lower=0.0)
    down = -delta.clip(upper=0.0)
    avg_gain = up.rolling(period).mean()
    avg_loss = down.rolling(period).mean()
    rs = avg_gain / avg_loss.replace(0, float("nan"))
    return 100.0 - (100.0 / (1.0 + rs))


def _add_indicators(df: pd.DataFrame, params: Dict[str, float]) -> pd.DataFrame:
    close = df["close"].astype(float)
    low = df["low"].astype(float)
    high = df["high"].astype(float)

    bb_window = int(params["bb_window"])
    bb_std = float(params["bb_std"])
    atr_window = int(params["atr_window"])
    rsi_period = int(params["rsi_period"])
    momentum_fast = int(params["momentum_fast"])
    momentum_slow = int(params["momentum_slow"])

    df["sma"] = close.rolling(bb_window).mean()
    df["std"] = close.rolling(bb_window).std(ddof=0)
    df["bb_upper"] = df["sma"] + (bb_std * df["std"])
    df["bb_lower"] = df["sma"] - (bb_std * df["std"])
    df["rsi"] = _rsi(close, period=rsi_period)
    df["ma_fast"] = close.rolling(momentum_fast).mean()
    df["ma_slow"] = close.rolling(momentum_slow).mean()
    df["trend_strength"] = (df["ma_fast"] - df["ma_slow"]).abs() / df["ma_slow"].replace(0, float("nan"))

    prev_close = close.shift(1)
    tr = pd.concat(
        [
            high - low,
            (high - prev_close).abs(),
            (low - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    df["atr"] = tr.rolling(atr_window).mean()
    return df


def _calc_max_drawdown(equity: List[float]) -> float:
    peak = -float("inf")
    max_dd = 0.0
    for value in equity:
        if value > peak:
            peak = value
        if peak > 0:
            max_dd = max(max_dd, (peak - value) / peak)
    return max_dd


def run_backtest(args: argparse.Namespace, *, mode: str) -> Dict[str, Any]:
    data_path = Path(args.data_csv).expanduser()
    if not data_path.exists():
        return {"success": False, "error": f"Data file not found: {data_path}"}

    df = _load_ohlcv_csv(data_path)
    if len(df) < 50:
        return {"success": False, "error": "Not enough data to run backtest.", "rows": int(len(df))}

    strategy_mode = str(getattr(args, "strategy_mode", "adaptive")).lower()
    if strategy_mode not in {"adaptive", "mean-reversion", "momentum", "momentum-only", "stat-arb"}:
        strategy_mode = "adaptive"

    params: Dict[str, float] = {
        "bb_window": max(2, int(_to_float(args.bb_window, 20))),
        "bb_std": _to_float(args.bb_std, 2.0),
        "rsi_period": max(2, int(_to_float(args.rsi_period, 14))),
        "rsi_buy": _to_float(args.rsi_buy, 30.0),
        "rsi_sell": _to_float(args.rsi_sell, 70.0),
        "strategy_mode": strategy_mode,
        "momentum_fast": max(2, int(getattr(args, "momentum_fast", 50))),
        "momentum_slow": max(2, int(getattr(args, "momentum_slow", 200))),
        "trend_threshold": max(0.0001, _to_float(getattr(args, "trend_threshold", 0.0025), 0.0025)),
        "use_regime": bool(getattr(args, "use_regime", True)),
        "max_portfolio_risk": min(1.0, max(0.0, _to_float(getattr(args, "max_portfolio_risk", 0.05), 0.05))),
        "ml_enabled": bool(getattr(args, "ml_enabled", False)),
        "ml_model_type": str(getattr(args, "model_type", "random_forest")),
        "ml_horizon": max(1, int(_to_float(getattr(args, "ml_horizon", 4), 4))),
        "ml_train_ratio": _to_float(getattr(args, "ml_train_ratio", 0.70), 0.70),
        "ml_confidence": _to_float(getattr(args, "ml_confidence", 0.55), 0.55),
        "sentiment_csv": getattr(args, "sentiment_csv", None),
        "sentiment_weight": _to_float(getattr(args, "sentiment_weight", 1.0), 1.0),
        "sentiment_threshold": _to_float(getattr(args, "sentiment_threshold", 0.0), 0.0),
        "atr_window": max(2, int(_to_float(args.atr_window, 14))),
        "fee_rate": _to_float(args.fee_rate, 0.0004),
        "stop_atr_mult": _to_float(args.stop_atr_mult, 2.0),
        "strategy_correlation_cap": _to_float(getattr(args, "strategy_correlation_cap", 0.70), 0.70),
        "strategy_correlation_window": max(
            20, int(_to_float(getattr(args, "strategy_correlation_window", 120), 120)
        )),
        "secondary_data_csv": getattr(args, "secondary_data_csv", None),
        "pair_symbol": getattr(args, "pair_symbol", None),
        "statarb_window": max(20, int(_to_float(getattr(args, "statarb_window", 100), 100))),
        "statarb_z_entry": _to_float(getattr(args, "statarb_z_entry", 2.0), 2.0),
        "statarb_z_exit": abs(_to_float(getattr(args, "statarb_z_exit", 0.0), 0.0)),
        "statarb_z_stop": abs(_to_float(getattr(args, "statarb_z_stop", 3.5), 3.5)),
        "position_size": _safe_position_size(_to_float(args.position_size, 0.02)),
        "max_drawdown": _to_float(args.max_drawdown, 0.10),
    }

    if params["momentum_fast"] >= params["momentum_slow"]:
        params["momentum_fast"] = max(2, int(params["momentum_slow"]) - 1)

    pair_metadata: Dict[str, Any] = {
        "enabled": strategy_mode == "stat-arb",
        "primary_csv": str(data_path),
        "secondary_csv": params["secondary_data_csv"],
        "pair_symbol": str(params["pair_symbol"]) if params["pair_symbol"] else None,
        "statarb_window": int(params["statarb_window"]),
        "statarb_z_entry": float(params["statarb_z_entry"]),
        "statarb_z_exit": float(params["statarb_z_exit"]),
        "statarb_z_stop": float(params["statarb_z_stop"]),
        "hedge_ratio": None,
    }
    if strategy_mode == "stat-arb":
        pair_csv = params["secondary_data_csv"]
        if not pair_csv:
            return {"success": False, "error": "stat-arb requires --secondary-data-csv"}
        pair_path = Path(pair_csv).expanduser()
        if not pair_path.exists():
            return {"success": False, "error": f"Secondary data file not found: {pair_path}"}
        pair_df = _load_ohlcv_csv(pair_path)
        if len(pair_df) < max(30, int(params["statarb_window"])):
            return {
                "success": False,
                "error": "Not enough data in secondary dataset for stat-arb.",
                "rows": int(len(pair_df)),
            }
        pair_metadata["secondary_csv"] = str(pair_path)
        try:
            df = _build_stat_arb_df(
                df,
                pair_df,
                pair_metadata["pair_symbol"] or "PAIR2",
                int(params["statarb_window"]),
            )
        except Exception as exc:
            return {"success": False, "error": "Failed to build stat-arb spread", "details": str(exc)}
        if len(df) < 30:
            return {
                "success": False,
                "error": "Not enough overlapping rows after building stat-arb spread.",
                "rows": int(len(df)),
            }

    df = _add_indicators(df, params).dropna(
        subset=["sma", "std", "bb_upper", "bb_lower", "rsi", "atr", "ma_fast", "ma_slow", "trend_strength"]
    )
    if strategy_mode == "stat-arb" and not df.empty:
        pair_metadata["hedge_ratio"] = float(df["hedge_ratio"].iloc[-1]) if "hedge_ratio" in df.columns else None

    if len(df) < 30:
        return {
            "success": False,
            "error": "Not enough indicator-ready rows for indicators with configured window.",
            "rows": int(len(df)),
        }

    sentiment = _load_sentiment_series(
        df,
        params["sentiment_csv"],
        sentiment_weight=params["sentiment_weight"],
    )
    if len(sentiment) != len(df):
        sentiment = pd.Series([0.0] * len(df), index=df.index)

    ml_info = _build_ml_probabilities(df, sentiment, argparse.Namespace(**{
        "ml_enabled": params["ml_enabled"],
        "model_type": params["ml_model_type"],
        "ml_horizon": params["ml_horizon"],
        "ml_train_ratio": params["ml_train_ratio"],
        "ml_confidence": params["ml_confidence"],
    }))
    ml_probs = ml_info["probability"]

    initial_cash = max(1e-9, _to_float(args.initial_cash, 10000.0))
    cash = initial_cash
    peak_equity = cash
    position_qty = 0.0
    position_entry = 0.0
    position_entry_ts: Optional[pd.Timestamp] = None
    position_fees = 0.0
    halted = False
    halt_reason: Optional[str] = None

    equity_curve: List[float] = []
    trades: List[Dict[str, Any]] = []
    strategy_signal_history = {
        "momentum": [],
        "mean_reversion": [],
    }
    risk_events: List[Dict[str, Any]] = []
    risk_controls = {
        "drawdown_circuit_enabled": params["max_drawdown"] > 0,
        "drawdown_circuit_level": float(params["max_drawdown"]),
        "drawdown_circuit_hits": 0,
        "strategy_correlation_cap": float(params["strategy_correlation_cap"]),
        "strategy_correlation_window": int(params["strategy_correlation_window"]),
        "strategy_correlation_hits": 0,
        "max_strategy_correlation_abs": 0.0,
    }

    def _open_trade(ts: pd.Timestamp, price: float, qty: float, fee: float, reason: str = "entry_signal") -> None:
        nonlocal cash, position_qty, position_entry, position_entry_ts, position_fees
        side = "buy" if qty >= 0 else "sell"
        cash -= qty * price + fee
        position_qty += qty
        position_entry = price
        position_entry_ts = ts
        position_fees = fee
        trades.append(
            {
                "side": side,
                "timestamp": ts.isoformat(),
                "price": round(price, 8),
                "qty": round(qty, 8),
                "amount": round(qty * price, 8),
                "reason": reason,
                "order_type": "market",
                "position_open_timestamp": ts.isoformat(),
            }
        )

    def _close_trade(ts: pd.Timestamp, price: float, reason: str) -> None:
        nonlocal cash, position_qty, position_entry, position_entry_ts, position_fees
        if position_qty == 0:
            return
        side = "sell" if position_qty > 0 else "buy"
        proceeds = position_qty * price
        fee = abs(proceeds) * params["fee_rate"]
        cash += proceeds - fee
        pnl = (price - position_entry) * position_qty - position_fees - fee
        pnl_pct = (price - position_entry) / position_entry if position_entry > 0 else 0.0
        if position_qty < 0:
            pnl_pct *= -1
        trades.append(
            {
                "side": side,
                "timestamp": ts.isoformat(),
                "price": round(price, 8),
                "qty": round(position_qty, 8),
                "pnl": round(pnl, 8),
                "pnl_pct": round(pnl_pct, 6),
                "reason": reason,
                "order_type": "market",
                "position_open_timestamp": position_entry_ts.isoformat() if position_entry_ts else None,
            }
        )
        position_qty = 0.0
        position_entry = 0.0
        position_entry_ts = None
        position_fees = 0.0

    for idx, row in enumerate(df.itertuples(index=False)):
        ts = getattr(row, "timestamp")
        close = float(row.close)
        low = float(row.low)
        high = float(row.high)
        rsi = float(row.rsi)
        upper = float(row.bb_upper)
        lower = float(row.bb_lower)
        atr = float(row.atr)
        ma_fast = float(row.ma_fast)
        ma_slow = float(row.ma_slow)
        trend_strength = float(row.trend_strength)
        trending = (ma_fast > ma_slow) and (trend_strength >= params["trend_threshold"])
        ml_prob = float(ml_probs.iloc[idx]) if params["ml_enabled"] else 0.5
        sentiment_score = float(sentiment.iloc[idx]) if len(sentiment) > idx else 0.0
        sentiment_ok = sentiment_score >= params["sentiment_threshold"]

        equity = cash + position_qty * close
        if equity > peak_equity:
            peak_equity = equity
        drawdown = 1.0 - (equity / peak_equity) if peak_equity > 0 else 0.0

        if not halted and drawdown >= params["max_drawdown"]:
            if position_qty > 0:
                _close_trade(ts, close, "drawdown-halt")
            if position_qty < 0:
                _close_trade(ts, close, "drawdown-halt")
            halted = True
            halt_reason = f"drawdown {drawdown:.4f} exceeded {params['max_drawdown']}"
            risk_controls["drawdown_circuit_hits"] += 1
            risk_events.append(
                {
                    "type": "drawdown_circuit_breaker",
                    "timestamp": str(ts),
                    "equity": round(equity, 8),
                    "drawdown": round(drawdown, 6),
                }
            )

        equity_curve.append(float(equity))
        if halted:
            continue

        mean_reversion_signal = float(close <= lower and rsi < params["rsi_buy"]) - float(
            close >= upper and rsi > params["rsi_sell"]
        )
        momentum_signal = float(ma_fast > ma_slow and close > ma_fast and rsi > params["rsi_buy"]) - float(
            ma_fast <= ma_slow or rsi > params["rsi_sell"] + 5
        )
        strategy_signal_history["mean_reversion"].append(mean_reversion_signal)
        strategy_signal_history["momentum"].append(momentum_signal)

        current_corr: Optional[float] = None
        window = int(params["strategy_correlation_window"])
        if len(strategy_signal_history["momentum"]) >= window:
            corr = _safe_correlation(
                strategy_signal_history["momentum"][-window:],
                strategy_signal_history["mean_reversion"][-window:],
            )
            if corr is not None:
                current_corr = corr
                risk_controls["max_strategy_correlation_abs"] = max(
                    risk_controls["max_strategy_correlation_abs"],
                    abs(corr),
                )

        correlation_blocked = False
        if current_corr is not None and params["strategy_correlation_cap"] > 0:
            if abs(current_corr) > params["strategy_correlation_cap"]:
                correlation_blocked = True
                risk_controls["strategy_correlation_hits"] += 1
                risk_events.append(
                    {
                        "type": "strategy_correlation_block",
                        "timestamp": str(ts),
                        "correlation": round(current_corr, 8),
                        "cap": float(params["strategy_correlation_cap"]),
                    }
                )

        strategy_mode = params["strategy_mode"]
        if params["use_regime"] and strategy_mode == "adaptive":
            strategy_mode = "momentum" if trending else "mean-reversion"

        entry_qty_sign = 0.0
        exit_signal = False
        stop_loss_signal = False
        if strategy_mode == "mean-reversion":
            entry_signal = close <= lower and rsi < params["rsi_buy"]
            exit_signal = close >= upper and rsi > params["rsi_sell"]
        elif strategy_mode == "momentum":
            entry_signal = ma_fast > ma_slow and close > ma_fast and rsi > params["rsi_buy"]
            exit_signal = ma_fast <= ma_slow or rsi > params["rsi_sell"] + 5
        elif strategy_mode == "momentum-only":
            entry_signal = ma_fast > ma_slow and close > ma_fast and rsi > params["rsi_buy"]
            exit_signal = ma_fast <= ma_slow or rsi > params["rsi_sell"] + 5
        elif strategy_mode == "stat-arb":
            spread_std = float(row.std) if getattr(row, "std", 0.0) else 0.0
            zscore = (close - float(row.sma)) / spread_std if spread_std > 0 else 0.0
            long_entry = zscore <= -params["statarb_z_entry"]
            short_entry = zscore >= params["statarb_z_entry"]

            if params["ml_enabled"]:
                long_entry = long_entry and (ml_prob >= params["ml_confidence"])
                short_entry = short_entry and ((1.0 - ml_prob) >= params["ml_confidence"])

            if correlation_blocked:
                long_entry = False
                short_entry = False

            long_entry = bool(long_entry and sentiment_ok)
            short_entry = bool(short_entry and sentiment_ok)

            if short_entry and not long_entry:
                entry_qty_sign = -1.0
            elif long_entry:
                entry_qty_sign = 1.0

            entry_signal = bool(entry_qty_sign != 0.0)
            stop_loss_signal = (position_qty > 0 and zscore >= params["statarb_z_stop"]) or (
                position_qty < 0 and zscore <= -params["statarb_z_stop"]
            )
            exit_signal = (position_qty > 0 and zscore >= params["statarb_z_exit"]) or (
                position_qty < 0 and zscore <= -params["statarb_z_exit"]
            )
        else:
            entry_signal = close <= lower and rsi < params["rsi_buy"]
            exit_signal = close >= upper and rsi > params["rsi_sell"]

        if correlation_blocked and strategy_mode in {"momentum", "mean-reversion", "momentum-only"}:
            entry_signal = False

        if params["ml_enabled"] and params["ml_model_type"] in {"random_forest", "xgboost", "logistic"}:
            if params["ml_confidence"] >= 0:
                if strategy_mode != "stat-arb":
                    entry_signal = entry_signal and (ml_prob >= params["ml_confidence"]) and sentiment_ok
                exit_signal = exit_signal or (ml_prob <= 1.0 - params["ml_confidence"])
            else:
                if strategy_mode != "stat-arb":
                    entry_signal = entry_signal and sentiment_ok
        else:
            if strategy_mode != "stat-arb":
                entry_signal = entry_signal and sentiment_ok

        if not halted and position_qty != 0:
            if atr > 0 and position_qty > 0:
                stop_price = position_entry - (params["stop_atr_mult"] * atr)
                if stop_price is not None and low <= stop_price:
                    _close_trade(ts, max(stop_price, 1e-8), "stop_loss_atr")
                    continue
                if stop_loss_signal:
                    _close_trade(ts, max(stop_price, 1e-8), "statarb_stop_loss")
                    continue
                if exit_signal:
                    _close_trade(ts, close, "exit_signal")
                    continue
            if atr > 0 and position_qty < 0:
                stop_price = position_entry + (params["stop_atr_mult"] * atr)
                if high >= stop_price:
                    _close_trade(ts, max(stop_price, 1e-8), "stop_loss_atr_short")
                    continue
                if stop_loss_signal:
                    _close_trade(ts, max(stop_price, 1e-8), "statarb_stop_loss")
                    continue
                if exit_signal:
                    _close_trade(ts, close, "exit_signal")
                    continue

        if position_qty == 0 and entry_signal:
            if strategy_mode == "stat-arb" and correlation_blocked:
                continue
            max_position_allocation = cash * params["max_portfolio_risk"]
            requested_allocation = cash * params["position_size"]
            allocation = min(max_position_allocation, requested_allocation)
            if allocation > 0:
                size_price = close
                if strategy_mode == "stat-arb":
                    spread_floor = 1e-6
                    if not np.isfinite(size_price) or abs(size_price) < spread_floor:
                        risk_events.append(
                            {
                                "type": "statarb_entry_block",
                                "timestamp": str(ts),
                                "reason": "invalid_spread_price",
                                "price": float(size_price) if np.isfinite(size_price) else None,
                            }
                        )
                        continue
                    size_price = max(abs(size_price), spread_floor)
                qty = allocation / size_price
                if strategy_mode == "stat-arb":
                    qty = qty * entry_qty_sign
                    if entry_qty_sign == 0:
                        qty = 0
                    reason = "entry_signal_statarb"
                else:
                    reason = "entry_signal"
                fee = allocation * params["fee_rate"]
                if qty:
                    _open_trade(ts, close, qty, abs(fee), reason=reason)

    if position_qty != 0:
        _close_trade(df.iloc[-1]["timestamp"], float(df.iloc[-1]["close"]), "eod_close")

    final_equity = cash
    equity_series = pd.Series(equity_curve)
    equity_returns = equity_series.pct_change().dropna()
    sharpe = 0.0
    if len(equity_returns) > 1 and equity_returns.std() > 0:
        sharpe = float(
            equity_returns.mean() / equity_returns.std() * np.sqrt(_annualization_factor(getattr(args, "timeframe", "1h")))
        )

    max_drawdown = _calc_max_drawdown(equity_curve)
    closed_trades = [row for row in trades if "pnl" in row]
    closed_pnl = [float(row["pnl"]) for row in closed_trades]
    win_trades = [p for p in closed_pnl if p > 0]
    lose_trades = [p for p in closed_pnl if p <= 0]
    win_rate = (len(win_trades) / len(closed_pnl) * 100.0) if closed_pnl else 0.0
    gross_profit = sum(win_trades) if win_trades else 0.0
    gross_loss = -sum(lose_trades) if lose_trades else 0.0
    profit_factor = (gross_profit / gross_loss) if gross_loss > 0 else (float("inf") if gross_profit > 0 else 0.0)
    avg_trade_pnl = float(np.mean(closed_pnl)) if closed_pnl else 0.0
    total_return = (final_equity / initial_cash) - 1.0

    metrics = {
        "initial_equity": initial_cash,
        "final_equity": float(final_equity),
        "total_return": round(total_return, 6),
        "ml_enabled": bool(params["ml_enabled"]),
        "ml_model_type": params["ml_model_type"] if params["ml_enabled"] else "disabled",
        "ml_horizon": int(params["ml_horizon"]),
        "ml_train_ratio": round(float(params["ml_train_ratio"]), 6),
        "ml_confidence": round(float(params["ml_confidence"]), 6),
        "ml_model_fit": ml_info.get("model_fit", "unknown"),
        "ml_accuracy": round(float(ml_info.get("accuracy", 0.0)), 6),
        "ml_train_rows": int(ml_info.get("train_rows", 0)),
        "ml_test_rows": int(ml_info.get("test_rows", 0)),
        "ml_sentiment_threshold": round(float(params["sentiment_threshold"]), 6),
        "ml_eval_rows": int(ml_info.get("eval_rows", 0)),
        "strategy_mode": params["strategy_mode"],
        "strategy_regime_enabled": bool(params["use_regime"]),
        "max_portfolio_risk": round(float(params["max_portfolio_risk"]), 6),
        "sharpe": round(sharpe, 6),
        "max_drawdown": round(max_drawdown, 6),
        "risk_controls": risk_controls,
        "risk_events": risk_events,
        "win_rate": round(win_rate, 2),
        "trade_count": len(closed_trades),
        "profit_factor": round(float(profit_factor), 6),
        "avg_trade_pnl": round(avg_trade_pnl, 8),
        "drawdown_halt": bool(halted),
        "halt_reason": halt_reason,
        "statarb": pair_metadata if strategy_mode == "stat-arb" else None,
        "bars": int(len(df)),
        "trades": len(trades),
    }

    if args.trades_csv:
        trades_path = Path(args.trades_csv).expanduser()
        trades_path.parent.mkdir(parents=True, exist_ok=True)
        with trades_path.open("w", newline="", encoding="utf-8") as handle:
            fieldnames = [
                "side",
                "timestamp",
                "price",
                "qty",
                "amount",
                "pnl",
                "pnl_pct",
                "reason",
                "order_type",
                "position_open_timestamp",
            ]
            writer = csv.DictWriter(handle, fieldnames=fieldnames)
            writer.writeheader()
            for row in trades:
                writer.writerow({key: row.get(key) for key in fieldnames})
        metrics["trades_csv"] = str(trades_path)

    last_timestamp = df.iloc[-1]["timestamp"]
    position_state = "halted" if halted else ("long" if position_qty > 0 else ("short" if position_qty < 0 else "flat"))
    signal = "none" if not trades else position_state

    return {
        "success": True,
        "mode": mode,
        "mode_description": "portfolio-paper" if mode == "portfolio-run" else ("ml-paper" if mode == "ml-run" else ("paper" if mode == "paper-run" else "backtest")),
        "halted": halted,
        "halt_reason": halt_reason,
        "signals": {
            "position": signal,
            "last_price": float(df.iloc[-1]["close"]),
            "last_timestamp": str(last_timestamp),
            "last_ml_prob": float(ml_probs.iloc[-1]) if params["ml_enabled"] else 0.5,
            "last_sentiment": float(sentiment.iloc[-1]) if len(sentiment) > 0 else 0.0,
        },
        "metrics": metrics,
        "trades": trades,
    }


def write_json(result: Dict[str, Any]) -> None:
    print(json.dumps(result, indent=2))


def main() -> int:
    argv = sys.argv[1:]
    if argv:
        first_arg = argv[0]
        looks_like_flag = str(first_arg).startswith("-")
        if not looks_like_flag and not _looks_like_known_mode(first_arg):
            parsed_human_args = _build_human_mode_args(" ".join(argv))
            if parsed_human_args is not None:
                _bootstrap_progress(
                    "Detected human-readable prompt. Translating into structured trading mode arguments."
                )
                argv = parsed_human_args

    parser = build_parser()
    sys.argv = [sys.argv[0], *argv]
    args = parser.parse_args()
    try:
        if args.mode == "fetch":
            if getattr(args, "market", "crypto") == "stock":
                result = fetch_stock_ohlcv(args)
            else:
                result = fetch_ohlcv(args)
        elif args.mode in {"backtest", "paper-run", "portfolio-run", "ml-run"}:
            if args.mode == "ml-run":
                args.ml_enabled = True
            result = run_backtest(args, mode=args.mode)
        elif args.mode == "execute":
            result = run_execute(args)
        else:
            result = {"success": False, "error": f"Unknown mode: {args.mode}"}

        write_json(result)
        return 0 if result.get("success") else 1
    except Exception as exc:  # pragma: no cover
        write_json({"success": False, "error": str(exc)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
