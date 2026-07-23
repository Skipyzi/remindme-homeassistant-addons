# pyright: reportMissingImports=false
"""FastAPI application entry point."""

import asyncio
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager, suppress
from typing import cast

import structlog
from fastapi import FastAPI, Response
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException
from starlette.types import ExceptionHandler

from cultivation_assistant import __version__
from cultivation_assistant.api.errors import http_exception_handler
from cultivation_assistant.config import Settings
from cultivation_assistant.db.engine import Database
from cultivation_assistant.grow_spaces.router import create_router as create_grow_spaces_router
from cultivation_assistant.home_assistant.client import (
    HomeAssistantClient,
    HomeAssistantConnectionError,
)
from cultivation_assistant.home_assistant.state_cache import EntityStateCache
from cultivation_assistant.home_assistant.subscription import HomeAssistantEventSubscriber
from cultivation_assistant.logging import configure_logging
from cultivation_assistant.middleware import correlation_id_middleware
from cultivation_assistant.runtime import RuntimeStatus


@asynccontextmanager
async def application_lifespan(application: FastAPI) -> AsyncGenerator[None]:
    """Initialize and close process-local dependencies safely."""
    database = cast(Database, application.state.database)
    status = cast(RuntimeStatus, application.state.runtime_status)
    home_assistant = cast(
        HomeAssistantClient | None,
        application.state.home_assistant_client,
    )
    subscriber = cast(
        HomeAssistantEventSubscriber | None,
        application.state.home_assistant_subscriber,
    )
    stop_subscription = asyncio.Event()
    subscription_task: asyncio.Task[None] | None = None
    await database.initialize()
    status.database_ready = True
    status.schema_version = await database.schema_version()
    if home_assistant is not None:
        try:
            await home_assistant.validate_authentication()
            await home_assistant.load_initial_states()
            if subscriber is not None:
                subscription_task = asyncio.create_task(
                    subscriber.run_forever(stop_subscription),
                    name="home-assistant-state-subscription",
                )
        except HomeAssistantConnectionError as exc:
            structlog.get_logger(__name__).warning(
                "home_assistant_startup_unavailable",
                reason=str(exc),
            )
    try:
        yield
    finally:
        status.database_ready = False
        stop_subscription.set()
        if subscription_task is not None:
            subscription_task.cancel()
            with suppress(asyncio.CancelledError):
                await subscription_task
        if home_assistant is not None:
            await home_assistant.close()
        await database.close()


def create_app(
    runtime_status: RuntimeStatus | None = None,
    settings: Settings | None = None,
    database: Database | None = None,
    home_assistant_client: HomeAssistantClient | None = None,
) -> FastAPI:
    """Create the Cultivation Assistant ASGI application."""
    status = runtime_status or RuntimeStatus()
    runtime_settings = settings or Settings()
    runtime_database = database or Database(runtime_settings.database_url)
    state_cache = EntityStateCache()
    runtime_home_assistant = home_assistant_client
    runtime_subscriber: HomeAssistantEventSubscriber | None = None
    if runtime_home_assistant is None and runtime_settings.supervisor_token is not None:
        runtime_home_assistant = HomeAssistantClient(
            base_url=runtime_settings.supervisor_url,
            token=runtime_settings.supervisor_token,
            state_cache=state_cache,
            runtime_status=status,
        )
        runtime_subscriber = HomeAssistantEventSubscriber(
            websocket_url=runtime_settings.supervisor_websocket_url,
            token=runtime_settings.supervisor_token,
            state_cache=state_cache,
            runtime_status=status,
        )
    configure_logging(runtime_settings.log_level)

    app = FastAPI(
        title="Cultivation Assistant",
        version=__version__,
        lifespan=application_lifespan,
    )
    app.state.runtime_status = status
    app.state.settings = runtime_settings
    app.state.database = runtime_database
    app.state.entity_state_cache = state_cache
    app.state.home_assistant_client = runtime_home_assistant
    app.state.home_assistant_subscriber = runtime_subscriber
    app.middleware("http")(correlation_id_middleware)
    app.add_exception_handler(HTTPException, cast(ExceptionHandler, http_exception_handler))

    async def health_endpoint() -> dict[str, str]:
        return {"status": "healthy", "version": __version__}

    async def readiness_endpoint(response: Response) -> dict[str, object]:
        if not status.ready:
            response.status_code = 503
        return {
            "status": "ready" if status.ready else "not_ready",
            "checks": status.checks(),
        }

    async def diagnostics_endpoint() -> dict[str, str]:
        checks = status.checks()
        return {
            "app_version": __version__,
            "schema_version": status.schema_version,
            "database": checks["database"],
            "home_assistant": checks["home_assistant"],
        }

    app.add_api_route("/api/v1/health", health_endpoint, methods=["GET"], tags=["system"])
    app.add_api_route("/api/v1/readiness", readiness_endpoint, methods=["GET"], tags=["system"])
    app.add_api_route("/api/v1/diagnostics", diagnostics_endpoint, methods=["GET"], tags=["system"])
    app.include_router(
        create_grow_spaces_router(runtime_database, state_cache, status),
        prefix="/api/v1",
    )
    if runtime_settings.frontend_dist.is_dir():
        app.mount(
            "/",
            StaticFiles(directory=runtime_settings.frontend_dist, html=True),
            name="frontend",
        )
    return app


app = create_app()
