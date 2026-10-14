/**
 * ファイル一覧の更新日時表示フォーマットのテスト
 */
import { describe, expect, it } from "vitest";
import { formatFileDate } from "./formatFileDate";

describe("formatFileDate", () => {
  it("formats an ISO datetime with hours and minutes", () => {
    // バックエンドはタイムゾーンなしのローカル時刻を返すため、実行環境のタイムゾーンに依存しない
    expect(formatFileDate("2026-05-06T14:23:45")).toBe("2026/05/06 14:23");
  });

  it("returns hyphen when the value is missing or invalid", () => {
    expect(formatFileDate(undefined)).toBe("-");
    expect(formatFileDate("not-a-date")).toBe("-");
  });
});
