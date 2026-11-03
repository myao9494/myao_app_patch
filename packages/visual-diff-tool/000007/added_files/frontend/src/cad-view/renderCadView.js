/**
 * Markdown内の3D表示を、プラグイン（Dagnetz CAD Viewer）の印刷用画像と同じ手順で PNG にする。
 * - 白い背景に、モデル・注記（札と引出線）・座標軸（左下）を重ねる
 * - 照明・材質・輪郭線・カメラ（平行投影の viewHeight、視点の名前、90°回転）はプラグインの値に合わせる
 * - 断面はクリッピング平面とステンシルの中実キャップ（3D差分ビューアと同じ部品）で描く
 * - HEAD と作業ツリーを同じ描き方で描くので、比べたときに違うのはノートの設定とモデルの差だけになる
 * Three.js を含むため、Git差分で3D表示を開いたときだけ読み込む（React.lazy と同じく動的 import）。
 */
import * as THREE from "three";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";
import { createHatchTexture, createSectionStencilGroup } from "../three-diff/sectionPlane.js";
import {
  CAD_VIEW_PIXEL_RATIO,
  LABEL_LINE_HEIGHT,
  LABEL_MAX_WIDTH,
  LABEL_PADDING,
  annotationCaption,
  annotationFontPx,
  cadViewSize,
  fitCamera,
  orthoZoom,
  placeLabel,
  readablePrintColor,
  sectionPlaneSpec,
  viewDirection,
  wrapPrintText,
} from "./cadViewModel.js";

const MODEL_COLOR = 0xcccccc;
const EDGE_COLOR = 0x222222;
const EDGE_THRESHOLD_ANGLE = 30;
const EDGE_TRIANGLE_BUDGET = 1_500_000; // 大きなモデルでは輪郭線を省く（プラグインと同じ上限）
const LEADER_COLOR = "#656565";
const ARROW_SIZE = 7;
const PIN_RADIUS = 4;
const AXES = [
  { label: "X", color: "#e5484d", dir: new THREE.Vector3(1, 0, 0) },
  { label: "Y", color: "#30a46c", dir: new THREE.Vector3(0, 1, 0) },
  { label: "Z", color: "#3b82f6", dir: new THREE.Vector3(0, 0, 1) },
];
const AXIS_MARGIN = 46;
const AXIS_LENGTH = 30;
const AXIS_LABEL_GAP = 11;

/** VDM1（バックエンドがSTEPから作ったメッシュ）を、位置と三角形だけのジオメトリにする。 */
export function geometryFromVdm1(parsed) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(parsed.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(parsed.indices, 1));
  return geometry;
}

/** STL / OBJ のファイルを、ローダーの変換を焼き込んだ1つのジオメトリにする。 */
export function geometryFromModelFile(format, buffer) {
  if (format === "stl") return new STLLoader().parse(buffer);
  const root = new OBJLoader().parse(new TextDecoder().decode(buffer));
  const chunks = [];
  root.updateMatrixWorld(true);
  root.traverse((object) => {
    if (!object.isMesh) return;
    const geometry = (object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone()).applyMatrix4(object.matrixWorld);
    chunks.push(geometry.getAttribute("position").array);
  });
  const positions = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  chunks.reduce((offset, chunk) => {
    positions.set(chunk, offset);
    return offset + chunk.length;
  }, 0);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return geometry;
}

/** 3D表示の設定（コードブロック）とモデルのジオメトリから PNG（Blob）を作る。 */
export async function renderCadViewImage(geometry, config) {
  const size = cadViewSize(config);
  const pixelRatio = Math.max(window.devicePixelRatio || 1, CAD_VIEW_PIXEL_RATIO);
  const scene = new THREE.Scene();
  const disposables = [];

  // モデルの姿勢（90°回転など）はジオメトリへ焼き込み、注記の錨にも同じ変換を当てる
  const rawBox = boxOf(geometry);
  const camera = createCamera(config, rawBox, size);
  const modelMatrix = modelTransform(config, camera.userData.target);
  const placed = geometry.clone().applyMatrix4(modelMatrix);
  disposables.push(placed);
  const model = buildModel(placed, disposables);
  scene.add(model);
  addLights(scene);

  const box = boxOf(placed);
  const section = sectionPlaneSpec(config.section, box);
  if (section) applySection(scene, model, section, box, disposables);

  const canvas = document.createElement("canvas");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, stencil: true, preserveDrawingBuffer: true });
  try {
    renderer.localClippingEnabled = true;
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(size.width, size.height, false);
    renderer.setClearColor(0xffffff, 0);
    renderer.render(scene, camera);

    const output = document.createElement("canvas");
    output.width = Math.round(size.width * pixelRatio);
    output.height = Math.round(size.height * pixelRatio);
    const ctx = output.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, output.width, output.height);
    ctx.drawImage(canvas, 0, 0, output.width, output.height);
    if (config.showAnnotations !== false) {
      drawAnnotations(ctx, config.annotations ?? [], modelMatrix, camera, size, pixelRatio);
    }
    drawAxes(ctx, camera, new THREE.Quaternion().setFromRotationMatrix(modelMatrix), size.height, pixelRatio);
    return await new Promise((resolve, reject) => {
      output.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("3D表示を画像にできませんでした"))), "image/png");
    });
  } finally {
    disposables.forEach((item) => item.dispose?.());
    renderer.dispose();
    renderer.forceContextLoss();
  }
}

function boxOf(geometry) {
  geometry.computeBoundingBox();
  const { min, max } = geometry.boundingBox;
  return { min: min.toArray(), max: max.toArray() };
}

/** プラグインと同じく、まず全体が入るように合わせ、コードブロックの視点（位置・注視点・見えている高さ）を当てる。 */
function createCamera(config, box, size) {
  const aspect = size.width / size.height;
  const perspective = Boolean(config.camera?.perspective);
  const fit = fitCamera(box, aspect, perspective);
  const camera = perspective
    ? new THREE.PerspectiveCamera(45, aspect, fit.near, fit.far)
    : new THREE.OrthographicCamera(-fit.halfWidth, fit.halfWidth, fit.halfHeight, -fit.halfHeight, fit.near, fit.far);
  const target = new THREE.Vector3(...fit.center);
  camera.position.set(...fit.position);

  if (config.camera) {
    camera.position.set(...config.camera.position);
    target.set(...config.camera.target);
    if (!perspective) camera.zoom = orthoZoom(config.camera, fit.halfHeight);
  } else {
    const direction = viewDirection(config.view);
    if (direction) {
      const distance = camera.position.distanceTo(target) || 1;
      camera.position.copy(target).addScaledVector(new THREE.Vector3(...direction).normalize(), distance);
    }
  }
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  camera.userData.target = target;
  return camera;
}

/** 保存されたモデルの位置・回転、またはカメラ指定が無いときの roll（視線まわりの90°回転）。 */
function modelTransform(config, target) {
  const matrix = new THREE.Matrix4();
  const camera = config.camera;
  if (camera?.modelPosition && camera?.modelRotation) {
    return matrix.compose(
      new THREE.Vector3(...camera.modelPosition),
      new THREE.Quaternion(...camera.modelRotation),
      new THREE.Vector3(1, 1, 1),
    );
  }
  if (!camera && config.roll) {
    const direction = viewDirection(config.view) ?? [1, 0.8, 1];
    const axis = new THREE.Vector3(...direction).normalize().negate(); // 視線の向き（カメラ → 注視点）
    const rotation = new THREE.Matrix4().makeRotationAxis(axis, (config.roll * Math.PI) / 2);
    return matrix
      .makeTranslation(target.x, target.y, target.z)
      .multiply(rotation)
      .multiply(new THREE.Matrix4().makeTranslation(-target.x, -target.y, -target.z));
  }
  return matrix;
}

function buildModel(geometry, disposables) {
  const shaded = geometry.index ? toCreasedNormals(geometry, (EDGE_THRESHOLD_ANGLE * Math.PI) / 180) : geometry.clone();
  if (!shaded.getAttribute("normal")) shaded.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({ color: MODEL_COLOR, metalness: 0.1, roughness: 0.7, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(shaded, material);
  mesh.name = "cad-model";
  disposables.push(shaded, material);

  const triangles = (geometry.index ? geometry.index.count : geometry.getAttribute("position").count) / 3;
  if (triangles <= EDGE_TRIANGLE_BUDGET) {
    const edgesGeometry = new THREE.EdgesGeometry(geometry, EDGE_THRESHOLD_ANGLE);
    const edgesMaterial = new THREE.LineBasicMaterial({ color: EDGE_COLOR });
    const edges = new THREE.LineSegments(edgesGeometry, edgesMaterial);
    edges.name = "cad-edges";
    mesh.add(edges);
    disposables.push(edgesGeometry, edgesMaterial);
  }
  return mesh;
}

/** プラグインの照明（環境光 0.9、主光 1.2、補助光 0.5）。光源はワールドに固定する。 */
function addLights(scene) {
  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const main = new THREE.DirectionalLight(0xffffff, 1.2);
  main.position.set(1, 1, 1);
  scene.add(main);
  const fill = new THREE.DirectionalLight(0xffffff, 0.5);
  fill.position.set(-1, -0.5, -1);
  scene.add(fill);
}

function applySection(scene, model, spec, box, disposables) {
  const plane = new THREE.Plane(new THREE.Vector3(...spec.normal), spec.constant);
  model.material.clippingPlanes = [plane];
  model.children.forEach((child) => {
    if (child.material) child.material.clippingPlanes = [plane];
  });
  const hatch = createHatchTexture();
  disposables.push(hatch);
  const bounds = new THREE.Box3(new THREE.Vector3(...box.min), new THREE.Vector3(...box.max));
  scene.add(createSectionStencilGroup(scene, plane, bounds, hatch));
}

/** 注記の錨（ピン）と札、引出線を描く。札の大きさと折り返しはプラグインの印刷用画像と同じ。 */
function drawAnnotations(ctx, annotations, modelMatrix, camera, size, scale) {
  const projected = new THREE.Vector3();
  const labels = annotations.flatMap((annotation) => {
    projected.set(annotation.x, annotation.y, annotation.z).applyMatrix4(modelMatrix).project(camera);
    if (projected.z > 1 || projected.z < -1) return [];
    const anchor = { x: (projected.x * 0.5 + 0.5) * size.width, y: (-projected.y * 0.5 + 0.5) * size.height };
    const text = annotationCaption(annotation.text);
    const fontPx = annotationFontPx(annotation.fontSize);
    const font = `${fontPx * scale}px sans-serif`;
    ctx.font = font;
    const measure = (line) => ctx.measureText(line).width / scale;
    const lines = text ? wrapPrintText(text, LABEL_MAX_WIDTH, measure) : [];
    const lineHeight = fontPx * LABEL_LINE_HEIGHT;
    const box = { width: Math.max(0, ...lines.map(measure)) + LABEL_PADDING * 2, height: lines.length * lineHeight + 4 };
    const place = placeLabel(anchor, annotation, box, size);
    return [{ annotation, anchor, lines, font, lineHeight, box, ...place, color: readablePrintColor(annotation.textColor) }];
  });

  ctx.save();
  // 引出線を先に描き、ほかの札の文字の上に線が重ならないようにする
  for (const label of labels) {
    if (label.leader && label.lines.length) drawLeader(ctx, label.cx * scale, label.cy * scale, label.anchor.x * scale, label.anchor.y * scale, scale);
  }
  for (const label of labels) {
    ctx.beginPath();
    ctx.arc(label.anchor.x * scale, label.anchor.y * scale, PIN_RADIUS * scale, 0, Math.PI * 2);
    ctx.fillStyle = label.annotation.color || "#ffc531";
    ctx.fill();
    ctx.lineWidth = scale;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
  }
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  for (const label of labels) {
    if (!label.lines.length) continue;
    ctx.fillStyle = "rgba(255,255,255,0.88)";
    ctx.fillRect((label.cx - label.box.width / 2) * scale, (label.cy - label.box.height / 2) * scale, label.box.width * scale, label.box.height * scale);
    ctx.font = label.font;
    ctx.fillStyle = label.color;
    label.lines.forEach((line, i) => {
      const offset = (i - (label.lines.length - 1) / 2) * label.lineHeight;
      ctx.fillText(line, label.cx * scale, (label.cy + offset) * scale);
    });
  }
  ctx.restore();
}

function drawLeader(ctx, fromX, fromY, toX, toY, scale) {
  const angle = Math.atan2(toY - fromY, toX - fromX);
  const size = ARROW_SIZE * scale;
  ctx.save();
  ctx.strokeStyle = LEADER_COLOR;
  ctx.fillStyle = LEADER_COLOR;
  ctx.lineWidth = 1.5 * scale;
  ctx.setLineDash([3 * scale, 3 * scale]);
  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.lineTo(toX, toY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(toX - size * Math.cos(angle - 0.45), toY - size * Math.sin(angle - 0.45));
  ctx.lineTo(toX - size * Math.cos(angle + 0.45), toY - size * Math.sin(angle + 0.45));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** モデルの X/Y/Z 軸が画面で向く方向を左下に描く（奥の軸から順に）。 */
function drawAxes(ctx, camera, modelQuaternion, height, scale) {
  const toCamera = camera.quaternion.clone().invert();
  const axes = AXES.map(({ label, color, dir }) => {
    const v = dir.clone().applyQuaternion(modelQuaternion).applyQuaternion(toCamera);
    return { label, color, x: v.x, y: v.y, depth: v.z };
  }).sort((a, b) => a.depth - b.depth);
  const ox = AXIS_MARGIN * scale;
  const oy = (height - AXIS_MARGIN) * scale;
  ctx.save();
  ctx.lineWidth = 2 * scale;
  ctx.lineCap = "round";
  ctx.font = `bold ${Math.round(12 * scale)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const axis of axes) {
    ctx.strokeStyle = axis.color;
    ctx.fillStyle = axis.color;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(ox + axis.x * AXIS_LENGTH * scale, oy - axis.y * AXIS_LENGTH * scale);
    ctx.stroke();
    const distance = (AXIS_LENGTH + AXIS_LABEL_GAP) * scale;
    ctx.fillText(axis.label, ox + axis.x * distance, oy - axis.y * distance);
  }
  ctx.restore();
}
