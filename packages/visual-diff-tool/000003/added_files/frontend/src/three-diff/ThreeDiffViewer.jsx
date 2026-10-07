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
import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";
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
  Square,
  Ruler,
  MessageSquare,
  Scissors,
} from "lucide-react";
import { parseVdm1 } from "./vdm1.js";
import { createDiffMaterial, updateMaterialUniforms } from "./materials.js";
import { MeasureAnnotationLayer } from "./MeasureAnnotationLayer.jsx";
import {
  findNearestVertex,
  createMeasurement,
  createAnnotation,
  createSmartMeasurement,
  detectSmartDimension,
} from "./measureUtils.js";
import {
  createClippingPlane,
  createHatchTexture,
  createSectionStencilGroup,
} from "./sectionPlane.js";
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
  const [showEdges, setShowEdges] = useState(true);

  // 寸法測定・注記（メモ）ツール状態
  const [toolMode, setToolMode] = useState("none"); // "none" | "measure" | "annotate"
  const [measurements, setMeasurements] = useState([]);
  const [currentMeasurePoints, setCurrentMeasurePoints] = useState([]); // 複数点指定 (2点または3点)
  const [hoverSnapPoint, setHoverSnapPoint] = useState(null);
  const [annotations, setAnnotations] = useState([]);
  const [cameraVersion, setCameraVersion] = useState(0);
  const [viewportSize, setViewportSize] = useState({ width: 800, height: 600 });

  // 断面表示 (Section Plane) 状態
  const [showSection, setShowSection] = useState(false);
  const [sectionAxis, setSectionAxis] = useState("x"); // "x" | "y" | "z"
  const [sectionPosition, setSectionPosition] = useState(0.0);
  const [sectionFlipped, setSectionFlipped] = useState(false);
  const hatchTextureRef = useRef(null);

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
    const rawGeom = new THREE.BufferGeometry();
    rawGeom.setAttribute("position", new THREE.BufferAttribute(parsed.positions, 3));
    rawGeom.setIndex(new THREE.BufferAttribute(parsed.indices, 1));
    rawGeom.setAttribute("diffDistance", new THREE.BufferAttribute(parsed.distances, 1));

    // 30度以上の折り目（ハードエッジ）で法線を分離。
    // これにより平面でのメッシュ分割に起因する陰影のモヤモヤ・ガタガタを完全に解消し、
    // 穴の内面などの円筒・曲面部分は滑らかなスムースシェーディングを保つ
    const geom = toCreasedNormals(rawGeom, (30 * Math.PI) / 180);
    geom.computeBoundingBox();
    geom.computeBoundingSphere();
    return geom;
  };

  const createEdgesSegments = (geometry, visible = true) => {
    // 30度以上の鋭角エッジをCADの輪郭線として描画
    const edgesGeom = new THREE.EdgesGeometry(geometry, 30);
    const edgesMat = new THREE.LineBasicMaterial({
      color: 0x1e293b,
      transparent: true,
      opacity: 0.85,
    });
    const edges = new THREE.LineSegments(edgesGeom, edgesMat);
    edges.name = "cad-edges";
    edges.visible = visible;
    edges.raycast = () => {};
    return edges;
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
    scene.background = new THREE.Color(0x0f172a);

    const width = container.clientWidth || 800;
    const height = container.clientHeight || 600;
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 10000);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true });
    renderer.localClippingEnabled = true;
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    // ライト（均一で影が綺麗に落ちるCAD向けマルチライト構成）
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.85);
    scene.add(ambientLight);
    const dirLight1 = new THREE.DirectionalLight(0xffffff, 1.05);
    dirLight1.position.set(1.5, 2.0, 1.8).normalize();
    scene.add(dirLight1);
    const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.45);
    dirLight2.position.set(-1.5, -1.0, -1.2).normalize();
    scene.add(dirLight2);
    const dirLight3 = new THREE.DirectionalLight(0xffffff, 0.35);
    dirLight3.position.set(0, 0, 2.0).normalize();
    scene.add(dirLight3);

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
      const edgesNew = createEdgesSegments(meshData.new.geometry, showEdges);
      meshNew.add(edgesNew);
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
      if (viewMode === "old") {
        const edgesOld = createEdgesSegments(meshData.old.geometry, showEdges);
        meshOld.add(edgesOld);
      }
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

    window.THREE_REF = THREE;
    setViewportSize({ width, height });

    controls.addEventListener("change", () => {
      setCameraVersion((v) => v + 1);
    });

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
      setViewportSize({ width: w, height: h });
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
    sceneL.background = new THREE.Color(0x0f172a);
    const cameraL = new THREE.PerspectiveCamera(45, leftEl.clientWidth / leftEl.clientHeight, 0.1, 10000);
    const rendererL = new THREE.WebGLRenderer({ antialias: true, stencil: true });
    rendererL.localClippingEnabled = true;
    rendererL.setSize(leftEl.clientWidth, leftEl.clientHeight);
    rendererL.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    leftEl.innerHTML = "";
    leftEl.appendChild(rendererL.domElement);
    const controlsL = new OrbitControls(cameraL, rendererL.domElement);

    // 右画面（新版: 追加部分を緑色表示）
    const sceneR = new THREE.Scene();
    sceneR.background = new THREE.Color(0x0f172a);
    const cameraR = new THREE.PerspectiveCamera(45, rightEl.clientWidth / rightEl.clientHeight, 0.1, 10000);
    const rendererR = new THREE.WebGLRenderer({ antialias: true, stencil: true });
    rendererR.localClippingEnabled = true;
    rendererR.setSize(rightEl.clientWidth, rightEl.clientHeight);
    rendererR.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    rightEl.innerHTML = "";
    rightEl.appendChild(rendererR.domElement);
    const controlsR = new OrbitControls(cameraR, rendererR.domElement);

    // ライト追加（左右同一設定）
    [sceneL, sceneR].forEach((s) => {
      s.add(new THREE.AmbientLight(0xffffff, 0.85));
      const dl1 = new THREE.DirectionalLight(0xffffff, 1.05);
      dl1.position.set(1.5, 2.0, 1.8).normalize();
      s.add(dl1);
      const dl2 = new THREE.DirectionalLight(0xffffff, 0.45);
      dl2.position.set(-1.5, -1.0, -1.2).normalize();
      s.add(dl2);
      const dl3 = new THREE.DirectionalLight(0xffffff, 0.35);
      dl3.position.set(0, 0, 2.0).normalize();
      s.add(dl3);
    });

    const matOld = createDiffMaterial({ side: "old", threshold, discardMatching: false, wireframe });
    const meshOld = new THREE.Mesh(meshData.old.geometry, matOld);
    const edgesOld = createEdgesSegments(meshData.old.geometry, showEdges);
    meshOld.add(edgesOld);
    sceneL.add(meshOld);

    const matNew = createDiffMaterial({ side: "new", threshold, discardMatching: false, wireframe });
    const meshNew = new THREE.Mesh(meshData.new.geometry, matNew);
    const edgesNew = createEdgesSegments(meshData.new.geometry, showEdges);
    meshNew.add(edgesNew);
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

    controlsL.addEventListener("change", () => {
      syncControls(cameraL, controlsL, cameraR, controlsR);
      setCameraVersion((v) => v + 1);
    });
    controlsR.addEventListener("change", () => {
      syncControls(cameraR, controlsR, cameraL, controlsL);
      setCameraVersion((v) => v + 1);
    });

    sideBySideRef.current = {
      sceneL,
      sceneR,
      cameraL,
      cameraR,
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
      const w = leftEl.clientWidth;
      const h = leftEl.clientHeight;
      setViewportSize({ width: w, height: h });
      cameraL.aspect = w / h;
      cameraL.updateProjectionMatrix();
      rendererL.setSize(w, h);

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

  // 9. CADエッジ表示のリアルタイム切替
  useEffect(() => {
    const setEdgesVisible = (scene) => {
      if (!scene) return;
      scene.traverse((obj) => {
        if (obj.name === "cad-edges") {
          obj.visible = showEdges;
        }
      });
    };
    if (singleSceneRef.current?.scene) {
      setEdgesVisible(singleSceneRef.current.scene);
    }
    if (sideBySideRef.current?.sceneL) {
      setEdgesVisible(sideBySideRef.current.sceneL);
      setEdgesVisible(sideBySideRef.current.sceneR);
    }
  }, [showEdges]);

  const handleResetCamera = () => {
    if (viewMode === "side-by-side" && sideBySideRef.current) {
      sideBySideRef.current.resetCamera();
    } else if (singleSceneRef.current) {
      singleSceneRef.current.resetCamera();
    }
  };

  // 10. 断面 (Section Plane) および中実ステンシルキャップの更新
  useEffect(() => {
    if (!meshData) return;

    if (!hatchTextureRef.current) {
      hatchTextureRef.current = createHatchTexture();
    }
    const hatchTex = hatchTextureRef.current;

    const bBox = meshData.new.geometry.boundingBox || meshData.old.geometry.boundingBox;
    if (!bBox) return;

    const clippingPlanes = showSection
      ? [createClippingPlane(sectionAxis, sectionPosition, sectionFlipped)]
      : [];

    const updateSceneSection = (scene, mats) => {
      if (!scene) return;
      mats.forEach((m) => {
        if (m) {
          m.clippingPlanes = clippingPlanes;
          m.clipShadows = true;
          m.needsUpdate = true;
        }
      });

      const existing = scene.getObjectByName("section-stencil-group");
      if (existing) {
        scene.remove(existing);
      }

      if (showSection && clippingPlanes.length > 0) {
        const stencilGrp = createSectionStencilGroup(scene, clippingPlanes[0], bBox, hatchTex);
        scene.add(stencilGrp);
      }
    };

    if (viewMode === "side-by-side" && sideBySideRef.current) {
      updateSceneSection(sideBySideRef.current.sceneL, [sideBySideRef.current.matOld]);
      updateSceneSection(sideBySideRef.current.sceneR, [sideBySideRef.current.matNew]);
    } else if (singleSceneRef.current) {
      updateSceneSection(singleSceneRef.current.scene, [
        singleSceneRef.current.matOld,
        singleSceneRef.current.matNew,
      ]);
    }
  }, [showSection, sectionAxis, sectionPosition, sectionFlipped, meshData, viewMode]);

  const sectionBounds = useMemo(() => {
    if (!meshData) return { min: -50, max: 50 };
    const bBox = meshData.new.geometry.boundingBox || meshData.old.geometry.boundingBox;
    if (!bBox) return { min: -50, max: 50 };
    return {
      min: Math.floor(bBox.min[sectionAxis]),
      max: Math.ceil(bBox.max[sectionAxis]),
    };
  }, [meshData, sectionAxis]);

  // 11. 寸法測定・注記用 マウス操作・Raycaster頂点スナップ処理
  const getActiveSceneContext = (e) => {
    if (viewMode === "side-by-side") {
      const leftEl = leftContainerRef.current;
      const rightEl = rightContainerRef.current;
      if (leftEl && leftEl.contains(e.target)) {
        return {
          container: leftEl,
          camera: sideBySideRef.current?.cameraL,
          scene: sideBySideRef.current?.sceneL,
        };
      }
      if (rightEl && rightEl.contains(e.target)) {
        return {
          container: rightEl,
          camera: sideBySideRef.current?.cameraR,
          scene: sideBySideRef.current?.sceneR,
        };
      }
      return null;
    }
    const singleEl = singleContainerRef.current;
    if (singleEl && singleEl.contains(e.target)) {
      return {
        container: singleEl,
        camera: singleSceneRef.current?.camera,
        scene: singleSceneRef.current?.scene,
      };
    }
    return null;
  };

  const getSnapHit = (e, ctx) => {
    if (!ctx || !ctx.container || !ctx.camera || !ctx.scene) return null;
    const rect = ctx.container.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(x, y), ctx.camera);

    const meshes = [];
    ctx.scene.traverse((obj) => {
      if (obj.isMesh && obj.visible && obj.name !== "cad-edges" && obj.name !== "section-cap-plane") {
        meshes.push(obj);
      }
    });

    const intersects = raycaster.intersectObjects(meshes, false);
    if (intersects.length === 0) return null;

    const hit = intersects[0];
    const face = hit.face;
    const posAttr = hit.object.geometry?.attributes?.position;
    let vertices = [];

    if (face && posAttr) {
      const vA = new THREE.Vector3().fromBufferAttribute(posAttr, face.a);
      const vB = new THREE.Vector3().fromBufferAttribute(posAttr, face.b);
      const vC = new THREE.Vector3().fromBufferAttribute(posAttr, face.c);
      hit.object.localToWorld(vA);
      hit.object.localToWorld(vB);
      hit.object.localToWorld(vC);
      vertices = [vA, vB, vC];
    }

    const sphereRadius = hit.object.geometry?.boundingSphere?.radius || 50;
    const snapThreshold = Math.max(1.0, sphereRadius * 0.08);

    const snapped = findNearestVertex(hit.point, vertices, snapThreshold);
    return snapped;
  };

  const handlePointerMove = (e) => {
    if (toolMode === "none") {
      if (hoverSnapPoint) setHoverSnapPoint(null);
      return;
    }
    const ctx = getActiveSceneContext(e);
    if (!ctx) {
      if (hoverSnapPoint) setHoverSnapPoint(null);
      return;
    }
    const hit = getSnapHit(e, ctx);
    setHoverSnapPoint(hit);
  };

  const handlePointerLeave = () => {
    setHoverSnapPoint(null);
  };

  const handleClickCanvas = (e) => {
    if (toolMode === "none") return;
    const ctx = getActiveSceneContext(e);
    if (!ctx) return;
    const hit = getSnapHit(e, ctx);
    if (!hit) return;

    if (toolMode === "measure") {
      const nextPoints = [...currentMeasurePoints, hit];
      if (nextPoints.length === 2) {
        // 2点クリックでスマート認識
        const isChamfer = hit.snapped && Math.abs(hit.x - nextPoints[0].x) > 0.5 && Math.abs(hit.y - nextPoints[0].y) > 0.5;
        const newM = createSmartMeasurement(
          `m-${Date.now()}`,
          nextPoints,
          "auto",
          { isChamferFace: isChamfer }
        );
        setMeasurements((prev) => [...prev, newM]);
        setCurrentMeasurePoints([]);
        setHoverSnapPoint(null);
      } else {
        setCurrentMeasurePoints(nextPoints);
      }
    } else if (toolMode === "annotate") {
      const newAnnot = createAnnotation(`a-${Date.now()}`, hit, "");
      setAnnotations((prev) => [...prev, newAnnot]);
      setToolMode("none");
      setHoverSnapPoint(null);
    }
  };

  const handleUpdateMeasurement = (id, fields) => {
    setMeasurements((prev) =>
      prev.map((m) => (m.id === id ? { ...m, ...fields } : m))
    );
  };

  const handleDeleteMeasurement = (id) => {
    setMeasurements((prev) => prev.filter((m) => m.id !== id));
  };

  const handleClearMeasurements = () => {
    setMeasurements([]);
    setCurrentMeasurePoints([]);
  };

  const handleUpdateAnnotation = (id, fields) => {
    setAnnotations((prev) =>
      prev.map((a) => (a.id === id ? { ...a, ...fields } : a))
    );
  };

  const handleDeleteAnnotation = (id) => {
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
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
              className={`three-diff-btn ${toolMode === "measure" ? "three-diff-btn-primary" : ""}`}
              onClick={() => {
                setToolMode((prev) => (prev === "measure" ? "none" : "measure"));
                setCurrentMeasurePoints([]);
                setHoverSnapPoint(null);
              }}
              title="寸法を計測してピン留め (頂点スナップ・スマート認識付き)"
            >
              <Ruler size={14} />
              寸法
            </button>

            <button
              className={`three-diff-btn ${toolMode === "annotate" ? "three-diff-btn-primary" : ""}`}
              onClick={() => {
                setToolMode((prev) => (prev === "annotate" ? "none" : "annotate"));
                setCurrentMeasurePoints([]);
                setHoverSnapPoint(null);
              }}
              title="3Dモデル表面に注記（メモ）を追加"
            >
              <MessageSquare size={14} />
              注記
            </button>

            <button
              className={`three-diff-btn ${showSection ? "three-diff-btn-primary" : ""}`}
              onClick={() => setShowSection(!showSection)}
              title="CAD中実ハッチング断面表示の切替"
            >
              <Scissors size={14} />
              断面
            </button>

            <button
              className={`three-diff-btn ${showEdges ? "three-diff-btn-primary" : ""}`}
              onClick={() => setShowEdges(!showEdges)}
              title="CAD輪郭線 (エッジ) 表示の切替"
            >
              <Square size={14} />
              エッジ
            </button>

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

      {/* 断面コントロールバー */}
      {meshData && showSection && (
        <div className="three-diff-section-toolbar">
          <div className="three-diff-input-group">
            <span style={{ fontWeight: 600, color: "#38bdf8" }}>✂ 断面切断:</span>
            <label>切断軸:</label>
            <div className="three-diff-axis-buttons">
              {["x", "y", "z"].map((axis) => (
                <button
                  key={axis}
                  className={`three-diff-axis-btn ${sectionAxis === axis ? "active" : ""}`}
                  onClick={() => {
                    setSectionAxis(axis);
                    setSectionPosition(0.0);
                  }}
                >
                  {axis.toUpperCase()}軸
                </button>
              ))}
            </div>
          </div>

          <div className="three-diff-slider-box" style={{ flex: 1, maxWidth: "420px" }}>
            <label>位置 ({sectionAxis.toUpperCase()}):</label>
            <input
              type="range"
              min={sectionBounds.min}
              max={sectionBounds.max}
              step="0.5"
              value={sectionPosition}
              onChange={(e) => setSectionPosition(parseFloat(e.target.value))}
            />
            <input
              type="number"
              className="three-diff-input"
              style={{ width: "68px" }}
              step="0.5"
              value={sectionPosition}
              onChange={(e) => setSectionPosition(parseFloat(e.target.value) || 0)}
            />
            <span>mm</span>
          </div>

          <button
            className={`three-diff-btn ${sectionFlipped ? "three-diff-btn-primary" : ""}`}
            onClick={() => setSectionFlipped(!sectionFlipped)}
            title="切断方向を反転"
          >
            反転 (Flip)
          </button>
        </div>
      )}

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
                <div
                  className="three-diff-viewport"
                  ref={leftContainerRef}
                  onPointerMove={handlePointerMove}
                  onPointerLeave={handlePointerLeave}
                  onClick={handleClickCanvas}
                  style={{
                    position: "relative",
                    cursor: toolMode !== "none" ? "crosshair" : "default",
                  }}
                >
                  <div className="viewport-label">旧版 (削除部: 赤)</div>
                  {sideBySideRef.current?.cameraL && (
                    <MeasureAnnotationLayer
                      key={`layer-left-${cameraVersion}`}
                      width={leftContainerRef.current?.clientWidth || viewportSize.width}
                      height={leftContainerRef.current?.clientHeight || viewportSize.height}
                      camera={sideBySideRef.current.cameraL}
                      activeMode={toolMode}
                      measurements={measurements}
                      onUpdateMeasurement={handleUpdateMeasurement}
                      onDeleteMeasurement={handleDeleteMeasurement}
                      onClearMeasurements={handleClearMeasurements}
                      currentMeasurePoints={currentMeasurePoints}
                      hoverSnapPoint={hoverSnapPoint}
                      annotations={annotations}
                      onUpdateAnnotation={handleUpdateAnnotation}
                      onDeleteAnnotation={handleDeleteAnnotation}
                    />
                  )}
                </div>
                <div
                  className="three-diff-viewport"
                  ref={rightContainerRef}
                  onPointerMove={handlePointerMove}
                  onPointerLeave={handlePointerLeave}
                  onClick={handleClickCanvas}
                  style={{
                    borderLeft: "1px solid #334155",
                    position: "relative",
                    cursor: toolMode !== "none" ? "crosshair" : "default",
                  }}
                >
                  <div className="viewport-label">新版 (追加部: 緑)</div>
                  {sideBySideRef.current?.cameraR && (
                    <MeasureAnnotationLayer
                      key={`layer-right-${cameraVersion}`}
                      width={rightContainerRef.current?.clientWidth || viewportSize.width}
                      height={rightContainerRef.current?.clientHeight || viewportSize.height}
                      camera={sideBySideRef.current.cameraR}
                      activeMode={toolMode}
                      measurements={measurements}
                      onUpdateMeasurement={handleUpdateMeasurement}
                      onDeleteMeasurement={handleDeleteMeasurement}
                      onClearMeasurements={handleClearMeasurements}
                      currentMeasurePoints={currentMeasurePoints}
                      hoverSnapPoint={hoverSnapPoint}
                      annotations={annotations}
                      onUpdateAnnotation={handleUpdateAnnotation}
                      onDeleteAnnotation={handleDeleteAnnotation}
                    />
                  )}
                </div>
              </>
            ) : (
              <div
                className="three-diff-viewport"
                ref={singleContainerRef}
                onPointerMove={handlePointerMove}
                onPointerLeave={handlePointerLeave}
                onClick={handleClickCanvas}
                style={{
                  position: "relative",
                  cursor: toolMode !== "none" ? "crosshair" : "default",
                }}
              >
                <div className="viewport-label">
                  {viewMode === "overlay" && "重ね表示 (緑: 追加 / 赤: 削除 / グレー: 一致)"}
                  {viewMode === "new" && "新版 (緑: 追加 / グレー: 一致)"}
                  {viewMode === "old" && "旧版 (赤: 削除 / グレー: 一致)"}
                </div>
                {singleSceneRef.current?.camera && (
                  <MeasureAnnotationLayer
                    key={`layer-single-${cameraVersion}`}
                    width={singleContainerRef.current?.clientWidth || viewportSize.width}
                    height={singleContainerRef.current?.clientHeight || viewportSize.height}
                    camera={singleSceneRef.current.camera}
                    activeMode={toolMode}
                    measurements={measurements}
                    onUpdateMeasurement={handleUpdateMeasurement}
                    onDeleteMeasurement={handleDeleteMeasurement}
                    onClearMeasurements={handleClearMeasurements}
                    currentMeasurePoints={currentMeasurePoints}
                    hoverSnapPoint={hoverSnapPoint}
                    annotations={annotations}
                    onUpdateAnnotation={handleUpdateAnnotation}
                    onDeleteAnnotation={handleDeleteAnnotation}
                  />
                )}
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
