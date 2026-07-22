# pyright: reportMissingImports=false
"""Alembic migration environment."""

from logging.config import fileConfig

from alembic import context
from cultivation_assistant.config import Settings
from cultivation_assistant.db.models import Base
from sqlalchemy import engine_from_config, pool

config = context.config
configured_url = config.get_main_option("sqlalchemy.url") or ""
if configured_url.endswith("/data/cultivation.db"):
    config.set_main_option("sqlalchemy.url", Settings().database_url)
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    """Run migrations without creating a database connection."""
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations through a synchronous migration connection."""
    configuration = config.get_section(config.config_ini_section, {})
    url = configuration.get("sqlalchemy.url", "")
    configuration["sqlalchemy.url"] = url.replace("+aiosqlite", "")
    connectable = engine_from_config(
        configuration,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata, compare_type=True)
        with context.begin_transaction():
            context.run_migrations()
    connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
