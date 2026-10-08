import asyncio
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app.core.lifespan import lifespan


@pytest.fixture
def collaborators(monkeypatch):
    engine = Mock()
    session_factory = Mock()
    mocks = SimpleNamespace(
        engine=engine,
        session_factory=session_factory,
        create_engine=Mock(return_value=engine),
        create_factory=Mock(return_value=session_factory),
        initialize=Mock(),
    )
    monkeypatch.setattr("app.core.lifespan.create_database_engine", mocks.create_engine)
    monkeypatch.setattr("app.core.lifespan.create_session_factory", mocks.create_factory)
    monkeypatch.setattr("app.core.lifespan.initialize", mocks.initialize)
    return mocks


def make_app():
    return SimpleNamespace(state=SimpleNamespace(database_url="postgresql+psycopg://u:p@h/db"))


async def run_lifespan(app):
    async with lifespan(app):
        return app.state.session_factory


def test_lifespan_prepares_database_and_exposes_session_factory(collaborators):
    app = make_app()
    assert asyncio.run(run_lifespan(app)) is collaborators.session_factory
    collaborators.create_engine.assert_called_once_with("postgresql+psycopg://u:p@h/db")
    collaborators.initialize.assert_called_once_with(collaborators.engine)
    collaborators.create_factory.assert_called_once_with(collaborators.engine)


def test_lifespan_disposes_engine_on_shutdown(collaborators):
    asyncio.run(run_lifespan(make_app()))
    collaborators.engine.dispose.assert_called_once_with()


def test_lifespan_disposes_engine_when_initialization_fails(collaborators):
    collaborators.initialize.side_effect = RuntimeError("no database")
    app = make_app()
    with pytest.raises(RuntimeError, match="no database"):
        asyncio.run(run_lifespan(app))
    collaborators.engine.dispose.assert_called_once_with()
    collaborators.create_factory.assert_not_called()
    assert not hasattr(app.state, "session_factory")
