---
name: backend-unit-tests
description: Conventions and patterns for unit tests in the Taskly FastAPI backend - pytest layout mirroring app/, the conftest fixtures (client, repository_mock, todo, todo_values, model_factory), tests/mocks.py, TestClient with dependency overrides, SQLAlchemy Session mocks and statement comparison, config, lifespan and factory tests without a real database. Use when creating or updating backend/tests/**/*.py.
paths: backend/**
---

# Backend unit tests (pytest + FastAPI TestClient)

## Setup you can rely on

- Tests run from `backend/` with the configuration in `backend/pyproject.toml`: `testpaths = ["tests"]`, `pythonpath = ["."]`, `addopts = "-ra"`. Import application code absolutely (`from app.features.todos.router import router`) and helpers as `from tests.mocks import make_repository_mock`.
- Coverage uses `source = ["app"]` with branch coverage and omits `__init__.py`, `main.py`, `schemas.py`, `models.py`, `types.py`, `constants.py`. Behaviour defined in `schemas.py` (field limits, strict booleans, `extra="forbid"`, the patch validator) is still tested, through the router or `validators.py` tests.
- Available libraries: `pytest`, `pytest-cov`, `fastapi.testclient` (httpx), `unittest.mock`, SQLAlchemy. No pytest-asyncio, no factory libraries, no network. Use `asyncio.run` for the rare async helper.
- The backend follows PEP 8: snake_case names, double quotes, four spaces, lines up to about 100 characters. Keep that style in test files.

## Files and naming

- Mirror the package path: `app/features/todos/router.py` -> `tests/features/todos/test_router.py`, `app/core/config.py` -> `tests/core/test_config.py`, `app/factory.py` -> `tests/test_factory.py`.
- Every test directory is a package. When you create a new directory under `backend/tests/`, add an empty `__init__.py` to it, otherwise two `test_router.py` files would collide.
- Plain test functions, no test classes. Names state the behaviour: `test_invalid_create_never_calls_repository`, `test_get_returns_none_for_missing_task`.
- Use `@pytest.mark.parametrize` for input tables (see `test_router.py` and `test_validators.py`). Keep one behaviour per test.
- Put fixtures needed by several modules in `tests/conftest.py`, helpers in `tests/mocks.py`. Fixtures used by one module stay in that module.

## Fixtures in `tests/conftest.py`

| Fixture | What it gives you |
|---|---|
| `repository_mock` | `create_autospec(TodoRepository, instance=True)` with `list` returning `[]`; calls are signature-checked |
| `client` | `TestClient` for a bare `FastAPI()` that mounts only the todos router, with `get_repository` overridden to return `repository_mock`; no lifespan, no database |
| `todo_values` | a dict with every `Todo` field (`id=7`, UTC timestamps on 2026-10-01) |
| `todo` | `Todo.model_validate(todo_values)` |
| `model_factory` | `lambda values: TodoRecord(**values)` to build ORM records without a session |

## Patterns

**Routers**: drive HTTP through `client`, program `repository_mock`, assert status, body and the exact repository call.

```python
def test_update_returns_404_for_missing_task(client, repository_mock):
    repository_mock.update.return_value = None
    response = client.patch("/api/todos/404", json={"completed": True})
    assert response.status_code == 404
    assert response.json() == {"detail": "Task not found."}
    repository_mock.update.assert_called_once_with(404, TodoUpdate(completed=True))
```

Cover per route: success (status code, `todo.model_dump(mode="json")` body), not found (`404`, `"Task not found."`), invalid path ids (`0` and negative ids give `422` and no repository call), invalid bodies (`422`, `assert_not_called()`), and `204` with an empty body for delete.

**Repositories**: use `Mock(spec=Session)`, never a database. Compare generated statements structurally and, where ordering matters, by compiled SQL (see `test_repository.py`):

```python
def test_create_persists_a_record_with_matching_timestamps(todo_values):
    session = Mock(spec=Session)
    session.refresh.side_effect = lambda record: setattr(record, "id", 7)
    before = datetime.now(timezone.utc)
    created = TodoRepository(session).create(TodoCreate(title="Plan the sprint"))
    after = datetime.now(timezone.utc)
    record = session.add.call_args.args[0]
    assert isinstance(record, TodoRecord)
    session.commit.assert_called_once_with()
    session.refresh.assert_called_once_with(record)
    assert created.id == 7
    assert before <= created.created_at == created.updated_at <= after
```

Emulate database-assigned values through `side_effect` on `refresh`. For `update` and `delete`, test the found path (fields from `model_dump(exclude_unset=True)` applied, `updated_at` moved forward, commit) and the missing path (returns `None` or `False`, no commit, no delete).

**Dependencies** (`app/api/dependencies.py`): call the generator directly with a minimal Starlette `Request`, as `tests/api/test_dependencies.py` does. Use `next(dependency)` to enter, `dependency.close()` for the normal exit and `dependency.throw(RuntimeError("boom"))` for the failure path; assert `rollback` and `close` on the session mock.

**Health route**: build a small app with the health router, override `get_repository`, and give the autospec mock a session explicitly, because instance attributes are not part of the spec:

```python
repository_mock.session = Mock(spec=Session)
```

Assert the executed statement with `.compare(select(TodoRecord.id).limit(1))` and use `TestClient(app, raise_server_exceptions=False)` to check that a database error becomes `500`.

**Configuration** (`app/core/config.py`): isolate the environment completely. Patch `load_dotenv` so a developer's real `.env` never leaks in, and set or delete every variable with `monkeypatch`:

```python
@pytest.fixture
def clean_env(monkeypatch):
    monkeypatch.setattr("app.core.config.load_dotenv", lambda *args, **kwargs: False)
    for name in ["DATABASE_URL", "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_HOST", "DB_PORT", "POSTGRES_DB"]:
        monkeypatch.delenv(name, raising=False)
    return monkeypatch
```

Cover the precedence explicit argument > `DATABASE_URL` > components, the rendered URL (password not hidden, integer port), and a missing variable raising `KeyError`.

**Database helpers and lifespan** (`app/core/database.py`, `app/core/lifespan.py`): engines are lazy, so `create_database_engine` can be inspected without connecting (see `tests/core/test_database.py`); always `dispose()` it. Replace `initialize`, `create_database_engine` and `create_session_factory` in `app.core.lifespan` with mocks through `monkeypatch.setattr`, then run the context manager:

```python
async def run_lifespan(app):
    async with lifespan(app):
        return app.state.session_factory

assert asyncio.run(run_lifespan(app)) is session_factory
engine.dispose.assert_called_once_with()
```

Also check that `dispose` runs when `initialize` raises.

**Factory** (`app/factory.py`): with the lifespan collaborators mocked as above, `create_app("postgresql+psycopg://user:secret@db:5432/taskly")` must store the URL on `app.state.database_url` and register `/api/health` and the `/api/todos` routes (inspect `app.routes` or `app.openapi()["paths"]`). Use `with TestClient(app):` only when you want the lifespan to run.

**Validators and mappers**: pure functions; parametrize inputs and assert both the happy path and the exact `ValidationError` message (`match="Field title cannot be null"`).

## Anti-patterns (reject them in your own output)

- Connecting to PostgreSQL or any real service, or reading the developer's `.env`.
- Mocking the function under test, or asserting only that a mock was called with whatever the code passed (`assert_called()` without arguments when the arguments are the behaviour).
- Asserting `datetime.now()` equality, sleeping, or depending on the local time zone; assert ordering and UTC awareness instead.
- Broad `except` or `try` blocks in tests; use `pytest.raises(..., match=...)`.
- Test classes, global mutable state between tests, or fixtures that silently change for other modules.
- `@pytest.mark.skip`, `xfail`, or loosening an existing assertion to get green.
