# pyright: reportMissingImports=false
import base64

import pytest
from httpx import AsyncClient

PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


async def _bootstrap(api_client: AsyncClient) -> dict[str, str]:
    space = await api_client.post(
        "/api/v1/grow-spaces",
        json={
            "name": "Photo tent",
            "space_type": "tent",
            "dimensions": {"length": "80", "width": "80", "height": "180", "unit": "cm"},
        },
    )
    grow = await api_client.post(
        "/api/v1/grows",
        json={
            "grow_space_id": space.json()["id"],
            "name": "Photo grow",
            "status": "active",
            "start_date": "2026-07-23",
        },
    )
    cultivar = await api_client.post(
        "/api/v1/cultivars",
        json={"name": "House cut", "breeder_id": None, "seed_type": "feminized"},
    )
    stages = (await api_client.get("/api/v1/lifecycle-stages")).json()["items"]
    stage_by_key = {item["key"]: item["id"] for item in stages}
    plant = await api_client.post(
        "/api/v1/plants",
        json={
            "grow_id": grow.json()["id"],
            "cultivar_id": cultivar.json()["id"],
            "name": "North 1",
            "propagation_source": "seed",
            "seed_type": "feminized",
            "current_stage_id": stage_by_key["seedling"],
            "status": "active",
            "start_date": "2026-07-23",
        },
    )
    entry = await api_client.post(
        f"/api/v1/plants/{plant.json()['id']}/journal-entries",
        json={"entry_type": "note", "title": "Week 3"},
    )
    return {
        "plant_id": plant.json()["id"],
        "seedling_id": stage_by_key["seedling"],
        "entry_id": entry.json()["id"],
    }


@pytest.fixture
async def context(api_client: AsyncClient) -> dict[str, str]:
    return await _bootstrap(api_client)


async def test_uploads_a_photo(api_client: AsyncClient, context: dict[str, str]) -> None:
    response = await api_client.post(
        f"/api/v1/plants/{context['plant_id']}/photos",
        files={"file": ("leaf.png", PNG_1X1, "image/png")},
        data={"caption": "Week 3"},
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["caption"] == "Week 3"
    assert body["content_type"] == "image/png"
    assert body["file_size"] == len(PNG_1X1)

    file_response = await api_client.get(f"/api/v1/photos/{body['id']}/file")
    assert file_response.status_code == 200
    assert file_response.headers["content-type"] == "image/png"
    assert file_response.content == PNG_1X1


async def test_upload_links_to_a_journal_entry_and_stage(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    response = await api_client.post(
        f"/api/v1/plants/{context['plant_id']}/photos",
        files={"file": ("leaf.png", PNG_1X1, "image/png")},
        data={"journal_entry_id": context["entry_id"], "stage_id": context["seedling_id"]},
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["journal_entry_id"] == context["entry_id"]
    assert body["stage"]["key"] == "seedling"


async def test_rejects_disallowed_content_type(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    response = await api_client.post(
        f"/api/v1/plants/{context['plant_id']}/photos",
        files={"file": ("doc.pdf", b"%PDF-1.4", "application/pdf")},
    )
    assert response.status_code == 422


async def test_rejects_oversized_upload(api_client: AsyncClient, context: dict[str, str]) -> None:
    oversized = b"0" * (15 * 1024 * 1024 + 1)
    response = await api_client.post(
        f"/api/v1/plants/{context['plant_id']}/photos",
        files={"file": ("leaf.png", oversized, "image/png")},
    )
    assert response.status_code == 422


async def test_unknown_plant_returns_404(api_client: AsyncClient) -> None:
    response = await api_client.post(
        "/api/v1/plants/missing/photos",
        files={"file": ("leaf.png", PNG_1X1, "image/png")},
    )
    assert response.status_code == 404


async def test_lists_photos_for_a_plant(api_client: AsyncClient, context: dict[str, str]) -> None:
    await api_client.post(
        f"/api/v1/plants/{context['plant_id']}/photos",
        files={"file": ("leaf.png", PNG_1X1, "image/png")},
    )
    response = await api_client.get(f"/api/v1/plants/{context['plant_id']}/photos")
    assert len(response.json()["items"]) == 1


async def test_updates_caption_and_tags(api_client: AsyncClient, context: dict[str, str]) -> None:
    created = await api_client.post(
        f"/api/v1/plants/{context['plant_id']}/photos",
        files={"file": ("leaf.png", PNG_1X1, "image/png")},
    )
    photo_id = created.json()["id"]
    updated = await api_client.patch(
        f"/api/v1/photos/{photo_id}", json={"caption": "Renamed", "tags": ["week3"]}
    )
    assert updated.status_code == 200
    assert updated.json()["caption"] == "Renamed"
    assert updated.json()["tags"] == ["week3"]


async def test_delete_removes_row_and_file(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    created = await api_client.post(
        f"/api/v1/plants/{context['plant_id']}/photos",
        files={"file": ("leaf.png", PNG_1X1, "image/png")},
    )
    photo_id = created.json()["id"]

    deleted = await api_client.delete(f"/api/v1/photos/{photo_id}")
    assert deleted.status_code == 204

    missing = await api_client.get(f"/api/v1/photos/{photo_id}/file")
    assert missing.status_code == 404


async def test_deleting_a_journal_entry_leaves_its_photo_unattached(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    upload = await api_client.post(
        f"/api/v1/plants/{context['plant_id']}/photos",
        files={"file": ("leaf.png", PNG_1X1, "image/png")},
        data={"journal_entry_id": context["entry_id"]},
    )
    photo_id = upload.json()["id"]

    await api_client.delete(f"/api/v1/journal-entries/{context['entry_id']}")

    photos = await api_client.get(f"/api/v1/plants/{context['plant_id']}/photos")
    remaining = next(item for item in photos.json()["items"] if item["id"] == photo_id)
    assert remaining["journal_entry_id"] is None
