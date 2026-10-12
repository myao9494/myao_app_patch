import { describe, expect, it } from "vitest";
import type { FileItem } from "../types/file";
import { filterAndSortItems, getFileExtension, type FileListFilterOptions } from "./fileListFilter";

const items: FileItem[] = [
  { name: "b.md", type: "file", path: "/r/b.md", size: 30, modified: "2026-01-03T00:00:00" },
  { name: "docs", type: "directory", path: "/r/docs", modified: "2026-01-01T00:00:00" },
  { name: "A.txt", type: "file", path: "/r/A.txt", size: 10, modified: "2026-01-05T00:00:00" },
  { name: "archive", type: "directory", path: "/r/archive", modified: "2026-01-09T00:00:00" },
  { name: "c.MD", type: "file", path: "/r/c.MD", size: 20 },
];

const base: FileListFilterOptions = {
  searchQuery: "",
  isRegex: false,
  typeFilter: "all",
  extFilter: "all",
  sortKey: "name",
  sortOrder: "asc",
};

const names = (r: { folders: FileItem[]; files: FileItem[] }) => [...r.folders, ...r.files].map((i) => i.name);

describe("filterAndSortItems", () => {
  it("separates folders and files and sorts by name", () => {
    expect(names(filterAndSortItems(items, base))).toEqual(["archive", "docs", "A.txt", "b.md", "c.MD"]);
    expect(names(filterAndSortItems(items, { ...base, sortOrder: "desc" }))).toEqual(["docs", "archive", "c.MD", "b.md", "A.txt"]);
  });

  it("filters by case-insensitive substring or regex, falling back to substring for an invalid regex", () => {
    expect(names(filterAndSortItems(items, { ...base, searchQuery: "MD" }))).toEqual(["b.md", "c.MD"]);
    expect(names(filterAndSortItems(items, { ...base, isRegex: true, searchQuery: "^a" }))).toEqual(["archive", "A.txt"]);
    expect(names(filterAndSortItems(items, { ...base, isRegex: true, searchQuery: "b.md(" }))).toEqual([]);
    expect(names(filterAndSortItems(items, { ...base, isRegex: true, searchQuery: "[" }))).toEqual([]);
  });

  it("filters by type and by extension (extensions do not hide folders)", () => {
    expect(names(filterAndSortItems(items, { ...base, typeFilter: "files" }))).toEqual(["A.txt", "b.md", "c.MD"]);
    expect(names(filterAndSortItems(items, { ...base, typeFilter: "folders" }))).toEqual(["archive", "docs"]);
    expect(names(filterAndSortItems(items, { ...base, extFilter: "md" }))).toEqual(["archive", "docs", "b.md", "c.MD"]);
  });

  it("sorts by size and by date, preferring aggregated folder dates", () => {
    expect(names(filterAndSortItems(items, { ...base, sortKey: "size" }))).toEqual(["docs", "archive", "A.txt", "c.MD", "b.md"]);
    expect(names(filterAndSortItems(items, { ...base, sortKey: "date" }))).toEqual(["docs", "archive", "c.MD", "b.md", "A.txt"]);
    expect(
      names(filterAndSortItems(items, { ...base, sortKey: "date", folderLatestModified: { "/r/docs": "2026-02-01T00:00:00" } })),
    ).toEqual(["archive", "docs", "c.MD", "b.md", "A.txt"]);
  });

  it("does not mutate the source array", () => {
    const copy = [...items];
    filterAndSortItems(items, { ...base, sortKey: "size", sortOrder: "desc" });
    expect(items).toEqual(copy);
  });
});

describe("getFileExtension", () => {
  it("returns the lowercase extension or an empty string", () => {
    expect(getFileExtension("a.TXT")).toBe("txt");
    expect(getFileExtension("archive.tar.gz")).toBe("gz");
    expect(getFileExtension("README")).toBe("");
    expect(getFileExtension("trailing.")).toBe("");
  });
});
