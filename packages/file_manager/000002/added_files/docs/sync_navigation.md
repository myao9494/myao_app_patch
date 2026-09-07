# 左右ペイン同期移動仕様書 (Synchronized Browsing)

## 概要
2ペイン構成（左ペインと中央ペイン）において、一方のペインでフォルダを移動した際に、もう一方のペインも連動して対応するフォルダへ移動する同期ブラウジング機能です。バックアップ元とバックアップ先の比較や、同一階層構造を持つフォルダ間の並行操作を効率化します。

---

## 主な機能

1. **同期移動モードのON/OFF切り替え**:
   - ヘッダー内の「同期移動」ボタンをクリック、またはショートカットキー `Alt + S` で切り替え。
   - 有効時はボタンがハイライト表示（青色背景）され、状態は `localStorage`（`file_manager_sync_navigation`）に永続化。

2. **高度なパス同期ロジック (`resolveSyncedPath`)**:
   - **同一パス同期**: 左右が同じディレクトリにいる場合、移動先パスがそのまま相手ペインにも適用されます。
   - **親フォルダ移動の同期**: 一方が親フォルダ（`..`）に移動した際、もう一方も自身の親フォルダに移動します。
   - **サブフォルダ移動の同期**: 一方がサブフォルダ `XYZ` に入った際、もう一方の配下に同名フォルダ `XYZ` が存在すれば自動移動します。
   - **無限ループ防止**: 同期反映中の再帰的トリガーを防ぐセーフティガード（`isSyncingRef`）を内蔵。

3. **左右パスの一発同期ボタン**:
   - 同期移動ボタンの隣にある「左右パス同期」ボタン（`ArrowRightLeft` アイコン）をクリックすると、右ペインが即座に左ペインと同一パスに設定されます。

---

## 動作構成図（Excalidraw形式）

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "https://excalidraw.com",
  "elements": [
    {
      "type": "rectangle",
      "id": "pane-left",
      "x": 80,
      "y": 80,
      "width": 240,
      "height": 140,
      "strokeColor": "#3b82f6",
      "backgroundColor": "#eff6ff",
      "fillStyle": "solid",
      "strokeWidth": 2
    },
    {
      "type": "text",
      "id": "pane-left-text",
      "x": 95,
      "y": 95,
      "text": "【左ペイン (Left)】\nPath: /source/dir/subA\n\n・サブフォルダへ入る\n・親階層へ戻る\n・履歴で移動",
      "fontSize": 13
    },
    {
      "type": "rectangle",
      "id": "sync-controller",
      "x": 380,
      "y": 100,
      "width": 180,
      "height": 100,
      "strokeColor": "#f59e0b",
      "backgroundColor": "#fffbeb",
      "fillStyle": "solid",
      "strokeWidth": 2
    },
    {
      "type": "text",
      "id": "sync-controller-text",
      "x": 395,
      "y": 115,
      "text": "【同期コントローラ】\n・Alt+S でON/OFF\n・相対パス計算\n・ループ防止ガード",
      "fontSize": 13
    },
    {
      "type": "rectangle",
      "id": "pane-center",
      "x": 620,
      "y": 80,
      "width": 240,
      "height": 140,
      "strokeColor": "#10b981",
      "backgroundColor": "#ecfdf5",
      "fillStyle": "solid",
      "strokeWidth": 2
    },
    {
      "type": "text",
      "id": "pane-center-text",
      "x": 635,
      "y": 95,
      "text": "【中央/右ペイン (Center)】\nPath: /backup/dir/subA\n\n・左の移動に自動追従\n・同名フォルダへ連動移動",
      "fontSize": 13
    },
    {
      "type": "arrow",
      "id": "arrow-sync-1",
      "x": 320,
      "y": 150,
      "width": 60,
      "height": 0,
      "strokeColor": "#64748b"
    },
    {
      "type": "arrow",
      "id": "arrow-sync-2",
      "x": 560,
      "y": 150,
      "width": 60,
      "height": 0,
      "strokeColor": "#64748b"
    }
  ]
}
```
