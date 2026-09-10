# Obsidian図面・Excalidrawプレビュー・Mermaid描画仕様書

## 概要

Obsidian Vault（`/Users/mine/000_work/obsidian-dagnetz`）内のMarkdownノートには、以下のような多彩な図面や画像が含まれています：
1. **Excalidraw 図面埋め込み**: `![[図_確定申告.excalidraw|1475]]`
2. **Vault相対パス / 添付ファイル画像**: `![[01_data/common_image/logo.png]]`、`![[Pasted image 20260103155031.png]]`
3. **Mermaid ダイアグラム**: ````mermaid ... ````
4. **Excalidraw ファイル直接閲覧**: `.excalidraw.md`

スマートフォン特化クイック検索・閲覧アプリ（`/quick/`）において、これらの図面を美麗かつレスポンシブに描画するための連携仕様を定義します。

---

## 1. Excalidraw キャッシュ自動解決 (FNV-1a)

### 背景と仕組み
Obsidian Vault では、`obsidian-excalidraw-cards` プラグイン等により、Excalidraw図面のレンダリング済みPNG画像が `.excalidraw-cache/` 配下に保存されています。
キャッシュのインデックスファイル `.excalidraw-cache/index.json` は以下のような形式です：

```json
{
  "01_data/2026/03/01/図_確定申告.excalidraw.md": {
    "mtime": 1779912388320,
    "cachefile": "4b9144b7_1779912388320_preview.png"
  }
}
```

### ハッシュ生成アルゴリズム
キャッシュファイル名冒頭のハッシュ（例: `4b9144b7`）は、Vault相対パス文字列の **FNV-1a 32-bit unsigned 16進数** で算出されます。

```python
def get_string_hash(s: str) -> str:
    h = 0x811C9DC5
    for b in s.encode("utf-8"):
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"{h:08x}"
```

### 探索・フォールバック順序
バックエンドの `/api/view-image` では、`.excalidraw` または `.excalidraw.md` が要求された際に以下の優先順序で画像を探索して配信します：
1. `.excalidraw-cache/index.json` 内のエントリ照合
2. `.excalidraw-cache/[hash]_*_preview.png` の直接検索
3. 同一フォルダ内の同名 `.svg` または `.png`
4. 上記が存在しない場合、Excalidrawアイコンを含むインラインSVG図面を動的生成して返却

---

## 2. Vault ルートおよび Vault 相対パス自動探索

1. **Vault ルート検出**:
   ファイルの指定パスまたは `baseDir` から上位階層を遡り、`.obsidian` ディレクトリが存在するフォルダを Vault ルートとして動的検出。
2. **Vault 相対パス解決**:
   Markdown内で `![[01_data/common_image/logo.png]]` のように指定された場合、Vault ルートを基準にパスを解決。
3. **ファイル名のみ（添付ファイル）の自動検索**:
   `![[Pasted image 20260103155031.png]]` のようにファイル名のみで指定された場合、Vault ルート配下を再帰的にスキャンして即座に実ファイルを特定。

---

## 3. クライアント側（Quickアプリ）連携

### API URL 生成 (`client.ts`)
```typescript
export function getImageViewUrl(filePath: string, settings: AppSettings, baseDir?: string): string {
  const baseUrl = getApiBaseUrl(settings);
  let url = `${baseUrl}/api/view-image?path=${encodeURIComponent(filePath)}`;
  if (baseDir) {
    url += `&baseDir=${encodeURIComponent(baseDir)}`;
  }
  return url;
}
```

### Markdown 内の Obsidian 埋め込み認識 (`markdownPreview.ts`)
- `isImageFile`: `.excalidraw`, `.excalidraw.md`, `.excalidraw.svg`, `.drawio.svg` を画像（図面）として判定。
- `resolveMarkdownImageUrl`: `baseDir` を `getImageViewUrl` に引き渡し、バックエンドが Vault ルートを特定できるようにする。

### Excalidraw ファイル直接オープン時のスマートビュー (`FileViewer.tsx`)
- `.excalidraw.md` ファイルを直接開いた場合、生JSONテキストではなく、図面プレビュー画像を大画面で表示。
- 「Excalidraw で開く（Port 3001）」ボタンを提供。
- ソース切替ボタンにより、必要に応じて元のテキスト/JSON構造も確認可能。

---

## 4. Mermaid ダイアグラム動的描画

Markdown内のコードブロック（````mermaid ... ````）を認識し、クライアント側でSVGダイアグラムを動的に生成します。

```typescript
useEffect(() => {
  if (isMarkdownDoc && viewMode === 'rendered' && previewContainerRef.current) {
    const mermaidElements = previewContainerRef.current.querySelectorAll('.mermaid');
    if (mermaidElements.length > 0) {
      mermaid.initialize({
        startOnLoad: false,
        theme: settings.theme === 'dark' ? 'dark' : 'default',
        securityLevel: 'loose',
      });
      mermaid.run({
        nodes: mermaidElements as unknown as ArrayLike<HTMLElement>,
      });
    }
  }
}, [renderedHtml, isMarkdownDoc, viewMode, settings.theme]);
```

スマートフォン画面でも快適に閲覧できるよう、横スクロール（`-webkit-overflow-scrolling: touch`）およびダークテーマに対応しています。
