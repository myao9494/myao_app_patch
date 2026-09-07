/**
 * 左右ペイン同期移動ユーティリティのテスト
 * - 同一パスにいる場合の同期移動
 * - 親フォルダへの相対移動同期
 * - サブフォルダへの相対移動同期（同名フォルダ存在時・非存在時）
 * - Windowsパス・UNIXパス両対応
 */
import { describe, it, expect } from "vitest";
import { resolveSyncedPath, getParentFolderPath, getSubfolderName } from "./syncNavigation";

describe("syncNavigation", () => {
  describe("getParentFolderPath", () => {
    it("UNIXパスの親フォルダを正しく取得すること", () => {
      expect(getParentFolderPath("/Users/name/work/project")).toBe("/Users/name/work");
      expect(getParentFolderPath("/Users")).toBe("/");
      expect(getParentFolderPath("/")).toBe(null);
    });

    it("Windowsパスの親フォルダを正しく取得すること", () => {
      expect(getParentFolderPath("C:\\Users\\name\\work")).toBe("C:\\Users\\name");
      expect(getParentFolderPath("C:\\")).toBe(null);
    });
  });

  describe("getSubfolderName", () => {
    it("直下の子フォルダ名を正しく抽出すること", () => {
      expect(getSubfolderName("/Users/name/work", "/Users/name/work/project")).toBe("project");
      expect(getSubfolderName("C:\\work", "C:\\work\\sub")).toBe("sub");
    });

    it("直下の子フォルダでない場合はnullを返すこと", () => {
      expect(getSubfolderName("/Users/name/work", "/Users/name/other/sub")).toBe(null);
      expect(getSubfolderName("/Users/name/work", "/Users/name")).toBe(null);
    });
  });

  describe("resolveSyncedPath", () => {
    it("左右が同一パスにいる場合、移動先パスにそのまま同期すること", () => {
      const result = resolveSyncedPath(
        "/common/path",
        "/common/path/sub",
        "/common/path"
      );
      expect(result.nextPath).toBe("/common/path/sub");
      expect(result.reason).toBe("identical");
    });

    it("左右が異なるパスにいて親フォルダへ移動した場合、ターゲット側も親フォルダへ移動すること", () => {
      const result = resolveSyncedPath(
        "/left/project/src",
        "/left/project",
        "/right/backup/src"
      );
      expect(result.nextPath).toBe("/right/backup");
      expect(result.reason).toBe("parent");
    });

    it("左右が異なるパスにいてサブフォルダへ入った場合、同名サブフォルダが存在すれば移動すること", () => {
      const result = resolveSyncedPath(
        "/left/project",
        "/left/project/docs",
        "/right/backup",
        ["docs", "src", "tests"]
      );
      expect(result.nextPath).toBe("/right/backup/docs");
      expect(result.reason).toBe("subfolder");
    });

    it("左右が異なるパスにいてサブフォルダへ入ったが、同名サブフォルダが存在しない場合は移動しないこと", () => {
      const result = resolveSyncedPath(
        "/left/project",
        "/left/project/docs",
        "/right/backup",
        ["src", "tests"]
      );
      expect(result.nextPath).toBe(null);
      expect(result.reason).toBe("not_found");
    });

    it("パスが変わっていない場合はunchangedを返すこと", () => {
      const result = resolveSyncedPath(
        "/left/project",
        "/left/project",
        "/right/backup"
      );
      expect(result.nextPath).toBe(null);
      expect(result.reason).toBe("unchanged");
    });
  });
});
