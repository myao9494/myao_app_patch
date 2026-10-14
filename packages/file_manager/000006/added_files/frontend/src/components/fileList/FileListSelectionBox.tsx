/**
 * 範囲選択（ラバーバンド選択）中の矩形。状態は useDragSelect が持つ
 */
import { boxRect, type Box } from "./useDragSelect";

export function SelectionBox({ box }: { box: Box | null }) {
  if (!box) return null;
  return <div className="selection-box" style={boxRect(box)} />;
}
