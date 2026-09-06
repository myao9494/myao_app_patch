/**
 * ショートカット一覧の定義および検索・フィルタユーティリティ
 * 
 * 仕様:
 * 1. SHORTCUT_CATEGORIES: カテゴリ定義（すべて、独自機能、描画ツール、編集・操作）
 * 2. SHORTCUT_LIST: アプリ独自ショートカットおよびExcalidraw主要ショートカットの一覧定義
 * 3. filterShortcuts: カテゴリおよびキーワード（部分一致・大小無視）による絞り込み関数
 **/

export type ShortcutCategory = 'all' | 'custom' | 'tools' | 'edit';

export interface CategoryInfo {
  id: ShortcutCategory;
  label: string;
  description: string;
}

export interface ShortcutItem {
  key: string;
  description: string;
  category: 'custom' | 'tools' | 'edit';
  detail?: string;
  badge?: string;
}

/** ショートカットのカテゴリ一覧 */
export const SHORTCUT_CATEGORIES: CategoryInfo[] = [
  { id: 'all', label: 'すべて', description: '全ショートカットを表示' },
  { id: 'custom', label: '独自機能', description: '本アプリ独自の拡張ショートカット' },
  { id: 'tools', label: '描画ツール', description: '図形・テキスト等のツール選択' },
  { id: 'edit', label: '編集・操作', description: '配置、保存、グループ化等の操作' },
];

/** ショートカットの一覧データ */
export const SHORTCUT_LIST: ShortcutItem[] = [
  // --- 独自機能 ---
  {
    key: '.',
    description: 'ショートカット一覧ヘルプの表示 / 非表示',
    category: 'custom',
    detail: '本ダイアログを開閉します。',
    badge: '独自',
  },
  {
    key: 'M',
    description: 'マーカー機能（ハイライト）',
    category: 'custom',
    detail: 'テキスト選択時: テキスト下半分に蛍光マーカーを生成してグループ化（トグル解除可）。未選択時: マーカー矩形描画ツールを起動。',
    badge: '独自',
  },
  {
    key: 'U',
    description: 'アンダーライン機能（赤色下線）',
    category: 'custom',
    detail: 'テキスト選択時: 下端に赤色の直線下線を付与（トグル解除可）。未選択時: 赤色直線ツールを起動（文字と重なると自動グループ化）。',
    badge: '独自',
  },
  {
    key: ',',
    description: 'マーカーとアンダーラインの設定パネル',
    category: 'custom',
    detail: 'ハイライト色、下線の色、線の太さ、不透明度を調整する設定パネルを開閉します。',
    badge: '独自',
  },
  {
    key: 'C',
    description: '矢印なしの直線描画',
    category: 'custom',
    detail: '矢印ヘッドのない純粋な直線をすばやく描画するツールに切り替えます。',
    badge: '独自',
  },
  {
    key: 'N',
    description: '基本付箋（Sticky Note）の作成',
    category: 'custom',
    detail: 'マウスカーソル位置に黄色の四角い付箋メモを作成します。',
    badge: '独自',
  },
  {
    key: 'W',
    description: 'クリップボードからリンク付箋を作成',
    category: 'custom',
    detail: 'クリップボード内のURLやテキストを元に、自動でリンク付き付箋を生成します。',
    badge: '独自',
  },
  {
    key: 'Tab',
    description: '選択図形の形状切り替え',
    category: 'custom',
    detail: '選択中の図形の形状を順次変換します（四角形 → ひし形 → 円）。',
    badge: '独自',
  },
  {
    key: 'Cmd / Ctrl + S',
    description: '手動保存（強制バックアップ）',
    category: 'custom',
    detail: '現在の描画内容とファイルをサーバーへ即時保存し、バックアップを更新します。',
    badge: '独自',
  },
  {
    key: 'Cmd / Ctrl + M',
    description: '選択要素を最前面に移動',
    category: 'custom',
    detail: '選択中の要素を重ね順の一番上（最前面）へ移動します。',
    badge: '独自',
  },
  {
    key: 'Cmd / Ctrl + B',
    description: '選択要素を最背面に移動',
    category: 'custom',
    detail: '選択中の要素を重ね順の一番下（最背面）へ移動します。',
    badge: '独自',
  },

  // --- 描画ツール ---
  {
    key: 'V / 1',
    description: '選択ツール',
    category: 'tools',
    detail: '要素の選択、移動、リサイズを行う基本ツール。',
  },
  {
    key: 'R / 2',
    description: '四角形ツール',
    category: 'tools',
    detail: '矩形・長方形を描画します。',
  },
  {
    key: 'D / 3',
    description: 'ひし形ツール',
    category: 'tools',
    detail: 'フローチャート等に用いるひし形を描画します。',
  },
  {
    key: 'O / 4',
    description: '楕円・円ツール',
    category: 'tools',
    detail: '真円または楕円を描画します（Shiftキー併用で正円）。',
  },
  {
    key: 'A / 5',
    description: '矢印ツール',
    category: 'tools',
    detail: '方向を示す矢印線を描画します。',
  },
  {
    key: 'L / 6',
    description: '直線ツール',
    category: 'tools',
    detail: '折れ線や直線を連続描画します。',
  },
  {
    key: 'P / 7',
    description: 'ドロー（フリーハンド）',
    category: 'tools',
    detail: '手書きの線や文字を描画します。',
  },
  {
    key: 'T / 8',
    description: 'テキストツール',
    category: 'tools',
    detail: 'クリックした位置に文字を入力します。',
  },
  {
    key: 'E / 0',
    description: '消しゴムツール',
    category: 'tools',
    detail: 'クリックまたはドラッグして要素を削除します。',
  },
  {
    key: 'H',
    description: '手のひらツール（ハンド / パン）',
    category: 'tools',
    detail: 'ドラッグしてキャンバスを自由にスクロール移動します（Space+ドラッグでも可）。',
  },

  // --- 編集・操作 ---
  {
    key: 'Cmd / Ctrl + Z',
    description: '元に戻す (Undo)',
    category: 'edit',
    detail: '直前の操作を取り消します。',
  },
  {
    key: 'Cmd / Ctrl + Shift + Z',
    description: 'やり直し (Redo)',
    category: 'edit',
    detail: '取り消した操作をやり直します（Cmd/Ctrl+Yも可）。',
  },
  {
    key: 'Cmd / Ctrl + A',
    description: '全選択',
    category: 'edit',
    detail: 'キャンバス上のすべての要素を選択します。',
  },
  {
    key: 'Cmd / Ctrl + C',
    description: 'コピー',
    category: 'edit',
    detail: '選択中の要素をクリップボードにコピーします。',
  },
  {
    key: 'Cmd / Ctrl + V',
    description: '貼り付け',
    category: 'edit',
    detail: 'クリップボードの要素をキャンバスに貼り付けます。',
  },
  {
    key: 'Cmd / Ctrl + D',
    description: '複製 (Duplicate)',
    category: 'edit',
    detail: '選択中の要素をその場で複製します。',
  },
  {
    key: 'Delete / Backspace',
    description: '要素の削除',
    category: 'edit',
    detail: '選択中の要素を削除します。',
  },
  {
    key: 'Cmd / Ctrl + G',
    description: 'グループ化',
    category: 'edit',
    detail: '選択された複数の要素を1つのグループにまとめます。',
  },
  {
    key: 'Cmd / Ctrl + Shift + G',
    description: 'グループ解除',
    category: 'edit',
    detail: '選択されたグループを個別の要素に分解します。',
  },
  {
    key: 'Space + ドラッグ',
    description: 'パン（キャンバス移動）',
    category: 'edit',
    detail: 'キャンバスの表示領域を上下左右にスクロール・移動します。',
  },
  {
    key: '+ / -',
    description: '拡大 / 縮小 (Zoom)',
    category: 'edit',
    detail: 'キャンバスのズーム倍率を変更します（Cmd/Ctrl + マウスホイールも可）。',
  },
  {
    key: 'Esc',
    description: '選択解除 / モーダルを閉じる',
    category: 'edit',
    detail: '現在の選択をクリア、開いているダイアログを閉じます。',
  },
];

/**
 * カテゴリおよび検索文字列に基づいてショートカット一覧をフィルタリングする
 * 
 * @param list - ショートカット一覧データ
 * @param category - 絞り込み対象のカテゴリ ('all' の場合は全カテゴリ)
 * @param query - 検索キーワード（キー名、説明、詳細を対象に部分一致）
 * @returns フィルタリングされたショートカット配列
 */
export function filterShortcuts(
  list: ShortcutItem[],
  category: ShortcutCategory,
  query: string,
): ShortcutItem[] {
  const normalizedQuery = query.trim().toLowerCase();

  return list.filter((item) => {
    // カテゴリ一致判定
    if (category !== 'all' && item.category !== category) {
      return false;
    }

    // 検索クエリ判定
    if (!normalizedQuery) {
      return true;
    }

    const matchKey = item.key.toLowerCase().includes(normalizedQuery);
    const matchDesc = item.description.toLowerCase().includes(normalizedQuery);
    const matchDetail = item.detail ? item.detail.toLowerCase().includes(normalizedQuery) : false;

    return matchKey || matchDesc || matchDetail;
  });
}
