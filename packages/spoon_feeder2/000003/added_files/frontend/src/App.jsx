/**
 * Spoonfeeder2 フロントエンドのルート (App.jsx)
 *
 * 仕様:
 * 1. /map では依存関係マップ画面、それ以外ではメイン画面を表示する。
 * 2. 画面本体は pages/、描画部品は components/、状態と副作用は hooks/、純粋ロジックは lib/ にある。
 **/

import { DependencyMap } from './pages/DependencyMap';
import { MainPage } from './pages/MainPage';

export default function App() { return location.pathname === '/map' ? <DependencyMap/> : <MainPage/>; }
