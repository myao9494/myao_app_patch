import { describe, expect, it } from "vitest";
import type { BatchItemResult } from "../types/file";
import {
  classifyBatchResults,
  collectLockingProcesses,
  formatLockingProcesses,
  getTransferHistoryData,
} from "./batchResult";

const results: BatchItemResult[] = [
  { path: "/a/ok.txt", dest: "/b/ok.txt", status: "success", message: "移動完了" },
  { path: "/a/same.txt", dest: "/b/same.txt", status: "error", message: "同名のファイルが存在します" },
  { path: "/a/locked.xlsx", status: "error", message: "WinError 32", locked_by: [{ pid: 10, name: "EXCEL.EXE" }] },
  { path: "/a/locked2.xlsx", status: "error", message: "WinError 32", locked_by: [{ pid: 10, name: "EXCEL.EXE" }, { pid: 11, name: "WORD.EXE" }] },
  { path: "/a/broken", status: "error", message: "disk error" },
  { path: "/b/noop", dest: "/b/noop", status: "skipped", message: "移動元と移動先が同じです" },
];

describe("classifyBatchResults", () => {
  it("splits results into success, conflicts, locked and other errors", () => {
    const classified = classifyBatchResults(results);

    expect(classified.succeeded.map((r) => r.path)).toEqual(["/a/ok.txt"]);
    expect(classified.conflicts.map((r) => r.path)).toEqual(["/a/same.txt"]);
    expect(classified.locked.map((r) => r.path)).toEqual(["/a/locked.xlsx", "/a/locked2.xlsx"]);
    expect(classified.otherErrors.map((r) => r.path)).toEqual(["/a/broken"]);
  });

  it("handles missing results", () => {
    expect(classifyBatchResults(undefined).succeeded).toEqual([]);
  });
});

describe("collectLockingProcesses", () => {
  it("returns unique processes", () => {
    const processes = collectLockingProcesses(classifyBatchResults(results).locked);

    expect(processes).toEqual([
      { pid: 10, name: "EXCEL.EXE" },
      { pid: 11, name: "WORD.EXE" },
    ]);
    expect(formatLockingProcesses(processes)).toBe("・EXCEL.EXE (PID: 10)\n・WORD.EXE (PID: 11)");
  });
});

describe("getTransferHistoryData", () => {
  it("records only moved items so undo never touches files that were not moved", () => {
    expect(getTransferHistoryData("move", results, "/b")).toEqual({
      type: "MOVE",
      data: { srcPaths: ["/a/ok.txt"], destParentPath: "/b" },
    });
  });

  it("records only copied destinations so undo never deletes pre-existing files", () => {
    expect(getTransferHistoryData("copy", results, "/b")).toEqual({
      type: "COPY",
      data: { copiedPaths: ["/b/ok.txt"], originalPaths: ["/a/ok.txt"] },
    });
  });

  it("falls back to destPath + name when dest is missing", () => {
    expect(
      getTransferHistoryData("copy", [{ path: "C:\\data\\x.txt", status: "success", message: "" }], "D:/out"),
    ).toEqual({ type: "COPY", data: { copiedPaths: ["D:/out/x.txt"], originalPaths: ["C:\\data\\x.txt"] } });
  });

  it("returns null when nothing succeeded", () => {
    expect(getTransferHistoryData("move", results.filter((r) => r.status !== "success"), "/b")).toBeNull();
  });
});
