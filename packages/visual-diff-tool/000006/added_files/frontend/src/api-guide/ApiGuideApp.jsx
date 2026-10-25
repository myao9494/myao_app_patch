/**
 * 外部アプリ・AIエージェント向けのAPI説明ページ（/api-guide）。
 */
import React from "react";
import { ExternalLink, HelpCircle } from "lucide-react";
import { ShortcutHelp, useShortcutHelp } from "../components/ShortcutHelp.jsx";

export function ApiGuideApp() {
  const [helpOpen, setHelpOpen] = useShortcutHelp();
  return (
    <main className="api-guide-page">
      <header className="api-guide-header">
        <div>
          <h1>Visual Diff Tool API Guide</h1>
          <p>外部アプリやAIエージェントが本アプリのAPIを呼び出すための実装仕様</p>
        </div>
        <div>
          <button type="button" className="primary secondary" onClick={() => setHelpOpen(true)}><HelpCircle size={18} />ヘルプ</button>
          <a className="primary secondary api-guide-openapi" href="/docs" target="_blank" rel="noreferrer">
            <ExternalLink size={18} />
            FastAPI docs
          </a>
        </div>
      </header>

      <section className="api-guide-content">
        <ApiGuideSection title="基本情報">
          <ul>
            <li>Application Base URL: <code>http://127.0.0.1:8078/</code></li>
            <li>API Base URL: <code>http://127.0.0.1:8078/api</code>。各エンドポイントはこのURLに <code>/health</code>, <code>/diff</code> などを連結して呼び出す。</li>
            <li>画像データはレスポンス内で <code>{"{ mime_type: \"image/png\", data: \"...\" }"}</code> の形で返る。<code>data</code> は data URI prefix を含まないPNGのBase64文字列。</li>
            <li>アップロード上限は1ファイルあたりバックエンド設定の <code>MAX_UPLOAD_BYTES</code> に従う。上限超過時は <code>413</code>。</li>
            <li>対応入力形式: PNG, JPG/JPEG, WebP, BMP, GIF, TIFF/TIF, SVG, PDF, Excalidraw。</li>
            <li>ページ番号は0始まり。PDF/TIFFなど複数ページ形式は <code>/analyze</code> でページ一覧を取得し、選択したページを <code>page</code>, <code>page_a</code>, <code>page_b</code> に指定する。</li>
            <li>エラーは主に <code>{"{ detail: \"message\" }"}</code> 形式で返る。クライアントはHTTPステータスと <code>detail</code> を表示またはログ化する。</li>
          </ul>
        </ApiGuideSection>

        <ApiEndpoint
          method="GET"
          path="/api/health"
          purpose="バックエンドが起動してAPIを受け付けられるか確認する。"
          request="リクエストボディなし。"
          response={`{ "status": "ok" }`}
          notes="外部アプリは初期化時にこのエンドポイントを呼び、200以外ならAPI未起動として扱う。"
        />

        <ApiEndpoint
          method="POST"
          path="/api/analyze"
          purpose="アップロードファイルの形式、ページ数、各ページのサイズ、変換時の注意を取得する。比較前の事前検査に使う。"
          request={`Content-Type: multipart/form-data
file: 対象ファイル`}
          response={`{
  "filename": "drawing.pdf",
  "format": "pdf",
  "page_count": 2,
  "pages": [
    { "index": 0, "width": 1240, "height": 1754, "warnings": [] }
  ],
  "warnings": []
}`}
          notes="Excalidrawでは未対応表現がwarningsに入る。UIや外部アプリは警告をユーザーに見せるとよい。"
        />

        <ApiEndpoint
          method="POST"
          path="/api/convert"
          purpose="指定ページをPNG相当にラスタライズし、プレビュー画像と基準領域候補を取得する。"
          request={`Content-Type: multipart/form-data
file: 対象ファイル
page: 0始まりのページ番号。省略時は0`}
          response={`{
  "filename": "drawing.svg",
  "format": "svg",
  "page": 0,
  "width": 800,
  "height": 600,
  "image": { "mime_type": "image/png", "data": "base64..." },
  "regions": [
    { "x": 10, "y": 20, "width": 300, "height": 200, "label": "枠線候補" }
  ],
  "warnings": []
}`}
          notes="regionsは後続の/api/diffでanchor_regionとして使える。画像表示時は data:image/png;base64, をprefixとして付ける。"
        />

        <ApiEndpoint
          method="POST"
          path="/api/diff"
          purpose="2つのファイルを指定ページで比較し、位置合わせ済み画像、差分オーバーレイ、マスク、差分矩形、差分率を返す。"
          request={`Content-Type: multipart/form-data
file_a: 基準ファイル
file_b: 比較対象ファイル
page_a: 基準ファイルのページ番号。省略時0
page_b: 比較対象ファイルのページ番号。省略時0
category: 汎用 | 図面 | グラフ | 書類。省略時 汎用
diff_threshold: 0.0から1.0の差分しきい値。省略時0.1
anchor_region: 任意。JSON文字列。例 {"x":0,"y":0,"width":800,"height":600,"label":"全体枠候補"}`}
          response={`{
  "result_id": "cache-id",
  "filename_a": "drawing-before.png",
  "filename_b": "clipboard.png",
  "page_a": 0,
  "page_b": 0,
  "category": "図面",
  "width": 800,
  "height": 600,
  "alignment": {
    "success": true,
    "method": "ORB homography",
    "warning": null,
    "matches": 120,
    "inliers": 88,
    "matrix": [[1,0,0],[0,1,0],[0,0,1]]
  },
  "image_a": { "mime_type": "image/png", "data": "base64..." },
  "image_a_original": { "mime_type": "image/png", "data": "base64..." },
  "image_b_original": { "mime_type": "image/png", "data": "base64..." },
  "image_b_aligned": { "mime_type": "image/png", "data": "base64..." },
  "overlay": { "mime_type": "image/png", "data": "base64..." },
  "mask": { "mime_type": "image/png", "data": "base64..." },
  "diff_rects": [{ "x": 100, "y": 80, "width": 40, "height": 20, "area": 800 }],
  "diff_pixels": 1234,
  "diff_ratio": 0.00257,
  "diff_threshold": 0.1,
  "conversion_warnings": []
}`}
          notes="AIや外部アプリが最初に使う中心API。result_idが返り、localhost/127.0.0.1で呼ばれた場合は、成功後にWebアプリも http://127.0.0.1:8078/?result_id=... 形式で自動表示する。巨大ペアがキャッシュ上限を超える場合、result_idはnull。差分の可視化はoverlay、二値的な差分抽出はmask、機械判定はdiff_ratioとdiff_rectsを見る。"
        />

        <ApiEndpoint
          method="GET"
          path="/api/diff/{result_id}"
          purpose="/api/diffで作成済みの短期キャッシュ結果を取得し、外部アプリからWeb画面表示へつなぐ。"
          request={`Query:
diff_threshold: 0.0から1.0の差分しきい値。省略時0.1`}
          response="/api/diff と同じ DiffResponse。"
          notes="外部アプリは /api/diff 成功後に http://127.0.0.1:8078/?result_id=cache-id を開くと、このエンドポイント経由でWebアプリが結果を表示する。"
        />

        <ApiEndpoint
          method="POST"
          path="/api/rediff"
          purpose="位置合わせ済みの比較結果に対して、しきい値だけを変えて差分を再計算する。再アップロードや再位置合わせを避けるために使う。"
          request={`Content-Type: application/json
{
  "result_id": "/api/diffで返ったID",
  "diff_threshold": 0.4
}

cacheが失効した場合のfallback:
{
  "image_a": { "mime_type": "image/png", "data": "base64..." },
  "image_b_aligned": { "mime_type": "image/png", "data": "base64..." },
  "diff_threshold": 0.4
}`}
          response={`{
  "result_id": "cache-id",
  "overlay": { "mime_type": "image/png", "data": "base64..." },
  "mask": { "mime_type": "image/png", "data": "base64..." },
  "diff_rects": [],
  "diff_pixels": 0,
  "diff_ratio": 0,
  "diff_threshold": 0.4
}`}
          notes="404 Diff result cache expired が返った場合はfallback形式でimage_aとimage_b_alignedを送る。"
        />

        <ApiEndpoint
          method="POST"
          path="/api/attachments"
          purpose="クリップボード由来などの一時画像をバックエンド側に保存する。比較そのものには必須ではない。"
          request={`Content-Type: multipart/form-data
file: 保存したい添付ファイル`}
          response={`{
  "filename": "clipboard.png",
  "stored_as": "generated-name.png",
  "size": 12345,
  "retention_days": 3,
  "deleted_expired": 0
}`}
          notes="保存ファイルは保持期限後にcleanup対象になる。外部アプリが一時添付の追跡をしたい場合に使う。"
        />

        <ApiEndpoint
          method="POST"
          path="/api/git/images"
          purpose="互換用API。指定フォルダのGit差分から変更画像を一覧する。"
          request={`Content-Type: application/json
{ "folder": "/absolute/path/to/repo/or/subfolder" }`}
          response={`{
  "folder": "/absolute/path/to/repo",
  "repo_root": "/absolute/path/to/repo",
  "files": [
    {
      "path": "new.png",
      "head_path": "old.png",
      "status": "R",
      "comparable": true,
      "reason": null
    }
  ]
}`}
          notes="追加・削除など両側がそろわない画像はcomparable=falseになる。新しいUIでは画像とテキストを扱う/api/git/filesを使用する。"
        />

        <ApiEndpoint
          method="GET"
          path="/api/settings/obsidian"
          purpose="サーバーに保存されているObsidianフォルダーとレポート保存先を取得する。"
          request="リクエストボディなし。"
          response={`{
  "obsidian_folder": "/absolute/path/to/obsidian-vault",
  "obsidian_report_folder": "/absolute/path/to/report-folder"
}`}
          notes="設定はブラウザではなくBackendの設定ファイルに保存される。未設定時は空文字列。"
        />

        <ApiEndpoint
          method="PUT"
          path="/api/settings/obsidian"
          purpose="Obsidianフォルダーとレポート保存先を検証してサーバーへ保存する。"
          request={`Content-Type: application/json
{
  "obsidian_folder": "/absolute/path/to/obsidian-vault",
  "obsidian_report_folder": "/absolute/path/to/report-folder"
}`}
          response={`{
  "obsidian_folder": "/absolute/path/to/obsidian-vault",
  "obsidian_report_folder": "/absolute/path/to/report-folder"
}`}
          notes="空文字列を送ると設定を解除する。省略した項目は既存値を維持する。存在しないパスやファイルを指定した場合は422。"
        />

        <ApiEndpoint
          method="POST"
          path="/api/reports/save"
          purpose="自己完結HTMLレポートをサーバー上のObsidianレポート保存先へ保存する。"
          request={`Content-Type: application/json
{
  "filename": "note_変更差分レポート.html",
  "html": "<!doctype html>..."
}`}
          response={`{
  "filename": "note_変更差分レポート.html",
  "path": "/absolute/path/to/report-folder/note_変更差分レポート.html"
}`}
          notes="保存先は /api/settings/obsidian の obsidian_report_folder だけを使用し、リクエストからは変更できない。設定がない場合、Frontendはブラウザダウンロードへフォールバックする。上限は50MB。"
        />

        <ApiEndpoint
          method="POST"
          path="/api/git/files"
          purpose="設定された拡張子に従い、変更画像と変更テキストを追加・削除・未追跡も含めて一覧する。"
          request={`Content-Type: application/json
{ "folder": "/absolute/path/to/repo", "text_extensions": [".md", ".txt"] }`}
          response={`{
  "repo_root": "/absolute/path/to/repo",
  "files": [{
    "path": "guide.md", "head_path": "guide.md", "kind": "text",
    "change_type": "modified", "has_head": true, "has_current": true,
    "diffable": true, "comparable": true
  }]
}`}
          notes="画像拡張子は常に対象。text_extensionsは最大50件で、先頭のドットは省略できる。"
        />

        <ApiEndpoint
          method="POST / GET"
          path="/api/git/markdown"
          purpose="Obsidianの現在Markdownノートを起点に関連Git差分を取得し、DIFF画面へのリンクを返す。"
          request={`POST JSON:
{ "markdown_path": "/absolute/path/to/note.md", "text_extensions": [".md", ".txt"] }

GET:
/api/git/markdown?path=%2Fabsolute%2Fpath%2Fto%2Fnote.md`}
          response={`{
  "source_markdown": "/absolute/path/to/note.md",
  "files": [{ "path": "assets/diagram.svg", "kind": "image" }],
  "diff_url": "/?markdown_path=%2Fabsolute%2Fpath%2Fto%2Fnote.md"
}`}
          notes="Obsidianの右クリックメニューはdiff_urlを開く。Web UIはMarkdown本文と、リンクを再帰的にたどった変更画像・図面を表示する。"
        />

        <ApiEndpoint
          method="POST"
          path="/api/git/item"
          purpose="Git変更ファイルのHEAD側と作業フォルダ側を取得する。テキストでは左右差分行、画像ではPNGプレビューを返す。"
          request={`Content-Type: application/json
{
  "folder": "/absolute/path/to/repo", "path": "guide.md", "head_path": "guide.md",
  "kind": "text", "has_head": true, "has_current": true,
  "text_extensions": [".md", ".txt"]
}`}
          response="テキストはtext_head、text_current、rows。画像はimage_head、image_currentを返す。"
          notes="テキストはUTF-8/CP932を読み取り、5 MB・30,000行/片側を上限とする。include_text=falseなら全文フィールドを省略できる。バイナリ内容はテキストとして返さない。"
        />

        <ApiEndpoint
          method="POST"
          path="/api/git/revert-line"
          purpose="HTML出力プレビューに表示した変更行を、作業ファイル上でHEADの内容へ1行だけ戻す。"
          request={`Content-Type: application/json
{
  "folder": "/absolute/path/to/repo", "path": "guide.md", "head_path": "guide.md",
  "text_extensions": [".md"],
  "row": { "kind": "replace", "old_index": 3, "new_index": 3, "old": "before", "new": "after" }
}`}
          response={`{ "path": "guide.md", "rows": [/* 更新後の差分行 */] }`}
          notes="作業ファイルを書き換える操作。rowの種類・内容・両側インデックスを現在の差分と厳密照合し、プレビュー後にファイルが変わっていれば409で拒否する。対象は設定済みテキスト拡張子のみ。"
        />

        <ApiEndpoint
          method="POST"
          path="/api/git/diff"
          purpose="git管理下の現在ファイルとHEAD側画像を比較する。リネーム時は現在パスとHEAD側パスを分けて指定する。"
          request={`Content-Type: application/json
{
  "folder": "/absolute/path/to/repo/or/subfolder",
  "path": "current/path.png",
  "head_path": "head/path.png",
  "category": "汎用",
  "diff_threshold": 0.1
}`}
          response="/api/diff と同じ DiffResponse。page_a と page_b は0。"
          notes="pathとhead_pathはリポジトリ相対パス。絶対パスや..を含むパスは拒否される。"
        />

        <ApiEndpoint
          method="POST"
          path="/api/git/text-diff"
          purpose="編集中のテキストとHEAD側の差分行を計算する。作業ファイルは書き換えない。"
          request={`Content-Type: application/json
{
  "folder": "/absolute/path/to/repo", "path": "guide.md", "head_path": "guide.md",
  "has_head": true, "text_extensions": [".md"], "text": "編集後の全文"
}`}
          response={`{ "path": "guide.md", "rows": [/* 差分行 */], "text_current": "編集後の全文" }`}
          notes="Git差分画面で行を編集したときのプレビューに使う。保存は /api/git/save-text で行う。"
        />

        <ApiEndpoint
          method="POST"
          path="/api/git/save-text"
          purpose="編集したテキストを作業ツリーのファイルへ保存する。"
          request={`Content-Type: application/json
{
  "folder": "/absolute/path/to/repo", "path": "guide.md", "head_path": "guide.md",
  "text_extensions": [".md"],
  "base_text": "読み込み時の全文（改行はLF）",
  "text": "保存する全文"
}`}
          response={`{ "path": "guide.md", "text_current": "保存後の全文", "rows": [/* 差分行 */], "encoding_current": "utf-8" }`}
          notes="作業ファイルを書き換える操作。改行コード（CRLF/LF）と文字コード（UTF-8 / BOM付きUTF-8 / CP932）は元ファイルに合わせる。base_textと現在のファイル内容が違う（外部で変更された）場合は409で拒否する。"
        />

        <ApiEndpoint
          method="GET"
          path="/api/3d/status"
          purpose="3D差分（STEP比較）に必要なライブラリが導入済みか確認する。"
          request="リクエストボディなし。"
          response={`{ "available": true, "missing": [], "install_hint": ".venv/bin/python -m pip install -r requirements-3d.txt" }`}
          notes="available=false の場合、3D系のジョブ作成APIは503を返す。"
        />

        <ApiEndpoint
          method="POST"
          path="/api/3d/jobs"
          purpose="新旧2つのSTEPファイルをアップロードし、3D差分ジョブを子プロセスで開始する。"
          request={`Content-Type: multipart/form-data
file_old: 旧版STEP（.step / .stp）
file_new: 新版STEP（.step / .stp）
quality: coarse | standard | fine。省略時 standard
align_mode: auto | none | centroid | fit。省略時 auto
linear_deflection: 任意。メッシュ化精度（mm）`}
          response={`202 Accepted
{ "job_id": "32桁の16進ID", "status": "queued" }`}
          notes="結果は /api/3d/jobs/{job_id} を数百ms間隔で確認し、status が done になったら mesh を取得する。サンプルは GET /api/3d/samples の id を POST /api/3d/samples/load に { sample_id } で渡すと同じ形式で開始できる。"
        />

        <ApiEndpoint
          method="GET"
          path="/api/3d/jobs/{job_id}"
          purpose="3D差分ジョブの進捗・警告・エラー・統計を取得する。"
          request="リクエストボディなし。job_id は作成時に返った32桁の16進ID。"
          response={`{
  "job_id": "...", "status": "running | done | error", "stage": "メッシュの細分化中",
  "progress": 0.35, "warnings": [], "error": null,
  "stats": { "linear_deflection": 0.12, "alignment": { "applied": "identity" }, "old": {}, "new": {} },
  "single_mode": "new | old（片側だけのときのみ）", "retention_minutes": 60
}`}
          notes="結果は保持期間（既定60分）を過ぎると削除される。不要になったら DELETE /api/3d/jobs/{job_id} で即時破棄（実行中なら停止）できる。"
        />

        <ApiEndpoint
          method="GET"
          path="/api/3d/jobs/{job_id}/mesh/{side}"
          purpose="完了ジョブの位置合わせ済みメッシュと各頂点の相手表面までの距離を取得する。"
          request="side は old または new。"
          response={`Content-Type: application/octet-stream（VDM1形式）
"VDM1" + JSONヘッダ長(uint32) + JSONヘッダ + 4バイト境界の埋め
+ 頂点座標 float32×3×N + 面インデックス uint32×3×M + 頂点距離 float32×N（すべてリトルエンディアン）`}
          notes="ジョブが未完了なら409。距離がしきい値を超える頂点が追加（new側）・削除（old側）箇所になる。"
        />

        <ApiEndpoint
          method="POST"
          path="/api/git/3d/jobs"
          purpose="Git管理下のSTEPファイルについて、HEAD側と作業ツリー側を比較する3D差分ジョブを開始する。"
          request={`Content-Type: application/json
{
  "folder": "/absolute/path/to/repo", "path": "models/part.step", "head_path": "models/part.step",
  "has_head": true, "has_current": true, "quality": "standard", "align_mode": "auto"
}`}
          response={`202 Accepted
{ "job_id": "...", "status": "pending" }`}
          notes="片側だけ存在する場合（新規追加・削除）は単体プレビュー用ジョブになり、状態の single_mode が new / old になる。"
        />

        <ApiGuideSection title="外部アプリ向け推奨フロー">
          <ol>
            <li><code>GET /api/health</code> で起動確認をする。</li>
            <li>ユーザーが通常ファイルを比較する場合は、両ファイルに <code>/api/analyze</code> を実行してページ数と警告を取得する。</li>
            <li>必要なら <code>/api/convert</code> でプレビューと <code>regions</code> を取得し、ユーザーが基準領域を選べるようにする。</li>
            <li><code>/api/diff</code> に2ファイル、ページ番号、カテゴリ、しきい値、任意の <code>anchor_region</code> を送る。</li>
            <li>結果表示には <code>image_a</code> と <code>overlay</code> または <code>image_b_aligned</code> を使う。自動判定には <code>diff_ratio</code>, <code>diff_pixels</code>, <code>diff_rects</code> を使う。</li>
            <li>しきい値だけ変更する場合は <code>/api/rediff</code> を使う。</li>
          </ol>
        </ApiGuideSection>
      </section>
      {helpOpen && <ShortcutHelp page="api" onClose={() => setHelpOpen(false)} />}
    </main>
  );
}

function ApiGuideSection({ title, children }) {
  return (
    <section className="api-guide-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function ApiEndpoint({ method, path, purpose, request, response, notes }) {
  return (
    <section className="api-endpoint">
      <div className="api-endpoint-title">
        <span className="api-method">{method}</span>
        <code>{path}</code>
      </div>
      <p>{purpose}</p>
      <h3>Request</h3>
      <pre>{request}</pre>
      <h3>Response</h3>
      <pre>{response}</pre>
      <h3>Notes for AI clients</h3>
      <p>{notes}</p>
    </section>
  );
}
