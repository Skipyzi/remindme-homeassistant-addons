import { expect, it } from "vitest";
import { layoutTreemap } from "../public/treemap.js";

it("lays out positive nodes proportionally inside the viewport", () => {
  const rectangles = layoutTreemap([
    { id: "a", size: 60 },
    { id: "b", size: 30 },
    { id: "c", size: 10 },
  ], 100, 50);

  expect(rectangles).toHaveLength(3);
  expect(rectangles.every((item) => item.x >= 0 && item.y >= 0)).toBe(true);
  expect(rectangles.every((item) => item.x + item.width <= 100.0001)).toBe(true);
  expect(rectangles.every((item) => item.y + item.height <= 50.0001)).toBe(true);
  expect(rectangles.reduce((sum, item) => sum + item.width * item.height, 0)).toBeCloseTo(5_000, 4);
  const largest = rectangles.find((item) => item.node.id === "a");
  expect((largest.width * largest.height) / 5_000).toBeCloseTo(.6, 4);
});

it("ignores invalid sizes and invalid viewports", () => {
  expect(layoutTreemap([{ id: "zero", size: 0 }, { id: "bad", size: Number.NaN }], 100, 50)).toEqual([]);
  expect(layoutTreemap([{ id: "one", size: 1 }], 0, 50)).toEqual([]);
});
