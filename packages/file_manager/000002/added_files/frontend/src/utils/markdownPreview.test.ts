/**
 * Markdownプレビュー描画のテスト
 * Obsidian風プレビューで必要な基本構文と安全なエスケープを検証する
 */
import { describe, expect, it } from "vitest";

import { renderMarkdownToHtml } from "./markdownPreview";

describe("renderMarkdownToHtml", () => {
  it("renders headings, paragraphs, emphasis and links", () => {
    const html = renderMarkdownToHtml("# Title\n\nHello **world** and [site](https://example.com).");

    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<p>Hello <strong>world</strong> and <a href=\"https://example.com\"");
  });

  it("renders task lists and unordered lists", () => {
    const html = renderMarkdownToHtml("- [ ] todo\n- [x] done\n- plain");

    expect(html).toContain("contains-task-list");
    expect(html).toContain("type=\"checkbox\"");
    expect(html).toContain("data-task-line=\"0\"");
    expect(html).toContain("<li>plain</li>");
  });

  it("renders fenced code blocks and inline code safely", () => {
    const html = renderMarkdownToHtml("```ts\nconst value = 1 < 2;\n```\n\nUse `code`.");

    expect(html).toContain("markdown-code-block");
    expect(html).toContain('data-language="ts"');
    expect(html).toContain("const value = 1 &lt; 2;");
    expect(html).toContain("<code>code</code>");
  });

  it("renders callouts and wikilinks", () => {
    const html = renderMarkdownToHtml("> [!note] Memo\n> body\n\nSee [[Daily Note|today]].");

    expect(html).toContain("markdown-callout");
    expect(html).toContain("markdown-callout-title");
    expect(html).toContain("<span class=\"markdown-wikilink\" data-target=\"Daily Note\">today</span>");
  });

  it("escapes raw html to avoid injection", () => {
    const html = renderMarkdownToHtml("<script>alert(1)</script>");

    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });

  describe("image rendering", () => {
    it("renders markdown image with relative path using baseDir", () => {
      const markdown = "eratl\n\n![alt text](image.png)";
      const html = renderMarkdownToHtml(markdown, {
        baseDir: "/Users/mine/000_work/temp/test",
      });

      expect(html).toContain('<img ');
      expect(html).toContain('src="/api/view-image?path=%2FUsers%2Fmine%2F000_work%2Ftemp%2Ftest%2Fimage.png"');
      expect(html).toContain('alt="alt text"');
      expect(html).toContain('class="markdown-preview-image"');
    });

    it("renders markdown image with ./ relative path", () => {
      const markdown = "![photo](./images/pic.png)";
      const html = renderMarkdownToHtml(markdown, {
        baseDir: "/Users/mine/projects",
      });

      expect(html).toContain('src="/api/view-image?path=%2FUsers%2Fmine%2Fprojects%2Fimages%2Fpic.png"');
      expect(html).toContain('alt="photo"');
    });

    it("renders markdown image with external http/https URL as-is", () => {
      const markdown = "![web logo](https://example.com/logo.png)";
      const html = renderMarkdownToHtml(markdown, {
        baseDir: "/Users/mine/projects",
      });

      expect(html).toContain('src="https://example.com/logo.png"');
      expect(html).toContain('alt="web logo"');
    });

    it("renders markdown image with data URI as-is", () => {
      const markdown = "![pixel](data:image/png;base64,iVBORw0KGgo=)";
      const html = renderMarkdownToHtml(markdown);

      expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
      expect(html).toContain('alt="pixel"');
    });

    it("renders Obsidian style image embed ![[image.png]]", () => {
      const markdown = "![[diagram.png]]";
      const html = renderMarkdownToHtml(markdown, {
        baseDir: "/Users/mine/docs",
      });

      expect(html).toContain('<img ');
      expect(html).toContain('src="/api/view-image?path=%2FUsers%2Fmine%2Fdocs%2Fdiagram.png"');
      expect(html).toContain('alt="diagram.png"');
    });

    it("renders Obsidian style image embed with width ![[image.png|300]]", () => {
      const markdown = "![[diagram.png|300]]";
      const html = renderMarkdownToHtml(markdown, {
        baseDir: "/Users/mine/docs",
      });

      expect(html).toContain('<img ');
      expect(html).toContain('width="300"');
    });

    it("renders markdown image with title attribute", () => {
      const markdown = '![alt](image.png "Image Title")';
      const html = renderMarkdownToHtml(markdown, {
        baseDir: "/Users/mine/docs",
      });

      expect(html).toContain('title="Image Title"');
    });
  });
});

