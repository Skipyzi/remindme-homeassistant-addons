from pathlib import Path

import pytest
from cultivation_assistant.journal.storage import PhotoStorage, UnsupportedPhotoContentType


def test_save_derives_filename_from_id_and_content_type(tmp_path: Path) -> None:
    storage = PhotoStorage(tmp_path)
    relative_path = storage.save("plant-1", "photo-1", "image/png", b"binary-content")
    assert relative_path == "plant-1/photo-1.png"
    assert (tmp_path / "photos" / relative_path).read_bytes() == b"binary-content"


def test_save_maps_jpeg_and_webp_extensions(tmp_path: Path) -> None:
    storage = PhotoStorage(tmp_path)
    assert storage.save("plant-1", "photo-2", "image/jpeg", b"x").endswith(".jpg")
    assert storage.save("plant-1", "photo-3", "image/webp", b"x").endswith(".webp")


def test_save_rejects_unsupported_content_type(tmp_path: Path) -> None:
    storage = PhotoStorage(tmp_path)
    with pytest.raises(UnsupportedPhotoContentType):
        storage.save("plant-1", "photo-1", "application/pdf", b"...")


def test_absolute_path_resolves_under_the_photos_root(tmp_path: Path) -> None:
    storage = PhotoStorage(tmp_path)
    relative_path = storage.save("plant-1", "photo-1", "image/png", b"x")
    assert storage.absolute_path(relative_path) == tmp_path / "photos" / relative_path


def test_delete_is_idempotent(tmp_path: Path) -> None:
    storage = PhotoStorage(tmp_path)
    storage.delete("plant-1/missing.png")


def test_delete_removes_an_existing_file(tmp_path: Path) -> None:
    storage = PhotoStorage(tmp_path)
    relative_path = storage.save("plant-1", "photo-1", "image/png", b"x")
    storage.delete(relative_path)
    assert not storage.absolute_path(relative_path).exists()
