/**
 * 3Dメッシュ差分 VDM1バイナリパーサー仕様。
 * バックエンドから取得した ArrayBuffer を解析し、
 * メタデータヘッダ、頂点座標(Float32)、面インデックス(Uint32)、頂点ごとの相手面距離(Float32)を展開する。
 */

export function parseVdm1(arrayBuffer) {
  if (arrayBuffer.byteLength < 8) {
    throw new Error("バイナリデータが短すぎます (VDM1)");
  }
  const dataView = new DataView(arrayBuffer);
  const magic = String.fromCharCode(
    dataView.getUint8(0),
    dataView.getUint8(1),
    dataView.getUint8(2),
    dataView.getUint8(3)
  );
  if (magic !== "VDM1") {
    throw new Error(`不正な3Dメッシュ形式です: ${magic}`);
  }

  const jsonLen = dataView.getUint32(4, true);
  if (8 + jsonLen > arrayBuffer.byteLength) {
    throw new Error("ヘッダー長が不正です");
  }

  const utf8Decoder = new TextDecoder("utf-8");
  const jsonBytes = new Uint8Array(arrayBuffer, 8, jsonLen);
  const header = JSON.parse(utf8Decoder.decode(jsonBytes));

  const padLen = (4 - (jsonLen % 4)) % 4;
  let offset = 8 + jsonLen + padLen;

  const vCount = header.vertex_count;
  const fCount = header.face_count;

  // Float32Array / Uint32Array のバッファビュー生成
  const positions = new Float32Array(arrayBuffer, offset, vCount * 3);
  offset += vCount * 3 * 4;

  const indices = new Uint32Array(arrayBuffer, offset, fCount * 3);
  offset += fCount * 3 * 4;

  const distances = new Float32Array(arrayBuffer, offset, vCount);

  return {
    header,
    positions,
    indices,
    distances,
  };
}
