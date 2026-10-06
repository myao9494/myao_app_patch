/**
 * 3D差分ビューアー コンポーネント仕様。
 * CADデータ (STEP) の新旧2バージョンを3D空間上で視覚的に比較する。
 * - 比較表示:
 *   - 重ね表示 (Overlay): 新版 (グレー/緑) に旧版の削除箇所 (赤) を重ね合わせ。
 *   - 左右並べ表示 (Side-by-Side): 旧版と新版を並べ、カメラ操作 (回転/ズーム/パン) を完全同期。
 * - リアルタイムしきい値調整:
 *   - バックエンドから取得した頂点距離 (diffDistance) に対し、GPUシェーダーで色分け。
 *   - サーバー再計算なしで、スライダー操作に即座に追従して差分ハイライトを更新。
 * - 非同期ジョブ進捗表示、エラー・警告通知、サンプル即時読み込みに対応。
 */

import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  Box,
  Layers,
  Columns,
  RotateCcw,
  Sliders,
  AlertTriangle,
  Upload,
  CheckCircle2,
  RefreshCw,
  Eye,
  FileCode,
} from "lucide-react";
import { parseVdm1 } from "./vdm1.js";
import { createDiffMaterial, updateMaterialUniforms } from "./materials.js";
import "./three-diff.css";

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";

export function ThreeDiffViewer() {
  const [availability, setAvailability] = useState(null);
  const [samples, setSamples] = useState([]);
  const [selectedSample, setSelectedSample] = useState("");

  const [fileOld, setFileOld] = useState(null);
  const [fileNew, setFileNew] = useState(null);
  const [quality, setQuality] = useState("standard");
  const [alignMode, setAlignMode] = useState("auto");

  const [jobId, setJobId] = useState(null);
  const [jobStatus, setJobStatus] = useState(null); // { status, stage, progress, warnings, error, stats }
  const [isRunning, setIsRunning] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);

  // 取得した3Dメッシュデータ
  const [meshData, setMeshData] = useState(null); // { old: { geometry, distances }, new: { geometry, distances }, stats, warnings }

  // 表示コントロール
  const [viewMode, setViewMode] = useState("overlay"); // "overlay" | "side-by-side" | "old" | "new"
  const [threshold, setThreshold] = useState(0.2);
  const [overlayOpacity, setOverlayOpacity] = useState(0.9);
  const [wireframe, setWireframe] = useState(false);

  // キャンバス用 ref
  const singleContainerRef = useRef(null);
  const leftContainerRef = useRef(null);
  const rightContainerRef = useRef(null);

  // Three.js インスタンス管理用 ref
  const singleSceneRef = useRef(null);
  const sideBySideRef = useRef(null);

  // 1. 3D環境状況およびサンプルの取得
  useEffect(() => {
    fetch(`${API_BASE}/3d/status`)
      .then((res) => res.json())
      .then((data) => setAvailability(data))
      .catch((err) => setErrorMessage(`3Dステータスの取得に失敗しました: ${err.message}`));

    fetch(`${API_BASE}/3d/samples`)
      .then((res) => res.json())
      .then((data) => setSamples(data))
      .catch(() => {});
  }, []);

  // 2. ジョブポーリング
  useEffect(() => {
    if (!jobId || !isRunning) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/3d/jobs/${jobId}`);
        if (!res.ok) {
          throw new Error("ジョブステータスの取得に失敗しました");
        }
        const status = await res.json();
        setJobStatus(status);

        if (status.status === "done") {
          setIsRunning(false);
          clearInterval(interval);
          loadJobMeshes(jobId, status);
        } else if (status.status === "error") {
          setIsRunning(false);
          setErrorMessage(status.error || "3D差分処理に失敗しました");
          clearInterval(interval);
        }
      } catch (err) {
        setIsRunning(false);
        setErrorMessage(err.message);
        clearInterval(interval);
      }
    }, 400);

    return () => clearInterval(interval);
  }, [jobId, isRunning]);

  // 3. VDM1バイナリのダウンロードとジオメトリ生成
  const loadJobMeshes = async (id, status) => {
    try {
      setErrorMessage(null);
      const [resOld, resNew] = await Promise.all([
        fetch(`${API_BASE}/3d/jobs/${id}/mesh/old`),
        fetch(`${API_BASE}/3d/jobs/${id}/mesh/new`),
      ]);
      if (!resOld.ok || !resNew.ok) {
        throw new Error("メッシュデータのダウンロードに失敗しました");
      }

      const [bufOld, bufNew] = await Promise.all([
        resOld.arrayBuffer(),
        resNew.arrayBuffer(),
      ]);

      const parsedOld = parseVdm1(bufOld);
      const parsedNew = parseVdm1(bufNew);

      const geomOld = createBufferGeometry(parsedOld);
      const geomNew = createBufferGeometry(parsedNew);

      // 初期しきい値の設定（線形許容差の2倍）
      const initialThreshold = status.stats?.linear_deflection
        ? Number((status.stats.linear_deflection * 2).toFixed(3))
        : 0.2;
      setThreshold(initialThreshold);

      setMeshData({
        old: { geometry: geomOld, distances: parsedOld.distances, count: parsedOld.header.vertex_count },
        new: { geometry: geomNew, distances: parsedNew.distances, count: parsedNew.header.vertex_count },
        stats: status.stats,
        warnings: status.warnings || [],
      });
    } catch (err) {
      setErrorMessage(`3Dメッシュの展開エラー: ${err.message}`);
    }
  };

  const createBufferGeometry = (parsed) => {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(parsed.positions, 3));
    geom.setIndex(new THREE.BufferAttribute(parsed.indices, 1));
    geom.setAttribute("diffDistance", new THREE.BufferAttribute(parsed.distances, 1));
    geom.computeVertexNormals();
    geom.computeBoundingBox();
    geom.computeBoundingSphere();
    return geom;
  };

  // 4. ジョブ実行トリガー
  const runDiff = async () => {
    setErrorMessage(null);
    setMeshData(null);

    try {
      let res;
      if (selectedSample) {
        res = await fetch(`${API_BASE}/3d/samples/load`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sample_id: selectedSample,
            quality,
            align_mode: alignMode,
          }),
        });
      } else {
        if (!fileOld || !fileNew) {
          setErrorMessage("旧版(A)と新版(B)の両方のSTEPファイルを選択してください。");
          return;
        }
        const formData = new FormData();
        formData.append("file_old", fileOld);
        formData.append("file_new", fileNew);
        formData.append("quality", quality);
        formData.append("align_mode", alignMode);

        res = await fetch(`${API_BASE}/3d/jobs`, {
          method: "POST",
          body: formData,
        });
      }

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.detail || "ジョブの開始に失敗しました");
      }

      const data = await res.json();
      setJobId(data.job_id);
      setIsRunning(true);
      setJobStatus({ status: "queued", stage: "処理開始待ち", progress: 0.0 });
    } catch (err) {
      setErrorMessage(err.message);
    }
  };

  // 5. 差分割合の集計（リアルタイム）
  const statsSummary = useMemo(() => {
    if (!meshData) return null;
    let oldDeleted = 0;
    const oldDists = meshData.old.distances;
    for (let i = 0; i < oldDists.length; i++) {
      if (oldDists[i] > threshold) oldDeleted++;
    }
    let newAdded = 0;
    const newDists = meshData.new.distances;
    for (let i = 0; i < newDists.length; i++) {
      if (newDists[i] > threshold) newAdded++;
    }
    const oldRatio = (oldDeleted / oldDists.length) * 100;
    const newRatio = (newAdded / newDists.length) * 100;
    return {
      oldDeleted,
      oldTotal: oldDists.length,
      oldRatio: oldRatio.toFixed(1),
      newAdded,
      newTotal: newDists.length,
      newRatio: newRatio.toFixed(1),
    };
  }, [meshData, threshold]);

  // 6. 単一キャンバス（Overlay / Old only / New only）の初期化とレンダリング
  useEffect(() => {
    if (!meshData || viewMode === "side-by-side") return;
    const container = singleContainerRef.current;
    if (!container) return;

    // シーン・カメラ・レンダラー
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0f1d);

    const width = container.clientWidth || 800;
    const height = container.clientHeight || 600;
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 10000);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    // ライト
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.75);
    scene.add(ambientLight);
    const dirLight1 = new THREE.DirectionalLight(0xffffff, 0.9);
    dirLight1.position.set(1, 2, 1.5).normalize();
    scene.add(dirLight1);
    const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.4);
    dirLight2.position.set(-1, -1, -1).normalize();
    scene.add(dirLight2);

    // メッシュとマテリアルの配置
    let meshNew = null;
    let meshOld = null;
    let matNew = null;
    let matOld = null;

    if (viewMode === "overlay" || viewMode === "new") {
      matNew = createDiffMaterial({
        side: "new",
        threshold,
        discardMatching: false,
        wireframe,
        opacity: 1.0,
      });
      meshNew = new THREE.Mesh(meshData.new.geometry, matNew);
      scene.add(meshNew);
    }

    if (viewMode === "overlay" || viewMode === "old") {
      matOld = createDiffMaterial({
        side: "old",
        threshold,
        discardMatching: viewMode === "overlay", // 重ね表示時は一致部分をdiscard
        wireframe,
        opacity: viewMode === "overlay" ? overlayOpacity : 1.0,
      });
      meshOld = new THREE.Mesh(meshData.old.geometry, matOld);
      scene.add(meshOld);
    }

    // カメラ位置をモデルの中心にフォーカス
    const sphere = (meshData.new.geometry.boundingSphere || meshData.old.geometry.boundingSphere);
    if (sphere) {
      const radius = sphere.radius || 50;
      const center = sphere.center;
      controls.target.copy(center);
      camera.position.set(center.x + radius * 1.8, center.y + radius * 1.5, center.z + radius * 2.2);
      camera.near = radius * 0.01;
      camera.far = radius * 100;
      camera.updateProjectionMatrix();
      controls.update();
    }

    singleSceneRef.current = {
      scene,
      camera,
      renderer,
      controls,
      matNew,
      matOld,
      resetCamera: () => {
        if (!sphere) return;
        const radius = sphere.radius || 50;
        const center = sphere.center;
        controls.target.copy(center);
        camera.position.set(center.x + radius * 1.8, center.y + radius * 1.5, center.z + radius * 2.2);
        controls.update();
      },
    };

    let animationId;
    const animate = () => {
      animationId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const handleResize = () => {
      if (!container) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", handleResize);

    return () => {
      cancelAnimationFrame(animationId);
      window.removeEventListener("resize", handleResize);
      renderer.dispose();
      controls.dispose();
    };
  }, [meshData, viewMode]);

  // 7. 左右並べ表示（Side-by-Side）の初期化とカメラ同期
  useEffect(() => {
    if (!meshData || viewMode !== "side-by-side") return;
    const leftEl = leftContainerRef.current;
    const rightEl = rightContainerRef.current;
    if (!leftEl || !rightEl) return;

    // 左画面（旧版: 削除部分を赤色表示）
    const sceneL = new THREE.Scene();
    sceneL.background = new THREE.Color(0x0a0f1d);
    const cameraL = new THREE.PerspectiveCamera(45, leftEl.clientWidth / leftEl.clientHeight, 0.1, 10000);
    const rendererL = new THREE.WebGLRenderer({ antialias: true });
    rendererL.setSize(leftEl.clientWidth, leftEl.clientHeight);
    rendererL.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    leftEl.innerHTML = "";
    leftEl.appendChild(rendererL.domElement);
    const controlsL = new OrbitControls(cameraL, rendererL.domElement);

    // 右画面（新版: 追加部分を緑色表示）
    const sceneR = new THREE.Scene();
    sceneR.background = new THREE.Color(0x0a0f1d);
    const cameraR = new THREE.PerspectiveCamera(45, rightEl.clientWidth / rightEl.clientHeight, 0.1, 10000);
    const rendererR = new THREE.WebGLRenderer({ antialias: true });
    rendererR.setSize(rightEl.clientWidth, rightEl.clientHeight);
    rendererR.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    rightEl.innerHTML = "";
    rightEl.appendChild(rendererR.domElement);
    const controlsR = new OrbitControls(cameraR, rendererR.domElement);

    // ライト追加
    [sceneL, sceneR].forEach((s) => {
      s.add(new THREE.AmbientLight(0xffffff, 0.75));
      const dl1 = new THREE.DirectionalLight(0xffffff, 0.9);
      dl1.position.set(1, 2, 1.5).normalize();
      s.add(dl1);
      const dl2 = new THREE.DirectionalLight(0xffffff, 0.4);
      dl2.position.set(-1, -1, -1).normalize();
      s.add(dl2);
    });

    const matOld = createDiffMaterial({ side: "old", threshold, discardMatching: false, wireframe });
    const meshOld = new THREE.Mesh(meshData.old.geometry, matOld);
    sceneL.add(meshOld);

    const matNew = createDiffMaterial({ side: "new", threshold, discardMatching: false, wireframe });
    const meshNew = new THREE.Mesh(meshData.new.geometry, matNew);
    sceneR.add(meshNew);

    // カメラ位置の初期化
    const sphere = meshData.new.geometry.boundingSphere || meshData.old.geometry.boundingSphere;
    if (sphere) {
      const radius = sphere.radius || 50;
      const center = sphere.center;
      [controlsL, controlsR].forEach((ctrl) => ctrl.target.copy(center));
      [cameraL, cameraR].forEach((cam) => {
        cam.position.set(center.x + radius * 1.8, center.y + radius * 1.5, center.z + radius * 2.2);
        cam.near = radius * 0.01;
        cam.far = radius * 100;
        cam.updateProjectionMatrix();
      });
      controlsL.update();
      controlsR.update();
    }

    // カメラの完全同期処理（無限ループ防止フラグ付き）
    let isSyncing = false;
    const syncControls = (sourceCam, sourceCtrl, targetCam, targetCtrl) => {
      if (isSyncing) return;
      isSyncing = true;
      targetCam.position.copy(sourceCam.position);
      targetCam.rotation.copy(sourceCam.rotation);
      targetCtrl.target.copy(sourceCtrl.target);
      targetCtrl.update();
      isSyncing = false;
    };

    controlsL.addEventListener("change", () => syncControls(cameraL, controlsL, cameraR, controlsR));
    controlsR.addEventListener("change", () => syncControls(cameraR, controlsR, cameraL, controlsL));

    sideBySideRef.current = {
      matOld,
      matNew,
      resetCamera: () => {
        if (!sphere) return;
        const radius = sphere.radius || 50;
        const center = sphere.center;
        [controlsL, controlsR].forEach((ctrl) => ctrl.target.copy(center));
        [cameraL, cameraR].forEach((cam) => {
          cam.position.set(center.x + radius * 1.8, center.y + radius * 1.5, center.z + radius * 2.2);
        });
        controlsL.update();
        controlsR.update();
      },
    };

    let animId;
    const animate = () => {
      animId = requestAnimationFrame(animate);
      rendererL.render(sceneL, cameraL);
      rendererR.render(sceneR, cameraR);
    };
    animate();

    const handleResize = () => {
      if (!leftEl || !rightEl) return;
      cameraL.aspect = leftEl.clientWidth / leftEl.clientHeight;
      cameraL.updateProjectionMatrix();
      rendererL.setSize(leftEl.clientWidth, leftEl.clientHeight);

      cameraR.aspect = rightEl.clientWidth / rightEl.clientHeight;
      cameraR.updateProjectionMatrix();
      rendererR.setSize(rightEl.clientWidth, rightEl.clientHeight);
    };
    window.addEventListener("resize", handleResize);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", handleResize);
      rendererL.dispose();
      rendererR.dispose();
      controlsL.dispose();
      controlsR.dispose();
    };
  }, [meshData, viewMode]);

  // 8. しきい値・不透明度・ワイヤーフレームのリアルタイム反映 (Uniform更新)
  useEffect(() => {
    if (viewMode === "side-by-side" && sideBySideRef.current) {
      updateMaterialUniforms(sideBySideRef.current.matOld, { threshold, wireframe });
      updateMaterialUniforms(sideBySideRef.current.matNew, { threshold, wireframe });
    } else if (singleSceneRef.current) {
      updateMaterialUniforms(singleSceneRef.current.matOld, {
        threshold,
        discardMatching: viewMode === "overlay",
        opacity: viewMode === "overlay" ? overlayOpacity : 1.0,
        wireframe,
      });
      updateMaterialUniforms(singleSceneRef.current.matNew, {
        threshold,
        wireframe,
      });
    }
  }, [threshold, overlayOpacity, wireframe, viewMode]);

  const handleResetCamera = () => {
    if (viewMode === "side-by-side" && sideBySideRef.current) {
      sideBySideRef.current.resetCamera();
    } else if (singleSceneRef.current) {
      singleSceneRef.current.resetCamera();
    }
  };

  return (
    <div className="three-diff-container">
      {/* ツールバー */}
      <div className="three-diff-toolbar">
        <div className="three-diff-controls-group">
          {/* サンプル選択 */}
          {samples.length > 0 && (
            <div className="three-diff-input-group">
              <label>サンプル:</label>
              <select
                className="three-diff-select"
                value={selectedSample}
                onChange={(e) => {
                  setSelectedSample(e.target.value);
                  if (e.target.value) {
                    setFileOld(null);
                    setFileNew(null);
                  }
                }}
              >
                <option value="">(自前STEPをアップロード)</option>
                {samples.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* 品質設定 */}
          <div className="three-diff-input-group">
            <label>メッシュ精度:</label>
            <select
              className="three-diff-select"
              value={quality}
              onChange={(e) => setQuality(e.target.value)}
              disabled={isRunning}
            >
              <option value="coarse">粗い (高速)</option>
              <option value="standard">標準 (推奨)</option>
              <option value="fine">細かい (精密)</option>
            </select>
          </div>

          {/* 位置合わせ設定 */}
          <div className="three-diff-input-group">
            <label>位置合わせ:</label>
            <select
              className="three-diff-select"
              value={alignMode}
              onChange={(e) => setAlignMode(e.target.value)}
              disabled={isRunning}
            >
              <option value="auto">自動 (元座標/補正 最適選択)</option>
              <option value="none">元座標のまま (動かさない)</option>
              <option value="centroid">重心合わせのみ</option>
              <option value="fit">最適フィット (ICP)</option>
            </select>
          </div>

          <button
            className="three-diff-btn three-diff-btn-primary"
            onClick={runDiff}
            disabled={isRunning || (!selectedSample && (!fileOld || !fileNew))}
          >
            {isRunning ? <RefreshCw size={15} className="spin" /> : <Layers size={15} />}
            3D差分を実行
          </button>
        </div>

        {/* 差分結果表示中のコントロール */}
        {meshData && (
          <div className="three-diff-controls-group">
            {/* 表示モード切替 */}
            <div className="three-diff-input-group">
              <label>表示:</label>
              <select
                className="three-diff-select"
                value={viewMode}
                onChange={(e) => setViewMode(e.target.value)}
              >
                <option value="overlay">重ね表示 (Overlay)</option>
                <option value="side-by-side">左右並べ表示 (Side-by-Side)</option>
                <option value="new">新版のみ</option>
                <option value="old">旧版のみ</option>
              </select>
            </div>

            {/* 許容誤差 (しきい値) スライダー */}
            <div className="three-diff-slider-box">
              <Sliders size={14} color="#94a3b8" />
              <label>しきい値:</label>
              <input
                type="range"
                min="0.01"
                max="5.0"
                step="0.01"
                value={threshold}
                onChange={(e) => setThreshold(parseFloat(e.target.value))}
              />
              <input
                type="number"
                className="three-diff-input"
                style={{ width: "64px" }}
                step="0.01"
                min="0.001"
                value={threshold}
                onChange={(e) => setThreshold(parseFloat(e.target.value) || 0.01)}
              />
              <span>mm</span>
            </div>

            {viewMode === "overlay" && (
              <div className="three-diff-slider-box">
                <label>旧版透明度:</label>
                <input
                  type="range"
                  min="0.1"
                  max="1.0"
                  step="0.05"
                  value={overlayOpacity}
                  onChange={(e) => setOverlayOpacity(parseFloat(e.target.value))}
                />
              </div>
            )}

            <button
              className={`three-diff-btn ${wireframe ? "three-diff-btn-primary" : ""}`}
              onClick={() => setWireframe(!wireframe)}
              title="ワイヤーフレーム表示の切替"
            >
              <Box size={14} />
              枠線
            </button>

            <button
              className="three-diff-btn"
              onClick={handleResetCamera}
              title="カメラの視点をリセット"
            >
              <RotateCcw size={14} />
              視点リセット
            </button>
          </div>
        )}
      </div>

      {/* 依存環境チェックアラート */}
      {availability && !availability.available && (
        <div className="three-diff-error-box">
          <AlertTriangle size={16} />
          <div>
            <strong>3D差分ライブラリが未インストールです:</strong> {availability.missing.join(", ")}
            <br />
            サーバー環境で以下のコマンドを実行してください:
            <code>{availability.install_hint}</code>
          </div>
        </div>
      )}

      {/* エラーメッセージ */}
      {errorMessage && (
        <div className="three-diff-error-box">
          <AlertTriangle size={16} />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* 警告メッセージ */}
      {meshData && meshData.warnings && meshData.warnings.length > 0 && (
        <div className="three-diff-warning-box">
          {meshData.warnings.map((w, idx) => (
            <div key={idx} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <AlertTriangle size={14} />
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}

      {/* メインワークスペース */}
      <div className="three-diff-workspace">
        {/* ファイル未設定 / 比較前の案内カード */}
        {!meshData && !isRunning && !selectedSample && (
          <div className="three-diff-setup-card">
            <h3>CAD (STEP) ファイルの3D差分比較</h3>
            <p style={{ color: "#94a3b8", fontSize: "13px", margin: 0 }}>
              旧版 (A) と新版 (B) のSTEPファイルを選択し、「3D差分を実行」を押してください。
              形状の差異（削除箇所は赤、追加箇所は緑、変更なしはグレー）を瞬時に可視化します。
            </p>

            <div className="dropzone-row">
              {/* 旧版 (A) ドロップゾーン */}
              <label className={`step-dropzone ${fileOld ? "has-file" : ""}`}>
                <input
                  type="file"
                  accept=".step,.stp"
                  style={{ display: "none" }}
                  onChange={(e) => setFileOld(e.target.files[0] || null)}
                />
                <Upload size={24} color={fileOld ? "#22c55e" : "#64748b"} />
                <span className="dropzone-title">旧版 STEP (A 基準)</span>
                <span className="dropzone-filename">
                  {fileOld ? fileOld.name : "クリックまたはドラッグ＆ドロップ"}
                </span>
              </label>

              {/* 新版 (B) ドロップゾーン */}
              <label className={`step-dropzone ${fileNew ? "has-file" : ""}`}>
                <input
                  type="file"
                  accept=".step,.stp"
                  style={{ display: "none" }}
                  onChange={(e) => setFileNew(e.target.files[0] || null)}
                />
                <Upload size={24} color={fileNew ? "#22c55e" : "#64748b"} />
                <span className="dropzone-title">新版 STEP (B 変更後)</span>
                <span className="dropzone-filename">
                  {fileNew ? fileNew.name : "クリックまたはドラッグ＆ドロップ"}
                </span>
              </label>
            </div>

            {samples.length > 0 && (
              <div className="samples-selector">
                <FileCode size={16} />
                <span>または、上部のサンプルメニューから検証用ペアを選んで試すことができます。</span>
              </div>
            )}
          </div>
        )}

        {/* 実行中プログレスオーバーレイ */}
        {isRunning && (
          <div className="three-diff-progress-overlay">
            <RefreshCw size={36} className="spin" color="#3b82f6" />
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "16px", fontWeight: "600", marginBottom: "6px" }}>
                {jobStatus?.stage || "3D形状解析・位置合わせ中..."}
              </div>
              <div style={{ color: "#94a3b8", fontSize: "13px" }}>
                {Math.round((jobStatus?.progress || 0) * 100)}% 完了
              </div>
            </div>
            <div className="three-diff-progress-bar">
              <div
                className="three-diff-progress-fill"
                style={{ width: `${Math.round((jobStatus?.progress || 0) * 100)}%` }}
              />
            </div>
          </div>
        )}

        {/* 3D レンダリングキャンバスエリア */}
        {meshData && (
          <div className="three-diff-canvas-area">
            {viewMode === "side-by-side" ? (
              <>
                <div className="three-diff-viewport" ref={leftContainerRef}>
                  <div className="viewport-label">旧版 (削除部: 赤)</div>
                </div>
                <div
                  className="three-diff-viewport"
                  ref={rightContainerRef}
                  style={{ borderLeft: "1px solid #334155" }}
                >
                  <div className="viewport-label">新版 (追加部: 緑)</div>
                </div>
              </>
            ) : (
              <div className="three-diff-viewport" ref={singleContainerRef}>
                <div className="viewport-label">
                  {viewMode === "overlay" && "重ね表示 (緑: 追加 / 赤: 削除 / グレー: 一致)"}
                  {viewMode === "new" && "新版 (緑: 追加 / グレー: 一致)"}
                  {viewMode === "old" && "旧版 (赤: 削除 / グレー: 一致)"}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* フッター統計バー */}
      {meshData && statsSummary && (
        <div className="three-diff-stats-drawer">
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span>差分割合:</span>
            <span className="three-diff-stat-badge badge-added">
              +追加 {statsSummary.newRatio}% ({statsSummary.newAdded} / {statsSummary.newTotal} 頂点)
            </span>
            <span className="three-diff-stat-badge badge-deleted">
              -削除 {statsSummary.oldRatio}% ({statsSummary.oldDeleted} / {statsSummary.oldTotal} 頂点)
            </span>
          </div>

          {meshData.stats?.linear_deflection && (
            <span>テッセレーション精度: {meshData.stats.linear_deflection.toFixed(4)} mm</span>
          )}

          {meshData.stats?.alignment && (
            <span>
              位置合わせ: {meshData.stats.alignment.applied}
              {meshData.stats.alignment.applied === "fit" &&
                ` (一致率 ${(meshData.stats.alignment.inlier_ratio * 100).toFixed(0)}%, 回転 ${meshData.stats.alignment.rotation_deg.toFixed(1)}°)`}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
