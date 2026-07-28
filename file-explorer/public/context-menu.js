const ACTIONS = Object.freeze({
  open: { id: "open", label: "Open" },
  "open-readonly": { id: "open-readonly", label: "Open read-only" },
  "preview-edit": { id: "preview-edit", label: "Preview / edit" },
  download: { id: "download", label: "Download" },
  move: { id: "move", label: "Move / rename" },
  "copy-path": { id: "copy-path", label: "Copy path" },
  "storage-details": { id: "storage-details", label: "Storage details" },
  trash: { id: "trash", label: "Move to trash", danger: true },
  "new-file": { id: "new-file", label: "New file" },
  "new-folder": { id: "new-folder", label: "New folder" },
  upload: { id: "upload", label: "Upload here" },
  "map-folder": { id: "map-folder", label: "Map this folder" },
  "show-in-map": { id: "show-in-map", label: "Show in storage map" },
});

const LOCAL_FILE_ACTIONS = [
  "open",
  "preview-edit",
  "download",
  "move",
  "copy-path",
  "storage-details",
  "trash",
];
const LOCAL_DIRECTORY_ACTIONS = [
  "open",
  "new-file",
  "new-folder",
  "upload",
  "move",
  "copy-path",
  "map-folder",
  "trash",
];
const READ_ONLY_FILE_ACTIONS = [
  "open-readonly",
  "download",
  "copy-path",
  "storage-details",
  "show-in-map",
];
const READ_ONLY_DIRECTORY_ACTIONS = ["open", "copy-path", "map-folder"];

export function actionsForEntry(entry, root) {
  const actionIds = root.readOnly
    ? entry.type === "directory" ? READ_ONLY_DIRECTORY_ACTIONS : READ_ONLY_FILE_ACTIONS
    : entry.type === "directory" ? LOCAL_DIRECTORY_ACTIONS : LOCAL_FILE_ACTIONS;
  return actionIds.map((id) => ({ ...ACTIONS[id] }));
}
