import csv
import json
import math
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "trading_foundation.py"


def _write_ohlcv_csv(path: Path, closes, timestamp_offset_ms: int = 0) -> None:
    rows = []
    start_ms = 1700000000000
    step_ms = 3_600_000
    for i, close in enumerate(closes):
        open_price = float(close) * 0.998
        high = max(open_price, float(close)) + 1.0
        low = min(open_price, float(close)) - 1.0
        rows.append(
            {
                "timestamp": start_ms + timestamp_offset_ms + (i * step_ms),
                "open": f"{open_price:.8f}",
                "high": f"{high:.8f}",
                "low": f"{low:.8f}",
                "close": f"{float(close):.8f}",
                "volume": f"{1000 + i:.8f}",
            }
        )

    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["timestamp", "open", "high", "low", "close", "volume"])
        writer.writeheader()
        writer.writerows(rows)


class TradingFoundationCliTests(unittest.TestCase):
    @classmethod
    def _run_cli(cls, args, expect_success: bool = True):
        cmd = [sys.executable, str(SCRIPT_PATH), *args]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0 and expect_success:
            raise AssertionError(
                f"Command failed with code {proc.returncode}: {proc.stdout}\\n{proc.stderr}"
            )
        return json.loads(proc.stdout.strip())

    @classmethod
    def _build_series(cls, n=240):
        for i in range(n):
            yield 100.0 + (i * 0.05) + 5.0 * math.sin(i / 10.0)

    def _make_dataset(
        self, directory: Path, name: str, multiplier: float = 1.0, phase: float = 0.0, timestamp_offset_ms: int = 0
    ):
        closes = []
        for i in range(260):
            base = 100.0 + (i * 0.05) + 5.0 * math.sin((i + phase) / 10.0)
            closes.append(base * multiplier)
        path = directory / f"{name}.csv"
        _write_ohlcv_csv(path, closes, timestamp_offset_ms=timestamp_offset_ms)
        return path

    def test_execute_risk_blocks_and_report_includes_fill_telemetry(self):
        output = self._run_cli(
            [
                "execute",
                "--exchange",
                "binance",
                "--symbol",
                "BTC/USDT",
                "--side",
                "buy",
                "--order-type",
                "limit",
                "--amount",
                "0.01",
                "--price",
                "100",
                "--max-order-notional",
                "2",
            ]
        )
        self.assertTrue(output["success"])
        self.assertEqual(output["status"], "dry_run")
        report = output["execution_report"]
        self.assertIn("risk_blocks", report)
        self.assertIn("risk_summary", report)
        self.assertIn("fill", report)
        self.assertIsNone(report["fill"])
        self.assertTrue(any(block.get("name") == "order_amount" and block.get("status") == "pass" for block in report["risk_blocks"]))
        block_total = len(report["risk_blocks"])
        summary_total = sum(report["risk_summary"].values())
        self.assertEqual(block_total, summary_total)

    def test_execute_invalid_amount_is_blocked(self):
        output = self._run_cli(
            [
                "execute",
                "--exchange",
                "binance",
                "--symbol",
                "BTC/USDT",
                "--side",
                "buy",
                "--order-type",
                "market",
                "--amount",
                "0",
                "--max-order-notional",
                "100",
            ]
            , expect_success=False
        )
        self.assertFalse(output["success"])
        self.assertEqual(output["status"], "invalid_input")
        report = output["execution_report"]
        self.assertTrue(any(block.get("name") == "order_amount" and block.get("status") == "blocked" for block in report["risk_blocks"]))

    def test_statarb_requires_secondary_data(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            dataset = self._make_dataset(Path(tmpdir), "primary")
            output = self._run_cli(
                [
                    "portfolio-run",
                    "--data-csv",
                    str(dataset),
                    "--initial-cash",
                    "10000",
                    "--strategy-mode",
                    "stat-arb",
                    "--statarb-window",
                    "30",
                ],
                expect_success=False,
            )
            self.assertFalse(output["success"])
            self.assertIn("stat-arb requires --secondary-data-csv", output["error"])

    def test_statarb_output_contains_pair_metadata(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            base_path = self._make_dataset(Path(tmpdir), "primary", multiplier=1.0)
            pair_path = self._make_dataset(Path(tmpdir), "pair", multiplier=0.6, phase=3.0)
            output = self._run_cli(
                [
                    "portfolio-run",
                    "--data-csv",
                    str(base_path),
                    "--secondary-data-csv",
                    str(pair_path),
                    "--initial-cash",
                    "10000",
                    "--strategy-mode",
                    "stat-arb",
                    "--pair-symbol",
                    "BTC/ETH",
                    "--statarb-window",
                    "30",
                    "--statarb-z-entry",
                    "1.2",
                    "--statarb-z-exit",
                    "0.25",
                    "--statarb-z-stop",
                    "3.5",
                ]
            )
            self.assertTrue(output["success"])
            self.assertIsNotNone(output["metrics"]["statarb"])
            self.assertEqual(output["metrics"]["statarb"]["pair_symbol"], "BTC/ETH")
            self.assertEqual(output["metrics"]["statarb"]["statarb_window"], 30)

    def test_human_prompt_without_mode_defaults_to_portfolio_run(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            base_path = self._make_dataset(Path(tmpdir), "primary")
            output = self._run_cli(
                [
                    f"{base_path} --initial-cash 10000 --strategy-mode adaptive --position-size 0.03",
                ]
            )
            self.assertTrue(output["success"])
            self.assertEqual(output["mode"], "portfolio-run")
            self.assertIn("risk_controls", output["metrics"])

    def test_human_prompt_statarb_mode_parses_pair_csv(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            base_path = self._make_dataset(Path(tmpdir), "primary")
            pair_path = self._make_dataset(Path(tmpdir), "pair", phase=3.0)
            output = self._run_cli(
                [f"{base_path} {pair_path} --strategy-mode stat-arb --pair-symbol BTC/ETH --statarb-window 30"]
            )
            self.assertTrue(output["success"])
            self.assertEqual(output["mode"], "portfolio-run")
            self.assertEqual(output["metrics"]["strategy_mode"], "stat-arb")

    def test_statarb_tolerates_timestamp_skew(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            base_path = self._make_dataset(Path(tmpdir), "primary")
            pair_path = self._make_dataset(Path(tmpdir), "pair", phase=4.0, timestamp_offset_ms=30_000)
            output = self._run_cli(
                [
                    "portfolio-run",
                    "--data-csv",
                    str(base_path),
                    "--secondary-data-csv",
                    str(pair_path),
                    "--initial-cash",
                    "10000",
                    "--strategy-mode",
                    "stat-arb",
                    "--pair-symbol",
                    "BTC/ETH",
                    "--statarb-window",
                    "30",
                ]
            )
            self.assertTrue(output["success"])
            self.assertIsNotNone(output["metrics"]["statarb"])
            self.assertEqual(output["metrics"]["statarb"]["pair_symbol"], "BTC/ETH")

    def test_statarb_handles_negative_spread_domain(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            base_path = self._make_dataset(Path(tmpdir), "primary", multiplier=1.0)
            pair_path = self._make_dataset(Path(tmpdir), "pair", multiplier=3.0, phase=12.0)
            output = self._run_cli(
                [
                    "portfolio-run",
                    "--data-csv",
                    str(base_path),
                    "--secondary-data-csv",
                    str(pair_path),
                    "--initial-cash",
                    "10000",
                    "--strategy-mode",
                    "stat-arb",
                    "--pair-symbol",
                    "BTC/ETH",
                    "--statarb-window",
                    "30",
                    "--statarb-z-entry",
                    "1.0",
                ]
            )
            self.assertTrue(output["success"])
            self.assertFalse(math.isinf(output["metrics"]["max_drawdown"]))
            self.assertFalse(math.isnan(output["metrics"]["max_drawdown"]))
            for trade in output["trades"]:
                if "price" in trade and trade["price"] is not None:
                    self.assertGreater(trade["price"], 0.0)

    def test_backtest_includes_portfolio_risk_controls(self):
        primary = self._build_series(260)
        with tempfile.TemporaryDirectory() as tmpdir:
            base_path = self._make_dataset(Path(tmpdir), "primary", multiplier=1.0)
            pair_path = self._make_dataset(Path(tmpdir), "pair", multiplier=0.95, phase=2.5)
            output = self._run_cli(
                [
                    "portfolio-run",
                    "--data-csv",
                    str(base_path),
                    "--secondary-data-csv",
                    str(pair_path),
                    "--initial-cash",
                    "10000",
                    "--strategy-mode",
                    "adaptive",
                    "--max-drawdown",
                    "0.10",
                    "--strategy-correlation-cap",
                    "0.85",
                    "--strategy-correlation-window",
                    "30",
                    "--momentum-fast",
                    "8",
                    "--momentum-slow",
                    "18",
                ]
            )
            self.assertTrue(output["success"])
            risk_controls = output["metrics"]["risk_controls"]
            self.assertIn("drawdown_circuit_enabled", risk_controls)
            self.assertIn("strategy_correlation_cap", risk_controls)
            self.assertTrue(risk_controls["drawdown_circuit_enabled"])
            self.assertAlmostEqual(risk_controls["drawdown_circuit_level"], 0.10)
            self.assertEqual(risk_controls["strategy_correlation_cap"], 0.85)


if __name__ == "__main__":
    unittest.main()
