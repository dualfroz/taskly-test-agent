from datetime import date, datetime, timezone
from unittest.mock import Mock

from sqlalchemy import select
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Session

from app.features.todos.models import TodoRecord
from app.features.todos.repository import TodoRepository
from app.features.todos.schemas import TodoCreate, TodoUpdate


def test_list_maps_models_and_orders_tasks_newest_first(model_factory, todo_values, todo):
    session = Mock(spec=Session)
    session.scalars.return_value = [model_factory(todo_values)]
    assert TodoRepository(session).list() == [todo]
    statement = session.scalars.call_args.args[0]
    expected = select(TodoRecord).order_by(TodoRecord.created_at.desc(), TodoRecord.id.desc())
    assert statement.compare(expected)
    compiled = str(statement.compile(dialect=postgresql.dialect()))
    assert "ORDER BY todos.created_at DESC, todos.id DESC" in compiled


def test_get_returns_none_for_missing_task():
    session = Mock(spec=Session)
    session.get.return_value = None
    assert TodoRepository(session).get(404) is None
    session.get.assert_called_once_with(TodoRecord, 404)


def test_get_maps_found_record(model_factory, todo_values, todo):
    session = Mock(spec=Session)
    session.get.return_value = model_factory(todo_values)
    assert TodoRepository(session).get(7) == todo


def test_create_persists_a_record_with_matching_timestamps():
    session = Mock(spec=Session)
    session.refresh.side_effect = lambda record: setattr(record, "id", 7)
    before = datetime.now(timezone.utc)
    created = TodoRepository(session).create(TodoCreate(title="Plan the sprint", priority="high"))
    after = datetime.now(timezone.utc)
    record = session.add.call_args.args[0]
    assert isinstance(record, TodoRecord)
    session.commit.assert_called_once_with()
    session.refresh.assert_called_once_with(record)
    assert created.id == 7
    assert created.title == "Plan the sprint"
    assert created.priority == "high"
    assert before <= created.created_at == created.updated_at <= after


def test_update_applies_only_provided_fields_and_moves_updated_at(
    model_factory, todo_values
):
    session = Mock(spec=Session)
    session.get.return_value = model_factory(todo_values)
    updated = TodoRepository(session).update(7, TodoUpdate(completed=True))
    session.get.assert_called_once_with(TodoRecord, 7)
    session.commit.assert_called_once_with()
    session.refresh.assert_called_once_with(session.get.return_value)
    assert updated is not None
    assert updated.completed is True
    assert updated.title == todo_values["title"]
    assert updated.description == todo_values["description"]
    assert updated.created_at == todo_values["created_at"]
    assert updated.updated_at > todo_values["updated_at"]
    assert updated.updated_at.tzinfo is not None


def test_update_can_clear_a_due_date(model_factory, todo_values):
    session = Mock(spec=Session)
    session.get.return_value = model_factory({**todo_values, "due_date": date(2026, 10, 15)})
    updated = TodoRepository(session).update(7, TodoUpdate(due_date=None))
    assert updated is not None
    assert updated.due_date is None


def test_update_returns_none_for_missing_task_without_commit():
    session = Mock(spec=Session)
    session.get.return_value = None
    assert TodoRepository(session).update(404, TodoUpdate(completed=True)) is None
    session.commit.assert_not_called()
    session.refresh.assert_not_called()


def test_delete_removes_found_record_and_commits(model_factory, todo_values):
    session = Mock(spec=Session)
    record = model_factory(todo_values)
    session.get.return_value = record
    assert TodoRepository(session).delete(7) is True
    session.delete.assert_called_once_with(record)
    session.commit.assert_called_once_with()


def test_delete_returns_false_for_missing_task_without_side_effects():
    session = Mock(spec=Session)
    session.get.return_value = None
    assert TodoRepository(session).delete(404) is False
    session.delete.assert_not_called()
    session.commit.assert_not_called()
