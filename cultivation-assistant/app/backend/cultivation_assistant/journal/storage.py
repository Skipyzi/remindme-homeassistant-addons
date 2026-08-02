"""Filesystem storage for Plant photos, isolated from the service layer."""

from pathlib import Path

from cultivation_assistant.journal.rules import PHOTO_CONTENT_TYPES

_EXTENSIONS: dict[str, str] = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
}


class UnsupportedPhotoContentType(ValueError):
    """Raised when a photo upload's content type is not on the allowlist."""


class PhotoStorage:
    """Persist and remove photo files under `{data_dir}/photos/`."""

    def __init__(self, data_dir: Path) -> None:
        self._root = data_dir / "photos"

    def relative_path_for(self, plant_id: str, photo_id: str, content_type: str) -> str:
        """Derive the storage path for a photo without writing anything."""
        if content_type not in PHOTO_CONTENT_TYPES:
            raise UnsupportedPhotoContentType(content_type)
        extension = _EXTENSIONS[content_type]
        return f"{plant_id}/{photo_id}.{extension}"

    def write(self, relative_path: str, content: bytes) -> None:
        """Write `content` to disk at a previously derived relative path."""
        destination = self.absolute_path(relative_path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)

    def save(self, plant_id: str, photo_id: str, content_type: str, content: bytes) -> str:
        """Write `content` to disk and return its path relative to the photos root."""
        relative_path = self.relative_path_for(plant_id, photo_id, content_type)
        self.write(relative_path, content)
        return relative_path

    def absolute_path(self, relative_path: str) -> Path:
        """Resolve a stored relative path to its absolute location on disk."""
        return self._root / relative_path

    def delete(self, relative_path: str) -> None:
        """Remove a stored file. Missing files are not an error."""
        self.absolute_path(relative_path).unlink(missing_ok=True)
