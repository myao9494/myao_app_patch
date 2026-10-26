// =============================================================================
// draw.io の図を Excalidraw の図（図形ごとに編集できる .excalidraw.md）へ変換する
// =============================================================================
//
// draw.io の元データ（mxGraphModel の XML）を読み、図形・文字・矢印を Excalidraw Automate（EA）で作り直す。
// SVG を Excalidraw に取り込む方法（ea.importSVG）は文字を変換できないため使わない。
// 元の draw.io ファイルは変更せず、同じフォルダに新しい .excalidraw.md を作り、
// ノート内の元の図の埋め込みのすぐ下に、変換した図の埋め込み（![[名前.excalidraw]]）を追加する。
// 仕様: docs/drawio_to_excalidraw_spec.md

const DRAWIO_FILE_PATTERN = /\.(?:drawio|dio)(?:\.svg|\.png)?$/i;
// Excalidraw の文字の既定フォント（6: Nunito。手書き風でない通常の字体）
const DRAWIO_EXCALIDRAW_FONT_FAMILY = 6;
// Excalidraw が図形の内側に文字を置くときの余白（BOUND_TEXT_PADDING）
const DRAWIO_BOUND_TEXT_PADDING = 5;
// 複数ページの図を横に並べるときの間隔
const DRAWIO_PAGE_GAP = 200;

const isDrawioConvertibleFile = (file) => DRAWIO_FILE_PATTERN.test(file?.name || file?.path || "");

// XML の文字参照（&lt; &#10; など）を文字へ戻す
const decodeXmlEntities = (text) => String(text ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

const parseXmlAttributes = (source) => {
    const attrs = {};
    const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let match;
    while ((match = pattern.exec(source || ""))) {
        attrs[match[1]] = decodeXmlEntities(match[2] ?? match[3] ?? "");
    }
    return attrs;
};

/**
 * draw.io の XML を、{ name, attrs, children, text } の木にする（コメント・XML宣言は読み飛ばす）。
 * Obsidian と Node のテストの両方で動くよう、DOMParser を使わずに読む。
 **/
const parseXmlTree = (xml) => {
    const root = { name: "#root", attrs: {}, children: [], text: "" };
    const stack = [root];
    const pattern = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
    let match;
    while ((match = pattern.exec(xml || ""))) {
        const [, cdata, closing, name, attrSource, selfClosing, text] = match;
        const current = stack[stack.length - 1];
        if (cdata !== undefined) {
            current.text += cdata;
        } else if (text !== undefined) {
            current.text += decodeXmlEntities(text);
        } else if (name && closing) {
            const index = stack.map((node) => node.name).lastIndexOf(name);
            if (index > 0) stack.length = index;
        } else if (name) {
            const node = { name, attrs: parseXmlAttributes(attrSource), children: [], text: "" };
            current.children.push(node);
            if (!selfClosing) stack.push(node);
        }
    }
    return root;
};

const findXmlElements = (node, name) => {
    const found = [];
    const visit = (current) => {
        for (const child of current.children || []) {
            if (child.name === name) found.push(child);
            visit(child);
        }
    };
    visit(node);
    return found;
};

// draw.io が書き出した SVG（.drawio.svg）の content 属性から、元の図の XML（mxfile）を取り出す
const extractDrawioXmlFromSvg = (svgText) => {
    const svgTag = String(svgText || "").match(/<svg\b[^>]*>/i)?.[0];
    if (!svgTag) return null;
    const content = parseXmlAttributes(svgTag.slice(4)).content;
    return content && /<(?:mxfile|mxGraphModel)\b/.test(content) ? content : null;
};

// draw.io が書き出した PNG（.drawio.png）の tEXt チャンク（キーワード mxfile）から、元の図の XML を取り出す
const extractDrawioXmlFromPng = (bytes) => {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let offset = 8;
    while (offset + 8 <= data.length) {
        const length = ((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]) >>> 0;
        const type = String.fromCharCode(...data.subarray(offset + 4, offset + 8));
        if (type === "tEXt") {
            const chunk = data.subarray(offset + 8, offset + 8 + length);
            const separator = chunk.indexOf(0);
            const keyword = String.fromCharCode(...chunk.subarray(0, separator));
            if (keyword === "mxfile") {
                const value = Array.from(chunk.subarray(separator + 1), (code) => String.fromCharCode(code)).join("");
                try {
                    return decodeURIComponent(value);
                } catch {
                    return value;
                }
            }
        }
        if (type === "IEND") break;
        offset += 12 + length;
    }
    return null;
};

// raw deflate（draw.io の圧縮形式）を展開する
const inflateRawBytes = async (bytes) => {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
};

/**
 * <diagram> の本文を mxGraphModel の XML にする。
 * 圧縮されている場合は「base64 → raw deflate の展開 → URL デコード」の順に戻す。
 **/
const decodeDrawioDiagramPayload = async (payload, inflateRaw = inflateRawBytes) => {
    const text = String(payload || "").trim();
    if (!text || text.startsWith("<")) return text;
    const binary = atob(text);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const inflated = new TextDecoder("utf-8").decode(await inflateRaw(bytes));
    try {
        return decodeURIComponent(inflated);
    } catch {
        return inflated;
    }
};

const toDrawioNumber = (value, fallback = 0) => {
    const number = parseFloat(value);
    return Number.isFinite(number) ? number : fallback;
};

const readDrawioPoint = (node) => node ? { x: toDrawioNumber(node.attrs.x), y: toDrawioNumber(node.attrs.y) } : null;

// mxCell（<object> / <UserObject> で包まれている場合はその属性も）を、扱いやすい形にする
const readDrawioCell = (cellNode, wrapper = null) => {
    const attrs = { ...cellNode.attrs, ...(wrapper ? { id: wrapper.attrs.id } : {}) };
    const geometryNode = cellNode.children.find((child) => child.name === "mxGeometry");
    const geometryPoints = geometryNode?.children || [];
    const pointsArray = geometryPoints.find((child) => child.name === "Array" && child.attrs.as === "points");
    return {
        id: attrs.id,
        parent: attrs.parent ?? null,
        value: wrapper ? (wrapper.attrs.label ?? "") : (attrs.value ?? ""),
        link: wrapper?.attrs.link || null,
        style: attrs.style ?? "",
        vertex: attrs.vertex === "1",
        edge: attrs.edge === "1",
        source: attrs.source ?? null,
        target: attrs.target ?? null,
        geometry: geometryNode ? {
            x: toDrawioNumber(geometryNode.attrs.x),
            y: toDrawioNumber(geometryNode.attrs.y),
            width: toDrawioNumber(geometryNode.attrs.width),
            height: toDrawioNumber(geometryNode.attrs.height),
            relative: geometryNode.attrs.relative === "1",
            sourcePoint: readDrawioPoint(geometryPoints.find((child) => child.attrs.as === "sourcePoint")),
            targetPoint: readDrawioPoint(geometryPoints.find((child) => child.attrs.as === "targetPoint")),
            points: (pointsArray?.children || []).filter((child) => child.name === "mxPoint").map(readDrawioPoint),
        } : null,
    };
};

const readDrawioModelCells = (modelNode) => {
    const rootNode = modelNode.children.find((child) => child.name === "root") || modelNode;
    const cells = [];
    for (const child of rootNode.children) {
        if (child.name === "mxCell") {
            cells.push(readDrawioCell(child));
        } else if (child.name === "object" || child.name === "UserObject") {
            const cellNode = child.children.find((grandChild) => grandChild.name === "mxCell");
            if (cellNode) cells.push(readDrawioCell(cellNode, child));
        }
    }
    return cells;
};

/**
 * draw.io のファイルの XML（mxfile、または mxGraphModel だけのもの）を、ページごとのセルの一覧にする。
 * @returns {Promise<{ name: string, cells: object[] }[]>}
 **/
const parseDrawioPages = async (xml, inflateRaw = inflateRawBytes) => {
    const tree = parseXmlTree(xml);
    const diagrams = findXmlElements(tree, "diagram");
    if (diagrams.length === 0) {
        const model = findXmlElements(tree, "mxGraphModel")[0];
        return model ? [{ name: "Page-1", cells: readDrawioModelCells(model) }] : [];
    }
    const pages = [];
    for (const [index, diagram] of diagrams.entries()) {
        let model = diagram.children.find((child) => child.name === "mxGraphModel");
        if (!model) {
            const decoded = await decodeDrawioDiagramPayload(diagram.text, inflateRaw);
            model = findXmlElements(parseXmlTree(decoded), "mxGraphModel")[0];
        }
        if (model) pages.push({ name: diagram.attrs.name || `Page-${index + 1}`, cells: readDrawioModelCells(model) });
    }
    return pages;
};

// "rounded=1;whiteSpace=wrap;ellipse" を { rounded: "1", whiteSpace: "wrap", ellipse: true, _base: "rounded=1" } にする
const parseDrawioStyle = (style) => {
    const result = {};
    const entries = String(style || "").split(";").map((entry) => entry.trim()).filter(Boolean);
    entries.forEach((entry, index) => {
        const separator = entry.indexOf("=");
        if (separator < 0) {
            result[entry] = true;
            if (index === 0) result._base = entry;
        } else {
            result[entry.slice(0, separator)] = entry.slice(separator + 1);
        }
    });
    return result;
};

// ラベル（html=1 の場合は HTML）を、改行を保ったプレーンテキストにする。
// 末尾の改行（"Project<br>" など）は、draw.io で文字を上へ寄せるために使われるため残す
const drawioLabelToText = (value, isHtml) => {
    let text = String(value ?? "");
    if (isHtml) {
        text = text
            // 末尾のブロックの閉じタグ（</div>）は改行にしない
            .replace(/(?:<\/(?:div|p|li|h[1-6]|tr)>\s*)+$/i, "")
            .replace(/<br\s*\/?>/gi, "\n")
            // 隣り合うブロック（</div><div>）の間は1回だけ改行する
            .replace(/<\/(?:div|p|li|h[1-6]|tr)>\s*<(?:div|p|li|h[1-6]|tr)\b[^>]*>/gi, "\n")
            .replace(/<\/(?:div|p|li|h[1-6]|tr)>/gi, "\n")
            .replace(/<(?:div|p|li|h[1-6]|tr)\b[^>]*>/gi, (tag, offset) => (offset > 0 ? "\n" : ""))
            .replace(/<[^>]+>/g, "");
        text = decodeXmlEntities(text);
    }
    text = text
        .replace(/\u00a0/g, " ")
        .split("\n")
        .map((line) => line.replace(/\s+$/, ""))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/^\s+/, "");
    // 文字が無いラベル（改行だけ）は空にする
    return /\S/.test(text) ? text : "";
};

const resolveDrawioColor = (value, fallback) => {
    if (value === undefined || value === "" || value === "default" || value === "inherit") return fallback;
    if (value === "none") return "transparent";
    return value;
};

// draw.io の図形名（一般の図形と、フローチャートの図形 mxgraph.flowchart.*）→ Excalidraw で作る形
const DRAWIO_SHAPE_KINDS = {
    rectangle: "rectangle",
    label: "rectangle",
    "mxgraph.flowchart.process": "rectangle",
    ellipse: "ellipse",
    doubleEllipse: "ellipse",
    "mxgraph.flowchart.start_1": "ellipse",
    "mxgraph.flowchart.start_2": "ellipse",
    "mxgraph.flowchart.on-page_reference": "ellipse",
    "mxgraph.flowchart.or": "ellipse",
    "mxgraph.flowchart.summing_function": "ellipse",
    rhombus: "diamond",
    "mxgraph.flowchart.decision": "diamond",
    "mxgraph.flowchart.sort": "diamond",
    "mxgraph.flowchart.terminator": "terminator",
    process: "process",
    "mxgraph.flowchart.predefined_process": "process",
    umlActor: "actor",
    swimlane: "swimlane",
    parallelogram: "parallelogram",
    "mxgraph.flowchart.data": "parallelogram",
    trapezoid: "trapezoid",
    "mxgraph.flowchart.manual_operation": "manualOperation",
    hexagon: "hexagon",
    "mxgraph.flowchart.preparation": "hexagon",
    triangle: "triangle",
    "mxgraph.flowchart.extract_or_measurement": "triangleUp",
    "mxgraph.flowchart.merge_or_storage": "triangleDown",
    document: "document",
    "mxgraph.flowchart.document": "document",
    "mxgraph.flowchart.multi-document": "document",
    tape: "tape",
    "mxgraph.flowchart.paper_tape": "tape",
    "mxgraph.flowchart.manual_input": "manualInput",
    cylinder: "cylinder",
    cylinder3: "cylinder",
    datastore: "cylinder",
    "mxgraph.flowchart.database": "cylinder",
    "mxgraph.flowchart.direct_data": "cylinder",
    step: "step",
    offPageConnector: "offPage",
    "mxgraph.flowchart.off-page_reference": "offPage",
    card: "card",
    "mxgraph.flowchart.card": "card",
    note: "note",
    "mxgraph.flowchart.delay": "delay",
    "mxgraph.flowchart.display": "display",
    "mxgraph.flowchart.stored_data": "storedData",
    "mxgraph.flowchart.loop_limit": "loopLimit",
    "mxgraph.flowchart.annotation_1": "annotation",
    "mxgraph.flowchart.annotation_2": "annotation",
};

// 図形の種類（Excalidraw で作る形）を決める。対応していない図形は "rectangle"（四角で代用）
const getDrawioShapeKind = (style) => {
    const shape = style.shape || style._base || "";
    if (style.text === true || style._base === "text" || style._base === "edgeLabel") return "text";
    if (shape === "group" || style.group === true) return "group";
    if (DRAWIO_SHAPE_KINDS[shape]) return DRAWIO_SHAPE_KINDS[shape];
    if (style.ellipse === true) return "ellipse";
    if (style.rhombus === true || style.perimeter === "rhombusPerimeter") return "diamond";
    if (style.triangle === true) return "triangle";
    return "rectangle";
};

// 対応表に無い図形（四角で代用したもの）か
const isDrawioShapeUnsupported = (style) => {
    const shape = style.shape || "";
    return Boolean(shape) && !DRAWIO_SHAPE_KINDS[shape] && getDrawioShapeKind(style) === "rectangle";
};

// 多角形・曲線で描く図形の輪郭（図形の枠を 0〜1 とした点の列）。closed: 閉じて塗る、extra: 補助線
const getDrawioOutline = (kind, width, height) => {
    const fx = (px, ratio) => Math.min(px / Math.max(width, 1), ratio);
    const fy = (px, ratio) => Math.min(px / Math.max(height, 1), ratio);
    const arc = (cx, cy, rx, ry, from, to, steps = 10) => Array.from({ length: steps + 1 }, (_, index) => {
        const angle = from + (to - from) * (index / steps);
        return [cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)];
    });
    const wave = (fromX, toX, baseY, amplitude, steps = 12) => Array.from({ length: steps + 1 }, (_, index) => {
        const u = fromX + (toX - fromX) * (index / steps);
        return [u, baseY + amplitude * Math.sin(2 * Math.PI * u)];
    });
    const s = fx(20, 0.25);
    switch (kind) {
        case "parallelogram": return { points: [[s, 0], [1, 0], [1 - s, 1], [0, 1]], closed: true };
        case "trapezoid": return { points: [[s, 0], [1 - s, 0], [1, 1], [0, 1]], closed: true };
        case "manualOperation": return { points: [[0, 0], [1, 0], [1 - s, 1], [s, 1]], closed: true };
        case "hexagon": return { points: [[s, 0], [1 - s, 0], [1, 0.5], [1 - s, 1], [s, 1], [0, 0.5]], closed: true };
        case "triangle": return { points: [[0, 0], [1, 0.5], [0, 1]], closed: true };
        case "triangleUp": return { points: [[0.5, 0], [1, 1], [0, 1]], closed: true };
        case "triangleDown": return { points: [[0, 0], [1, 0], [0.5, 1]], closed: true };
        case "step": return { points: [[0, 0], [1 - s, 0], [1, 0.5], [1 - s, 1], [0, 1], [s, 0.5]], closed: true };
        case "offPage": return { points: [[0, 0], [1, 0], [1, 0.7], [0.5, 1], [0, 0.7]], closed: true };
        case "manualInput": return { points: [[0, fy(height * 0.3, 0.3)], [1, 0], [1, 1], [0, 1]], closed: true };
        case "card": return { points: [[s, 0], [1, 0], [1, 1], [0, 1], [0, fy(20, 0.25)]], closed: true };
        case "loopLimit": return { points: [[s, 0], [1 - s, 0], [1, fy(20, 0.25)], [1, 1], [0, 1], [0, fy(20, 0.25)]], closed: true };
        case "note": {
            const cx = 1 - fx(30, 0.3);
            const cy = fy(30, 0.3);
            return { points: [[0, 0], [cx, 0], [1, cy], [1, 1], [0, 1]], closed: true, extra: [[[cx, 0], [cx, cy], [1, cy]]] };
        }
        case "document": return { points: [[0, 0], [1, 0], ...wave(1, 0, 0.9, 0.1)], closed: true };
        case "tape": return { points: [...wave(0, 1, 0.1, 0.1), ...wave(1, 0, 0.9, 0.1)], closed: true };
        case "cylinder": {
            const r = fy(15, 0.2);
            return {
                points: [...arc(0.5, r, 0.5, r, Math.PI, 2 * Math.PI), ...arc(0.5, 1 - r, 0.5, r, 0, Math.PI)],
                closed: true,
                extra: [arc(0.5, r, 0.5, r, Math.PI, 0)],
            };
        }
        case "delay": return { points: [[0, 0], ...arc(0.7, 0.5, 0.3, 0.5, -Math.PI / 2, Math.PI / 2), [0, 1]], closed: true };
        case "display": return { points: [[0, 0.5], [0.15, 0], ...arc(0.8, 0.5, 0.2, 0.5, -Math.PI / 2, Math.PI / 2), [0.15, 1]], closed: true };
        case "storedData": return {
            points: [...arc(0.15, 0.5, 0.15, 0.5, -Math.PI / 2, -Math.PI * 1.5), ...arc(1, 0.5, 0.15, 0.5, Math.PI / 2, Math.PI * 1.5)],
            closed: true,
        };
        case "annotation": return { points: [[1, 0], [0, 0], [0, 1], [1, 1]], closed: false };
        default: return null;
    }
};

// draw.io の direction（south など）と flipH / flipV を、輪郭の点（0〜1）に当てる
const transformDrawioOutlinePoint = ([u, v], { direction, flipH, flipV }) => {
    let point = [u, v];
    if (direction === "south") point = [1 - v, u];
    else if (direction === "north") point = [v, 1 - u];
    else if (direction === "west") point = [1 - u, 1 - v];
    if (flipH) point = [1 - point[0], point[1]];
    if (flipV) point = [point[0], 1 - point[1]];
    return point;
};

// draw.io の矢印の先端を Excalidraw の先端へ対応させる
const toExcalidrawArrowhead = (name, filled) => {
    if (!name || name === "none") return null;
    const outline = filled === "0";
    // draw.io の既定の先端（classic）は塗りつぶした三角形のため、Excalidraw の triangle にする
    if (/^(?:block|blockThin|classic|classicThin)$/.test(name)) return outline ? "triangle_outline" : "triangle";
    if (/^(?:open|openThin|openAsync|async)$/.test(name)) return "arrow";
    if (/^(?:oval|dot|circle|circlePlus)$/.test(name)) return outline ? "circle_outline" : "circle";
    if (/^(?:diamond|diamondThin)$/.test(name)) return outline ? "diamond_outline" : "diamond";
    if (name === "dash") return "bar";
    if (name === "ERmany" || name === "ERzeroToMany") return "crowfoot_many";
    if (name === "ERone" || name === "ERmandOne") return "crowfoot_one";
    if (name === "ERoneToMany") return "crowfoot_one_or_many";
    return "arrow";
};

// draw.io の図形のリンクを Excalidraw のリンクにする（URL 以外は保管庫内のファイルへのリンクとみなす）
const toExcalidrawLink = (link) => {
    if (!link) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(link)) return link;
    return `[[${link.replace(/^\.\//, "")}]]`;
};

const roundDrawioPoint = (point) => ({ x: Math.round(point.x * 100) / 100, y: Math.round(point.y * 100) / 100 });

/**
 * 直交する折れ線（draw.io の orthogonalEdgeStyle）の点を整える。
 * わずかな斜めのずれを縦横へそろえ、同じ点・一直線上の途中の点を取り除く。
 **/
const orthogonalizeDrawioPoints = (points, tolerance = 1.5) => {
    const result = [];
    for (const point of points.map(roundDrawioPoint)) {
        const previous = result[result.length - 1];
        if (previous) {
            if (Math.abs(point.x - previous.x) <= tolerance) point.x = previous.x;
            if (Math.abs(point.y - previous.y) <= tolerance) point.y = previous.y;
            if (point.x === previous.x && point.y === previous.y) continue;
            if (point.x !== previous.x && point.y !== previous.y) {
                // 斜めの区間は、縦横の2区間に分ける（先に長い方向へ進む）
                const corner = Math.abs(point.x - previous.x) >= Math.abs(point.y - previous.y)
                    ? { x: point.x, y: previous.y }
                    : { x: previous.x, y: point.y };
                result.push(corner);
            }
        }
        result.push(point);
    }
    // 一直線上の途中の点を取り除く
    return result.filter((point, index) => {
        if (index === 0 || index === result.length - 1) return true;
        const before = result[index - 1];
        const after = result[index + 1];
        return !((before.x === point.x && point.x === after.x) || (before.y === point.y && point.y === after.y));
    });
};

// SVG の path（d 属性）から、通る点を順に取り出す（Q の角は制御点を角とみなす）
const parseSvgPathPoints = (d) => {
    const tokens = String(d || "").match(/[MLQCZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
    const points = [];
    let command = null;
    for (let index = 0; index < tokens.length;) {
        if (/^[MLQCZ]$/i.test(tokens[index])) {
            command = tokens[index].toUpperCase();
            index += 1;
            continue;
        }
        const numbers = tokens.slice(index).map(Number);
        if (command === "M" || command === "L") {
            points.push({ x: numbers[0], y: numbers[1] });
            index += 2;
        } else if (command === "Q") {
            points.push({ x: numbers[0], y: numbers[1] }, { x: numbers[2], y: numbers[3] });
            index += 4;
        } else if (command === "C") {
            points.push({ x: numbers[4], y: numbers[5] });
            index += 6;
        } else {
            index += 1;
        }
    }
    return points;
};

// 各セルの絶対位置（親の図形の中にある図形は親の位置を足す）を求める
const getDrawioAbsoluteBounds = (cell, cellsById, cache = new Map()) => {
    if (cache.has(cell.id)) return cache.get(cell.id);
    const geometry = cell.geometry || { x: 0, y: 0, width: 0, height: 0 };
    const parent = cellsById.get(cell.parent);
    const origin = parent?.vertex && parent.geometry
        ? getDrawioAbsoluteBounds(parent, cellsById, cache)
        : { x: 0, y: 0 };
    const bounds = { x: origin.x + geometry.x, y: origin.y + geometry.y, width: geometry.width, height: geometry.height };
    cache.set(cell.id, bounds);
    return bounds;
};

/**
 * draw.io の SVG に描かれている矢印の経路を、図のモデルの座標で取り出す。
 * 自動で引かれた直交の矢印は経路がモデルに保存されないため、SVG の描画結果を使う。
 * @returns {Record<string, {x:number,y:number}[]>} 矢印のセルIDごとの点の列
 **/
const extractDrawioSvgEdgeRoutes = (svgText, cells) => {
    const svg = String(svgText || "");
    const cellsById = new Map(cells.map((cell) => [cell.id, cell]));
    const groups = new Map();
    const groupPattern = /<g\b[^>]*\bdata-cell-id="([^"]+)"[^>]*>/g;
    const starts = [];
    let match;
    while ((match = groupPattern.exec(svg))) starts.push({ id: decodeXmlEntities(match[1]), index: match.index + match[0].length });
    starts.forEach((start, position) => {
        const end = starts[position + 1]?.index ?? svg.length;
        groups.set(start.id, svg.slice(start.index, end));
    });

    // SVG は図の左上を原点に描かれるため、図形の四角の位置から、モデルの座標とのずれを求める
    let offset = null;
    const boundsCache = new Map();
    for (const cell of cells) {
        if (!cell.vertex || !groups.has(cell.id)) continue;
        const rectTag = groups.get(cell.id).match(/<rect\b[^>]*>/)?.[0];
        if (!rectTag) continue;
        const rect = parseXmlAttributes(rectTag.slice(5));
        const bounds = getDrawioAbsoluteBounds(cell, cellsById, boundsCache);
        if (Math.abs(toDrawioNumber(rect.width) - bounds.width) > 1 || Math.abs(toDrawioNumber(rect.height) - bounds.height) > 1) continue;
        offset = { x: bounds.x - toDrawioNumber(rect.x), y: bounds.y - toDrawioNumber(rect.y) };
        break;
    }
    if (!offset) return {};

    const routes = {};
    for (const cell of cells) {
        if (!cell.edge || !groups.has(cell.id)) continue;
        const pathTag = groups.get(cell.id).match(/<path\b[^>]*\bd="([^"]+)"[^>]*>/);
        if (!pathTag) continue;
        const points = parseSvgPathPoints(pathTag[1]).map((point) => ({ x: point.x + offset.x, y: point.y + offset.y }));
        if (points.length >= 2) routes[cell.id] = points;
    }
    return routes;
};

// 図形の枠上の点（比率）を、絶対座標にする
const getDrawioPortPoint = (bounds, ratioX, ratioY) => ({
    x: bounds.x + bounds.width * ratioX,
    y: bounds.y + bounds.height * ratioY,
});

// 図形の中心から toward へ向かう線が、図形の枠と交わる点
const getDrawioBoundaryPoint = (bounds, toward) => {
    const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const dx = toward.x - center.x;
    const dy = toward.y - center.y;
    if (dx === 0 && dy === 0) return center;
    const scale = Math.min(
        dx === 0 ? Infinity : (bounds.width / 2) / Math.abs(dx),
        dy === 0 ? Infinity : (bounds.height / 2) / Math.abs(dy),
    );
    return { x: center.x + dx * scale, y: center.y + dy * scale };
};

const getDrawioCenter = (bounds) => ({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });

// 図形の中心から toward へ向かう線が、図形の輪郭（楕円・ひし形は曲線・斜辺）と交わる点
const getDrawioPerimeterPoint = (shape, toward) => {
    const center = getDrawioCenter(shape);
    const dx = toward.x - center.x;
    const dy = toward.y - center.y;
    const rx = shape.width / 2 || 1;
    const ry = shape.height / 2 || 1;
    if (dx === 0 && dy === 0) return center;
    if (shape.kind === "ellipse") {
        const t = 1 / Math.hypot(dx / rx, dy / ry);
        return { x: center.x + dx * t, y: center.y + dy * t };
    }
    if (shape.kind === "diamond") {
        const t = 1 / (Math.abs(dx) / rx + Math.abs(dy) / ry);
        return { x: center.x + dx * t, y: center.y + dy * t };
    }
    return getDrawioBoundaryPoint(shape, toward);
};

// 図形の辺（left / right / top / bottom）の中央
const getDrawioSidePoint = (bounds, side) => {
    const center = getDrawioCenter(bounds);
    if (side === "left") return { x: bounds.x, y: center.y };
    if (side === "right") return { x: bounds.x + bounds.width, y: center.y };
    if (side === "top") return { x: center.x, y: bounds.y };
    return { x: center.x, y: bounds.y + bounds.height };
};

// ポートの位置（比率）が、図形のどの辺にあるか
const getDrawioPortSide = ([ratioX, ratioY]) => {
    const distances = { left: ratioX, right: 1 - ratioX, top: ratioY, bottom: 1 - ratioY };
    return Object.entries(distances).sort((a, b) => a[1] - b[1])[0][0];
};

/**
 * 直交の矢印の経路を、図形の位置関係から作る（SVG の描画結果が無い場合）。
 * - ポート（exitX/entryX）があればその辺から、無ければ相手の図形に向いた辺の中央から出入りする。
 * - elbowEdgeStyle は elbow（horizontal / vertical）の向き、それ以外は図形の間の隙間が大きい向きに進む。
 * - elbowEdgeStyle の中継点1つは、折れ曲がる位置を表す。
 **/
const routeDrawioElbowEdgeFallback = ({ source, target, sourcePoint, targetPoint, waypoints, exit, entry, style }) => {
    const sourceBox = source || (sourcePoint ? { ...sourcePoint, width: 0, height: 0 } : null);
    const targetBox = target || (targetPoint ? { ...targetPoint, width: 0, height: 0 } : null);
    if (!sourceBox || !targetBox) return null;
    const sourceCenter = getDrawioCenter(sourceBox);
    const targetCenter = getDrawioCenter(targetBox);
    const horizontalGap = Math.max(targetBox.x - (sourceBox.x + sourceBox.width), sourceBox.x - (targetBox.x + targetBox.width));
    const verticalGap = Math.max(targetBox.y - (sourceBox.y + sourceBox.height), sourceBox.y - (targetBox.y + targetBox.height));
    const horizontal = style.edgeStyle === "elbowEdgeStyle"
        ? style.elbow !== "vertical"
        : horizontalGap >= verticalGap;
    const facing = (from, to) => (horizontal
        ? (to.x >= from.x ? "right" : "left")
        : (to.y >= from.y ? "bottom" : "top"));
    const startSide = exit && source ? getDrawioPortSide(exit) : facing(sourceCenter, waypoints[0] || targetCenter);
    const endSide = entry && target ? getDrawioPortSide(entry) : facing(targetCenter, waypoints[waypoints.length - 1] || sourceCenter);
    const start = source ? (exit ? getDrawioPortPoint(source, ...exit) : getDrawioSidePoint(source, startSide)) : sourcePoint;
    const end = target ? (entry ? getDrawioPortPoint(target, ...entry) : getDrawioSidePoint(target, endSide)) : targetPoint;
    const startHorizontal = startSide === "left" || startSide === "right";
    const endHorizontal = endSide === "left" || endSide === "right";

    if (style.edgeStyle === "elbowEdgeStyle" && waypoints.length === 1) {
        const [elbow] = waypoints;
        return horizontal
            ? [start, { x: elbow.x, y: start.y }, { x: elbow.x, y: end.y }, end]
            : [start, { x: start.x, y: elbow.y }, { x: end.x, y: elbow.y }, end];
    }
    if (waypoints.length > 0) {
        // 中継点は、出る辺の向きに合わせて最初の角を作る
        const first = waypoints[0];
        const lead = startHorizontal ? { x: first.x, y: start.y } : { x: start.x, y: first.y };
        return [start, lead, ...waypoints, end];
    }
    return routeDrawioOrthogonalEdge(start, end, startHorizontal, endHorizontal);
};

// 図形に接する端点を、隣の点と同じ縦・横の線の上で、図形の枠へ寄せる（矢印の先端の分の隙間を埋める）
const snapDrawioEndpointToBounds = (point, neighbor, bounds) => {
    if (!bounds || !neighbor) return point;
    if (Math.abs(point.x - neighbor.x) < 0.01) {
        return { x: point.x, y: neighbor.y < point.y ? bounds.y : bounds.y + bounds.height };
    }
    if (Math.abs(point.y - neighbor.y) < 0.01) {
        return { x: neighbor.x < point.x ? bounds.x : bounds.x + bounds.width, y: point.y };
    }
    return point;
};

// 端点が図形の枠のどこにあるかを比率で表す（Excalidraw の矢印の結び付け位置 fixedPoint）
const getDrawioFixedPoint = (point, bounds) => {
    if (!bounds || !bounds.width || !bounds.height) return null;
    const clamp = (value) => Math.min(1, Math.max(0, Math.round(value * 10000) / 10000));
    return [clamp((point.x - bounds.x) / bounds.width), clamp((point.y - bounds.y) / bounds.height)];
};

/**
 * 直交の矢印の経路を、始点・終点で線が出入りする向き（左右か上下か）から作る（SVG の描画結果が無い場合）。
 * 向きが違えば L 字、同じなら中間で折れる Z 字にする。
 **/
const routeDrawioOrthogonalEdge = (start, end, startHorizontal, endHorizontal = startHorizontal) => {
    if (Math.abs(start.x - end.x) < 0.01 || Math.abs(start.y - end.y) < 0.01) return [start, end];
    if (startHorizontal && !endHorizontal) return [start, { x: end.x, y: start.y }, end];
    if (!startHorizontal && endHorizontal) return [start, { x: start.x, y: end.y }, end];
    if (startHorizontal) {
        const middleX = (start.x + end.x) / 2;
        return [start, { x: middleX, y: start.y }, { x: middleX, y: end.y }, end];
    }
    const middleY = (start.y + end.y) / 2;
    return [start, { x: start.x, y: middleY }, { x: end.x, y: middleY }, end];
};

const readDrawioLabel = (cell, style, defaults = {}) => {
    const text = drawioLabelToText(cell.value, style.html === "1");
    if (!text) return null;
    return {
        text,
        fontSize: toDrawioNumber(style.fontSize, defaults.fontSize ?? 12),
        color: resolveDrawioColor(style.fontColor, "#000000"),
        align: ["left", "center", "right"].includes(style.align) ? style.align : (defaults.align ?? "center"),
        verticalAlign: ["top", "middle", "bottom"].includes(style.verticalAlign) ? style.verticalAlign : (defaults.verticalAlign ?? "middle"),
    };
};

/**
 * 1ページ分のセルを、Excalidraw で作る図形・矢印の一覧（モデルの座標）にする。
 * @param {object[]} cells parseDrawioPages の cells
 * @param {{ edgeRoutes?: Record<string, {x:number,y:number}[]> }} options
 * @returns {{ shapes: object[], edges: object[], groups: string[][], unsupported: string[] }}
 **/
const buildDrawioScene = (cells, options = {}) => {
    const edgeRoutes = options.edgeRoutes || {};
    const cellsById = new Map(cells.map((cell) => [cell.id, cell]));
    const boundsCache = new Map();
    const shapes = [];
    const shapesById = new Map();
    const edgeLabelCells = new Map();
    const groupMembers = new Map();
    const unsupported = [];

    for (const cell of cells) {
        if (!cell.vertex || !cell.geometry) continue;
        const style = parseDrawioStyle(cell.style);
        const parent = cellsById.get(cell.parent);
        if (parent?.edge) {
            // 矢印の上に置かれたラベル（edgeLabel）は、矢印のラベルとしてまとめる
            if (!edgeLabelCells.has(parent.id)) edgeLabelCells.set(parent.id, []);
            edgeLabelCells.get(parent.id).push({ cell, style });
            continue;
        }
        let kind = getDrawioShapeKind(style);
        if (kind === "group") continue;
        if (isDrawioShapeUnsupported(style)) unsupported.push(style.shape);

        const bounds = getDrawioAbsoluteBounds(cell, cellsById, boundsCache);
        const strokeColor = resolveDrawioColor(style.strokeColor, "#000000");
        const backgroundColor = resolveDrawioColor(style.fillColor, kind === "text" ? "transparent" : "#ffffff");
        // 枠も塗りも無い図形は、文字だけの要素にする
        if (kind === "rectangle" && strokeColor === "transparent" && backgroundColor === "transparent") kind = "text";

        const labelOutside = style.verticalLabelPosition === "bottom" || style.verticalLabelPosition === "top"
            || style.labelPosition === "left" || style.labelPosition === "right" || kind === "actor";
        const label = readDrawioLabel(cell, style, { fontSize: 12 });
        if (kind === "text" && !label) continue;

        const shape = {
            id: cell.id,
            kind,
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
            strokeColor,
            backgroundColor,
            strokeWidth: toDrawioNumber(style.strokeWidth, 1),
            dashed: style.dashed === "1",
            rounded: style.rounded === "1",
            opacity: Math.round(toDrawioNumber(style.opacity, 100)),
            link: toExcalidrawLink(cell.link),
            angle: ((toDrawioNumber(style.rotation, 0) % 360 + 360) % 360) * Math.PI / 180,
            outline: getDrawioOutline(kind, bounds.width, bounds.height),
            outlineTransform: { direction: style.direction, flipH: style.flipH === "1", flipV: style.flipV === "1" },
            label,
            labelOutside: labelOutside && kind !== "text"
                ? (style.verticalLabelPosition === "top" ? "top" : style.labelPosition === "left" ? "left" : style.labelPosition === "right" ? "right" : "bottom")
                : null,
        };
        // horizontal=0 の図形は、ラベルを下から上へ読む向き（270°）に回して描く
        if (shape.label && style.horizontal === "0" && kind !== "swimlane" && kind !== "text") shape.label = { ...shape.label, vertical: true };
        if (kind === "swimlane") {
            // スイムレーン: 見出し（startSize の帯）は fillColor、本体は swimlaneFillColor で塗る。
            // horizontal=0 は見出しが左端の縦の帯で、文字は下から上へ読む向きに回す
            shape.swimlane = {
                startSize: Math.max(0, toDrawioNumber(style.startSize, 23)),
                horizontal: style.horizontal !== "0",
                bodyColor: resolveDrawioColor(style.swimlaneFillColor, "transparent"),
            };
            if (shape.label) shape.label = { ...shape.label, align: "center", verticalAlign: "middle" };
        }
        shapes.push(shape);
        shapesById.set(cell.id, shape);

        // 「グループ」（見えない入れ物）の中の図形は、Excalidraw でもグループにする
        let ancestor = parent;
        while (ancestor && ancestor.vertex) {
            if (getDrawioShapeKind(parseDrawioStyle(ancestor.style)) === "group") {
                if (!groupMembers.has(ancestor.id)) groupMembers.set(ancestor.id, []);
                groupMembers.get(ancestor.id).push(cell.id);
                break;
            }
            ancestor = cellsById.get(ancestor.parent);
        }
    }

    const edges = [];
    for (const cell of cells) {
        if (!cell.edge) continue;
        const style = parseDrawioStyle(cell.style);
        const source = shapesById.get(cell.source) || null;
        const target = shapesById.get(cell.target) || null;
        const parentBounds = (() => {
            const parent = cellsById.get(cell.parent);
            return parent?.vertex ? getDrawioAbsoluteBounds(parent, cellsById, boundsCache) : { x: 0, y: 0 };
        })();
        const toAbsolute = (point) => (point ? { x: point.x + parentBounds.x, y: point.y + parentBounds.y } : null);
        const elbowed = /^(?:orthogonalEdgeStyle|elbowEdgeStyle|entityRelationEdgeStyle|segmentEdgeStyle)$/.test(style.edgeStyle || "");
        const hasExit = style.exitX !== undefined && style.exitY !== undefined;
        const hasEntry = style.entryX !== undefined && style.entryY !== undefined;

        let points = edgeRoutes[cell.id]?.map((point) => ({ ...point }));
        if (!points) {
            const waypoints = (cell.geometry?.points || []).map(toAbsolute);
            const sourcePoint = toAbsolute(cell.geometry?.sourcePoint);
            const targetPoint = toAbsolute(cell.geometry?.targetPoint);
            const exit = hasExit ? [toDrawioNumber(style.exitX), toDrawioNumber(style.exitY)] : null;
            const entry = hasEntry ? [toDrawioNumber(style.entryX), toDrawioNumber(style.entryY)] : null;
            if (elbowed) {
                points = routeDrawioElbowEdgeFallback({ source, target, sourcePoint, targetPoint, waypoints, exit, entry, style });
            } else {
                const sourceCenter = source ? getDrawioCenter(source) : null;
                const targetCenter = target ? getDrawioCenter(target) : null;
                const towardEnd = waypoints[0] || targetCenter || targetPoint;
                const towardStart = waypoints[waypoints.length - 1] || sourceCenter || sourcePoint;
                const start = source
                    ? (exit ? getDrawioPortPoint(source, ...exit) : getDrawioPerimeterPoint(source, towardEnd || sourceCenter))
                    : sourcePoint;
                const end = target
                    ? (entry ? getDrawioPortPoint(target, ...entry) : getDrawioPerimeterPoint(target, towardStart || targetCenter))
                    : targetPoint;
                points = start && end ? [start, ...waypoints, end] : null;
            }
            if (!points) continue;
        }
        if (elbowed) points = orthogonalizeDrawioPoints(points);
        if (points.length < 2) continue;
        if (elbowed) {
            points[0] = snapDrawioEndpointToBounds(points[0], points[1], source);
            points[points.length - 1] = snapDrawioEndpointToBounds(points[points.length - 1], points[points.length - 2], target);
        }
        points = points.map(roundDrawioPoint);

        const labels = [readDrawioLabel(cell, style)]
            .concat((edgeLabelCells.get(cell.id) || []).map(({ cell: labelCell, style: labelStyle }) => readDrawioLabel(labelCell, { ...style, ...labelStyle })))
            .filter(Boolean);
        const label = labels.length > 0 ? { ...labels[0], text: labels.map((item) => item.text).join("\n") } : null;

        edges.push({
            id: cell.id,
            sourceId: source?.id ?? null,
            targetId: target?.id ?? null,
            points,
            elbowed,
            startFixedPoint: source ? getDrawioFixedPoint(points[0], source) : null,
            endFixedPoint: target ? getDrawioFixedPoint(points[points.length - 1], target) : null,
            startArrowhead: toExcalidrawArrowhead(style.startArrow, style.startFill),
            endArrowhead: toExcalidrawArrowhead(style.endArrow ?? "classic", style.endFill),
            strokeColor: resolveDrawioColor(style.strokeColor, "#000000"),
            strokeWidth: toDrawioNumber(style.strokeWidth, 1),
            dashed: style.dashed === "1",
            // 角丸（rounded）と曲線（curved）の矢印は、Excalidraw の曲線の矢印にする
            rounded: style.rounded === "1" || style.curved === "1",
            opacity: Math.round(toDrawioNumber(style.opacity, 100)),
            label: label ? { ...label, align: "center", verticalAlign: "middle" } : null,
        });
    }

    return {
        shapes,
        edges,
        groups: [...groupMembers.values()].filter((members) => members.length > 1),
        unsupported: [...new Set(unsupported)],
    };
};

// 図全体の範囲（図形と矢印の点）
const getDrawioSceneBounds = (scene) => {
    const xs = [];
    const ys = [];
    scene.shapes.forEach((shape) => {
        xs.push(shape.x, shape.x + shape.width);
        ys.push(shape.y, shape.y + shape.height);
    });
    scene.edges.forEach((edge) => edge.points.forEach((point) => {
        xs.push(point.x);
        ys.push(point.y);
    }));
    if (xs.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
};

const translateDrawioScene = (scene, dx, dy) => ({
    ...scene,
    shapes: scene.shapes.map((shape) => ({ ...shape, x: shape.x + dx, y: shape.y + dy })),
    edges: scene.edges.map((edge) => ({ ...edge, points: edge.points.map((point) => ({ x: point.x + dx, y: point.y + dy })) })),
});

// ページごとの図を、左上を原点にして横に並べる
const layoutDrawioPages = (scenes) => {
    let left = 0;
    return scenes.map((scene) => {
        const bounds = getDrawioSceneBounds(scene);
        const placed = translateDrawioScene(scene, left - bounds.x, -bounds.y);
        left += bounds.width + DRAWIO_PAGE_GAP;
        return { ...placed, bounds: { x: left - bounds.width - DRAWIO_PAGE_GAP, y: 0, width: bounds.width, height: bounds.height } };
    });
};

/**
 * 文字を最大幅で折り返す（日本語は文字単位、英語は空白の位置を優先して折り返す）。
 * @param {(text: string) => number} measureWidth 文字列の表示幅を返す関数
 **/
const wrapDrawioText = (text, maxWidth, measureWidth) => {
    if (!(maxWidth > 0)) return text;
    return String(text).split("\n").map((line) => {
        const wrapped = [];
        let current = "";
        for (const char of Array.from(line)) {
            const next = current + char;
            if (current && measureWidth(next) > maxWidth) {
                const spaceIndex = current.lastIndexOf(" ");
                if (spaceIndex > 0 && /\S/.test(char)) {
                    wrapped.push(current.slice(0, spaceIndex));
                    current = current.slice(spaceIndex + 1) + char;
                } else {
                    wrapped.push(current.replace(/\s+$/, ""));
                    current = char === " " ? "" : char;
                }
            } else {
                current = next;
            }
        }
        wrapped.push(current);
        return wrapped.join("\n");
    }).join("\n");
};

// Excalidraw が図形の内側に文字を置ける幅（Excalidraw の getBoundTextMaxWidth と同じ考え方）
const getDrawioBoundTextMaxWidth = (kind, width) => {
    if (kind === "ellipse") return Math.round((width / 2) * Math.SQRT2) - DRAWIO_BOUND_TEXT_PADDING * 2;
    if (kind === "diamond") return Math.round(width / 2) - DRAWIO_BOUND_TEXT_PADDING * 2;
    if (kind === "arrow") return Infinity;
    return width - DRAWIO_BOUND_TEXT_PADDING * 2;
};

// Excalidraw が図形の内側に文字を置ける高さ（Excalidraw の getBoundTextMaxHeight と同じ考え方）
const getDrawioBoundTextMaxHeight = (kind, height) => {
    if (kind === "ellipse") return Math.round((height / 2) * Math.SQRT2) - DRAWIO_BOUND_TEXT_PADDING * 2;
    if (kind === "diamond") return Math.round(height / 2) - DRAWIO_BOUND_TEXT_PADDING * 2;
    return height - DRAWIO_BOUND_TEXT_PADDING * 2;
};

// 折り返しで、英数字の単語の途中に改行が入ったか（"obscu\nrities" など）
const isDrawioWrapBreakingWord = (original, wrapped) => {
    const source = Array.from(original);
    const result = Array.from(wrapped);
    let index = 0;
    for (let position = 0; position < result.length; position += 1) {
        if (index < source.length && result[position] === source[index]) {
            index += 1;
            continue;
        }
        // 折り返しで足された改行（元の空白を置き換えた改行は単語の区切り）
        if (result[position] === "\n" && source[index] === " ") {
            index += 1;
            continue;
        }
        if (result[position] === "\n" && /[A-Za-z0-9]/.test(source[index - 1] || "") && /[A-Za-z0-9]/.test(source[index] || "")) return true;
    }
    return false;
};

/**
 * ラベルを図形に結び付けた文字にして、draw.io と同じ見た目で収まるか。
 * Excalidraw は図形の内側（ひし形は幅の半分など）で折り返すため、draw.io（図形の幅で折り返す）より改行が増える、
 * 英単語が途中で切れる、または高さからはみ出す場合は収まらないとする。
 **/
const doesDrawioLabelFitContainer = (ea, label, kind, width, height) => {
    ea.style.fontSize = label.fontSize;
    ea.style.fontFamily = DRAWIO_EXCALIDRAW_FONT_FAMILY;
    const measureWidth = (value) => ea.measureText(value).width;
    const bound = wrapDrawioText(label.text, getDrawioBoundTextMaxWidth(kind, width), measureWidth);
    const drawio = wrapDrawioText(label.text, width - DRAWIO_BOUND_TEXT_PADDING * 2, measureWidth);
    if (bound.split("\n").length > drawio.split("\n").length) return false;
    if (isDrawioWrapBreakingWord(label.text, bound)) return false;
    return ea.measureText(bound).height <= Math.max(getDrawioBoundTextMaxHeight(kind, height), label.fontSize * 1.25);
};

const getExcalidrawAutomate = () => {
    const shared = window.ExcalidrawAutomate || app.plugins?.plugins?.["obsidian-excalidraw-plugin"]?.ea;
    if (!shared) return null;
    return typeof shared.getAPI === "function" ? shared.getAPI() : shared;
};

const applyDrawioStyleToEA = (ea, item) => {
    ea.style.strokeColor = item.strokeColor;
    ea.style.backgroundColor = item.backgroundColor ?? "transparent";
    ea.style.strokeWidth = item.strokeWidth;
    ea.style.strokeStyle = item.dashed ? "dashed" : "solid";
    ea.style.fillStyle = "solid";
    ea.style.roughness = 0;
    ea.style.opacity = item.opacity ?? 100;
};

// 文字を作る。containerId を渡すと、その図形・矢印に結び付けた（一緒に動く）文字になる
const addDrawioTextToEA = (ea, label, area, options = {}) => {
    ea.style.strokeColor = label.color;
    ea.style.backgroundColor = "transparent";
    ea.style.opacity = 100;
    ea.style.fontSize = label.fontSize;
    ea.style.fontFamily = DRAWIO_EXCALIDRAW_FONT_FAMILY;
    const measureWidth = (value) => ea.measureText(value).width;
    const container = options.containerId ? ea.getElement(options.containerId) : null;
    const maxWidth = container ? getDrawioBoundTextMaxWidth(options.kind, area.width) : area.width;
    const wrapped = options.wrap === false ? label.text : wrapDrawioText(label.text, maxWidth, measureWidth);
    const id = ea.addText(area.x, area.y, wrapped, { textAlign: label.align, textVerticalAlign: label.verticalAlign });
    const element = ea.getElement(id);
    const size = ea.measureText(wrapped);
    const padding = container && options.kind !== "arrow" ? DRAWIO_BOUND_TEXT_PADDING : 0;
    element.width = size.width;
    element.height = size.height;
    element.x = label.align === "left" ? area.x + padding
        : label.align === "right" ? area.x + area.width - padding - size.width
            : area.x + (area.width - size.width) / 2;
    element.y = label.verticalAlign === "top" ? area.y + padding
        : label.verticalAlign === "bottom" ? area.y + area.height - padding - size.height
            : area.y + (area.height - size.height) / 2;
    if (container) {
        element.containerId = container.id;
        element.originalText = label.text;
        element.rawText = label.text;
        element.autoResize = true;
        container.boundElements = [...(container.boundElements || []), { type: "text", id }];
    }
    return id;
};

// 人型（umlActor）を、頭（円）と線で描く
const addDrawioActorToEA = (ea, shape) => {
    const { x, y, width: w, height: h } = shape;
    const headSize = Math.min(w, h / 4);
    return [
        ea.addEllipse(x + (w - headSize) / 2, y, headSize, headSize),
        ea.addLine([[x + w / 2, y + headSize], [x + w / 2, y + h * 0.65]]),
        ea.addLine([[x, y + h * 0.4], [x + w, y + h * 0.4]]),
        ea.addLine([[x, y + h], [x + w / 2, y + h * 0.65], [x + w, y + h]]),
    ];
};

/**
 * buildDrawioScene の結果を EA の作業領域に追加する。
 * @returns {Map<string, string>} draw.io のセルID → Excalidraw の要素ID
 **/
const addDrawioSceneToEA = (ea, scene) => {
    const elementIds = new Map();
    const memberIds = new Map();

    // 輪郭を描かない、文字と矢印を結び付けるための透明な四角
    const addHitBox = (shape) => {
        const id = ea.addRect(shape.x, shape.y, shape.width, shape.height);
        Object.assign(ea.getElement(id), { strokeColor: "transparent", backgroundColor: "transparent", roundness: null });
        return id;
    };

    for (const shape of scene.shapes) {
        applyDrawioStyleToEA(ea, shape);
        const { x, y, width, height } = shape;
        const ids = [];
        let containerId = null;
        let labelDone = false;
        if (shape.kind === "text") {
            ids.push(addDrawioTextToEA(ea, shape.label, shape));
            labelDone = true;
        } else if (shape.kind === "swimlane") {
            const { startSize, horizontal, bodyColor } = shape.swimlane;
            containerId = ea.addRect(x, y, width, height);
            Object.assign(ea.getElement(containerId), { backgroundColor: bodyColor, roundness: null });
            ids.push(containerId);
            if (startSize > 0) {
                const header = horizontal
                    ? { x, y, width, height: Math.min(startSize, height) }
                    : { x, y, width: Math.min(startSize, width), height };
                const headerId = ea.addRect(header.x, header.y, header.width, header.height);
                ea.getElement(headerId).roundness = null;
                ids.push(headerId);
                if (shape.label && horizontal) {
                    ids.push(addDrawioTextToEA(ea, shape.label, header, { containerId: headerId, kind: "rectangle" }));
                } else if (shape.label) {
                    // 縦の帯: 帯の長さで折り返した文字を帯の中央に置き、下から上へ読む向き（270°）に回す
                    const band = { x: x + header.width / 2 - height / 2, y: y + height / 2 - header.width / 2, width: height, height: header.width };
                    const textId = addDrawioTextToEA(ea, shape.label, band);
                    ea.getElement(textId).angle = Math.PI * 1.5;
                    ids.push(textId);
                }
            }
            labelDone = true;
        } else if (shape.outline) {
            // 多角形・曲線の図形: 輪郭は線で描き、文字と矢印は同じ大きさの透明な四角に結び付ける
            const toScene = (point) => {
                const [u, v] = transformDrawioOutlinePoint(point, shape.outlineTransform);
                return [x + u * width, y + v * height];
            };
            const points = shape.outline.points.map(toScene);
            if (shape.outline.closed) points.push(points[0]);
            const outlineId = ea.addLine(points);
            Object.assign(ea.getElement(outlineId), {
                polygon: shape.outline.closed,
                backgroundColor: shape.outline.closed ? shape.backgroundColor : "transparent",
                roundness: null,
            });
            ids.push(outlineId);
            for (const extra of shape.outline.extra || []) {
                const extraId = ea.addLine(extra.map(toScene));
                Object.assign(ea.getElement(extraId), { backgroundColor: "transparent", roundness: null });
                ids.push(extraId);
            }
            containerId = addHitBox(shape);
            ids.push(containerId);
        } else if (shape.kind === "actor") {
            ids.push(...addDrawioActorToEA(ea, shape));
            containerId = addHitBox(shape);
            ids.push(containerId);
        } else {
            containerId = shape.kind === "ellipse" ? ea.addEllipse(x, y, width, height)
                : shape.kind === "diamond" ? ea.addDiamond(x, y, width, height)
                    : ea.addRect(x, y, width, height);
            // 端子（terminator）は角丸の四角で代用する
            const rounded = shape.rounded || shape.kind === "terminator";
            ea.getElement(containerId).roundness = rounded ? { type: shape.kind === "diamond" ? 2 : 3 } : null;
            ids.push(containerId);
            if (shape.kind === "process") {
                // 「処理」（左右に縦線のある四角）
                const inset = Math.min(width * 0.1, 12);
                ids.push(ea.addLine([[x + inset, y], [x + inset, y + height]]));
                ids.push(ea.addLine([[x + width - inset, y], [x + width - inset, y + height]]));
            }
        }
        elementIds.set(shape.id, containerId || ids[0]);
        if (shape.link) ea.getElement(containerId || ids[0]).link = shape.link;

        let boundTextId = null;
        const containerKind = shape.outline || shape.kind === "actor" ? "rectangle" : shape.kind;
        if (shape.label && !labelDone) {
            if (shape.label.vertical) {
                // 縦書き: 図形の高さで折り返した文字を図形の中央に置き、270° 回して図形とグループにする
                const area = { x: x + width / 2 - height / 2, y: y + height / 2 - width / 2, width: height, height: width };
                const textId = addDrawioTextToEA(ea, { ...shape.label, align: "center", verticalAlign: "middle" }, area);
                ea.getElement(textId).angle = Math.PI * 1.5;
                ids.push(textId);
            } else if (containerId && !shape.labelOutside && doesDrawioLabelFitContainer(ea, shape.label, containerKind, width, height)) {
                boundTextId = addDrawioTextToEA(ea, shape.label, shape, { containerId, kind: containerKind });
                ids.push(boundTextId);
            } else if (!shape.labelOutside) {
                // 図形の内側に収まらないラベル（細いひし形の英文など）は、draw.io と同じく図形の幅で折り返した文字を
                // 図形の中央に置き、図形とグループにする
                const padding = DRAWIO_BOUND_TEXT_PADDING;
                const area = { x: x + padding, y: y + padding, width: width - padding * 2, height: height - padding * 2 };
                ids.push(addDrawioTextToEA(ea, shape.label, area));
            } else {
                // 図形の外（下など）に置くラベルは、図形と同じ幅の文字にして、図形とグループにする
                const lineCount = shape.label.text.split("\n").length;
                const height = shape.label.fontSize * 1.25 * lineCount;
                const area = shape.labelOutside === "top" ? { x: shape.x - 40, y: shape.y - height - 4, width: shape.width + 80, height }
                    : shape.labelOutside === "left" ? { x: shape.x - 200, y: shape.y, width: 196, height: shape.height }
                        : shape.labelOutside === "right" ? { x: shape.x + shape.width + 4, y: shape.y, width: 196, height: shape.height }
                            : { x: shape.x - 40, y: shape.y + shape.height + 4, width: shape.width + 80, height };
                ids.push(addDrawioTextToEA(ea, { ...shape.label, verticalAlign: "top" }, area, { wrap: false }));
            }
        }
        // 回転した図形（draw.io の rotation）。複数の部品を組み合わせた図形は回さない
        if (shape.angle && !["swimlane", "actor", "process"].includes(shape.kind)) {
            ids.forEach((id) => { ea.getElement(id).angle = shape.angle; });
        }
        // 複数の要素でできた図形（スイムレーン、多角形、人型、処理、外側のラベル）は、まとめて動かせるようグループにする
        if (ids.filter((id) => id !== boundTextId).length > 1) ea.addToGroup(ids);
        memberIds.set(shape.id, ids);
    }

    for (const edge of scene.edges) {
        applyDrawioStyleToEA(ea, { ...edge, backgroundColor: "transparent" });
        const startObjectId = edge.sourceId ? elementIds.get(edge.sourceId) : undefined;
        const endObjectId = edge.targetId ? elementIds.get(edge.targetId) : undefined;
        const id = ea.addArrow(edge.points.map((point) => [point.x, point.y]), {
            startArrowHead: edge.startArrowhead,
            endArrowHead: edge.endArrowhead,
            elbowed: edge.elbowed && Boolean(startObjectId || endObjectId),
            startObjectId,
            endObjectId,
            startFixedPoint: startObjectId ? edge.startFixedPoint : undefined,
            endFixedPoint: endObjectId ? edge.endFixedPoint : undefined,
        });
        const arrow = ea.getElement(id);
        if (arrow.elbowed) {
            arrow.roundness = null;
            arrow.fixedSegments = null;
            arrow.startIsSpecial = false;
            arrow.endIsSpecial = false;
        } else {
            arrow.roundness = edge.rounded ? { type: 2 } : null;
        }
        elementIds.set(edge.id, id);

        if (edge.label) {
            const middle = getDrawioPolylineMiddle(edge.points);
            addDrawioTextToEA(ea, edge.label, { x: middle.x, y: middle.y, width: 0, height: 0 }, { containerId: id, kind: "arrow" });
        }
    }

    for (const members of scene.groups || []) {
        const ids = members.flatMap((cellId) => memberIds.get(cellId) || []);
        if (ids.length > 1) ea.addToGroup(ids);
    }
    return elementIds;
};

// 折れ線の長さの中間点（矢印のラベルを置く位置）
const getDrawioPolylineMiddle = (points) => {
    const lengths = points.slice(1).map((point, index) => Math.hypot(point.x - points[index].x, point.y - points[index].y));
    let remaining = lengths.reduce((sum, length) => sum + length, 0) / 2;
    for (const [index, length] of lengths.entries()) {
        if (remaining <= length && length > 0) {
            const ratio = remaining / length;
            return {
                x: points[index].x + (points[index + 1].x - points[index].x) * ratio,
                y: points[index].y + (points[index + 1].y - points[index].y) * ratio,
            };
        }
        remaining -= length;
    }
    return points[0];
};

// 変換先のファイル名（同じフォルダに同名がある場合は _1, _2 … を付ける）
const getDrawioExcalidrawFileName = (file, exists) => {
    const baseName = file.name.replace(DRAWIO_FILE_PATTERN, "");
    const folder = file.parent?.path && file.parent.path !== "/" ? `${file.parent.path}/` : "";
    let name = baseName;
    for (let counter = 1; exists(`${folder}${name}.excalidraw.md`); counter += 1) name = `${baseName}_${counter}`;
    return name;
};

// 埋め込みリンクのリンク先（"#" や "|" の前）が、そのファイルを指しているか
const isDrawioEmbedTarget = (linkPath, file) => {
    let decoded = linkPath.trim();
    try {
        decoded = decodeURIComponent(decoded);
    } catch {
        // そのまま比べる
    }
    decoded = decoded.replace(/^<|>$/g, "").replace(/^\.?\//, "");
    return decoded === file.name || decoded === file.path || decoded.endsWith(`/${file.name}`);
};

/**
 * ノートの本文から、draw.io の図の埋め込みの下に、変換した図の埋め込みを入れる位置を求める。
 * - 対象は ![[図.drawio.svg|サイズ]] と ![説明](図.drawio.svg)。サイズの指定は変換した図にも付ける。
 * - 埋め込みの行の次の行に、同じ字下げ（箇条書きの場合は本文の位置）で入れる。
 * - 次の行に変換した図の埋め込みが既にある場合は入れない（2回変換しても重複しない）。
 * @param {string} content ノートの本文
 * @param {{ name: string, path: string }} drawioFile 元の図のファイル
 * @param {string} excalidrawLinkName 変換した図のリンク名（例: "図.excalidraw"）
 * @returns {{ offset: number, text: string }[]} 本文の位置と、そこへ入れる文字列（後ろから順に適用する）
 **/
const findDrawioExcalidrawEmbedInsertions = (content, drawioFile, excalidrawLinkName) => {
    const insertions = [];
    const lines = content.split("\n");
    let lineStart = 0;
    lines.forEach((line, index) => {
        const lineEnd = lineStart + line.length;
        const embedPattern = /!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]|!\[([^\]]*)\]\(([^)]+)\)/g;
        let size = null;
        let found = false;
        let match;
        while ((match = embedPattern.exec(line))) {
            if (match[1] !== undefined && isDrawioEmbedTarget(match[1], drawioFile)) {
                found = true;
                size = /^\d+(?:x\d+)?$/.test(match[2]?.trim() || "") ? match[2].trim() : size;
            } else if (match[4] !== undefined && isDrawioEmbedTarget(match[4].split(/[?#\s]/)[0], drawioFile)) {
                found = true;
                size = match[3]?.match(/\|\s*(\d+(?:x\d+)?)\s*$/)?.[1] ?? size;
            }
        }
        const nextLine = lines[index + 1] ?? "";
        const alreadyAdded = nextLine.includes(`![[${excalidrawLinkName}]]`) || nextLine.includes(`![[${excalidrawLinkName}|`);
        if (found && !alreadyAdded) {
            const listMarker = line.match(/^(\s*)([-*+]|\d+[.)])\s+/);
            const indent = listMarker ? " ".repeat(listMarker[0].length) : line.match(/^\s*/)[0];
            const embed = `![[${excalidrawLinkName}${size ? `|${size}` : ""}]]`;
            insertions.push({ offset: lineEnd, text: `\n${indent}${embed}` });
        }
        lineStart = lineEnd + 1;
    });
    return insertions.reverse();
};

// 元の図を埋め込んでいるノート（sourceFile を渡した場合はそのノートだけ）
const collectNotesEmbeddingDrawio = (drawioFile, sourceFile = null) => {
    if (sourceFile) return sourceFile.extension === "md" ? [sourceFile] : [];
    const resolvedLinks = app.metadataCache.resolvedLinks || {};
    return Object.keys(resolvedLinks)
        .filter((notePath) => resolvedLinks[notePath]?.[drawioFile.path])
        .map((notePath) => app.vault.getAbstractFileByPath(notePath))
        .filter((note) => note?.extension === "md");
};

/**
 * ノート内の元の図の埋め込みの下に、変換した図の埋め込みを追加する。
 * ノートが編集モードで開いている場合はエディタを書き換え（表示位置を変えない）、それ以外はファイルを書き換える。
 * @returns {Promise<string[]>} 埋め込みを追加したノートのパス
 **/
const addExcalidrawEmbedBelowDrawio = async (drawioFile, excalidrawLinkName, sourceFile = null) => {
    const updated = [];
    for (const note of collectNotesEmbeddingDrawio(drawioFile, sourceFile)) {
        const view = app.workspace.getLeavesOfType("markdown")
            .map((leaf) => leaf.view)
            .find((item) => item?.file?.path === note.path && item.getMode?.() === "source");
        const cm = view?.editor?.cm;
        if (cm && typeof cm.dispatch === "function") {
            const insertions = findDrawioExcalidrawEmbedInsertions(view.editor.getValue(), drawioFile, excalidrawLinkName);
            if (insertions.length === 0) continue;
            cm.dispatch({ changes: insertions.map(({ offset, text }) => ({ from: offset, insert: text })) });
            updated.push(note.path);
            continue;
        }
        let changed = false;
        await app.vault.process(note, (content) => {
            const insertions = findDrawioExcalidrawEmbedInsertions(content, drawioFile, excalidrawLinkName);
            changed = insertions.length > 0;
            return insertions.reduce((text, { offset, text: insert }) => text.slice(0, offset) + insert + text.slice(offset), content);
        });
        if (changed) updated.push(note.path);
    }
    return updated;
};

// ファイルの中身から、draw.io の図の XML を取り出す
const readDrawioFileXml = async (file) => {
    const name = file.name.toLowerCase();
    if (name.endsWith(".png")) {
        return { xml: extractDrawioXmlFromPng(new Uint8Array(await app.vault.readBinary(file))), svg: null };
    }
    const text = await app.vault.read(file);
    if (name.endsWith(".svg")) return { xml: extractDrawioXmlFromSvg(text), svg: text };
    return { xml: text, svg: null };
};

/**
 * draw.io のファイルを、同じフォルダの新しい .excalidraw.md へ変換し、ノート内の元の図の下に埋め込む。
 * 埋め込むノートが無い場合は、変換した図を新しいタブで開く。
 * @param {object} file 元の図のファイル
 * @param {object|null} sourceFile 操作したノート。省略時は元の図を埋め込んでいる全ノート
 * @returns {Promise<string|null>} 作成したファイルのパス
 **/
const convertDrawioFileToExcalidraw = async (file, sourceFile = null) => {
    if (!isDrawioConvertibleFile(file)) {
        new Notice("draw.io のファイル（.drawio / .drawio.svg / .drawio.png）ではありません");
        return null;
    }
    const ea = getExcalidrawAutomate();
    if (!ea) {
        new Notice("Excalidraw プラグインが有効ではありません");
        return null;
    }
    try {
        const { xml, svg } = await readDrawioFileXml(file);
        if (!xml) {
            new Notice(`${file.name} に draw.io の図のデータが含まれていません（画像だけのファイルです）`);
            return null;
        }
        const pages = await parseDrawioPages(xml);
        if (pages.length === 0) {
            new Notice(`${file.name} から図を読み取れませんでした`);
            return null;
        }
        // SVG に描かれているのは1ページ目だけのため、矢印の経路は1ページ目にだけ使う
        const scenes = pages.map((page, index) => buildDrawioScene(page.cells, {
            edgeRoutes: index === 0 && svg ? extractDrawioSvgEdgeRoutes(svg, page.cells) : {},
        }));
        const placed = layoutDrawioPages(scenes);

        ea.reset();
        placed.forEach((scene, index) => {
            const before = new Set(Object.keys(ea.elementsDict || {}));
            addDrawioSceneToEA(ea, scene);
            if (placed.length > 1) {
                const frameId = ea.addFrame(scene.bounds.x - 40, scene.bounds.y - 40, scene.bounds.width + 80, scene.bounds.height + 80, pages[index].name);
                Object.keys(ea.elementsDict).filter((id) => !before.has(id) && id !== frameId)
                    .forEach((id) => { ea.getElement(id).frameId = frameId; });
            }
        });

        const fileName = getDrawioExcalidrawFileName(file, (path) => Boolean(app.vault.getAbstractFileByPath(path)));
        const folder = file.parent?.path && file.parent.path !== "/" ? file.parent.path : "";
        const hasEmbeddingNotes = collectNotesEmbeddingDrawio(file, sourceFile).length > 0;
        const createdPath = await ea.create({ filename: fileName, foldername: folder, onNewPane: true, silent: hasEmbeddingNotes });
        const updatedNotes = hasEmbeddingNotes ? await addExcalidrawEmbedBelowDrawio(file, `${fileName}.excalidraw`, sourceFile) : [];

        const unsupported = [...new Set(scenes.flatMap((scene) => scene.unsupported))];
        const message = `Excalidraw に変換しました: ${fileName}.excalidraw.md`
            + (updatedNotes.length > 0 ? `\n元の図の下に埋め込みました: ${updatedNotes.map((path) => path.split("/").pop()).join(", ")}` : "")
            + (unsupported.length > 0 ? `\n四角で代用した図形: ${unsupported.join(", ")}` : "");
        new Notice(message, 8000);
        return createdPath || `${folder ? `${folder}/` : ""}${fileName}.excalidraw.md`;
    } catch (error) {
        console.error("drawio → Excalidraw の変換に失敗しました:", error);
        new Notice(`Excalidraw への変換に失敗しました: ${error.message}`);
        return null;
    } finally {
        if (ea !== window.ExcalidrawAutomate) ea.destroy?.();
    }
};

// ノートが埋め込み・リンクしている draw.io のファイル
const collectDrawioFilesInNote = (note) => {
    const cache = app.metadataCache.getFileCache(note) || {};
    const files = [];
    for (const link of [...(cache.embeds || []), ...(cache.links || [])]) {
        const linkPath = link.link.split(/[#|]/)[0];
        const target = app.metadataCache.getFirstLinkpathDest(linkPath, note.path);
        if (target && isDrawioConvertibleFile(target) && !files.includes(target)) files.push(target);
    }
    return files;
};

// コマンド: 開いている draw.io のファイル、またはノート内の draw.io の図を変換する
const convertActiveDrawioToExcalidraw = async () => {
    const activeFile = app.workspace.getActiveFile();
    if (!activeFile) {
        new Notice("アクティブなファイルがありません");
        return;
    }
    if (isDrawioConvertibleFile(activeFile)) {
        await convertDrawioFileToExcalidraw(activeFile);
        return;
    }
    const candidates = activeFile.extension === "md" ? collectDrawioFilesInNote(activeFile) : [];
    if (candidates.length === 0) {
        new Notice("このノートに draw.io の図がありません");
        return;
    }
    const target = candidates.length === 1
        ? candidates[0]
        : await tp.system.suggester(candidates.map((file) => file.path), candidates, false, "Excalidraw に変換する draw.io の図");
    if (target) await convertDrawioFileToExcalidraw(target, activeFile);
};
