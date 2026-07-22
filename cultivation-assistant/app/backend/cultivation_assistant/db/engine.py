# pyright: reportMissingImports=false
"""Async SQLAlchemy engine and explicit transaction management."""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Any

import sqlalchemy as sa
from sqlalchemy import event as sa_event
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext import asyncio as sa_async


class Database:
    """Own the async engine and session lifecycle for one SQLite database."""

    def __init__(self, database_url: str) -> None:
        self.engine: sa_async.AsyncEngine = sa_async.create_async_engine(
            database_url, pool_pre_ping=True
        )
        self.sessions = sa_async.async_sessionmaker(self.engine, expire_on_commit=False)
        sa_event.listen(self.engine.sync_engine, "connect", self._configure_sqlite)

    @staticmethod
    def _configure_sqlite(dbapi_connection: Any, connection_record: Any) -> None:
        del connection_record
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA busy_timeout=5000")
        finally:
            cursor.close()

    async def initialize(self) -> None:
        """Open the database once so SQLite connection settings are validated."""
        async with self.engine.connect():
            pass

    async def schema_version(self) -> str:
        """Return the applied Alembic revision without exposing database details."""
        version_table = sa.table("alembic_version", sa.column("version_num", sa.String))
        statement = sa.select(version_table.c.version_num).limit(1)
        try:
            async with self.engine.connect() as connection:
                version = await connection.scalar(statement)
        except SQLAlchemyError:
            return "unknown"
        return str(version) if version is not None else "unknown"

    @asynccontextmanager
    async def transaction(self) -> AsyncGenerator[sa_async.AsyncSession]:
        """Yield a session inside an explicit commit-or-rollback boundary."""
        async with self.sessions() as session, session.begin():
            yield session

    async def close(self) -> None:
        """Dispose all pooled connections."""
        await self.engine.dispose()
