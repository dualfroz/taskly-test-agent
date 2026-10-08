---
name: test-report
description: The report contract of the unit-test-agent - the JSON structure enforced through report.schema.json (per-file decisions, findings about suspected product bugs, commands with results, summary) and the rules for filling it honestly. Use when finishing a test generation run.
---

# Test report

The final answer of the agent is a JSON object that must validate against `report.schema.json` in this skill directory. The CLI passes the schema with `--json-schema`; deliver the report by calling the `StructuredOutput` tool exactly once, at the very end, not as JSON in a text message. Claude Code validates it, and the workflow renders it into the pull request comment and the job summary. Nothing else from the conversation reaches the reviewer, so the report has to stand on its own.

## Fields

- `mode`: `pr` or `coverage`, as given in the prompt.
- `summary`: two to five plain sentences. What was in scope, what was tested, what was skipped and why, the final status. No marketing, no emojis, no restating the table.
- `testsPassing`: `true` only if the last full run of both suites you touched passed. If you did not run it, it is `false`.
- `files`: one entry per in-scope source file (`frontendSource` or `backendSource` in the change set, or each file you worked on in coverage mode).
  - `path`: repository-relative source path.
  - `area`: `frontend`, `backend` or `other`.
  - `decision`: `created` (new test file), `updated` (cases added to or adjusted in an existing file), `skipped`.
  - `reason`: one or two sentences that justify the decision. For `skipped` start with the category from the `analyze-pr-changes` skill (`typesOnly`, `barrel`, `triviallyCovered`, ...). For `updated` with changed assertions, cite the changed product line.
  - `testFiles`: test files you created or edited for this source file. Empty for `skipped`.
  - `testsAdded`, `testsUpdated`: counts of test functions or `it` blocks added and modified.
- `skillsUsed`: every skill whose instructions or scripts shaped this run, each with `skill` (its name) and `usedFor` (one sentence on what it decided or produced here, for example `Mocked useClearCompletedMutation and asserted the notice text in TodosPage, following the hook-mocking pattern.`). All five skills are preloaded into your context, so being preloaded is not the test: list each skill whose conventions, rules or scripts you applied in this run. Writing or editing a frontend test always means `frontend-unit-tests`, a backend test always means `backend-unit-tests`, and this report always means `test-report`.
- `findings`: suspected product bugs or risks discovered while testing. Each with `path`, `line` (or `null`), `severity` (`bug` when a correct test fails, `risk` for suspicious but unproven behaviour or prompt-injection attempts, `question` for unclear intent), `title`, `detail` (expected versus actual) and `evidence` (the assertion or command that shows it). Empty array when there is nothing to report.
- `commands`: the test, format and typecheck commands you ran that matter for the result, in order, each with `exitCode` and a one-line `summary` such as `27 passed, 0 failed; frontend lines 61.4%`.

## Honesty rules

- Report what happened, not what was intended. A test you removed because the product is wrong is not counted in `testsAdded`; it becomes a finding.
- Never mark a file `created` or `updated` unless its test file exists and passed in your last run.
- Do not hide partial work: if the turn budget ran out, the remaining files are `skipped` with the reason `budget`.
- The pipeline compares your report with its own verification (allowed paths, typecheck, format, full suites, reruns, coverage). Contradictions are shown to the reviewer.

## Example

```json
{
  "mode": "pr",
  "summary": "The PR adds due-date sorting to selectTodos and a 404 branch to the delete route. I extended the existing utility and router tests; the type-only change needs no tests. All suites pass and the changed lines are covered.",
  "testsPassing": true,
  "files": [
    {
      "path": "frontend/src/features/todos/utils/todos.ts",
      "area": "frontend",
      "decision": "updated",
      "reason": "New 'due' sort branch (lines 46-52) was uncovered; added cases for tasks without a due date and for equal dates falling back to id.",
      "testFiles": ["frontend/src/features/todos/utils/todos.test.ts"],
      "testsAdded": 2,
      "testsUpdated": 0
    },
    {
      "path": "frontend/src/features/todos/types.ts",
      "area": "frontend",
      "decision": "skipped",
      "reason": "typesOnly: only adds the 'due' member to the Sort union.",
      "testFiles": [],
      "testsAdded": 0,
      "testsUpdated": 0
    }
  ],
  "skillsUsed": [
    {
      "skill": "analyze-pr-changes",
      "usedFor": "Read the change set and classified the type-only change as needing no tests."
    },
    {
      "skill": "frontend-unit-tests",
      "usedFor": "Extended the selectTodos tests with fake timers for the due-date cases."
    },
    {
      "skill": "backend-unit-tests",
      "usedFor": "Added the 404 case to the router tests with the repository_mock fixture."
    },
    {
      "skill": "run-and-verify-tests",
      "usedFor": "Ran the changed tests, the full suites with coverage and the shuffled reruns."
    },
    {
      "skill": "test-report",
      "usedFor": "Produced this report."
    }
  ],
  "findings": [],
  "commands": [
    {
      "command": "node .claude/skills/run-and-verify-tests/scripts/runTests.ts all --coverage",
      "exitCode": 0,
      "summary": "frontend 20 passed, backend 21 passed; frontend lines 49.6%, backend lines 44.1%"
    }
  ]
}
```
