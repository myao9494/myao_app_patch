# マーカーとアンダーラインの設定機能仕様書

ヘッダーメニューの専用ボタンまたはショートカットキー **「,（カンマ）」** により、マーカーおよびアンダーラインの描画色、透明度、線の太さを直感的にカスタマイズできる機能です。

---

## 1. 概要

- **ショートカットキー**: `,`（カンマ）
  - `<input>` や `<textarea>` 等の文字入力中を除き、`,` キーを押下することで設定パネルを即座に開閉（トグル）できます。
- **ヘッダーボタン**: 上部左側のアクションメニュー内「新規作成」ボタンの右隣に配置（「マーカーとアンダーラインの設定」）。
- **永続化**: 変更した設定はブラウザの `localStorage`（キー: `excalidraw_annotation_settings`）に即時保存され、次回アクセス時も維持されます。

---

## 2. 設定項目

### 2.1 マーカー設定 (Marker Settings)
ショートカットキー **`M`** を押した時のハイライト描画に連動します。

- **ハイライト色 (`color`)**:
  - プリセットパレット: イエロー (`#fef08a`)、グリーン (`#bbf7d0`)、ブルー (`#bae6fd`)、ピンク (`#fecdd3`)、オレンジ (`#fed7aa`)
  - カスタムカラーピッカー: 自由なカラーコードを選択可能。
  - 初期値: `#fef08a`
- **不透明度 (`opacity`)**:
  - `10%` 〜 `100%`（スライダー、5%刻み）
  - 初期値: `50%`

### 2.2 アンダーライン設定 (Underline Settings)
ショートカットキー **`U`** を押した時の赤色等下線描画に連動します。

- **下線の色 (`color`)**:
  - プリセットパレット: レッド (`#e03131`)、ブルー (`#1971c2`)、グリーン (`#2f9e44`)、オレンジ (`#f08c00`)、ブラック (`#1e1e1e`)
  - カスタムカラーピッカー: 自由なカラーコードを選択可能。
  - 初期値: `#e03131`
- **線の太さ (`strokeWidth`)**:
  - 選択ボタン: `1px`（細い）、`2px`（普通）、`3px`（太い）、`4px`（極太）
  - 初期値: `2px`
- **不透明度 (`opacity`)**:
  - `10%` 〜 `100%`（スライダー、5%刻み）
  - 初期値: `100%`

---

## 3. ヘッダーボタンの構成変更

不要となった「ファイルを開く（`[->`）」および「フォルダを表示（フォルダアイコン）」をヘッダーから削除し、以下の構成に整理されました。

1. `+`: 新規作成
2. **マーカーとアンダーラインの設定（ショートカット: `,`）**（★新規追加）
3. フォルダを開く（Finder/Explorer）
4. codeで開く（VS Code）
5. 手動保存（強制バックアップ）
6. SVGで保存

---

## 4. ファイル構成

| ファイル | 役割 |
|---|---|
| [`utils/annotationSettings.ts`](file:///Users/mine/000_work/app/excalidraw_myao9494/utils/annotationSettings.ts) | 設定のデータ型定義、localStorage連携・フォールバック |
| [`utils/annotationSettings.test.ts`](file:///Users/mine/000_work/app/excalidraw_myao9494/utils/annotationSettings.test.ts) | 設定管理の単体テスト |
| [`components/AnnotationSettingsModal.tsx`](file:///Users/mine/000_work/app/excalidraw_myao9494/components/AnnotationSettingsModal.tsx) | 設定パネルモーダルコンポーネント |
| [`components/ExampleApp.tsx`](file:///Users/mine/000_work/app/excalidraw_myao9494/components/ExampleApp.tsx) | ヘッダーボタン配置、モーダル連携 |
| [`hooks/useKeyboardShortcuts.ts`](file:///Users/mine/000_work/app/excalidraw_myao9494/hooks/useKeyboardShortcuts.ts) | カンマ（,）ショートカットハンドラ、設定値のM/Uキー反映 |
| [`docs/annotation_settings.excalidraw`](file:///Users/mine/000_work/app/excalidraw_myao9494/docs/annotation_settings.excalidraw) | 設定機能のExcalidraw図解 |
