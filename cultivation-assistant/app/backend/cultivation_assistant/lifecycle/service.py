"""Transactional application service for lifecycle stages."""

from datetime import UTC, datetime

from cultivation_assistant.audit import audit_record
from cultivation_assistant.db.engine import Database
from cultivation_assistant.lifecycle.repository import LifecycleRepository
from cultivation_assistant.lifecycle.schemas import (
    LifecycleStageCreate,
    LifecycleStageListResponse,
    LifecycleStageOrderUpdate,
    LifecycleStageResponse,
    LifecycleStageUpdate,
)


class LifecycleStageNotFound(RuntimeError):
    """Raised when a lifecycle stage does not exist."""


class LifecycleStageConflict(RuntimeError):
    """Raised when a stage change conflicts with existing configuration."""


class LifecycleStageValidationError(RuntimeError):
    """Raised when domain validation rejects a stage change."""


class LifecycleStageService:
    """Apply lifecycle stage policy inside explicit transactions."""

    def __init__(self, database: Database) -> None:
        self._database = database

    async def list_stages(
        self, *, include_disabled: bool = False
    ) -> LifecycleStageListResponse:
        async with self._database.transaction() as session:
            records = await LifecycleRepository(session).list_stages(
                include_disabled=include_disabled
            )
            return LifecycleStageListResponse(
                items=[LifecycleStageResponse.model_validate(record) for record in records]
            )

    async def create_stage(
        self, request: LifecycleStageCreate, correlation_id: str
    ) -> LifecycleStageResponse:
        async with self._database.transaction() as session:
            repository = LifecycleRepository(session)
            if await repository.key_exists(request.key):
                raise LifecycleStageConflict("A lifecycle stage with this key already exists")
            position = await repository.max_position() + 1
            record = await repository.add_stage(
                request.key, request.label, request.enabled, position
            )
            session.add(
                audit_record(
                    "lifecycle_stage.created",
                    "lifecycle_stage",
                    record.id,
                    correlation_id,
                    details={"key": record.key, "label": record.label},
                )
            )
            await session.flush()
            return LifecycleStageResponse.model_validate(record)

    async def update_stage(
        self, stage_id: str, request: LifecycleStageUpdate, correlation_id: str
    ) -> LifecycleStageResponse:
        async with self._database.transaction() as session:
            repository = LifecycleRepository(session)
            record = await repository.get_stage(stage_id)
            if record is None:
                raise LifecycleStageNotFound("Lifecycle stage was not found")
            was_enabled = record.enabled
            changed: set[str] = set()
            if request.label is not None:
                record.label = request.label
                changed.add("label")
            if request.enabled is not None:
                record.enabled = request.enabled
                changed.add("enabled")
            if changed:
                record.updated_at = datetime.now(UTC)
            action = (
                "lifecycle_stage.disabled"
                if was_enabled and not record.enabled
                else "lifecycle_stage.updated"
            )
            session.add(
                audit_record(
                    action,
                    "lifecycle_stage",
                    record.id,
                    correlation_id,
                    details={"changed_fields": sorted(changed)},
                )
            )
            await session.flush()
            return LifecycleStageResponse.model_validate(record)

    async def reorder(
        self, request: LifecycleStageOrderUpdate, correlation_id: str
    ) -> LifecycleStageListResponse:
        async with self._database.transaction() as session:
            repository = LifecycleRepository(session)
            stages = await repository.list_stages(include_disabled=True)
            existing_ids = {stage.id for stage in stages}
            submitted_ids = set(request.stage_ids)
            if submitted_ids != existing_ids:
                raise LifecycleStageValidationError(
                    "The lifecycle stage order must list every stage exactly once"
                )
            by_id = {stage.id: stage for stage in stages}
            for position, stage_id in enumerate(request.stage_ids):
                stage = by_id[stage_id]
                if stage.position != position:
                    stage.position = position
                    stage.updated_at = datetime.now(UTC)
            session.add(
                audit_record(
                    "lifecycle_stage.reordered",
                    "lifecycle_stage",
                    "*",
                    correlation_id,
                    details={"stage_count": len(request.stage_ids)},
                )
            )
            await session.flush()
            ordered = sorted(stages, key=lambda item: item.position)
            return LifecycleStageListResponse(
                items=[LifecycleStageResponse.model_validate(record) for record in ordered]
            )

    async def delete_stage(self, stage_id: str, correlation_id: str) -> None:
        async with self._database.transaction() as session:
            repository = LifecycleRepository(session)
            record = await repository.get_stage(stage_id)
            if record is None:
                raise LifecycleStageNotFound("Lifecycle stage was not found")
            if record.built_in:
                raise LifecycleStageConflict("Built-in lifecycle stages cannot be deleted")
            if await repository.is_referenced(record.id):
                raise LifecycleStageConflict(
                    "This lifecycle stage is referenced and can only be disabled"
                )
            details = {"key": record.key}
            await repository.delete_stage(record)
            session.add(
                audit_record(
                    "lifecycle_stage.deleted",
                    "lifecycle_stage",
                    stage_id,
                    correlation_id,
                    details=details,
                )
            )
