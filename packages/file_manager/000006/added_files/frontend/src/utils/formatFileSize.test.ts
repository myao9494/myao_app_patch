import { describe, expect, it } from "vitest";
import { formatFileSize } from "./formatFileSize";

describe("formatFileSize", () => {
  it("formats bytes, kilobytes and megabytes", () => {
    expect(formatFileSize(undefined)).toBe("-");
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(1023)).toBe("1023 B");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
