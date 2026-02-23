#!/usr/bin/env python3

"""Thin wrapper that forwards execution requests to the shared crypto_trading script."""

from __future__ import annotations

import os
import sys
from pathlib import Path


def main() -> int:
    script_path = (
        Path(__file__).resolve().parents[1]
        / "crypto-trading"
        / "scripts"
        / "crypto_trading.py"
    )
    if not script_path.exists():
        print(
            f"Missing shared script: {script_path}",
            file=sys.stderr,
        )
        return 1

    os.execv(
        sys.executable,
        [sys.executable, str(script_path), *sys.argv[1:]],
    )

    # os.execv replaces the current process; this return is defensive for typing.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
