/**
 * ベクトル管理画面（ベクトル検索の設定とインデックスの保守）。
 *
 * - 稼働状況の表示（VectorStatusHeader）: 推論に使う装置、検索エンジン、読み込み中のモデル。
 * - Embedding モデルの選択と読み込み（VectorModelPanel）: 軽量 ruri-v3-30m / 標準 ruri-v3-310m。
 *   モデルごとにインデックスは別の DB に保存され、件数と容量をバッジで表示する。
 * - インデックスの管理（VectorIndexPanel）: 差分更新と全件再作成、進捗と完了結果の表示。
 * - 単一ファイル差分更新ベンチマーク（VectorBenchmarkPanel）。
 *
 * 類似語・専門用語は「検索ルール管理」で一元管理する（この画面には編集機能を置かない）。
 * 状態と操作は hooks/useVectorManagement.ts が持つ。
 */
import { useVectorManagement } from "../hooks/useVectorManagement";
import { VectorBenchmarkPanel } from "./vectorManagement/VectorBenchmarkPanel";
import { VectorIndexPanel } from "./vectorManagement/VectorIndexPanel";
import { VectorModelPanel } from "./vectorManagement/VectorModelPanel";
import { VectorStatusHeader } from "./vectorManagement/VectorStatusHeader";

export function VectorManagementPage({ confirmIndexDeletion }: { confirmIndexDeletion?: boolean } = {}) {
  const vector = useVectorManagement({ confirmIndexDeletion });

  return (
    <div className="vector-management-container" style={{ padding: "16px 20px" }}>
      {/* ヘッダー */}
      <VectorStatusHeader vector={vector} />

      {/* 1. Embedding モデル設定 & 個別インデックス状況 */}
      <VectorModelPanel vector={vector} />

      {/* 2. インデックス管理 & 進捗サマリー */}
      <VectorIndexPanel vector={vector} />

      {/* 3. 単一ファイル差分更新ベンチマークパネル */}
      <VectorBenchmarkPanel vector={vector} />
    </div>
  );
}
