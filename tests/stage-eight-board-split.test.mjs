import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

const lines = (source) => source.split("\n").length;

test("the board is split into layers, not one file", async () => {
  for (const file of [
    "app/(app)/portal/board-model.ts",
    "app/(app)/portal/board-format.ts",
    "app/(app)/portal/board-primitives.tsx",
    "app/(app)/portal/board-cells.tsx",
  ]) {
    const source = await read(file);
    assert.ok(source.length > 0, `${file} must exist`);
  }
});

test("live-board is materially smaller than it was", async () => {
  const source = await read("app/(app)/portal/live-board.tsx");
  assert.ok(
    lines(source) < 6000,
    `live-board.tsx is ${lines(source)} lines; it was 7,344 before the split.`,
  );
});

test("the model layer holds no JSX and no hooks", async () => {
  const source = await read("app/(app)/portal/board-model.ts");
  assert.doesNotMatch(source, /use[A-Z]\w*\(/, "the model must not call hooks");
  assert.doesNotMatch(source, /<\/[a-z]/, "the model must not render markup");
  assert.doesNotMatch(source, /"use client"/, "pure data needs no client directive");
});

test("the format layer is pure", async () => {
  const source = await read("app/(app)/portal/board-format.ts");
  assert.doesNotMatch(source, /use[A-Z]\w*\(/, "formatters must not call hooks");
  assert.doesNotMatch(source, /"use client"/);
  // Pure means no reaching into the DOM or storage.
  assert.doesNotMatch(source, /document\.|window\.localStorage|sessionStorage/);
});

test("shared primitives live apart so the split is not circular", async () => {
  const primitives = await read("app/(app)/portal/board-primitives.tsx");
  assert.match(primitives, /export const MobileBoardContext/);
  assert.match(primitives, /export function MobileCellSheet/);
  assert.match(primitives, /export function useRevealBoardPopover/);

  // Neither shared file may import the board back.
  for (const file of [
    "app/(app)/portal/board-primitives.tsx",
    "app/(app)/portal/board-cells.tsx",
    "app/(app)/portal/board-subitems.tsx",
    "app/(app)/portal/board-model.ts",
    "app/(app)/portal/board-format.ts",
  ]) {
    const source = await read(file);
    assert.doesNotMatch(
      source,
      /from "\.\/live-board"/,
      `${file} must not import live-board — that would make the split circular`,
    );
  }
});

test("cell components are leaves", async () => {
  const source = await read("app/(app)/portal/board-cells.tsx");
  for (const component of [
    "ItemNameEditor", "OptionCell", "InlineTextCell",
    "DateStatusIcon", "MobileBoardCalendar", "DateCell", "TimelineCell",
  ]) {
    assert.match(source, new RegExp(`export function ${component}`));
  }
  assert.match(source, /"use client"/, "cells hold state and need the directive");
});

test("callers of live-board are unaffected by the split", async () => {
  const board = await read("app/(app)/portal/live-board.tsx");
  // portal-app imports these two types from live-board; the re-export keeps
  // the move invisible to it.
  assert.match(board, /export type \{[\s\S]{0,160}MaintenanceBoardSnapshot/);
  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.match(portal, /MaintenanceBoardSnapshot/);
});

test("no board file exceeds a reviewable size", async () => {
  const limits = {
    "app/(app)/portal/board-model.ts": 600,
    // Split out of board-model when the compact wire format grew a sixth slot.
    // Capped from the start: a file created to relieve a ceiling is the easiest
    // place for the next thing to be dropped without anyone noticing.
    "app/(app)/portal/board-compact.ts": 300,
    "app/(app)/portal/board-ordering.ts": 200,
    "app/(app)/portal/board-format.ts": 400,
    "app/(app)/portal/board-primitives.tsx": 200,
    "app/(app)/portal/board-cells.tsx": 1300,
    "app/(app)/portal/board-subitems.tsx": 300,
    "app/(app)/portal/board-chrome.tsx": 500,
  };
  for (const [file, limit] of Object.entries(limits)) {
    const source = await read(file);
    assert.ok(
      lines(source) <= limit,
      `${file} is ${lines(source)} lines, over its ${limit} limit — split it further.`,
    );
  }
});

test("the split moved code without rewriting behaviour", async () => {
  // Guards against a refactor quietly dropping a formatter.
  const format = await read("app/(app)/portal/board-format.ts");
  for (const fn of [
    "customCellKey", "choiceList", "parseBoardDateMetadata",
    "serializeBoardDateMetadata", "formatBoardTime", "formatFullBoardDate",
    "customCellDisplay", "serializeCustomCellValue", "compactNumber",
    "dateRangeSummary", "filledSummary",
  ]) {
    assert.match(format, new RegExp(`export function ${fn}\\b`), `${fn} must survive the split`);
  }

  const model = await read("app/(app)/portal/board-model.ts");
  for (const constant of [
    "boardDateIconOptions", "groupColors", "tierOptions", "engineerOptions",
    "priorityOptions", "labelOptions", "statusOptions", "columnLabels",
    "columnTypeDefinitions", "fallbackSystemColumns",
  ]) {
    assert.match(model, new RegExp(`export const ${constant}\\b`), `${constant} must survive`);
  }
});
