import * as THREE from "three";
import { readablePrintColor, wrapPrintText } from "../viewer/printLayout";

export interface LabelHandle {
  el: HTMLElement;
  remove(): void;
  /** Set the opacity of the label and its leader line/arrow together. */
  setOpacity(o: number): void;
}

/**
 * Optional leader: when the getter returns a screen-space offset {x, y}, the
 * label is drawn at anchor+offset with a connector line back to the anchor
 * (a CAD-style leader). Returning null pins the label directly at the anchor.
 */
export type LeaderGetter = () => { x: number; y: number } | null;

/** Text style of a label in the print image (annotations carry their own). */
export interface LabelPrintStyle {
  color?: string;
  fontPx?: number;
}

/** Same width as the annotation card (`.step-viewer-annot`), minus its padding. */
const PRINT_LABEL_MAX_WIDTH = 308;
const PRINT_LABEL_PADDING = 6;
const PRINT_LINE_HEIGHT = 1.4;
const PRINT_ARROW_SIZE = 7;

interface Item {
  el: HTMLElement;
  world: () => THREE.Vector3;
  leader: LeaderGetter | null;
  line: SVGLineElement | null;
  caption: (() => string) | null;
  printStyle: (() => LabelPrintStyle) | null;
}

const SVG_NS = "http://www.w3.org/2000/svg";

// Unique per-instance marker ids so multiple embeds don't collide on url(#id).
let markerSeq = 0;

/**
 * Renders HTML labels anchored to 3D world positions, projected to screen each
 * frame (a lightweight CSS2D layer). Used for measurement numbers and
 * annotation notes. The container ignores pointer events; individual labels can
 * opt back in via CSS (annotations do, to be editable). Leader lines are drawn
 * in a shared SVG overlay behind the labels.
 */
export class LabelLayer {
  private container: HTMLElement;
  private svg: SVGSVGElement;
  private markerId = `step-leader-arrow-${markerSeq++}`;
  private items: Item[] = [];
  private v = new THREE.Vector3();

  constructor(host: HTMLElement) {
    this.container = host.createDiv({ cls: "step-viewer-labels" });
    this.svg = activeDocument.createElementNS(SVG_NS, "svg");
    this.svg.classList.add("step-viewer-leaders");

    // Arrowhead marker, pointing at the anchor end of each leader line.
    const defs = activeDocument.createElementNS(SVG_NS, "defs");
    const marker = activeDocument.createElementNS(SVG_NS, "marker");
    marker.setAttribute("id", this.markerId);
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "8");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "7");
    marker.setAttribute("markerHeight", "7");
    marker.setAttribute("orient", "auto-start-reverse");
    const arrow = activeDocument.createElementNS(SVG_NS, "path");
    arrow.setAttribute("d", "M 0 1 L 9 5 L 0 9 z");
    arrow.classList.add("step-viewer-leader-arrow");
    marker.appendChild(arrow);
    defs.appendChild(marker);
    this.svg.appendChild(defs);

    this.container.appendChild(this.svg);
  }

  add(
    el: HTMLElement,
    world: () => THREE.Vector3,
    leader: LeaderGetter | null = null,
    caption: (() => string) | null = null,
    printStyle: (() => LabelPrintStyle) | null = null,
  ): LabelHandle {
    this.container.appendChild(el);
    const line = leader ? this.makeLine() : null;
    const item: Item = { el, world, leader, line, caption, printStyle };
    this.items.push(item);
    return {
      el,
      remove: () => {
        const i = this.items.indexOf(item);
        if (i >= 0) this.items.splice(i, 1);
        el.remove();
        item.line?.remove();
      },
      // `opacity` (not stroke-opacity) fades the arrowhead marker with the line.
      setOpacity: (o: number) => {
        el.style.opacity = String(o);
        if (item.line) item.line.style.opacity = String(o);
      },
    };
  }

  private makeLine(): SVGLineElement {
    const line = activeDocument.createElementNS(SVG_NS, "line");
    line.classList.add("step-viewer-leader-line");
    line.setAttribute("marker-end", `url(#${this.markerId})`);
    this.svg.appendChild(line);
    return line;
  }

  update(camera: THREE.Camera, dom: HTMLElement): void {
    const w = dom.clientWidth;
    const h = dom.clientHeight;
    for (const it of this.items) {
      // A hidden label (category filter / hide-all) must also drop its leader
      // line — the SVG line lives outside the label element's display:none.
      if (it.el.hasClass("is-hidden")) {
        it.line?.classList.add("is-hidden");
        continue;
      }
      this.v.copy(it.world()).project(camera);
      if (this.v.z > 1 || this.v.z < -1) {
        it.el.toggleClass("step-viewer-label-offscreen", true);
        it.line?.classList.add("is-hidden");
        continue;
      }
      const x = (this.v.x * 0.5 + 0.5) * w;
      const y = (-this.v.y * 0.5 + 0.5) * h;
      it.el.toggleClass("step-viewer-label-offscreen", false);

      const off = it.leader?.() ?? null;
      if (off && it.line) {
        const lx = x + off.x;
        const ly = y + off.y;
        it.el.style.transform = `translate(-50%, -50%) translate(${lx}px, ${ly}px)`;
        // Draw label → anchor so the arrowhead (marker-end) points at the anchor.
        it.line.setAttribute("x1", String(lx));
        it.line.setAttribute("y1", String(ly));
        it.line.setAttribute("x2", String(x));
        it.line.setAttribute("y2", String(y));
        it.line.classList.remove("is-hidden");
      } else {
        it.el.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`;
        it.line?.classList.add("is-hidden");
      }
    }
  }

  /**
   * Draw the labels' captions onto a 2D canvas context, for screenshots (the
   * HTML overlay isn't part of the WebGL buffer). `scale` maps CSS px → canvas
   * px. Only labels that declared a caption are drawn.
   */
  drawOnto(
    ctx: CanvasRenderingContext2D,
    camera: THREE.Camera,
    w: number,
    h: number,
    scale: number,
  ): void {
    ctx.save();
    ctx.font = `${Math.round(12 * scale)}px sans-serif`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    for (const it of this.items) {
      const shown = this.shownCaption(it, camera, w, h);
      if (!shown) continue;
      const x = (shown.x + (shown.off?.x ?? 0)) * scale;
      const y = (shown.y + (shown.off?.y ?? 0)) * scale;
      const line = shown.text.split("\n")[0];
      const tw = ctx.measureText(line).width;
      ctx.fillStyle = "rgba(20,20,20,0.72)";
      ctx.fillRect(x - tw / 2 - 4 * scale, y - 9 * scale, tw + 8 * scale, 18 * scale);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(line, x, y);
    }
    ctx.restore();
  }

  /**
   * Draw the labels for the print image: full (wrapped) text in each note's own
   * colour and size, on a white plate, with its leader line and arrowhead.
   * Unlike `drawOnto`, which is a one-line caption for the screenshot.
   */
  drawForPrint(
    ctx: CanvasRenderingContext2D,
    camera: THREE.Camera,
    w: number,
    h: number,
    scale: number,
  ): void {
    ctx.save();
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    const labels = this.items.flatMap((it) => {
      const shown = this.shownCaption(it, camera, w, h);
      if (!shown) return [];
      const style = it.printStyle?.() ?? {};
      const fontPx = style.fontPx && style.fontPx > 0 ? style.fontPx : 12;
      const font = `${fontPx * scale}px sans-serif`;
      ctx.font = font;
      const measure = (line: string): number => ctx.measureText(line).width / scale;
      const lines = wrapPrintText(shown.text, PRINT_LABEL_MAX_WIDTH, measure);
      const lineHeight = fontPx * PRINT_LINE_HEIGHT;
      const boxW = Math.max(...lines.map(measure)) + PRINT_LABEL_PADDING * 2;
      const boxH = lines.length * lineHeight + 4;
      // The label's centre, kept inside the image so its text is never cut off.
      const cx = Math.max(boxW / 2, Math.min(w - boxW / 2, shown.x + (shown.off?.x ?? 0)));
      const cy = Math.max(boxH / 2, Math.min(h - boxH / 2, shown.y + (shown.off?.y ?? 0)));
      return [{ ...shown, font, lines, lineHeight, boxW, boxH, cx, cy, color: readablePrintColor(style.color) }];
    });

    // Leaders first, so that no line runs over another note's text.
    for (const l of labels) {
      if (l.off) drawLeader(ctx, l.cx * scale, l.cy * scale, l.x * scale, l.y * scale, scale);
    }
    for (const l of labels) {
      ctx.fillStyle = "rgba(255,255,255,0.88)";
      ctx.fillRect(
        (l.cx - l.boxW / 2) * scale,
        (l.cy - l.boxH / 2) * scale,
        l.boxW * scale,
        l.boxH * scale,
      );
      ctx.font = l.font;
      ctx.fillStyle = l.color;
      l.lines.forEach((line, i) => {
        const offset = (i - (l.lines.length - 1) / 2) * l.lineHeight;
        ctx.fillText(line, l.cx * scale, (l.cy + offset) * scale);
      });
    }
    ctx.restore();
  }

  /**
   * The screen position and text of a label to draw into an image, or null when
   * it isn't shown (hidden, offscreen, or hover-only — collapsed to a dot) so
   * the image matches what's actually on screen.
   */
  private shownCaption(
    it: Item,
    camera: THREE.Camera,
    w: number,
    h: number,
  ): { text: string; x: number; y: number; off: { x: number; y: number } | null } | null {
    const text = it.caption?.();
    if (!text) return null;
    if (
      it.el.hasClass("is-hidden") ||
      it.el.hasClass("step-viewer-label-offscreen") ||
      it.el.hasClass("is-hover-only")
    ) {
      return null;
    }
    this.v.copy(it.world()).project(camera);
    if (this.v.z > 1 || this.v.z < -1) return null;
    return {
      text,
      x: (this.v.x * 0.5 + 0.5) * w,
      y: (-this.v.y * 0.5 + 0.5) * h,
      off: it.leader?.() ?? null,
    };
  }

  dispose(): void {
    for (const it of this.items) {
      it.el.remove();
      it.line?.remove();
    }
    this.items = [];
    this.svg.remove();
    this.container.remove();
  }
}

/** A dashed leader from the label to its anchor, with an arrowhead at the anchor. */
function drawLeader(
  ctx: CanvasRenderingContext2D,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  scale: number,
): void {
  const angle = Math.atan2(toY - fromY, toX - fromX);
  const size = PRINT_ARROW_SIZE * scale;
  ctx.save();
  ctx.strokeStyle = "#656565";
  ctx.fillStyle = "#656565";
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
