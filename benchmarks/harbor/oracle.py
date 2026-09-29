"""Small deterministic oracle used by hidden Harbor verifier scripts and unit tests."""

from __future__ import annotations


def grade_exact(expected: bytes, actual: bytes | None) -> int:
    """Return one only for the exact candidate artifact; missing proof is zero."""
    return int(actual is not None and actual == expected)
