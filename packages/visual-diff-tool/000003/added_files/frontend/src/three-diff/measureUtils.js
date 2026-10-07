/**
 * 3D寸法測定および注記（アノテーション）計算ユーティリティ仕様。
 * CADモデル（STEP）上の幾何学的寸法測定および注記ピン・引出線の計算を提供する。
 * - 2点間距離 (L) および各軸オフセット (dX, dY, dZ) の算出
 * - 頂点スナップ (最近傍頂点探索) による正確な角・端点吸着
 * - ピン留め寸法および注記メモのデータ構造生成
 * - 3Dワールド座標からスクリーン画面座標への射影変換
 */

/**
 * 2点間の直線距離および各軸オフセット成分を計算する
 * @param {{x: number, y: number, z: number}} p1 - 始点
 * @param {{x: number, y: number, z: number}} p2 - 終点
 * @returns {{distance: number, dx: number, dy: number, dz: number}}
 */
export function calculateDistance(p1, p2) {
  const dx = Math.abs(p2.x - p1.x);
  const dy = Math.abs(p2.y - p1.y);
  const dz = Math.abs(p2.z - p1.z);
  const rawDist = Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2 + (p2.z - p1.z) ** 2);

  return {
    distance: Number(rawDist.toFixed(4)),
    dx: Number(dx.toFixed(4)),
    dy: Number(dy.toFixed(4)),
    dz: Number(dz.toFixed(4)),
  };
}

/**
 * 交差点から候補頂点群の中で最も近い頂点を探索し、しきい値内であればスナップ座標を返す
 * @param {{x: number, y: number, z: number}} point - レイキャスト交差点
 * @param {Array<{x: number, y: number, z: number}>} vertices - 面の頂点配列
 * @param {number} threshold - スナップ許容距離
 * @returns {{x: number, y: number, z: number, snapped: boolean}}
 */
export function findNearestVertex(point, vertices, threshold = 15.0) {
  if (!vertices || vertices.length === 0) {
    return { x: point.x, y: point.y, z: point.z, snapped: false };
  }

  let minSq = Infinity;
  let nearest = null;

  for (const v of vertices) {
    const sq = (v.x - point.x) ** 2 + (v.y - point.y) ** 2 + (v.z - point.z) ** 2;
    if (sq < minSq) {
      minSq = sq;
      nearest = v;
    }
  }

  if (nearest && Math.sqrt(minSq) <= threshold) {
    return {
      x: nearest.x,
      y: nearest.y,
      z: nearest.z,
      snapped: true,
    };
  }

  return {
    x: point.x,
    y: point.y,
    z: point.z,
    snapped: false,
  };
}

/**
 * ピン留め用寸法オブジェクトを生成する
 * @param {string} id - 一意識別子
 * @param {{x: number, y: number, z: number}} start - 始点
 * @param {{x: number, y: number, z: number}} end - 終点
 * @returns {object}
 */
export function createMeasurement(id, start, end) {
  const calc = calculateDistance(start, end);
  return {
    id,
    start: { x: start.x, y: start.y, z: start.z },
    end: { x: end.x, y: end.y, z: end.z },
    distance: calc.distance,
    dx: calc.dx,
    dy: calc.dy,
    dz: calc.dz,
    label: `${calc.distance.toFixed(2)} mm`,
    createdAt: Date.now(),
  };
}

/**
 * 注記オブジェクトを生成する
 * @param {string} id - 一意識別子
 * @param {{x: number, y: number, z: number}} point - 3D表面座標
 * @param {string} text - メモテキスト
 * @param {string} color - カテゴリ色（16進数カラーコード）
 * @returns {object}
 */
export function createAnnotation(id, point, text = "", color = "#3b82f6") {
  return {
    id,
    point: { x: point.x, y: point.y, z: point.z },
    text,
    color,
    collapsed: false,
    offset: { x: 25, y: -45 }, // ピン位置からの引出線相対ピクセルオフセット
    createdAt: Date.now(),
  };
}

/**
 * 3Dワールド座標を2Dスクリーンピクセル座標へ射影変換する
 * @param {{x: number, y: number, z: number}} point - 3D座標
 * @param {Function} projectFn - Three.js Vector3.project 互換関数 (p) => NDC {x, y, z}
 * @param {number} width - キャンバス幅 (px)
 * @param {number} height - キャンバス高さ (px)
 * @returns {{x: number, y: number, visible: boolean}}
 */
export function projectToScreen(point, projectFn, width, height) {
  const ndc = projectFn(point);

  // カメラ背面 (ndc.z > 1.0) またはクリッピング外の判定
  if (ndc.z < -1.0 || ndc.z > 1.0) {
    return { x: 0, y: 0, visible: false };
  }

  // NDC空間 [-1, 1] からピクセル空間 [0, width], [0, height] へのマッピング
  const x = ((ndc.x + 1) / 2) * width;
  const y = ((-ndc.y + 1) / 2) * height;

  return {
    x: Number(x.toFixed(1)),
    y: Number(y.toFixed(1)),
    visible: true,
  };
}

/**
 * 3D空間上の3点を通る円の中心・半径R・直径φを算出する
 * @param {{x: number, y: number, z: number}} p1
 * @param {{x: number, y: number, z: number}} p2
 * @param {{x: number, y: number, z: number}} p3
 * @returns {{center: {x: number, y: number, z: number}, radius: number, diameter: number} | null}
 */
export function fitCircleFrom3Points(p1, p2, p3) {
  const u = { x: p2.x - p1.x, y: p2.y - p1.y, z: p2.z - p1.z };
  const w = { x: p3.x - p1.x, y: p3.y - p1.y, z: p3.z - p1.z };

  // 外積 t = u x w (法線ベクトル)
  const tx = u.y * w.z - u.z * w.y;
  const ty = u.z * w.x - u.x * w.z;
  const tz = u.x * w.y - u.y * w.x;

  const tLenSq = tx * tx + ty * ty + tz * tz;
  if (tLenSq < 1e-10) {
    // 3点が同一直線上
    return null;
  }

  const uLenSq = u.x * u.x + u.y * u.y + u.z * u.z;
  const wLenSq = w.x * w.x + w.y * w.y + w.z * w.z;

  // v = |u|^2 * w - |w|^2 * u
  const vx = uLenSq * w.x - wLenSq * u.x;
  const vy = uLenSq * w.y - wLenSq * u.y;
  const vz = uLenSq * w.z - wLenSq * u.z;

  // cOffset = (v x t) / (2 * |t|^2)
  const cxOffset = (vy * tz - vz * ty) / (2 * tLenSq);
  const cyOffset = (vz * tx - vx * tz) / (2 * tLenSq);
  const czOffset = (vx * ty - vy * tx) / (2 * tLenSq);

  const center = {
    x: Number((p1.x + cxOffset).toFixed(4)),
    y: Number((p1.y + cyOffset).toFixed(4)),
    z: Number((p1.z + czOffset).toFixed(4)),
  };

  const radius = Math.sqrt(cxOffset * cxOffset + cyOffset * cyOffset + czOffset * czOffset);
  const diameter = radius * 2;

  return {
    center,
    radius: Number(radius.toFixed(4)),
    diameter: Number(diameter.toFixed(4)),
  };
}

/**
 * 点群および幾何要素から寸法種別（穴径φ/円弧R/C面取り/直線）をスマート自動認識する
 * @param {Array<{x: number, y: number, z: number}>} points
 * @param {object} meta
 * @returns {object}
 */
export function detectSmartDimension(points, meta = {}) {
  if (!points || points.length === 0) {
    return { type: "distance", value: 0, label: "0.00 mm", availableTypes: ["distance"] };
  }

  // 1. 3点ある場合は円弧・穴径判定
  if (points.length >= 3) {
    const circle = fitCircleFrom3Points(points[0], points[1], points[2]);
    if (circle) {
      const isFullCircle = meta.isClosedHole !== false;
      const type = isFullCircle ? "diameter" : "radius";
      const value = isFullCircle ? circle.diameter : circle.radius;
      const label = isFullCircle ? `φ${value.toFixed(2)} mm` : `R${value.toFixed(2)} mm`;

      return {
        type,
        value,
        label,
        radius: circle.radius,
        diameter: circle.diameter,
        center: circle.center,
        availableTypes: ["diameter", "radius", "distance"],
      };
    }
  }

  // 2. 2点の場合: 面取り判定または直線距離
  if (points.length === 2) {
    const p1 = points[0];
    const p2 = points[1];
    const calc = calculateDistance(p1, p2);

    if (meta.isChamferFace) {
      // 面取り幅 (C寸法)
      const cVal = Math.min(calc.dx || calc.distance, calc.dy || calc.distance);
      return {
        type: "chamfer",
        value: Number(cVal.toFixed(2)),
        label: `C${cVal.toFixed(2)} mm`,
        dx: calc.dx,
        dy: calc.dy,
        dz: calc.dz,
        availableTypes: ["chamfer", "distance"],
      };
    }

    return {
      type: "distance",
      value: calc.distance,
      label: `${calc.distance.toFixed(2)} mm`,
      dx: calc.dx,
      dy: calc.dy,
      dz: calc.dz,
      availableTypes: ["distance", "chamfer"],
    };
  }

  return {
    type: "distance",
    value: 0,
    label: "0.00 mm",
    availableTypes: ["distance"],
  };
}

/**
 * スマート認識された寸法オブジェクトを生成する (ドラッグ移動・手動切替対応)
 * @param {string} id
 * @param {Array<{x: number, y: number, z: number}>} points
 * @param {string} preferredType - "auto" | "distance" | "diameter" | "radius" | "chamfer"
 * @param {object} meta
 * @returns {object}
 */
export function createSmartMeasurement(id, points, preferredType = "auto", meta = {}) {
  const detected = detectSmartDimension(points, meta);
  let finalType = detected.type;
  let finalValue = detected.value;
  let finalLabel = detected.label;

  if (preferredType !== "auto" && detected.availableTypes.includes(preferredType)) {
    finalType = preferredType;
    if (preferredType === "diameter" && detected.diameter) {
      finalValue = detected.diameter;
      finalLabel = `φ${finalValue.toFixed(2)} mm`;
    } else if (preferredType === "radius" && detected.radius) {
      finalValue = detected.radius;
      finalLabel = `R${finalValue.toFixed(2)} mm`;
    } else if (preferredType === "chamfer") {
      finalLabel = `C${finalValue.toFixed(2)} mm`;
    } else if (preferredType === "distance") {
      const dist = calculateDistance(points[0], points[points.length - 1]).distance;
      finalValue = dist;
      finalLabel = `${dist.toFixed(2)} mm`;
    }
  }

  return {
    id,
    points,
    start: points[0],
    end: points[points.length - 1],
    type: finalType,
    value: finalValue,
    label: finalLabel,
    availableTypes: detected.availableTypes,
    radius: detected.radius,
    diameter: detected.diameter,
    center: detected.center,
    dx: detected.dx ?? 0,
    dy: detected.dy ?? 0,
    dz: detected.dz ?? 0,
    offset: { dx: 0, dy: 0 }, // ドラッグ引き出しオフセット (px)
    createdAt: Date.now(),
  };
}
