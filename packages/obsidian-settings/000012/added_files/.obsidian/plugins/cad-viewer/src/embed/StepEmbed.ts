/**
 * Markdownノート内 ```step コードブロック埋め込みレンダラー
 * 
 * 1. ```step コードブロックからパス、幅、高さ、視点、カメラ座標、断面設定、注記を解析・表示
 * 2. IntersectionObserver による遅延マウント・コンテキスト節約
 * 3. ツールバーの固定ボタン押下時に、現在のカメラ・断面・注記設定をMarkdownファイルへ自動保存
 * 4. 枠ドラッグ（右端・下端・右下隅）による幅・高さのインタラクティブな変更とMarkdown保存
 * 5. 複数配置されたコードブロックを個別に一意特定し、他のブロックに影響を与えず単独保存
 **/

import { MarkdownRenderChild, Notice, Plugin, TFile } from "obsidian";
import { OcctLoader } from "../viewer/OcctLoader";
import {
  Profile,
  deflectionForSize,
  paramsForDeflection,
  tiersForProfile,
} from "../viewer/params";
import { mountViewer, ViewerHandle } from "../viewer/mountViewer";
import { formatFileSize, shouldWarnLargeModel } from "../viewer/mobileGuard";
import { hasRenderableMeshes, isWireframeOnly } from "../viewer/StepToThree";
import { METADATA_MAX_BYTES } from "../viewer/StepMeta";
import { cacheKey, resultBytes, CACHE_MIN_BYTES } from "../viewer/GeometryCache";
import { HasStepSettings } from "../settings";
import {
  parseStepCodeBlock,
  updateStepBlockInMarkdown,
  serializeStepCodeBlock,
  clampEmbedSize,
  carryOverEmbedSettings,
  StepEmbedConfig,
} from "./StepCodeBlockUtils";

const EMBED_PROFILES = new Set<Profile>(["fastest", "balanced", "detailed"]);

const DEFAULT_HEIGHT = 400;

/**
 * Renders a ```step code block as an inline 3D viewer inside a note.
 *
 * Because each viewer holds a WebGL context and those are scarce (design §2.6),
 * the viewer is mounted lazily when the block scrolls into view and disposed
 * when it scrolls away, so a note with many embeds never exhausts contexts.
 *
 * Block syntax:
 *   ```step
 *   path: Models/bracket.step
 *   width: 600
 *   height: 320
 *   view: front          # front/back/left/right/top/bottom/iso
 *   rotate: 90           # initial roll in degrees (or `roll: 1` in quarter turns)
 *   annotations: false   # hide saved notes in this embed (default true)
 *   quality: detailed    # fastest/balanced/detailed, or a coarseness like 0.01
 *   ```
 * `path` may be a wikilink target or a vault-relative path. A bare first line is
 * also accepted as the path.
 */
export class StepEmbed extends MarkdownRenderChild {
  private observer: IntersectionObserver | null = null;
  private viewer: ViewerHandle | null = null;
  private wrapper!: HTMLElement;
  private host!: HTMLElement;
  private linktext = "";
  private wantMounted = false;
  private busy = false;
  /** Set when the user opts past the mobile large-model warning. */
  private forceLarge = false;

  constructor(
    containerEl: HTMLElement,
    private plugin: Plugin & HasStepSettings,
    private source: string,
    private sourcePath: string,
    private ctx?: any,
  ) {
    super(containerEl);
  }

  private opts: StepEmbedConfig = { path: "", height: DEFAULT_HEIGHT };

  onload(): void {
    this.opts = parseStepCodeBlock(this.source);
    if (this.opts.height === undefined) this.opts.height = DEFAULT_HEIGHT;
    const { path, width, height } = this.opts;
    this.containerEl.empty();
    this.containerEl.addClass("step-viewer-embed");
    this.wrapper = this.containerEl.createDiv({ cls: "step-viewer-embed-wrapper" });
    this.host = this.wrapper.createDiv({ cls: "step-viewer-embed-host" });

    if (width !== undefined) {
      this.wrapper.style.width = `${width}px`;
    } else {
      this.wrapper.style.width = "100%";
    }
    this.wrapper.style.height = `${height}px`;

    // 枠ドラッグによるリサイズハンドルの初期化 (wrapper直下に配置しhost.empty()の影響を受けない)
    this.setupResizeHandles();

    if (!path) {
      this.message("No STEP path. Use a `path:` line inside the ```step block.");
      return;
    }
    this.linktext = path;
    this.placeholder();

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) this.mount();
          else this.unmount();
        }
      },
      { rootMargin: "200px" },
    );
    this.observer.observe(this.wrapper);
  }

  /**
   * 枠（右端・下端・右下隅）をドラッグして幅・高さを変更するハンドルの設置
   */
  private setupResizeHandles(): void {
    const handleRight = this.wrapper.createDiv({ cls: "step-viewer-resize-handle mod-right" });
    const handleBottom = this.wrapper.createDiv({ cls: "step-viewer-resize-handle mod-bottom" });
    const handleCorner = this.wrapper.createDiv({ cls: "step-viewer-resize-handle mod-corner" });

    this.wireResize(handleRight, "horizontal");
    this.wireResize(handleBottom, "vertical");
    this.wireResize(handleCorner, "both");
  }

  private wireResize(
    handle: HTMLElement,
    direction: "horizontal" | "vertical" | "both",
  ): void {
    let startX = 0;
    let startY = 0;
    let startW = 0;
    let startH = 0;
    let isDragging = false;

    handle.addEventListener("pointerdown", (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      startX = e.clientX;
      startY = e.clientY;
      startW = this.wrapper.offsetWidth;
      startH = this.wrapper.offsetHeight;
      isDragging = true;
      handle.setPointerCapture(e.pointerId);
      this.wrapper.addClass("is-resizing");
    });

    handle.addEventListener("pointermove", (e: PointerEvent) => {
      if (!isDragging) return;
      e.preventDefault();
      e.stopPropagation();

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      const parentW = this.containerEl.parentElement?.clientWidth || window.innerWidth;
      const targetW = direction === "vertical" ? startW : startW + dx;
      const targetH = direction === "horizontal" ? startH : startH + dy;

      const clamped = clampEmbedSize(targetW, targetH, parentW);

      if (direction !== "vertical") {
        this.wrapper.style.width = `${clamped.width}px`;
      }
      if (direction !== "horizontal") {
        this.wrapper.style.height = `${clamped.height}px`;
      }
    });

    const onPointerUp = async (e: PointerEvent) => {
      if (!isDragging) return;
      isDragging = false;
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch (_) {}
      this.wrapper.removeClass("is-resizing");

      const finalW = Math.round(this.wrapper.offsetWidth);
      const finalH = Math.round(this.wrapper.offsetHeight);

      this.opts.width = finalW;
      this.opts.height = finalH;

      try {
        await this.saveEmbedConfig(this.opts);
        new Notice(`CAD Viewer: 表示サイズを ${finalW} × ${finalH} px に保存しました`);
      } catch (err) {
        console.error("[CAD Viewer] Failed to save resized dimensions", err);
      }
    };

    handle.addEventListener("pointerup", onPointerUp);
    handle.addEventListener("pointercancel", onPointerUp);
  }

  private async saveEmbedConfig(config: StepEmbedConfig): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(this.sourcePath);
    if (!(file instanceof TFile)) return;

    // 表示サイズとメッシュ品質は、ビューアが作る設定に含まれないため現在の値を引き継ぐ。
    const newConfig = carryOverEmbedSettings(this.opts, config, DEFAULT_HEIGHT);

    // 現在のコードブロックの行情報を取得（利用可能な場合）
    const sectionInfo = this.ctx?.getSectionInfo?.(this.containerEl);

    await this.plugin.app.vault.process(file, (data) => {
      return updateStepBlockInMarkdown(data, this.opts.path, newConfig, {
        originalSource: this.source,
        lineStart: sectionInfo?.lineStart,
        lineEnd: sectionInfo?.lineEnd,
      });
    });

    this.opts = newConfig;
    this.source = serializeStepCodeBlock(newConfig);
  }


  private mount(): void {
    this.wantMounted = true;
    void this.ensure();
  }

  private unmount(): void {
    this.wantMounted = false;
    if (this.viewer) {
      this.viewer.dispose();
      this.viewer = null;
      this.placeholder();
    }
  }

  private async ensure(): Promise<void> {
    if (this.viewer || this.busy) return;
    this.busy = true;
    try {
      const file = this.resolveFile(this.linktext);
      if (!file) throw new Error(`STEP file not found: ${this.linktext}`);

      // On mobile, warn before parsing a large model (memory) unless opted in.
      if (!this.forceLarge && shouldWarnLargeModel(file.stat.size)) {
        this.largeWarning(file.stat.size);
        return;
      }

      this.host.empty();
      const loading = this.host.createDiv({
        cls: "step-viewer-overlay step-viewer-loading",
      });
      loading.createDiv({ cls: "step-viewer-spinner" });
      loading.createEl("div", { text: "Loading STEP…", cls: "step-viewer-message" });

      const settings = this.plugin.stepSettings;
      const deflection = this.deflectionFor(file.stat.size);
      const useCache = settings.cacheEnabled && file.stat.size >= CACHE_MIN_BYTES;
      const key = cacheKey(file.path, file.stat.mtime, file.stat.size, deflection);

      // Fast path: reuse previously parsed geometry (skips OCCT).
      if (useCache) {
        const cached = await this.plugin.geometryCache.get(key);
        if (!this.wantMounted) return;
        if (cached && hasRenderableMeshes(cached)) {
          this.host.empty();
          this.viewer = mountViewer(this.host, cached, {
            plugin: this.plugin,
            filePath: file.path,
            showAnnotations: this.opts.showAnnotations,
            initialView: this.opts.view,
            initialRoll: this.opts.roll,
            initialCamera: this.opts.camera,
            initialSection: this.opts.section,
            initialAnnotations: this.opts.annotations,
            initialLocked: this.opts.locked,
            onSaveConfig: (cfg) => this.saveEmbedConfig(cfg),
            healFaces: settings.healFaces,
          });
          return;
        }
      }

      const buffer = await this.plugin.app.vault.readBinary(file);
      const bytes = new Uint8Array(buffer);
      // Decode text for metadata before parsing (the worker transfers the byte
      // buffer); skip decoding large files, whose metadata is skipped anyway.
      const stepText =
        bytes.length > METADATA_MAX_BYTES
          ? undefined
          : new TextDecoder("latin1").decode(bytes);

      const { result } = await OcctLoader.parseStep(
        bytes,
        paramsForDeflection(deflection),
      );

      // Scrolled away (or unloaded) while we were parsing — bail out.
      if (!this.wantMounted) return;

      this.host.empty();
      if (!hasRenderableMeshes(result)) {
        this.message(
          isWireframeOnly(stepText)
            ? "This file contains only wireframe curves (no surface or solid bodies), " +
                "so there is nothing to render. Re-export it with solid/surface geometry."
            : `No usable geometry (${formatFileSize(file.stat.size)}). The model may be too ` +
                "large for the in-browser parser, or use unsupported entities.",
        );
        return;
      }

      if (useCache) {
        const cache = this.plugin.geometryCache;
        const maxBytes = settings.cacheMaxMB * 1024 * 1024;
        void cache
          .put(key, result, resultBytes(result))
          .then(() => cache.enforceCap(maxBytes));
      }

      this.viewer = mountViewer(this.host, result, {
        plugin: this.plugin,
        filePath: file.path,
        showAnnotations: this.opts.showAnnotations,
        initialView: this.opts.view,
        initialRoll: this.opts.roll,
        initialCamera: this.opts.camera,
        initialSection: this.opts.section,
        initialAnnotations: this.opts.annotations,
        initialLocked: this.opts.locked,
        onSaveConfig: (cfg) => this.saveEmbedConfig(cfg),
        stepText,
        healFaces: settings.healFaces,
      });

    } catch (err) {
      console.error("[STEP Viewer] Embed failed", this.linktext, err);
      this.message(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy = false;
    }
  }

  /**
   * Resolve the mesh coarseness for this embed: an explicit `quality:` override
   * (a profile name or a raw deflection number) wins, otherwise the global
   * size-based tiers apply.
   */
  private deflectionFor(sizeBytes: number): number {
    const q = this.opts.quality;
    if (typeof q === "number") return q;
    if (typeof q === "string" && EMBED_PROFILES.has(q as any)) {
      return deflectionForSize(sizeBytes, tiersForProfile(q as Exclude<Profile, "custom">));
    }
    return deflectionForSize(sizeBytes, this.plugin.stepSettings.tiers);
  }

  private resolveFile(linktext: string): TFile | null {
    const dest = this.plugin.app.metadataCache.getFirstLinkpathDest(
      linktext,
      this.sourcePath,
    );
    if (dest instanceof TFile) return dest;
    const byPath = this.plugin.app.vault.getAbstractFileByPath(linktext);
    return byPath instanceof TFile ? byPath : null;
  }

  private placeholder(): void {
    this.host.empty();
    const el = this.host.createDiv({
      cls: "step-viewer-overlay step-viewer-embed-placeholder",
    });
    el.createEl("div", { text: this.linktext, cls: "step-viewer-message" });
    el.createEl("div", {
      text: "STEP preview",
      cls: "step-viewer-message-sub",
    });
  }

  private largeWarning(sizeBytes: number): void {
    this.host.empty();
    const el = this.host.createDiv({
      cls: "step-viewer-overlay step-viewer-empty",
    });
    el.createEl("div", { text: this.linktext, cls: "step-viewer-message" });
    el.createEl("div", {
      text: `${formatFileSize(sizeBytes)} — large models may run out of memory on mobile.`,
      cls: "step-viewer-message-sub",
    });
    const btn = el.createEl("button", { text: "Open anyway", cls: "mod-cta" });
    btn.addEventListener("click", () => {
      this.forceLarge = true;
      void this.ensure();
    });
  }

  private message(text: string): void {
    this.host.empty();
    const el = this.host.createDiv({ cls: "step-viewer-overlay step-viewer-error" });
    el.createEl("div", { text, cls: "step-viewer-message-sub" });
  }

  onunload(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.viewer?.dispose();
    this.viewer = null;
  }
}
