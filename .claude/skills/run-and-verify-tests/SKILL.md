---
name: run-and-verify-tests
description: Exact commands to run targeted or full Taskly test suites (Vitest frontend, pytest backend), typecheck and format test files, collect machine-readable coverage, rerun changed tests shuffled and in shifted time zones to catch flakiness, and summarize coverage per file and for changed lines. Use whenever tests need to be executed or coverage measured.
---

# Run and verify tests

All test execution goes through one script so that every run is reproducible, uses the repo's own configuration and never sees credentials. Run it from the repository root with exactly this relative path; the permission rules match the literal command and deny absolute paths, `npx`, `npm`, `pytest` and `git`.

```sh
node .claude/skills/run-and-verify-tests/scripts/runTests.ts <command> [options] [files]
```

## Commands

| Command | Runs |
|---|---|
| `frontend [files]` | `vitest run` in `frontend/` for the given `frontend/src/**/*.test.ts(x)` files, or the whole suite |
| `backend [files]` | `python -m pytest -p no:cacheprovider -q` in `backend/` with `backend/.venv`, for the given `backend/tests/**/*.py` files or node ids (`backend/tests/features/todos/test_router.py::test_list_returns_tasks_from_repository`), or the whole suite |
| `all` | both full suites |
| `typecheck` | `tsc --noEmit -p tsconfig.json` in `frontend/` (test files included) |
| `format <files>` | `prettier --write` on the given frontend test files; add `--check` to only check |

Options:

- `--coverage`: collect coverage into `--out` (default `.testAgent/coverage`): `frontend/coverage-final.json` and `coverage-summary.json` from Vitest (v8, with the include and exclude lists of `vite.config.ts`), `backend/coverage.json` from coverage.py (branch coverage, `source = app`), plus a combined `summary.json` for the stacks that ran. `--out` must stay under `.testAgent/`.
- `--repeat <n>` (1 to 5): run the same selection n times. Run 1 is unchanged; runs 2 and up use `TZ=Pacific/Kiritimati` (UTC+14) and `TZ=Pacific/Pago_Pago` (UTC-11), and the frontend also shuffles test order with a fixed seed (printed in the output). A test that passes only in run 1 depends on order, time zone or shared state.
- `--match <pattern>`: Vitest `--testNamePattern` or pytest `-k`, to iterate on one case.
- `--timeoutSeconds <n>`: per-run timeout, default 900.

The child processes get a minimal environment (`PATH`, `HOME`, locale, `TMPDIR`, `TZ`, `CI`, `TERM`, `NO_COLOR=1`). API keys and tokens are never passed to test code. The script exits non-zero if any run fails and ends with one summary line, for example `runTests: 3 passed, 0 failed`.

## Typical loop

```sh
node .claude/skills/run-and-verify-tests/scripts/runTests.ts frontend frontend/src/lib/http.test.ts
node .claude/skills/run-and-verify-tests/scripts/runTests.ts backend backend/tests/core/test_config.py --match precedence
node .claude/skills/run-and-verify-tests/scripts/runTests.ts format frontend/src/lib/http.test.ts
node .claude/skills/run-and-verify-tests/scripts/runTests.ts typecheck
node .claude/skills/run-and-verify-tests/scripts/runTests.ts all --coverage
node .claude/skills/run-and-verify-tests/scripts/runTests.ts frontend --repeat 3 frontend/src/lib/http.test.ts
node .claude/skills/run-and-verify-tests/scripts/runTests.ts backend --repeat 3 backend/tests/core/test_config.py
```

Read failures fully before changing anything. Vitest prints the failing assertion with a diff and the code frame; pytest prints the assertion rewrite and `-ra` lists skips and errors at the end.

## Coverage summary

```sh
node .claude/skills/run-and-verify-tests/scripts/coverageSummary.ts --dir .testAgent/coverage --changeSet .testAgent/changeSet.json --top 15
```

Prints JSON with, per stack, total line and branch coverage and the files with the most uncovered lines, each with `missingLines` as `[start, end]` ranges in repository-relative paths. With `--changeSet` it adds `changedFiles`: for every changed source file whether it is in the coverage report at all (excluded files are not) and which `changedLines` are still uncovered. Use it to pick what to test next and to check that the lines you meant to cover are covered.

`--dir .testAgent/baseline` reads the coverage the workflow measured before you started.

## Definition of done

1. Every test file you touched passes alone and in the full suite.
2. `format` and `typecheck` pass for frontend test files.
3. `--repeat 3` passes for every changed test file.
4. `all --coverage` passes and the uncovered changed lines you targeted are gone.

The pipeline repeats all of this in a clean checkout without your workspace, so anything that only passes on your machine state will be rejected.
