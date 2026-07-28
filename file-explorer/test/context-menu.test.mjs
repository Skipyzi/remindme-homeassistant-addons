// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { actionsForEntry } from "../public/context-menu.js";

const actionIds = (entry, root) => actionsForEntry(entry, root).map(({ id }) => id);

describe("entry context action policy", () => {
  it("offers the complete local file actions", () => {
    expect(actionIds({ type: "file" }, { id: "config", readOnly: false })).toEqual([
      "open",
      "preview-edit",
      "download",
      "move",
      "copy-path",
      "storage-details",
      "trash",
    ]);
  });

  it("offers the complete local folder actions", () => {
    expect(actionIds({ type: "directory" }, { id: "share", readOnly: false })).toEqual([
      "open",
      "new-file",
      "new-folder",
      "upload",
      "move",
      "copy-path",
      "map-folder",
      "trash",
    ]);
  });

  it("omits every mutation from Host files", () => {
    expect(actionIds({ type: "file" }, { id: "host", readOnly: true })).toEqual([
      "open-readonly",
      "download",
      "copy-path",
      "storage-details",
      "show-in-map",
    ]);
  });

  it("omits every mutation from Host folders", () => {
    expect(actionIds({ type: "directory" }, { id: "host", readOnly: true })).toEqual([
      "open",
      "copy-path",
      "map-folder",
    ]);
  });
});
