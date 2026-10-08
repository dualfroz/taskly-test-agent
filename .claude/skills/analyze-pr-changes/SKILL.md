---
name: analyze-pr-changes
description: Get and interpret the change set of a pull request in the Taskly repo - changed files with status, area, kind, changed line ranges, the conventional test file and related tests - and decide per file whether unit tests must be created, updated, or are not needed. Use before writing tests for a PR or a branch diff.
---

# Analyze PR changes

The change set is computed by a script, not by reading `git diff` output by eye. The script is deterministic, so the workflow and you see exactly the same list.

## Getting the change set

In CI the workflow has already written it to `.testAgent/changeSet.json`. Read that file. To compute it yourself (local runs), from the repository root:

```sh
node .claude/skills/analyze-pr-changes/scripts/changeSet.ts files --base <base-ref> --head <head-ref>
```

To read the actual diff of specific files (merge-base to head, like GitHub shows it):

```sh
node .claude/skills/analyze-pr-changes/scripts/changeSet.ts diff --base <base-ref> --head <head-ref> --context 8 frontend/src/features/todos/utils/todos.ts
```

The classification rules described below are implemented in `scripts/classify.ts`. Always invoke the script with this repository-relative path. Permission rules match the literal command, so an absolute path is denied. Raw `git` commands are not available to you.

## Reading the output

```json
{
  "path": "frontend/src/features/todos/utils/todos.ts",
  "previousPath": null,
  "status": "modified",
  "area": "frontendSource",
  "kind": "module",
  "testCandidate": true,
  "changedLines": [[46, 52]],
  "conventionTest": "frontend/src/features/todos/utils/todos.test.ts",
  "conventionTestExists": true,
  "relatedTests": ["frontend/src/features/todos/components/TodoItem.test.tsx"]
}
```

- `status`: `added`, `modified`, `deleted` or `renamed` (then `previousPath` is set).
- `area`: `frontendSource` (`frontend/src`, not tests), `backendSource` (`backend/app/**/*.py`), `test`, `config`, `docs`, `other`.
- `kind`: a structural hint. Frontend: `module`, `types`, `styles`, `story`, `barrel`, `entrypoint`, `constants`, `asset`. Backend: `module`, `declarative` (`schemas.py`, `models.py`, `types.py`, `constants.py`), `packageInit`, `entrypoint`. A `types.ts` or `index.ts` that declares runtime code (`const`, `function`, `class`, `export default`) is reported as `module`.
- `testCandidate`: the deterministic pre-filter used by the workflow to decide whether to start you at all. It is `true` for non-deleted frontend `module` files and backend `module` or `declarative` files. You make the final decision.
- `changedLines`: line ranges in the head version that were added or modified. Pure deletions produce no range, but the file is still modified.
- `conventionTest`: where this repo keeps the test for that file. `conventionTestExists` tells you whether it is there already.
- `relatedTests`: other test files that import or `vi.mock` the module. They may need an update when behaviour changes, and they tell you how the module is already exercised.
- `counts` and `testCandidates` at the top level summarise the PR.

Test file conventions encoded in the script:

| Source | Test |
|---|---|
| `frontend/src/<dir>/Name.tsx` | `frontend/src/<dir>/Name.test.tsx` (colocated) |
| `frontend/src/<dir>/name.ts` | `frontend/src/<dir>/name.test.ts` (or `.test.tsx` if one exists) |
| `backend/app/<package>/<module>.py` | `backend/tests/<package>/test_<module>.py` |

## When tests are needed

Create or update tests when the change adds or alters behaviour that a user, a caller or the API contract can observe:

- functions with branches, validation, sorting, filtering, formatting, mapping (`utils/todos.ts`, `validators.py`, `mappers.py`);
- React components with conditional rendering, user interaction, disabled/busy states, error display (`components/*.tsx`, `TodosPage.tsx`);
- hooks that hold state, call the API, update the React Query cache or schedule timers (`hooks/*.ts`);
- HTTP and API modules (`lib/http.ts`, `features/todos/api/todos.ts`): request shape, error mapping;
- FastAPI routes (status codes, validation errors, 404s, repository calls), repository methods (queries, commit/refresh, not-found paths), dependencies, configuration resolution, the app factory and lifespan wiring;
- `schemas.py` changes that alter validation (field limits, strictness, `extra="forbid"`): test them through the router (422) or the validator tests even though `schemas.py` itself is excluded from coverage.

Update an existing test when the change deliberately alters behaviour it asserts (new label, new status code, new validation message). Cite the changed line in your reason.

## When tests are not needed

Skip the file and give the reason category:

- `typesOnly`: `types.ts`, `*.types.ts`, `*.d.ts` without runtime code.
- `styles`: `*.styles.ts`, `*.css`, theme tokens.
- `story`: `*.stories.tsx` (Storybook covers the design system visually).
- `barrel`: `index.ts` files that only re-export.
- `entrypoint`: `frontend/src/main.tsx`, `backend/app/main.py` (wiring that only calls tested factories).
- `config`, `docs`: anything outside `frontend/src` and `backend/app`.
- `deleted`: the file was removed. If its convention test still exists, raise a `risk` finding: the test will fail on import and the author must delete it (you cannot).
- `coverageExcluded`: `frontend/src/design-system/**`, `queryKeys.ts`, `lib/queryClient.ts`, `constants` kinds. Test them only if the change adds real logic (for example a new branch in `Button` state resolution).
- `triviallyCovered`: the change is a rename, a literal tweak or a refactor whose behaviour is already pinned by existing assertions. Name the test that covers it.
- `alreadyCovered`: existing tests already exercise the changed lines (check `uncoveredChangedLines`); name them.
- `blockedByProductBug`: a correct test fails because the product is wrong; it goes into `findings`.
- `budget`: the turn or cost budget ran out before the file was handled.

A file that changes only comments or formatting is `triviallyCovered`.

## Edge cases

- **Renamed file**: look at `previousPath`. If tests import the old path, they will fail; the author must fix the import (it is a test file, so you may do it and report `updated`).
- **Test-only PR**: no source files in scope; report an empty `files` array with a summary that says so.
- **Large PR**: order the candidates by changed lines that are uncovered in `.testAgent/baseline/summary.json` and by behavioural risk; report the rest as skipped with an honest reason if the budget runs out.
