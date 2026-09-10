/**
 * ファイル拡張子・ファイル名とアイコンのマッピング設定のテスト
 * 
 * - .msg ファイルにメールアイコン ('mail') が割り当てられていること
 * - .eml ファイルにメールアイコン ('mail') が割り当てられていること
 */
import { describe, it, expect } from "vitest";
import { extensionToIcon } from "./iconMapping";
import { getIconPath } from "../components/FileIcon";

describe("iconMapping", () => {
  it("msg 拡張子に mail アイコンが割り当てられていること", () => {
    expect(extensionToIcon["msg"]).toBe("mail");
  });

  it("eml 拡張子に mail アイコンが割り当てられていること", () => {
    expect(extensionToIcon["eml"]).toBe("mail");
  });

  it("getIconPath で .msg ファイルに対して mail.svg のパスが返されること", () => {
    expect(getIconPath("important_message.msg", "file")).toBe("/icons/catppuccin/mail.svg");
    expect(getIconPath("ANNOUNCEMENT.MSG", "file")).toBe("/icons/catppuccin/mail.svg");
  });

  it("getIconPath で .eml ファイルに対して mail.svg のパスが返されること", () => {
    expect(getIconPath("newsletter.eml", "file")).toBe("/icons/catppuccin/mail.svg");
    expect(getIconPath("EMAIL.EML", "file")).toBe("/icons/catppuccin/mail.svg");
  });
});
