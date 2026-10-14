# Obsidian Excalidraw 互換性メンテナンス用プロンプト

Obsidianプラグインの仕様変更や新しい要素の追加により、ファイルの保存形式に互換性の問題（文字化け、リンク切れ、フォーマット差異など）が発生した場合、以下のプロンプトをAIアシスタント（Agent）に入力して修正を依頼してください。

---

## 依頼: Obsidian Excalidraw互換性の修正と維持

**目的**:
このアプリケーションとObsidian Excalidrawプラグイン間の完全なファイル互換性を回復させてください。

**状況**:
アプリで保存した `.excalidraw.md` ファイルが、Obsidianで正しく表示されない、またはObsidianで保存したファイルの形式と差異が発生しています。

**関連ファイル**:
- `backend/obsidian_markdown.py`: Markdown の解析・生成（`extract_json_from_markdown`、`embed_json_into_markdown`）。
- `backend/obsidian_files.py`: 埋め込み画像の解決・書き出し（`resolve_embedded_file_path`、`export_embedded_images`）。
- `backend/main.py`: 保存(`save_file`)・読み込み(`load_file`)の API。
- `tests/obsidian_test/`・`tests/test_api_integration.py`: Obsidian で作成した実ノートと往復テスト。
- 検証用ファイル（例）:
    - 正解データ（Obsidian保存）: `/Users/sudoupousei/000_work/obsidian-dagnetz/tests/元/test_data/draw_file_manager.excalidraw.md`
    - 現在のデータ（アプリ保存）: `/Users/sudoupousei/000_work/obsidian-dagnetz/tests/test_data/draw_file_manager.excalidraw.md`

**過去の修正ナレッジ（回帰テスト用）**:
以下の機能が以前の実装で修正されています。今回の変更でこれらが壊れていないか、特に注意して確認してください。

1. **絵文字・サロゲートペアの圧縮**:
   - **問題**: PythonのLZStringライブラリがUTF-16サロゲートペアを正しく扱えず、絵文字（例: `🌐`）が文字化けする。
   - **正しい挙動**: JSと同様にUTF-16コードユニットに変換してから圧縮すること（`convert_to_utf16_surrogates`関数の使用）。

2. **テキスト要素の改行維持**:
   - **問題**: Markdownの `## Text Elements` セクション生成時に改行が削除されてしまう。
   - **正しい挙動**: 改行を維持し、Obsidianのフォーマット（行末のID付与など）に従うこと。

3. **画像リンクとパスの維持**:
   - **問題**: 保存時に画像が新しいファイル名で複製されたり、リンクが切れたりする。
   - **正しい挙動**:
     - `save_file` 実行時にまず既存のMarkdownを読み込み、`## Embedded Files` セクションのリンク（例: `[[assets/img.png]]`）を解析する。
     - 既存の画像IDがあれば、そのリンク先のパスに上書き保存し、Markdown上のリンク記述を変更しない。
     - 画像読み込み時は `.obsidian` フォルダ（Vaultルート）を探索し、相対パスを解決する。

**具体的作業手順（エージェントへの指示）**:

1. **現状の差異を確認する**:
   以下のスクリプトを作成・実行し、正解データと現在の保存データを比較して、どの部分（JSON構造、Text Elements、Embedded Files）が異なっているか特定してください。

   ```python:tests/compare_excalidraw.py
   import sys
   import os
   import json
   import re
   from pathlib import Path
   import difflib

   # backendモジュールをインポートできるようにする
   sys.path.append(os.path.join(os.getcwd(), 'backend'))
   from main import extract_json_from_markdown

   def compare_files():
       # 適宜パスを修正してください
       file_orig = Path('/Users/sudoupousei/000_work/obsidian-dagnetz/tests/元/test_data/draw_file_manager.excalidraw.md')
       file_curr = Path('/Users/sudoupousei/000_work/obsidian-dagnetz/tests/test_data/draw_file_manager.excalidraw.md')

       print(f"Comparing:\\nOriginal: {file_orig}\\nCurrent : {file_curr}")

       if not file_curr.exists():
           print("Error: Current file does not exist.")
           return

       with open(file_orig, 'r', encoding='utf-8') as f: content_orig = f.read()
       with open(file_curr, 'r', encoding='utf-8') as f: content_curr = f.read()

       def get_section(content, section_name):
           pattern = fr'## {section_name}\\n(.*?)(?=\\n##|%%|\\Z)'
           match = re.search(pattern, content, re.DOTALL)
           return match.group(1).strip() if match else ""

       print("\\n--- Text Elements Diff ---")
       text_orig = get_section(content_orig, "Text Elements")
       text_curr = get_section(content_curr, "Text Elements")
       if text_orig == text_curr: print("MATCH")
       else:
           for line in difflib.unified_diff(text_orig.splitlines(), text_curr.splitlines(), fromfile='Orig', tofile='Curr'):
               print(line)

       print("\\n--- Embedded Files Diff ---")
       embed_orig = get_section(content_orig, "Embedded Files")
       embed_curr = get_section(content_curr, "Embedded Files")
       # 空白正規化して比較
       if "".join(embed_orig.split()) == "".join(embed_curr.split()): print("MATCH")
       else:
           print(f"Orig:\\n{embed_orig}\\nCurr:\\n{embed_curr}")

       print("\\n--- JSON Element Diff ---")
       try:
           json_orig = json.loads(extract_json_from_markdown(content_orig))
           json_curr = json.loads(extract_json_from_markdown(content_curr))
           els_orig = json_orig.get('elements', [])
           els_curr = json_curr.get('elements', [])
           print(f"Count: Orig={len(els_orig)}, Curr={len(els_curr)}")
           
           # テキスト内容のチェック
           for eo, ec in zip(els_orig, els_curr):
               if eo.get('type') == 'text' and eo.get('text') != ec.get('text'):
                   print(f"Text Mismatch {eo.get('id')}: {eo.get('text')} != {ec.get('text')}")
       except Exception as e:
           print(f"JSON Error: {e}")

   if __name__ == "__main__":
       compare_files()
   ```

2. **修正を実装する**:
   差異の原因となっている `backend/obsidian_markdown.py`・`backend/obsidian_files.py` のロジックを修正してください。特に `embed_json_into_markdown` や `export_embedded_images` が対象です。

3. **検証する**:
   再度上記のスクリプトを実行し、`--- Text Elements Diff ---` や `--- JSON Element Diff ---` が "MATCH" になること、およびゴミ文字（文字化け）が発生していないことを確認してください。
