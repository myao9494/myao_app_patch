/**
 * ベクトル管理画面の「単一ファイル差分更新ベンチマーク」で使う、意地悪な入力のプリセット。
 * 極端に長い文書・特殊文字・空に近い文書・見出しだらけの文書で、インデックス更新の時間と頑健さを確かめる。
 */
export const EVIL_PRESETS = {
  LONG: {
    name: "🔥 超長文 (10,000文字)",
    generate: (title: string) => {
      let body = `# ${title || "超長文負荷テスト"}\n\n`;
      for (let i = 1; i <= 25; i++) {
        body += `## 第${i}セクション 高負荷検証用テキストブロック ${i}\n`;
        body += `これは社内検索システムのベクトル更新性能を極限まで検証するためのテストデータです。\n`;
        body += `自然言語処理モデルの推論スループットおよびチャンク分割の耐久性を確認します。\n\n`;
      }
      return body;
    },
  },
  SPECIAL: {
    name: "💣 特殊記号 & XSS",
    generate: (title: string) => {
      return (
        `# ${title || "特殊記号テスト"} <script>alert('test')</script>\n\n` +
        `## 記号乱舞 !@#$%^&*()_+{}[]|:;"'<>?,./~\\\n\n` +
        `- [[ノート名|別名エイリアス]]\n` +
        `- [タグ: #AI #検証_2026 #テスト/階層/タグ]\n` +
        `- 数式: $E=mc^2$ および $$\\sum_{i=1}^n x_i$$\n` +
        `\`\`\`python\ndef evil_code():\n    return "特殊エスケープ \\n \\t \\r"\n\`\`\`\n`
      );
    },
  },
  EMPTY: {
    name: "📄 空ファイル",
    generate: () => "",
  },
  HEADINGS: {
    name: "📑 見出し乱舞 (30階層)",
    generate: (title: string) => {
      let body = `# ${title || "見出し構造テスト"}\n\n`;
      for (let i = 1; i <= 15; i++) {
        body += `## レベル2 見出し ${i}\n本文1行目\n### レベル3 見出し ${i}-A\n本文2行目\n#### レベル4 見出し ${i}-B\n本文3行目\n\n`;
      }
      return body;
    },
  },
};
