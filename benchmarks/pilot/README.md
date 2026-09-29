# Development pilot fixtures

These are two synthetic, deterministic fixtures maintained by **cowork-os**. They exercise independent host-owned graders; they are not model trials or competitive results.

- **C01 — invoice rounding** asks for a code fix in a tiny Node 24 billing repository. Its grading oracle uses Python `Decimal` with round-half-up and validates JSON integer types strictly, rejecting booleans and floating-point values in every cents field. Submitted code runs only in the pinned Linux/amd64 Node image with no network, a read-only root filesystem, and bounded resources. The container sees one submitted source file and receives case inputs on stdin. It never receives oracle code, expected results, reward files, or host credentials.
- **R02 — conflicting forecast** asks for a machine-readable answer and a cited explanation from a fictional offline packet. The grader checks the controlling revision, the superseded forecast, and citation IDs/spans directly; it does not use a model as judge.

The remaining 22 tasks in the approved catalog are unsupported here. The current P04 adapter is fixture-only and cannot execute arbitrary real-model tasks. Model/provider integration and provider-budget qualification remain separate work. A runnable fixture means only that its independent grader accepted its known correct control and rejected the checked-in known-wrong controls. It does not mean a model passed, and these two fixtures do not represent the remaining catalog.

## Commands

The materializer and validator require Python 3.10 or newer and the validation command requires Docker with the pinned image already available. Materialize a clean candidate workspace without graders or hidden expected data:

```sh
python3 benchmarks/pilot/pilot.py materialize C01 --destination /tmp/c01-work
python3 benchmarks/pilot/pilot.py materialize R02 --destination /tmp/r02-work
```

Run the actual graders against the included controls using the pinned Docker image already present on the host:

```sh
python3 benchmarks/pilot/pilot.py validate --output-root /private/tmp/cowork-pilot-validation
```

Validation refuses an absent/wrong image and never pulls it. It writes a retained `validation-manifest.json` and `validation.log` beneath a unique run directory. It removes only that run's marked `submissions/` staging directory. The run and output-root sentinel files remain and their SHA-256 values are recorded before and after cleanup. `cleanup --output-root <root> --run-id <id>` repeats the same bounded cleanup for an interrupted run; it requires the exact run marker and only removes the direct child named `submissions`.

`HASHES.json` locks task inputs, grader code, documentation, and known-control submissions. Materialization and validation stop if a locked file changes or an unlisted file appears. The manifest records those hashes, pinned runtime/container permissions, each control verdict, and cleanup evidence. No third-party corpus, network lookup, customer data, or paid provider is involved.

## Scope and limits

Both fixtures are synthetic development artifacts with small, hand-authored inputs. They are useful for checking that task instructions, fixture packaging, and deterministic grading controls work. They provide no evidence about model performance, task representativeness, competitive standing, product integration, or provider cost. C01's container boundary reduces access to host files and network; it is a local development sandbox, not a general-purpose hostile-code service.
