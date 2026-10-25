/**
 * Hキーで開くショートカット・操作ヘルプ。
 */
import React, { useEffect, useState } from "react";
import { HelpCircle } from "lucide-react";
import { isTypingTarget } from "../lib/util.js";

export function useShortcutHelp() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const handleHelpShortcut = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        return;
      }
      if (isTypingTarget(event.target) || event.key.toLowerCase() !== "h") return;
      event.preventDefault();
      setOpen((current) => !current);
    };
    window.addEventListener("keydown", handleHelpShortcut);
    return () => window.removeEventListener("keydown", handleHelpShortcut);
  }, []);
  return [open, setOpen];
}

export function ShortcutHelp({ page, onClose }) {
  const content = page === "memo" ? {
    title: "画像メモのショートカット",
    shortcuts: [
      ["← / →", "前後の画像へ移動（Git差分から開いた場合）"],
      ["T", "メモを追加"], ["L", "選択メモへラインを追加"], ["N", "付箋を追加"],
      ["A", "ドラッグした起点から終点へ矢印を追加"], ["C", "変更雲"], ["R / 2", "矩形"],
      ["O / 4", "楕円"], ["M", "マーカー"], ["Ctrl/Cmd+Z", "元に戻す"],
      ["Ctrl/Cmd+Shift+Z", "やり直す"], ["Delete", "選択中の図形を削除"],
      ["H", "このヘルプの表示／非表示"], ["Esc", "テキスト編集／ヘルプを閉じる"],
    ],
    settings: [
      "画像内のメモ本文: ダブルクリックで文字編集になります。上部の本文欄はクリックで編集でき、Escまたは図形選択で編集を終了します。",
      "図形: クリックで水色の選択枠を表示します。選択後はDelete／Backspaceで削除できます。",
      "Git対象拡張子: git差分でテキストとして扱う形式を設定します。画像形式は常に対象です。",
      "Obsidianフォルダー: Markdownリンクの解決元です。",
      "レポート保存先: 出力HTMLをサーバー側で保存するフォルダーです。",
      "表示倍率: アプリ全体のUI倍率です。画像メモの表示サイズとは別です。",
    ],
  } : page === "git" ? {
    title: "git差分のショートカット",
    shortcuts: [
      ["← / →", "前後の変更ファイルへ移動"], ["1〜4", "表示を切替（元画像／補正B／差分／マスク）"], ["Tab", "補正Bと差分表示を切替"],
      ["] / [", "次／前の変更箇所へ移動"], ["Esc", "変更箇所の強調を解除"], ["F / W", "全体を表示／幅に合わせる"], ["I", "右パネルの表示切替"],
      ["Ctrl/Cmd+S", "テキストの編集を保存"], ["Ctrl/Cmd+Z", "テキストの編集を元に戻す"], ["変更行の→", "HEAD側の内容に戻す（テキスト）"], ["H", "このヘルプ"],
    ],
    settings: [
      "Git対象拡張子: 一覧・HTMLレポートに含めるテキスト形式を設定します。",
      "Obsidianフォルダー: Markdownから関連ファイルをたどる基準です。",
      "レポート保存先: プレビュー調整後のHTML保存先です。未設定時はダウンロードします。",
      "表示倍率: git差分画面全体を50〜200%で表示します。",
    ],
  } : page === "report" ? {
    title: "HTML出力プレビューの操作",
    shortcuts: [["H", "このヘルプ"]],
    settings: [
      "カード見出しをドラッグするか、↑／↓ボタンで出力順を変更します。",
      "画像はドラッグ／2本指スワイプで移動し、ピンチで拡大・縮小します。右下ハンドルでカードをリサイズできます。",
      "領域指定ボタンで出力範囲を選びます。未指定の場合は現在表示中の範囲を出力します。",
      "テキスト差分の戻すボタンは作業ファイルを1行だけ変更前へ戻します。ファイルがプレビュー後に変わった場合は安全のため拒否します。",
      "メモ編集で詳細を直した後は、「戻る」ボタンでHTML出力プレビューへ戻れます。",
    ],
  } : page === "api" ? {
    title: "API説明ページのショートカット",
    shortcuts: [["H", "このヘルプ"], ["Ctrl/Cmd+F", "ブラウザ内検索"]],
    settings: ["このページには固有設定がありません。設定は差分画面のハンバーガーメニューから変更できます。"],
  } : {
    title: "ファイル差分のショートカット",
    shortcuts: [
      ["Ctrl/Cmd+V", "選択中の枠（A / B）へ画像を貼り付け"], ["1〜4", "表示を切替（元画像／補正B／差分／マスク）"], ["Tab", "補正Bと差分表示を切替"],
      ["] / [", "次／前の変更箇所へ移動"], ["Esc", "変更箇所の強調を解除"], ["F / W", "全体を表示／幅に合わせる"], ["I", "右パネルの表示切替"],
      ["Ctrl/Cmd/Alt+ホイール", "画像を拡大・縮小"], ["H", "このヘルプ"],
    ],
    settings: [
      "Git対象拡張子: git差分モードで扱うテキスト形式です。",
      "Obsidianフォルダー／レポート保存先: Markdown連携とHTML保存に使います。",
      "表示倍率: アプリ全体のUI倍率です。画像の拡大率とは別です。",
    ],
  };
  return (
    <div className="shortcut-help-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="shortcut-help-modal" role="dialog" aria-modal="true" aria-labelledby="shortcut-help-title">
        <header><div><HelpCircle size={22} /><h2 id="shortcut-help-title">{content.title}</h2></div><button type="button" onClick={onClose} aria-label="閉じる">×</button></header>
        <div className="shortcut-help-body">
          <h3>ショートカット</h3>
          <dl>{content.shortcuts.map(([key, label]) => <div key={key}><dt><kbd>{key}</kbd></dt><dd>{label}</dd></div>)}</dl>
          <h3>設定と操作</h3>
          <ul>{content.settings.map((setting) => <li key={setting}>{setting}</li>)}</ul>
        </div>
      </section>
    </div>
  );
}
