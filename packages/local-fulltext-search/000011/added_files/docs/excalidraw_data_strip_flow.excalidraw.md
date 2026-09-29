<!--
/**
 * AIインプット用 Markdownエクスポートにおける Excalidraw Data 除去フロー図
 *
 * 1. Markdownノートのパース & 分離
 *    - ユーザーが選択した各ノートから本文とExcalidraw内部データを分離
 * 2. # Excalidraw Data 以降（テキスト要素・描画バイナリ・compressed-json）の完全切捨
 *    - AIにとって解釈不能な文字列・圧縮テキストを排除し、トークン消費を大幅節約
 * 3. 手前の本文・見出し・画像リンク記法（![[...]）の完全保護
 *    - Obsidianコピペ互換性を保証
 * 4. 全図面の高解像度結合画像（.png/.jpg）への集約
 *    - 図面実体は画像側で視覚的にAIへインプット
 **/
-->
# AIインプット Markdownエクスポート Excalidraw Data 完全除去フロー

```mermaid
flowchart TD
    RawNote["選択されたMarkdownノート (.md / .excalidraw.md)"] --> CheckContent{"# Excalidraw Data を含むか？"}
    
    subgraph ExcalidrawStrip["Excalidraw Data 切捨処理 (strip_excalidraw_data)"]
        Split["見出し # Excalidraw Data でテキストを前後分割"]
        Discard["# Excalidraw Data 以降を完全破棄\n(## Text Elements, ## Drawing, compressed-json)"]
        KeepPre["# Excalidraw Data より前の本文を維持\n(見出し, 通常文章, リスト, テーブル, コード)"]
        Split --> Discard
        Split --> KeepPre
    end
    
    CheckContent -- "含む" --> Split
    CheckContent -- "含まない" --> NormalClean["通常の本文整形 (DataviewJS注釈化等)"]
    
    KeepPre --> LinkKeep["生リンク記法 (![[...]]) を維持して Obsidian 貼り付け互換性を担保"]
    NormalClean --> LinkKeep
    
    LinkKeep --> MdOutput["統合Markdownファイル (〇〇_context.md) に出力\n【AIにとって可読・高品質・最小トークン】"]
    
    RawNote -. "図面リンク・データ抽出" .-> ImgRender["元データから直接高精細ベクターSVGを生成・ラスタライズ"]
    ImgRender --> ImgOutput["結合画像ファイル (〇〇_images.png / .jpg) に縦連結\n【視覚情報としてAIに添付提供】"]
    
    MdOutput --> AiInput["社内AIチャットへの同時インプット\n(テキスト + 結合画像)"]
    ImgOutput --> AiInput
```
