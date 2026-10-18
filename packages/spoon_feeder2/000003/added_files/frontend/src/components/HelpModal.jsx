/**
 * ショートカットと設定の説明モーダル (HelpModal.jsx)
 **/

import { X } from 'lucide-react';

export function HelpModal({ open, close }) {
  if (!open) return null;
  return <div className="modal-layer" onMouseDown={close}><div className="modal help-modal" onMouseDown={event => event.stopPropagation()}>
    <header><div><span className="eyebrow">SHORTCUTS & SETTINGS</span><h3>ショートカットと設定</h3></div><button className="icon-button" onClick={close}><X/></button></header>
    <div className="help-grid">
      <section><h4>ショートカット</h4><dl><div><dt><kbd>I</kbd></dt><dd>無視リスト編集モーダルを開く</dd></div><div><dt><kbd>H</kbd></dt><dd>この説明を開く／閉じる</dd></div><div><dt><kbd>Ctrl</kbd> + <kbd>S</kbd></dt><dd>編集中の無視リストを保存して閉じる</dd></div><div><dt><kbd>Esc</kbd></dt><dd>保存せずにモーダルを閉じる</dd></div><div><dt><kbd>Ctrl</kbd> + <kbd>Z</kbd></dt><dd>無視リスト編集中の変更を戻す</dd></div><div><dt><kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>Z</kbd></dt><dd>戻した変更を進める</dd></div></dl></section>
      <section><h4>ハンバーガーメニュー</h4><dl><div><dt>ignored項目を表示</dt><dd>無視対象の入口を取り消し線で表示します。</dd></div><div><dt>無視リストを編集</dt><dd>1行1パターンで編集し、リポジトリの設定ファイルへ保存します。</dd></div><div><dt>Python実行モード</dt><dd>通常版はvenvと環境変数から参照ソースも自動検出します。Embedded版では参照リポジトリ機能を無効にします。</dd></div><div><dt>Git差分コマンド</dt><dd>クリップボードへ格納する差分を取得するコマンドを指定します（デフォルト: git diff HEAD -- *.py）。</dd></div><div><dt>対象リポジトリを追加</dt><dd>ファイルの右クリックから、未解決モジュールと外部ソースリポジトリを手動で対応付けます。</dd></div></dl></section>
    </div>
    <p className="help-note">入力欄やターミナルにカーソルがある間は、I/Hを通常の入力として扱います。</p>
  </div></div>;
}
