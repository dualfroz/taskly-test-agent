import pytest

from app.core.config import resolve_database_url

COMPONENTS = {
    "POSTGRES_USER": "taskly",
    "POSTGRES_PASSWORD": "s3cret",
    "POSTGRES_HOST": "db",
    "DB_PORT": "5433",
    "POSTGRES_DB": "tasks",
}


@pytest.fixture
def clean_env(monkeypatch):
    monkeypatch.setattr("app.core.config.load_dotenv", lambda *args, **kwargs: False)
    for name in ["DATABASE_URL", *COMPONENTS]:
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


def set_components(env):
    for name, value in COMPONENTS.items():
        env.setenv(name, value)


def test_explicit_argument_wins_over_environment(clean_env):
    clean_env.setenv("DATABASE_URL", "postgresql+psycopg://env/db")
    set_components(clean_env)
    assert resolve_database_url("postgresql+psycopg://arg/db") == "postgresql+psycopg://arg/db"


def test_database_url_wins_over_components(clean_env):
    clean_env.setenv("DATABASE_URL", "postgresql+psycopg://env/db")
    set_components(clean_env)
    assert resolve_database_url() == "postgresql+psycopg://env/db"


def test_url_is_built_from_components_without_hiding_the_password(clean_env):
    set_components(clean_env)
    assert resolve_database_url() == "postgresql+psycopg://taskly:s3cret@db:5433/tasks"


def test_missing_component_raises_key_error(clean_env):
    set_components(clean_env)
    clean_env.delenv("POSTGRES_HOST")
    with pytest.raises(KeyError, match="POSTGRES_HOST"):
        resolve_database_url()


def test_non_integer_port_is_rejected(clean_env):
    set_components(clean_env)
    clean_env.setenv("DB_PORT", "abc")
    with pytest.raises(ValueError):
        resolve_database_url()


def test_dotenv_is_loaded_without_overriding_existing_variables(monkeypatch):
    calls = []
    monkeypatch.setattr(
        "app.core.config.load_dotenv", lambda *args, **kwargs: calls.append((args, kwargs))
    )
    monkeypatch.delenv("DATABASE_URL", raising=False)
    resolve_database_url("postgresql+psycopg://arg/db")
    assert len(calls) == 1
    args, kwargs = calls[0]
    assert str(args[0]).endswith(".env")
    assert kwargs == {"override": False}
