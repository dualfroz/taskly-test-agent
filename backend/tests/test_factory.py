from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from app.factory import create_app

URL = "postgresql+psycopg://user:secret@db:5432/taskly"


@pytest.fixture(autouse=True)
def isolated_lifespan(monkeypatch):
    monkeypatch.setattr("app.core.config.load_dotenv", lambda *args, **kwargs: False)
    monkeypatch.setattr("app.core.lifespan.create_database_engine", Mock())
    monkeypatch.setattr("app.core.lifespan.create_session_factory", Mock())
    monkeypatch.setattr("app.core.lifespan.initialize", Mock())


def test_create_app_stores_the_database_url():
    assert create_app(URL).state.database_url == URL


def test_create_app_falls_back_to_the_environment(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql+psycopg://env/db")
    assert create_app().state.database_url == "postgresql+psycopg://env/db"


def test_create_app_registers_health_and_todo_routes():
    paths = create_app(URL).openapi()["paths"]
    assert "/api/health" in paths
    assert set(paths["/api/todos"]) == {"get", "post"}
    assert set(paths["/api/todos/{todo_id}"]) == {"get", "patch", "delete"}


def test_create_app_sets_title_and_runs_the_lifespan(monkeypatch):
    initialize = Mock()
    monkeypatch.setattr("app.core.lifespan.initialize", initialize)
    app = create_app(URL)
    assert app.title == "Taskly API"
    with TestClient(app):
        initialize.assert_called_once()
        assert app.state.session_factory is not None
