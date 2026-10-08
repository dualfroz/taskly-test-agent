from unittest.mock import Mock

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dependencies import get_repository
from app.api.health import router
from app.features.todos.models import TodoRecord


def make_client(repository_mock):
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_repository] = lambda: repository_mock
    return TestClient(app, raise_server_exceptions=False)


def test_health_reports_ok_after_probing_the_database(repository_mock):
    repository_mock.session = Mock(spec=Session)
    response = make_client(repository_mock).get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    statement = repository_mock.session.execute.call_args.args[0]
    assert statement.compare(select(TodoRecord.id).limit(1))


def test_health_fails_with_500_when_the_database_errors(repository_mock):
    repository_mock.session = Mock(spec=Session)
    repository_mock.session.execute.side_effect = RuntimeError("db down")
    response = make_client(repository_mock).get("/api/health")
    assert response.status_code == 500
