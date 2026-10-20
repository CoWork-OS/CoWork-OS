"""Hermetic smoke coverage for the bundled CLI, using synthetic subjects only."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


CLI = Path(__file__).resolve().parents[1] / "scripts" / "pdd.py"


class CliSmokeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name) / "state"
        # Inherit only executable/system paths; never use operator credentials or config.
        self.env = {key: os.environ[key] for key in ("PATH", "SYSTEMROOT") if key in os.environ}
        self.env.update(PDD_DATA_DIR=str(self.data), COWORK_HOME=self.temp.name,
                        PYTHONDONTWRITEBYTECODE="1", PYTHONNOUSERSITE="1")

    def run_cli(self, *args, succeeds=True):
        result = subprocess.run([sys.executable, str(CLI), *args], env=self.env,
                                cwd=self.temp.name, text=True, capture_output=True, timeout=20)
        if succeeds:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout)
        return result

    def intake(self, authorized=True):
        args = ["intake", "--full-name", "Synthetic Audit Subject", "--email", "audit@example.invalid"]
        if authorized:
            args.append("--consent")
        return json.loads(self.run_cli(*args).stdout)

    def test_planning_requires_recorded_consent(self):
        subject = self.intake(authorized=False)
        for args in (("plan", subject["subject_id"]),
                     ("record", subject["subject_id"], "spokeo", "found")):
            result = self.run_cli(*args, succeeds=False)
            self.assertIn("no recorded authorization", result.stderr.lower())
        self.assertFalse((self.data / "subjects" / subject["subject_id"] / "ledger.json").exists())

    def test_subjects_are_opaque_and_isolated(self):
        first, second = self.intake(), self.intake()
        self.assertRegex(first["subject_id"], r"^sub_[0-9a-f]{10}$")
        self.assertNotEqual(first["subject_id"], second["subject_id"])
        for subject in (first, second):
            dossier = self.data / "subjects" / subject["subject_id"] / "dossier.json"
            self.assertEqual(json.loads(dossier.read_text())["identity"]["full_name"], "Synthetic Audit Subject")

    def test_invalid_transition_does_not_claim_removal(self):
        subject = self.intake()["subject_id"]
        self.run_cli("record", subject, "spokeo", "confirmed_removed", succeeds=False)
        self.assertFalse((self.data / "subjects" / subject / "ledger.json").exists())

    def test_recorded_finding_persists_with_audit_receipt(self):
        subject = self.intake()["subject_id"]
        result = json.loads(self.run_cli("record", subject, "spokeo", "found", "--found", "true").stdout)
        self.assertEqual(result["state"], "found")
        directory = self.data / "subjects" / subject
        self.assertEqual(json.loads((directory / "ledger.json").read_text())["spokeo"]["state"], "found")
        receipts = [json.loads(line) for line in (directory / "audit.jsonl").read_text().splitlines()]
        self.assertTrue(receipts)
        self.assertNotIn("Synthetic Audit Subject", json.dumps(receipts))


if __name__ == "__main__":
    unittest.main()
