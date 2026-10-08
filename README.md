# Taskly App

## Setup

```sh
cp .env.example .env
```

## Docker

```sh
docker compose up --build -d --wait
```

Application: http://localhost:8080. API: http://localhost:8000/docs.

```sh
docker compose down
```

## Frontend

Installation:

```sh
cd frontend
npm ci
```

Development — http://localhost:5173:

```sh
npm run dev
```

Storybook — http://localhost:6006:

```sh
npm run storybook
```

Tests:

```sh
npm test
```

Coverage — `frontend/coverage/index.html`:

```sh
npm run test:coverage
```

## Backend

Installation (from the repository root):

```sh
python3 -m venv backend/.venv
source backend/.venv/bin/activate
python -m pip install -r backend/requirements.txt
```

Development — http://localhost:8000/docs:

```sh
docker compose up -d --wait postgres
cd backend
python -m uvicorn app.main:app --reload
```

Tests (in `backend`, with `.venv` activated):

```sh
python -m pytest
```

Coverage — `backend/coverage/html/index.html`:

```sh
python -m pytest --cov=app --cov-report=term-missing --cov-report=html
```

## Unit test agent

The repository includes a Claude Code agent that creates and updates unit tests for both stacks, and a pull request workflow that runs it, verifies the result independently and reports back in the pull request.

- Agent, skills and guard hook: `.claude/agents/unit-test-agent.md`, `.claude/skills/`, `.claude/hooks/`.
- Pull request workflow: `.github/workflows/testAgent.yml`. It needs an `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` repository secret; without one it only posts a comment saying it was skipped.
- Local runs, from the repository root with a clean working tree:

```sh
scripts/runTestAgent.sh pr origin/main
scripts/runTestAgent.sh coverage all
```

- Tests of the agent tooling (after `npm ci` in `frontend`):

```sh
npm --prefix .github/testAgent test
```

Design decisions, security model, limitations and an example run: [SOLUTION.md](SOLUTION.md).
