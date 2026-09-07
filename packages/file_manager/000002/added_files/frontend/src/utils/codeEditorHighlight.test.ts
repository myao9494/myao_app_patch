/**
 * コードエディタ向けシンタックスハイライト生成のテスト
 */
import { describe, expect, it } from "vitest";

import {
  detectEditorLanguage,
  isWebFileEditorTarget,
  renderCodeToHighlightedHtml,
} from "./codeEditorHighlight";

describe("detectEditorLanguage", () => {
  it("maps representative file extensions to editor languages", () => {
    expect(detectEditorLanguage("main.py")).toBe("python");
    expect(detectEditorLanguage("index.tsx")).toBe("tsx");
    expect(detectEditorLanguage("notes.txt")).toBe("plaintext");
    expect(detectEditorLanguage("data.json")).toBe("json");
  });

  it("falls back to plaintext for unknown extensions", () => {
    expect(detectEditorLanguage("archive.unknown")).toBe("plaintext");
    expect(detectEditorLanguage("README")).toBe("plaintext");
  });
});

describe("renderCodeToHighlightedHtml", () => {
  it("highlights TypeScript keywords, strings, comments and preserves escaping", () => {
    const html = renderCodeToHighlightedHtml(
      "const label = \"<tag>\"; // note",
      "typescript",
    );

    expect(html).toContain('code-editor-token keyword">const</span>');
    expect(html).toContain('code-editor-token string">&quot;&lt;tag&gt;&quot;</span>');
    expect(html).toContain('code-editor-token comment">// note</span>');
  });

  it("highlights JSON keys and primitive values", () => {
    const html = renderCodeToHighlightedHtml(
      "{\n  \"enabled\": true,\n  \"count\": 3\n}",
      "json",
    );

    expect(html).toContain('code-editor-token property">&quot;enabled&quot;</span>');
    expect(html).toContain('code-editor-token keyword">true</span>');
    expect(html).toContain('code-editor-token number">3</span>');
  });

  it("keeps plain text readable without injecting markup from the source", () => {
    const html = renderCodeToHighlightedHtml("hello <script>", "plaintext");

    expect(html).toContain("hello &lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("highlights Python code with VS Code style tokens", () => {
    const pyCode = `"""
Module docstring
"""
import os
from typing import List

@property
def get_user(self, user_id: int = 42) -> str:
    # fetch user info
    name = f"User-{user_id}"
    print(name)
    return True
`;

    const html = renderCodeToHighlightedHtml(pyCode, "python");

    // docstring（3重クォート）
    expect(html).toContain('code-editor-token string">&quot;&quot;&quot;\nModule docstring\n&quot;&quot;&quot;</span>');
    // キーワード (import, from, def, return)
    expect(html).toContain('code-editor-token keyword">import</span>');
    expect(html).toContain('code-editor-token keyword">from</span>');
    expect(html).toContain('code-editor-token keyword">def</span>');
    expect(html).toContain('code-editor-token keyword">return</span>');
    // 真偽値 (True)
    expect(html).toContain('code-editor-token keyword">True</span>');
    // デコレータ (@property)
    expect(html).toContain('code-editor-token decorator">@property</span>');
    // 関数定義名 (get_user)
    expect(html).toContain('code-editor-token function">get_user</span>');
    // self
    expect(html).toContain('code-editor-token variable">self</span>');
    // 数値 (42)
    expect(html).toContain('code-editor-token number">42</span>');
    // コメント (# fetch user info)
    expect(html).toContain('code-editor-token comment"># fetch user info</span>');
    // f-string (f"User-{user_id}")
    expect(html).toContain('code-editor-token string">f&quot;User-{user_id}&quot;</span>');
    // 組み込み関数 (print)
    expect(html).toContain('code-editor-token builtin">print</span>');
  });

  it("highlights Python class definition", () => {
    const pyClass = `class UserManager:\n    pass`;
    const html = renderCodeToHighlightedHtml(pyClass, "python");

    expect(html).toContain('code-editor-token keyword">class</span>');
    expect(html).toContain('code-editor-token class">UserManager</span>');
    expect(html).toContain('code-editor-token keyword">pass</span>');
  });

  it("applies search match highlighting to code tokens", () => {
    const code = `def calculate_sum(a, b):\n    return a + b\n\ntotal = calculate_sum(1, 2)`;
    const html = renderCodeToHighlightedHtml(code, "python", {
      query: "calculate_sum",
      activeIndex: 0,
      isRegex: false,
    });

    expect(html).toContain('md-search-highlight active');
    expect(html).toContain('md-search-highlight');
  });
});



describe("isWebFileEditorTarget", () => {
  it("returns true for supported non-markdown text/code files", () => {
    expect(isWebFileEditorTarget("notes.txt")).toBe(true);
    expect(isWebFileEditorTarget("main.py")).toBe(true);
    expect(isWebFileEditorTarget("settings.json")).toBe(true);
  });

  it("returns false for markdown and unsupported files", () => {
    expect(isWebFileEditorTarget("memo.md")).toBe(false);
    expect(isWebFileEditorTarget("photo.png")).toBe(false);
  });
});
