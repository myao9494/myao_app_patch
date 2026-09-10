/**
 * Markdownレンダリングユーティリティのテスト
 * - 見出し、リスト、チェックボックスのHTML変換
 * - 画像（Markdown標準、Obsidian埋め込み）のURL解決
 * - コールアウトやコードブロックの変換
 */
import { describe, it, expect } from 'vitest';
import { renderMarkdownToHtml } from './markdownPreview';
import { AppSettings } from '../types';

describe('markdownPreview', () => {
  const dummySettings: AppSettings = {
    serverHost: 'mineomacbook-air.taild3cb7c.ts.net',
    serverPort: '8001',
    excalidrawPort: '3001',
    basePath: '/Users/mine/000_work',
    theme: 'dark',
  };

  it('見出しとパラグラフを正しくHTML変換すること', () => {
    const md = '# タイトル\n本文テキストです。';
    const html = renderMarkdownToHtml(md, { settings: dummySettings });
    expect(html).toContain('<h1>タイトル</h1>');
    expect(html).toContain('<p>本文テキストです。</p>');
  });

  it('チェックボックスリストを正しくHTML変換すること', () => {
    const md = '- [ ] 未完了タスク\n- [x] 完了タスク';
    const html = renderMarkdownToHtml(md, { settings: dummySettings });
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked');
    expect(html).toContain('未完了タスク');
    expect(html).toContain('完了タスク');
  });

  it('Obsidian埋め込み画像を正しく解決してimgタグに変換すること', () => {
    const md = '![[diagram.png|300x200]]';
    const html = renderMarkdownToHtml(md, {
      baseDir: '/Users/mine/000_work/notes',
      settings: dummySettings,
    });
    expect(html).toContain('<img src="');
    expect(html).toContain('/api/view-image?path=');
    expect(html).toContain('diagram.png');
    expect(html).toContain('width="300"');
    expect(html).toContain('height="200"');
  });

  it('相対パス画像を正しく絶対パス解決してimgタグに変換すること', () => {
    const md = '![写真](./images/photo.jpg)';
    const html = renderMarkdownToHtml(md, {
      baseDir: '/Users/mine/000_work/notes',
      settings: dummySettings,
    });
    expect(html).toContain('<img src="');
    expect(html).toContain('notes%2Fimages%2Fphoto.jpg');
    expect(html).toContain('alt="写真"');
  });

  it('コールアウト構文（[!NOTE]）を正しく変換すること', () => {
    const md = '> [!NOTE] 重要\n> これはノートです。';
    const html = renderMarkdownToHtml(md, { settings: dummySettings });
    expect(html).toContain('markdown-callout');
    expect(html).toContain('markdown-callout-note');
    expect(html).toContain('重要');
    expect(html).toContain('これはノートです。');
  });

  it('Markdown内のlocalhostリンクを設定ホスト名に置換すること', () => {
    const md = '[Excalidrawを開く](http://localhost:3001/file?name=test)';
    const html = renderMarkdownToHtml(md, { settings: dummySettings });
    expect(html).toContain('mineomacbook-air.taild3cb7c.ts.net:3001');
    expect(html).not.toContain('localhost:3001');
  });

  it('GFMテーブルを正しくHTMLテーブルに変換すること', () => {
    const md = `
| 氏名 | 所属 | 電話番号 |
| :--- | :---: | ---: |
| 山田 太郎 | **総務部** | 090-1234-5678 |
| 佐藤 花子 | \`開発部\` | 03-9999-8888 |
`;
    const html = renderMarkdownToHtml(md, { settings: dummySettings });

    // ラッパーとテーブル要素
    expect(html).toContain('<div class="markdown-table-wrapper">');
    expect(html).toContain('<table class="markdown-table">');
    expect(html).toContain('<thead>');
    expect(html).toContain('<tbody>');

    // ヘッダーとアライメント
    expect(html).toContain('<th style="text-align: left;">氏名</th>');
    expect(html).toContain('<th style="text-align: center;">所属</th>');
    expect(html).toContain('<th style="text-align: right;">電話番号</th>');

    // セル内のインライン装飾（太字、コード）
    expect(html).toContain('<td style="text-align: left;">山田 太郎</td>');
    expect(html).toContain('<td style="text-align: center;"><strong>総務部</strong></td>');
    expect(html).toContain('<td style="text-align: right;">090-1234-5678</td>');
    expect(html).toContain('<td style="text-align: center;"><code>開発部</code></td>');
  });

  it('インラインコード内のパイプ記号でセル分割が壊れないこと', () => {
    const md = `
| コマンド | 説明 |
| --- | --- |
| \`ls | grep test\` | パイプを使った検索 |
`;
    const html = renderMarkdownToHtml(md, { settings: dummySettings });
    expect(html).toContain('<code>ls | grep test</code>');
    expect(html).toContain('パイプを使った検索');
  });

  it('生のURL（Forms等）を同一タブで開くリンク（aタグ）に変換すること（戻るボタンが使えるようにtarget=_blankなし）', () => {
    const rawUrl = 'https://forms.office.com/pages/responsepage.aspx?id=boeAuaWBy0maf_CY5ASZhNvjMBF--DxOukoIsrTfnRtURUVERTBIQVFYMFhKOVA1M0M0VktVUVZFVy4u&origin=QRCode&route=shorturl';
    const md = `こちらのフォームから回答してください:\n${rawUrl}\nよろしくお願いします。`;
    const html = renderMarkdownToHtml(md, { settings: dummySettings });

    expect(html).toContain(`<a href="${rawUrl}">`);
    expect(html).not.toContain('target="_blank"');
  });

  it('インラインコード内のURLはリンク化されず、既存のMarkdownリンクも二重化されないこと', () => {
    const md = '`https://example.com/api` および [リンク](https://example.com/docs)';
    const html = renderMarkdownToHtml(md, { settings: dummySettings });

    expect(html).toContain('<code>https://example.com/api</code>');
    expect(html).not.toContain('<a href="https://example.com/api"');
    expect(html).toContain('<a href="https://example.com/docs">リンク</a>');
    expect(html).not.toContain('target="_blank"');
    expect(html).not.toContain('<a href="<a href=');
  });

  it('文末の句読点やカッコがURLリンクに含まれないこと', () => {
    const md = '(参考: https://example.com/guide) をご覧ください。';
    const html = renderMarkdownToHtml(md, { settings: dummySettings });

    expect(html).toContain('<a href="https://example.com/guide">https://example.com/guide</a>) をご覧ください。');
    expect(html).not.toContain('target="_blank"');
  });

  it('テーブルセル内のURLも自動的にリンク化されること', () => {
    const md = `
| サービス名 | リンク先 |
| --- | --- |
| Office Forms | https://forms.office.com/pages/responsepage.aspx?id=123 |
`;
    const html = renderMarkdownToHtml(md, { settings: dummySettings });

    expect(html).toContain('<td style="text-align: left;"><a href="https://forms.office.com/pages/responsepage.aspx?id=123">https://forms.office.com/pages/responsepage.aspx?id=123</a></td>');
    expect(html).not.toContain('target="_blank"');
  });

  it('Obsidian Excalidraw図面埋め込み（.excalidraw）を画像として解決しbaseDirをクエリに付与すること', () => {
    const md = '![[図_確定申告.excalidraw|1475]]';
    const html = renderMarkdownToHtml(md, {
      baseDir: '/Users/mine/000_work/obsidian-dagnetz/01_data/2026/03/01',
      settings: dummySettings,
    });

    expect(html).toContain('<img src="');
    expect(html).toContain('%E5%9B%B3_%E7%A2%BA%E5%AE%9A%E7%94%B3%E5%91%8A.excalidraw');
    expect(html).toContain('baseDir=%2FUsers%2Fmine%2F000_work%2Fobsidian-dagnetz%2F01_data%2F2026%2F03%2F01');
    expect(html).toContain('width="1475"');
    expect(html).not.toContain('markdown-embed-card');
  });

  it('Obsidian Excalidraw図面（.excalidraw.md）も画像として認識すること', () => {
    const md = '![[draw_file_manager.excalidraw.md]]';
    const html = renderMarkdownToHtml(md, {
      baseDir: '/Users/mine/000_work/obsidian-dagnetz/01_data/system',
      settings: dummySettings,
    });

    expect(html).toContain('<img src="');
    expect(html).toContain('draw_file_manager.excalidraw.md');
    expect(html).toContain('baseDir=');
  });

  it('Mermaidコードブロックを専用のdivラッパー（class="mermaid"）として出力すること', () => {
    const md = `\`\`\`mermaid
graph TD
  A[開始] --> B[処理]
  B --> C[終了]
\`\`\``;
    const html = renderMarkdownToHtml(md, { settings: dummySettings });

    expect(html).toContain('<div class="mermaid-container">');
    expect(html).toContain('<pre class="mermaid">');
    expect(html).toContain('graph TD');
    expect(html).toContain('A[開始] --&gt; B[処理]');
  });
});

