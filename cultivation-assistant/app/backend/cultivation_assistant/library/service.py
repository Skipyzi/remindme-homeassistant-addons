"""Transactional application service for breeders and cultivars."""

from datetime import UTC, datetime

from cultivation_assistant.audit import audit_record
from cultivation_assistant.db.engine import Database
from cultivation_assistant.db.models import Breeder, Cultivar
from cultivation_assistant.library.repository import LibraryRepository
from cultivation_assistant.library.schemas import (
    BreederCreate,
    BreederListResponse,
    BreederResponse,
    BreederUpdate,
    CompactBreeder,
    CultivarCreate,
    CultivarListResponse,
    CultivarResponse,
    CultivarUpdate,
)
from cultivation_assistant.lifecycle.rules import SeedType


class LibraryNotFound(RuntimeError):
    """Raised when a breeder or cultivar does not exist."""


class LibraryConflict(RuntimeError):
    """Raised when a requested identity already exists."""


class LibraryValidationError(RuntimeError):
    """Raised when domain validation rejects a requested change."""


class LibraryService:
    """Apply breeder and cultivar policy inside explicit transactions."""

    def __init__(self, database: Database) -> None:
        self._database = database

    async def list_breeders(self, *, include_inactive: bool = False) -> BreederListResponse:
        async with self._database.transaction() as session:
            records = await LibraryRepository(session).list_breeders(
                include_inactive=include_inactive
            )
            return BreederListResponse(
                items=[BreederResponse.model_validate(record) for record in records]
            )

    async def create_breeder(
        self, request: BreederCreate, correlation_id: str
    ) -> BreederResponse:
        async with self._database.transaction() as session:
            repository = LibraryRepository(session)
            if await repository.breeder_name_exists(request.name):
                raise LibraryConflict("An active breeder with this name already exists")
            record = await repository.add_breeder(request.name)
            session.add(
                audit_record(
                    "breeder.created",
                    "breeder",
                    record.id,
                    correlation_id,
                    details={"name": record.name},
                )
            )
            await session.flush()
            return BreederResponse.model_validate(record)

    async def update_breeder(
        self, breeder_id: str, request: BreederUpdate, correlation_id: str
    ) -> BreederResponse:
        async with self._database.transaction() as session:
            repository = LibraryRepository(session)
            record = await repository.get_breeder(breeder_id)
            if record is None:
                raise LibraryNotFound("Breeder was not found")
            resulting_active = request.active if request.active is not None else record.active
            resulting_name = request.name if request.name is not None else record.name
            if resulting_active and await repository.breeder_name_exists(
                resulting_name, exclude_id=record.id
            ):
                raise LibraryConflict("An active breeder with this name already exists")
            action = self._apply_breeder_update(record, request)
            session.add(audit_record(action, "breeder", record.id, correlation_id))
            await session.flush()
            return BreederResponse.model_validate(record)

    async def list_cultivars(
        self,
        *,
        include_inactive: bool = False,
        breeder_id: str | None = None,
        query: str | None = None,
    ) -> CultivarListResponse:
        async with self._database.transaction() as session:
            records = await LibraryRepository(session).list_cultivars(
                include_inactive=include_inactive,
                breeder_id=breeder_id,
                query=query,
            )
            return CultivarListResponse(items=[self._cultivar(record) for record in records])

    async def create_cultivar(
        self, request: CultivarCreate, correlation_id: str
    ) -> CultivarResponse:
        async with self._database.transaction() as session:
            repository = LibraryRepository(session)
            if (
                request.breeder_id is not None
                and await repository.get_breeder(request.breeder_id) is None
            ):
                raise LibraryNotFound("Breeder was not found")
            if await repository.cultivar_identity_exists(
                request.breeder_id, request.name, request.seed_type.value
            ):
                raise LibraryConflict("This cultivar identity already exists")
            record = await repository.add_cultivar(
                request.name, request.breeder_id, request.seed_type.value
            )
            session.add(
                audit_record(
                    "cultivar.created",
                    "cultivar",
                    record.id,
                    correlation_id,
                    details={"name": record.name, "breeder_id": record.breeder_id},
                )
            )
            await session.flush()
            await session.refresh(record)
            return self._cultivar(record)

    async def update_cultivar(
        self, cultivar_id: str, request: CultivarUpdate, correlation_id: str
    ) -> CultivarResponse:
        async with self._database.transaction() as session:
            repository = LibraryRepository(session)
            record = await repository.get_cultivar(cultivar_id)
            if record is None:
                raise LibraryNotFound("Cultivar was not found")

            if "breeder_id" in request.model_fields_set:
                resulting_breeder = request.breeder_id
            else:
                resulting_breeder = record.breeder_id
            if (
                resulting_breeder is not None
                and await repository.get_breeder(resulting_breeder) is None
            ):
                raise LibraryNotFound("Breeder was not found")
            resulting_name = request.name if request.name is not None else record.name
            resulting_seed = (
                request.seed_type.value if request.seed_type is not None else record.seed_type
            )
            resulting_active = request.active if request.active is not None else record.active
            if resulting_active and await repository.cultivar_identity_exists(
                resulting_breeder, resulting_name, resulting_seed, exclude_id=record.id
            ):
                raise LibraryConflict("This cultivar identity already exists")

            action = self._apply_cultivar_update(record, request)
            session.add(audit_record(action, "cultivar", record.id, correlation_id))
            await session.flush()
            await session.refresh(record)
            return self._cultivar(record)

    @staticmethod
    def _apply_breeder_update(record: Breeder, request: BreederUpdate) -> str:
        old_active = record.active
        if request.name is not None:
            record.name = request.name
        if request.active is not None:
            record.active = request.active
        record.updated_at = datetime.now(UTC)
        if old_active and not record.active:
            return "breeder.deactivated"
        if not old_active and record.active:
            return "breeder.reactivated"
        return "breeder.updated"

    @staticmethod
    def _apply_cultivar_update(record: Cultivar, request: CultivarUpdate) -> str:
        old_active = record.active
        if request.name is not None:
            record.name = request.name
        if "breeder_id" in request.model_fields_set:
            record.breeder_id = request.breeder_id
        if request.seed_type is not None:
            record.seed_type = request.seed_type.value
        if request.active is not None:
            record.active = request.active
        record.updated_at = datetime.now(UTC)
        if old_active and not record.active:
            return "cultivar.deactivated"
        if not old_active and record.active:
            return "cultivar.reactivated"
        return "cultivar.updated"

    @staticmethod
    def _cultivar(record: Cultivar) -> CultivarResponse:
        breeder = (
            CompactBreeder.model_validate(record.breeder) if record.breeder is not None else None
        )
        return CultivarResponse(
            id=record.id,
            name=record.name,
            breeder=breeder,
            seed_type=SeedType(record.seed_type),
            active=record.active,
            created_at=record.created_at,
            updated_at=record.updated_at,
        )
