"""Export the versioned FastAPI contract for review and client generation."""

import json
from pathlib import Path

from cultivation_assistant.main import create_app

OUTPUT = Path(__file__).resolve().parents[1] / "docs" / "openapi.json"


def main() -> None:
    """Write a deterministic OpenAPI document from the application factory."""
    document = create_app().openapi()
    OUTPUT.write_text(
        json.dumps(document, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
