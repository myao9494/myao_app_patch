/**
 * 画面上部のヘッダー (TopBar.jsx)
 *
 * 仕様:
 * 1. ブランド表示、依存関係マップ(別タブ)、無視リスト編集、設定ドロワーを開くボタンを提供する。
 * 2. リポジトリ未選択のときはマップと無視リスト編集を無効にする。
 **/

import { ExternalLink, ListPlus, Map, Menu } from 'lucide-react';

export function TopBar({ path, onOpenMap, onOpenIgnoreEditor, onOpenSettings }) {
  return <header className="topbar"><div className="brand"><div className="logo">S</div><div><h1>Spoonfeeder<span>2</span></h1><p>Repository context workspace</p></div></div><div className="top-actions"><button onClick={onOpenMap} disabled={!path}><Map/>依存関係マップ<ExternalLink/></button><button onClick={onOpenIgnoreEditor} disabled={!path}><ListPlus/>無視リスト編集</button><button className="icon-button" onClick={onOpenSettings}><Menu/></button></div></header>;
}
