# pyright: reportMissingImports=false
# pyright: reportUnknownVariableType=false, reportUnknownMemberType=false
from pathlib import Path

from cultivation_assistant.db.engine import Database
from sqlalchemy import text


async def test_database_enables_wal_and_foreign_keys(tmp_path: Path) -> None:
    database_path = tmp_path / "cultivation.db"
    database = Database(f"sqlite+aiosqlite:///{database_path.as_posix()}")

    await database.initialize()
    async with database.engine.connect() as connection:
        journal_mode = await connection.scalar(text("PRAGMA journal_mode"))
        foreign_keys = await connection.scalar(text("PRAGMA foreign_keys"))
    await database.close()

    assert journal_mode == "wal"
    assert foreign_keys == 1
