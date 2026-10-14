/**
 * 3Dモデル注記（アノテーション）レイヤー機能
 * 
 * 1. 通常時はモデル引出線先端にテキストのみを表示（クリーンな表示）
 * 2. クリック時に編集ボックスがポップアップ展開（textarea + IME保護 + 保存/取消）
 * 3. 文字色（カラーパレット）および文字サイズ（S/M/L/XL）のリアルタイム変更
 * 4. キーボードフォーカス時に Delete / Backspace キーで注記を即座に削除
 * 5. カテゴリ色分け、引出線（リーダー）、他ノートへのWikilink連携
 * 6. コードブロック（YAML）や外部ストレージとの相互同期（getAllStored / loadFromList）
 **/

import { Component, MarkdownRenderer, Plugin, setIcon, setTooltip } from "obsidian";
import * as THREE from "three";
import { ViewerController } from "../viewer/ViewerController";
import { LabelLayer, LabelHandle } from "./LabelLayer";
import { AnnotationStore, StoredAnnotation } from "../annotations/AnnotationStore";
import {
  FONT_SIZE_OPTIONS,
  TEXT_COLOR_OPTIONS,
  getEffectiveFontSize,
  getEffectiveTextColor,
} from "../annotations/annotationOptions";
import { TextHistory } from "./textHistory";

// Default leader offset (screen px) applied the first time a note is pulled out
// to the side — placed clearly up and to the right of the anchor.
const DEFAULT_LEADER_OFFSET = { x: 140, y: -96 };
// Pointer travel (px) before a press on a note becomes a drag rather than a click.
const DRAG_THRESHOLD = 4;

/** Category colours a note can be tagged with (cycled from the swatch button). */
export const ANNOT_CATEGORIES: { color: string; label: string }[] = [
  { color: "#ffc531", label: "Note" },
  { color: "#e5484d", label: "Issue" },
  { color: "#30a46c", label: "OK" },
  { color: "#3b82f6", label: "Info" },
];
const DEFAULT_COLOR = ANNOT_CATEGORIES[0].color;

interface Live {
  data: StoredAnnotation;
  pin: THREE.Object3D;
  label: LabelHandle;
  textEl: HTMLElement;
  textareaEl: HTMLTextAreaElement;
  enterEdit: () => void;
  commit: () => void;
  /** Repaint the card's own colour swatch after an external colour change. */
  repaintSwatch?: () => void;
  /** Apply current textColor and fontSize to DOM elements. */
  applyTextStyles?: () => void;
}

/** Row data for the annotations list panel. */
export interface AnnotationItem {
  id: string;
  text: string;
  part: string;
  color: string;
  link?: string;
}

export class AnnotationLayer {
  private items: Live[] = [];
  private saveTimer: number | null = null;
  private visible = true;
  private opacity = 1;
  private filter: string | null = null;
  // When isolate is active, only notes whose anchor falls inside this world box
  // (the isolated part's bounds) are shown; null = no isolate restriction.
  private isolateBox: THREE.Box3 | null = null;
  private deletedStack: StoredAnnotation[] = [];
  /** テキスト編集中（編集ボックス展開中）の注記の数。 */
  private editingCount = 0;
  /**
   * 注記の内容が変更された（保存が必要になった）ときに呼ばれる。
   * onChange は一覧パネルの再描画用で読み込み時にも呼ばれるため、保存の契機とは分けている。
   */
  onEdit?: () => void;
  // Owns the markdown-render child components so they're freed when this view
  // closes, not only when the plugin unloads.
  private mdComponent = new Component();
  /** Fired when annotations are added/removed/edited (drives the list panel). */
  onChange: (() => void) | null = null;

  /** 直前に削除した注記を復元する（Ctrl+Z / Cmd+Z Undo） */
  undoDelete(): boolean {
    const restored = this.deletedStack.pop();
    if (!restored) return false;
    this.spawn(restored);
    this.scheduleSave();
    this.onChange?.();
    return true;
  }

  constructor(
    private controller: ViewerController,
    private labelLayer: LabelLayer,
    private store: AnnotationStore,
    private path: string,
    private plugin: Plugin,
  ) {
    this.mdComponent.load();
  }

  async load(): Promise<void> {
    const list = await this.store.get(this.path);
    for (const d of list) this.spawn(d);
    this.onChange?.();
  }

  loadFromList(list: StoredAnnotation[]): void {
    for (const d of list) {
      if (!this.items.some((i) => i.data.id === d.id)) {
        this.spawn(d);
      }
    }
    this.onChange?.();
  }

  getAllStored(): StoredAnnotation[] {
    return this.items.map((i) => ({ ...i.data }));
  }

  /** Called when the user clicks a model point in annotate mode. */
  addAt(local: THREE.Vector3, part: string): void {
    const d: StoredAnnotation = {
      id: genId(),
      x: local.x,
      y: local.y,
      z: local.z,
      text: "",
      part,
    };
    const live = this.spawn(d);
    window.setTimeout(() => {
      live.enterEdit();
    }, 40);
    this.scheduleSave();
    this.onChange?.();
  }


  // --- List panel API ------------------------------------------------------

  getItems(): AnnotationItem[] {
    return this.items.map((i) => ({
      id: i.data.id,
      text: i.data.text,
      part: i.data.part ?? "",
      color: i.data.color ?? DEFAULT_COLOR,
      link: i.data.link,
    }));
  }

  /** Pan the camera to an annotation and flash its label. */
  focus(id: string): void {
    const live = this.items.find((i) => i.data.id === id);
    if (!live) return;
    this.controller.lookAtPoint(live.pin.getWorldPosition(new THREE.Vector3()));
    live.label.el.addClass("is-flash");
    window.setTimeout(() => live.label.el.removeClass("is-flash"), 900);
  }

  removeById(id: string): void {
    const live = this.items.find((i) => i.data.id === id);
    if (live) this.remove(live);
  }

  /** Recolour a note (hex string) from the list panel; persists + refreshes. */
  setColor(id: string, color: string): void {
    const live = this.items.find((i) => i.data.id === id);
    if (!live) return;
    live.data.color = color;
    live.repaintSwatch?.(); // keep the card's own swatch button in sync
    this.applyVisual(live);
    this.scheduleSave();
    this.onChange?.();
  }

  setVisible(v: boolean): void {
    this.visible = v;
    for (const live of this.items) this.applyVisual(live);
  }

  isVisible(): boolean {
    return this.visible;
  }

  setOpacity(o: number): void {
    this.opacity = o;
    for (const live of this.items) this.applyVisual(live);
  }

  getOpacity(): number {
    return this.opacity;
  }

  /** Show only notes of the given category colour (null = show all). */
  setFilter(color: string | null): void {
    this.filter = color;
    for (const live of this.items) this.applyVisual(live);
  }

  getFilter(): string | null {
    return this.filter;
  }

  /** Restrict visible notes to those anchored inside `kept` (isolate), or clear
   *  the restriction when `kept` is null. */
  setIsolate(kept: THREE.Object3D | null): void {
    if (!kept) {
      this.isolateBox = null;
    } else {
      const box = new THREE.Box3().setFromObject(kept);
      const pad = box.getSize(new THREE.Vector3()).length() * 0.01 || 1e-4;
      box.expandByScalar(pad);
      this.isolateBox = box;
    }
    for (const live of this.items) this.applyVisual(live);
  }

  // --- Internals -----------------------------------------------------------

  private matchesFilter(d: StoredAnnotation): boolean {
    return !this.filter || (d.color ?? DEFAULT_COLOR) === this.filter;
  }

  private matchesIsolate(live: Live): boolean {
    if (!this.isolateBox) return true;
    return this.isolateBox.containsPoint(live.pin.getWorldPosition(new THREE.Vector3()));
  }

  private applyVisual(live: Live): void {
    const shown = this.visible && this.matchesFilter(live.data) && this.matchesIsolate(live);
    live.pin.visible = shown;
    const mat = (live.pin as THREE.Mesh).material as THREE.MeshBasicMaterial;
    if (mat) {
      mat.color.set(live.data.color ?? DEFAULT_COLOR);
      mat.transparent = this.opacity < 1;
      mat.opacity = this.opacity;
    }
    live.label.el.toggleClass("is-hidden", !shown);
    live.label.setOpacity(this.opacity);
    live.label.el.style.setProperty("--annot-color", live.data.color ?? DEFAULT_COLOR);
    this.applyModes(live);
  }

  /** Reflect the per-note display options (hover-only / leader) onto the DOM. */
  private applyModes(live: Live): void {
    live.label.el.toggleClass("is-hover-only", !!live.data.hoverOnly);
    live.label.el.toggleClass("is-leader", !!live.data.leader);
  }

  private spawn(d: StoredAnnotation): Live {
    const pin = this.controller.addAnnotationPin(new THREE.Vector3(d.x, d.y, d.z));

    const el = activeDocument.createElement("div");
    el.className = "step-viewer-annot";
    el.setAttribute("tabindex", "0");

    // Collapsed marker shown in hover-only mode; the note expands on hover.
    const dot = activeDocument.createElement("span");
    dot.className = "step-viewer-annot-dot";
    el.appendChild(dot);

    const body = activeDocument.createElement("div");
    body.className = "step-viewer-annot-body";

    const tools = activeDocument.createElement("div");
    tools.className = "step-viewer-annot-tools";
    tools.hide();

    // Link chip (read state) + editable text + rendered markdown.
    const linkChip = activeDocument.createElement("a");
    linkChip.className = "step-viewer-annot-link";

    const linkRow = activeDocument.createElement("div");
    linkRow.className = "step-viewer-annot-linkrow";
    linkRow.hide();
    const linkInput = activeDocument.createElement("input");
    linkInput.type = "text";
    linkInput.placeholder = "Note to link, e.g. [[Design]]";
    linkInput.value = d.link ?? "";
    linkRow.appendChild(linkInput);

    const textEl = activeDocument.createElement("div");
    textEl.className = "step-viewer-annot-text";
    textEl.textContent = d.text;
    textEl.dataset.placeholder = "Click to add note… (markdown)";

    let isComposing = false;
    const history = new TextHistory(d.text);
    const textareaEl = activeDocument.createElement("textarea");
    textareaEl.className = "step-viewer-annot-textarea";
    textareaEl.placeholder = "注記を入力… (Markdown対応、Ctrl+Enterで保存)";
    textareaEl.value = d.text;
    textareaEl.hide();
    textareaEl.addEventListener("compositionstart", () => {
      isComposing = true;
    });
    textareaEl.addEventListener("compositionend", () => {
      isComposing = false;
      history.push(textareaEl.value);
    });
    textareaEl.addEventListener("input", () => {
      if (!isComposing) {
        history.push(textareaEl.value);
      }
    });
    textareaEl.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (isComposing) return;

      // Undo: Ctrl+Z または Cmd+Z (Mac対応)
      const isUndo = (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z";
      // Redo: Ctrl+Y または Ctrl+Shift+Z または Cmd+Shift+Z
      const isRedo =
        ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "z") ||
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y");

      if (isUndo) {
        e.preventDefault();
        const prev = history.undo();
        if (prev !== undefined) {
          textareaEl.value = prev;
        }
        return;
      }

      if (isRedo) {
        e.preventDefault();
        const next = history.redo();
        if (next !== undefined) {
          textareaEl.value = next;
        }
        return;
      }

      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        live.commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelEdit();
      }
    });
    textareaEl.addEventListener("keyup", (e) => e.stopPropagation());
    textareaEl.addEventListener("keypress", (e) => e.stopPropagation());
    textareaEl.addEventListener("pointerdown", (e) => e.stopPropagation());
    textareaEl.addEventListener("mousedown", (e) => e.stopPropagation());
    textareaEl.addEventListener("click", (e) => e.stopPropagation());

    const editActions = activeDocument.createElement("div");
    editActions.className = "step-viewer-annot-actions";
    editActions.hide();

    const saveBtn = activeDocument.createElement("button");
    saveBtn.className = "step-viewer-annot-action-btn mod-save";
    saveBtn.textContent = "保存";
    saveBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      live.commit();
    });

    const cancelBtn = activeDocument.createElement("button");
    cancelBtn.className = "step-viewer-annot-action-btn mod-cancel";
    cancelBtn.textContent = "取消";
    cancelBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      cancelEdit();
    });

    editActions.appendChild(saveBtn);
    editActions.appendChild(cancelBtn);

    const renderEl = activeDocument.createElement("div");
    renderEl.className = "step-viewer-annot-render";

    body.appendChild(tools);
    body.appendChild(linkChip);
    body.appendChild(linkRow);
    body.appendChild(textEl);
    body.appendChild(textareaEl);
    body.appendChild(editActions);
    body.appendChild(renderEl);
    el.appendChild(body);

    const label = this.labelLayer.add(
      el,
      () => pin.getWorldPosition(new THREE.Vector3()),
      () =>
        d.leader
          ? { x: d.ox ?? DEFAULT_LEADER_OFFSET.x, y: d.oy ?? DEFAULT_LEADER_OFFSET.y }
          : null,
      // Screenshot caption: the rendered (plain) text, not the markdown source.
      () => renderEl.textContent || d.text,
    );

    const applyTextStyles = (): void => {
      const fs = getEffectiveFontSize(d.fontSize);
      const tc = getEffectiveTextColor(d.textColor);
      textEl.style.fontSize = fs;
      renderEl.style.fontSize = fs;
      textareaEl.style.fontSize = fs;
      if (tc) {
        textEl.style.color = tc;
        renderEl.style.color = tc;
        textareaEl.style.color = tc;
      } else {
        textEl.style.color = "";
        renderEl.style.color = "";
        textareaEl.style.color = "";
      }
    };
    applyTextStyles();

    const live: Live = {
      data: d,
      pin,
      label,
      textEl,
      textareaEl,
      enterEdit: () => {},
      commit: () => {},
      applyTextStyles,
    };

    // Category colour: a swatch that opens a palette popover to pick a colour.
    const palette = activeDocument.createElement("div");
    palette.className = "step-viewer-annot-palette";
    palette.hide();
    body.insertBefore(palette, linkChip);

    const colorBtn = this.toolButton(tools, "", "Category colour (ピン色)", () => {
      palette.toggle(!palette.isShown());
      if (palette.isShown()) {
        textColorPalette.hide();
        fontSizePalette.hide();
      }
    });
    colorBtn.addClass("step-viewer-annot-swatch");
    const paintSwatch = (): void => {
      const cur = d.color ?? DEFAULT_COLOR;
      colorBtn.style.background = cur;
      const cat = ANNOT_CATEGORIES.find((c) => c.color === cur);
      setTooltip(colorBtn, `Category: ${cat?.label ?? "Note"}`, { placement: "top" });
    };
    for (const cat of ANNOT_CATEGORIES) {
      const sw = activeDocument.createElement("button");
      sw.className = "step-viewer-annot-palette-swatch";
      sw.style.background = cat.color;
      setTooltip(sw, cat.label, { placement: "top" });
      sw.addEventListener("click", (e) => {
        e.stopPropagation();
        d.color = cat.color;
        palette.hide();
        paintSwatch();
        this.applyVisual(live);
        this.scheduleSave();
        this.onChange?.();
      });
      palette.appendChild(sw);
    }

    const custom = activeDocument.createElement("input");
    custom.type = "color";
    custom.className = "step-viewer-annot-palette-custom";
    custom.value = hexOr(d.color, DEFAULT_COLOR);
    setTooltip(custom, "カスタムピン色", { placement: "top" });
    custom.addEventListener("click", (e) => e.stopPropagation());
    custom.addEventListener("pointerdown", (e) => e.stopPropagation());
    custom.addEventListener("input", () => {
      d.color = custom.value;
      paintSwatch();
      this.applyVisual(live);
      this.scheduleSave();
      this.onChange?.();
    });
    custom.addEventListener("change", () => palette.hide());
    palette.appendChild(custom);
    paintSwatch();
    live.repaintSwatch = paintSwatch;

    // Text Color palette
    const textColorPalette = activeDocument.createElement("div");
    textColorPalette.className = "step-viewer-annot-palette mod-text-color";
    textColorPalette.hide();
    body.insertBefore(textColorPalette, linkChip);

    const textColorLabel = activeDocument.createElement("div");
    textColorLabel.className = "step-viewer-annot-palette-label";
    textColorLabel.textContent = "文字色:";
    textColorPalette.appendChild(textColorLabel);

    const textColorBtn = this.toolButton(tools, "palette", "文字色 (Text color)", () => {
      textColorPalette.toggle(!textColorPalette.isShown());
      if (textColorPalette.isShown()) {
        palette.hide();
        fontSizePalette.hide();
      }
    });

    const textColorSwatches: HTMLElement[] = [];
    for (const opt of TEXT_COLOR_OPTIONS) {
      const sw = activeDocument.createElement("button");
      sw.className = "step-viewer-annot-palette-swatch";
      sw.style.background = opt.color;
      setTooltip(sw, opt.label, { placement: "top" });
      sw.addEventListener("click", (e) => {
        e.stopPropagation();
        d.textColor = opt.color;
        textColorPalette.hide();
        applyTextStyles();
        this.scheduleSave();
        this.onChange?.();
      });
      textColorPalette.appendChild(sw);
      textColorSwatches.push(sw);
    }

    const customTextColor = activeDocument.createElement("input");
    customTextColor.type = "color";
    customTextColor.className = "step-viewer-annot-palette-custom";
    customTextColor.value = hexOr(d.textColor, "#ffffff");
    setTooltip(customTextColor, "カスタム文字色", { placement: "top" });
    customTextColor.addEventListener("click", (e) => e.stopPropagation());
    customTextColor.addEventListener("pointerdown", (e) => e.stopPropagation());
    customTextColor.addEventListener("input", () => {
      d.textColor = customTextColor.value;
      applyTextStyles();
      this.scheduleSave();
      this.onChange?.();
    });
    customTextColor.addEventListener("change", () => textColorPalette.hide());
    textColorPalette.appendChild(customTextColor);

    // Font Size palette
    const fontSizePalette = activeDocument.createElement("div");
    fontSizePalette.className = "step-viewer-annot-palette mod-font-size";
    fontSizePalette.hide();
    body.insertBefore(fontSizePalette, linkChip);

    const fontSizeLabel = activeDocument.createElement("div");
    fontSizeLabel.className = "step-viewer-annot-palette-label";
    fontSizeLabel.textContent = "サイズ:";
    fontSizePalette.appendChild(fontSizeLabel);

    const fontSizeBtn = this.toolButton(tools, "type", "文字サイズ (Font size)", () => {
      fontSizePalette.toggle(!fontSizePalette.isShown());
      if (fontSizePalette.isShown()) {
        palette.hide();
        textColorPalette.hide();
      }
    });

    for (const opt of FONT_SIZE_OPTIONS) {
      const szBtn = activeDocument.createElement("button");
      szBtn.className = "step-viewer-annot-size-btn";
      szBtn.textContent = opt.key.slice(0, 1).toUpperCase();
      setTooltip(szBtn, opt.label, { placement: "top" });
      szBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        d.fontSize = opt.key;
        fontSizePalette.hide();
        applyTextStyles();
        this.scheduleSave();
        this.onChange?.();
      });
      fontSizePalette.appendChild(szBtn);
    }

    // Link: toggle the input row; the chip (read state) opens the target.
    const linkBtn = this.toolButton(tools, "link", "Link to a note", () => {
      linkRow.toggle(!linkRow.isShown());
      if (linkRow.isShown()) linkInput.focus();
    });
    const syncLink = (): void => {
      const has = !!(d.link && d.link.trim());
      linkBtn.toggleClass("is-active", has);
      if (has) {
        linkChip.setText(`↗ ${d.link}`);
        linkChip.show();
      } else {
        linkChip.hide();
      }
    };
    linkInput.addEventListener("input", () => {
      d.link = linkInput.value.trim() || undefined;
      syncLink();
      this.scheduleSave();
      this.onChange?.();
    });
    linkInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") linkRow.hide();
    });
    linkInput.addEventListener("pointerdown", (e) => e.stopPropagation());
    linkChip.addEventListener("click", (e) => {
      e.stopPropagation();
      if (d.link) void this.plugin.app.workspace.openLinkText(d.link, this.path, false);
    });
    syncLink();

    // Per-note display toggles: hover-only visibility, and leader placement.
    const hoverBtn = this.toolButton(tools, "eye", "Show only on hover", () => {
      d.hoverOnly = !d.hoverOnly;
      hoverBtn.toggleClass("is-active", !!d.hoverOnly);
      this.applyModes(live);
      this.scheduleSave();
    });
    hoverBtn.toggleClass("is-active", !!d.hoverOnly);

    const leaderBtn = this.toolButton(tools, "milestone", "Pull note out to the side (or drag it)", () => {
      d.leader = !d.leader;
      if (d.leader) {
        d.ox = d.ox ?? DEFAULT_LEADER_OFFSET.x;
        d.oy = d.oy ?? DEFAULT_LEADER_OFFSET.y;
      }
      leaderBtn.toggleClass("is-active", !!d.leader);
      this.applyModes(live);
      this.scheduleSave();
    });
    leaderBtn.toggleClass("is-active", !!d.leader);

    let isEditing = false;
    const editBtn = this.toolButton(tools, "pencil", "Edit note text", () => {
      if (isEditing) {
        commit();
      } else {
        enterEdit();
      }
    });

    const del = activeDocument.createElement("button");
    del.className = "step-viewer-annot-del clickable-icon";
    del.setAttribute("aria-label", "Delete note");
    setIcon(del, "x");
    setTooltip(del, "Delete note (削除)", { placement: "top" });
    tools.appendChild(del);

    // Markdown read/edit toggle.
    const enterEdit = (): void => {
      if (!isEditing) this.editingCount++;
      isEditing = true;
      el.addClass("is-editing");
      tools.show();
      renderEl.hide();
      textEl.hide();
      textareaEl.value = d.text;
      textareaEl.show();
      editActions.show();
      editBtn.addClass("is-active");
      setIcon(editBtn, "check");
      setTooltip(editBtn, "Done editing (完了)");
      window.setTimeout(() => {
        textareaEl.focus();
      }, 30);
    };

    const cancelEdit = (): void => {
      if (!isEditing) return;
      isEditing = false;
      this.editingCount = Math.max(0, this.editingCount - 1);
      el.removeClass("is-editing");
      tools.hide();
      palette.hide();
      textColorPalette.hide();
      fontSizePalette.hide();
      linkRow.hide();
      textareaEl.value = d.text;
      history.reset(d.text);
      textareaEl.hide();
      editActions.hide();
      editBtn.removeClass("is-active");
      setIcon(editBtn, "pencil");
      setTooltip(editBtn, "Edit note text (編集)");
      if (d.text.trim()) {
        textEl.hide();
        renderEl.show();
      } else {
        renderEl.hide();
        textEl.show();
      }
    };

    const commit = (): void => {
      if (!isEditing) return;
      isEditing = false;
      this.editingCount = Math.max(0, this.editingCount - 1);
      el.removeClass("is-editing");
      tools.hide();
      palette.hide();
      textColorPalette.hide();
      fontSizePalette.hide();
      linkRow.hide();
      d.text = textareaEl.value;
      history.reset(d.text);
      textEl.textContent = d.text;
      textareaEl.hide();
      editActions.hide();
      editBtn.removeClass("is-active");
      setIcon(editBtn, "pencil");
      setTooltip(editBtn, "Edit note text (編集)");
      if (d.text.trim()) {
        textEl.hide();
        void this.renderMarkdown(d.text, renderEl);
        renderEl.show();
      } else {
        renderEl.hide();
        textEl.show();
      }
      this.scheduleSave();
      this.onChange?.();
    };

    live.enterEdit = enterEdit;
    live.commit = commit;

    // キーボード操作で選択時（Delete/Backspaceで削除、Ctrl+Z/Cmd+Zで削除復元、Enterで編集開始）
    el.addEventListener("keydown", (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLInputElement
      ) {
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        e.stopPropagation();
        this.remove(live);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.stopPropagation();
        this.undoDelete();
      } else if (e.key === "Enter" && !isEditing) {
        e.preventDefault();
        e.stopPropagation();
        enterEdit();
      }
    });

    el.addEventListener("click", (e) => {
      if (!isEditing) {
        e.stopPropagation();
        el.focus();
      }
    });

    textEl.addEventListener("click", (e) => {
      e.stopPropagation();
      enterEdit();
    });

    // Initial state: rendered if there's text, editable if empty.
    if (d.text.trim()) {
      textEl.hide();
      void this.renderMarkdown(d.text, renderEl);
      renderEl.show();
    } else {
      renderEl.hide();
      textEl.show();
    }

    renderEl.addEventListener("click", (e) => {
      // A click that concluded a drag (pull-out) must not also enter edit mode.
      if (el.dataset.dragged) {
        delete el.dataset.dragged;
        return;
      }
      const a = (e.target as HTMLElement).closest("a");
      if (a) {
        e.preventDefault();
        e.stopPropagation();
        const href = a.getAttribute("data-href") || a.getAttribute("href") || "";
        if (href) void this.plugin.app.workspace.openLinkText(href, this.path, false);
        return;
      }
      e.stopPropagation();
      enterEdit();
    });

    del.addEventListener("click", (e) => {
      e.stopPropagation();
      this.remove(live);
    });

    this.wireDrag(el, textEl, textareaEl, renderEl, editActions, live);


    this.items.push(live);
    this.applyVisual(live);
    return live;
  }

  private async renderMarkdown(md: string, el: HTMLElement): Promise<void> {
    el.empty();
    await MarkdownRenderer.render(this.plugin.app, md, el, this.path, this.mdComponent);
  }

  /** Small icon toggle inside a note's toolbar strip. */
  private toolButton(
    parent: HTMLElement,
    icon: string,
    tooltip: string,
    onClick: () => void,
  ): HTMLElement {
    const btn = activeDocument.createElement("button");
    btn.className = "step-viewer-annot-tool clickable-icon";
    if (icon) setIcon(btn, icon);
    setTooltip(btn, tooltip, { placement: "top" });
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    parent.appendChild(btn);
    return btn;
  }

  /**
   * Pointer handling for a note. Always swallows canvas gestures (so editing
   * doesn't orbit the model). Dragging the note body (not the text, buttons,
   * link or input) pulls it off to the side: past a small threshold it turns on
   * leader mode automatically and follows the cursor, drawing the arrow back to
   * its anchor. A press that doesn't move stays a click (edit / open link).
   */
  private wireDrag(
    el: HTMLElement,
    textEl: HTMLElement,
    textareaEl: HTMLElement,
    renderEl: HTMLElement,
    editActions: HTMLElement,
    live: Live,
  ): void {
    const d = live.data;
    let press: { x: number; y: number; ox: number; oy: number } | null = null;
    let moved = false;

    el.addEventListener("pointerdown", (e) => {
      e.stopPropagation(); // never reaches the canvas (orbit / new annotation)
      delete el.dataset.dragged;
      const target = e.target as HTMLElement;
      if (
        target === textEl ||
        textEl.contains(target) ||
        target === textareaEl ||
        textareaEl.contains(target) ||
        target === renderEl ||
        renderEl.contains(target) ||
        target === editActions ||
        editActions.contains(target)
      ) {
        return; // allow editing
      }
      if (target.closest("button") || target.closest("input") || target.closest("a")) return;

      press = {
        x: e.clientX,
        y: e.clientY,
        ox: d.leader ? d.ox ?? DEFAULT_LEADER_OFFSET.x : 0,
        oy: d.leader ? d.oy ?? DEFAULT_LEADER_OFFSET.y : 0,
      };
      moved = false;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointermove", (e) => {
      if (!press) return;
      const dx = e.clientX - press.x;
      const dy = e.clientY - press.y;
      if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!moved) {
        moved = true;
        el.addClass("is-dragging");
        if (!d.leader) {
          d.leader = true; // dragging the note pulls it out with an arrow
          this.applyModes(live);
        }
      }
      d.ox = press.ox + dx;
      d.oy = press.oy + dy;
    });
    const end = (e: PointerEvent): void => {
      if (!press) return;
      el.releasePointerCapture?.(e.pointerId);
      if (moved) {
        el.removeClass("is-dragging");
        el.dataset.dragged = "1"; // suppress the click that follows a drag
        this.scheduleSave();
        this.onChange?.();
      }
      press = null;
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  private remove(live: Live): void {
    this.deletedStack.push({ ...live.data });
    this.controller.removeAnnotationPin(live.pin);
    live.label.remove();
    const i = this.items.indexOf(live);
    if (i >= 0) this.items.splice(i, 1);
    this.scheduleSave();
    this.onChange?.();
  }

  /** いずれかの注記がテキスト編集中かどうか。 */
  isEditing(): boolean {
    return this.editingCount > 0;
  }

  private scheduleSave(): void {
    this.onEdit?.();
    if (this.saveTimer != null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.store.set(
        this.path,
        this.items.map((i) => i.data),
      );
    }, 400);
  }

  dispose(): void {
    if (this.saveTimer != null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
      // Flush the latest state on teardown.
      void this.store.set(
        this.path,
        this.items.map((i) => i.data),
      );
    }
    for (const live of this.items) {
      this.controller.removeAnnotationPin(live.pin);
      live.label.remove();
    }
    this.items = [];
    this.mdComponent.unload(); // free all rendered-markdown child components
  }
}

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Return `v` if it's a #rrggbb hex string, otherwise the fallback. The native
 *  colour input only accepts that form. */
function hexOr(v: string | undefined, fallback: string): string {
  return v && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
}
