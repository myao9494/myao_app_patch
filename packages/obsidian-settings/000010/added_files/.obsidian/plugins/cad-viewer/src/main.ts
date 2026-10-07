/**
 * STEP Viewer プラグインエントリーポイント
 * 
 * 1. .step / .stp / .obj / .stl / .fcstd ファイルのカスタム3Dビュー登録
 * 2. Markdownノート内 ```step コードブロックプロセッサの登録（StepEmbed）
 * 3. CADファイルがMarkdownエディタにドロップされた際の自動コードブロック挿入連携（editor-drop）
 * 4. プラグイン設定タブの提供（パフォーマンス、詳細度、キャッシュ制御）
 **/

import { App, Editor, MarkdownFileInfo, MarkdownView, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { STEP_VIEW_TYPE, StepView } from "./view/StepView";
import { StepEmbed } from "./embed/StepEmbed";
import { StepViewerSettings, DEFAULT_SETTINGS } from "./settings";
import { Profile, QualityTier, tiersForProfile } from "./viewer/params";
import { GeometryCache } from "./viewer/GeometryCache";
import { isCadFile, buildCadCodeBlock, extractCadPathFromDropData } from "./dropHandler";


export default class StepViewerPlugin extends Plugin {
  // Named `stepSettings`, not `settings`: Obsidian 1.13 added an official
  // `Plugin.settings`, and reusing that name collides with it.
  stepSettings: StepViewerSettings = { ...DEFAULT_SETTINGS };
  // Shared across views/embeds; parsed-geometry cache (IndexedDB, off-vault).
  geometryCache = new GeometryCache();

  async onload(): Promise<void> {
    console.info(`[CAD Viewer] plugin ${this.manifest.version} loaded`);
    await this.loadSettings();

    this.registerView(STEP_VIEW_TYPE, (leaf) => new StepView(leaf, this));
    this.registerExtensions(["step", "stp", "obj", "stl", "fcstd"], STEP_VIEW_TYPE);

    // ```step と ```cad の両方のコードブロック構文をサポート
    const processor = (source: string, el: HTMLElement, ctx: any) => {
      ctx.addChild(new StepEmbed(el, this, source, ctx.sourcePath, ctx));
    };
    this.registerMarkdownCodeBlockProcessor("step", processor);
    this.registerMarkdownCodeBlockProcessor("cad", processor);

    // キャプチャフェーズでのCADファイルドロップ捕捉リスナーを登録
    document.addEventListener("drop", this.handleDocumentDrop, true);

    // 安全策（フォールバック）: 万が一[[...step]]が挿入された場合の自動変換
    this.registerEvent(
      this.app.workspace.on("editor-change", (editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
        const cursor = editor.getCursor();
        const line = editor.getLine(cursor.line);
        const match = /^(\s*!?\[\[([^\]]+\.(step|stp|fcstd|obj|stl))(\|[^\]]*)?\]\]\s*)$/i.exec(line);
        if (match) {
          const targetPath = match[2];
          const resolved = this.app.metadataCache.getFirstLinkpathDest(targetPath, info.file?.path || "");
          const finalPath = resolved ? resolved.path : targetPath;
          const codeBlock = buildCadCodeBlock(finalPath, 800, "iso");
          editor.setLine(cursor.line, codeBlock.trimEnd());
          new Notice(`CAD Viewer: ${targetPath} のプレビューに自動変換しました`);
        }
      }),
    );

    this.addSettingTab(new StepViewerSettingTab(this.app, this));
  }

  onunload(): void {
    document.removeEventListener("drop", this.handleDocumentDrop, true);
  }

  /**
   * キャプチャフェーズで発火するドロップハンドラー
   * Obsidian標準の[[...]]挿入より前にイベントを捕捉し、完全阻止して```stepコードブロックを挿入する
   */
  private handleDocumentDrop = async (evt: DragEvent): Promise<void> => {
    // アクティブなMarkdownエディタを取得
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const editor = activeView?.editor;
    if (!editor) return;

    // 1. OSからのCADファイルドロップ
    const files = evt.dataTransfer?.files;
    if (files && files.length > 0) {
      const file = files[0];
      if (isCadFile(file.name)) {
        evt.preventDefault();
        evt.stopPropagation();
        evt.stopImmediatePropagation();

        try {
          const activeFile = this.app.workspace.getActiveFile();
          let savePath = "";
          if ((this.app.fileManager as any).getAvailablePathForAttachment) {
            savePath = await (this.app.fileManager as any).getAvailablePathForAttachment(
              file.name,
              activeFile ? activeFile.path : "",
            );
          } else {
            const folder = activeFile?.parent?.path;
            savePath = folder && folder !== "/" ? `${folder}/${file.name}` : file.name;
          }

          const buffer = await file.arrayBuffer();
          const existing = this.app.vault.getAbstractFileByPath(savePath);
          if (!existing) {
            await this.app.vault.createBinary(savePath, buffer);
          }

          const codeBlock = buildCadCodeBlock(savePath, 800, "iso");
          const insertPos = this.getEditorDropPos(editor, evt);
          editor.replaceRange(codeBlock, insertPos);
          new Notice(`CAD Viewer: ${file.name} のプレビューを挿入しました`);
        } catch (err) {
          console.error("[CAD Viewer] Failed to handle dropped CAD file", err);
        }
        return;
      }
    }

    // 2. Obsidian内部（ファイルツリー等）からのドラッグ＆ドロップ
    const textData = evt.dataTransfer?.getData("text/plain") || "";
    let cadPath = extractCadPathFromDropData(textData);

    // dragManagerからのフォールバック取得
    if (!cadPath) {
      const dragManager = (this.app as any).dragManager;
      const draggedFile = dragManager?.activeHover?.file || dragManager?.draggedItems?.[0]?.file;
      if (draggedFile && isCadFile(draggedFile.name)) {
        cadPath = draggedFile.path;
      }
    }

    if (cadPath) {
      evt.preventDefault();
      evt.stopPropagation();
      evt.stopImmediatePropagation();

      const activeFile = this.app.workspace.getActiveFile();
      const targetFile = this.app.metadataCache.getFirstLinkpathDest(cadPath, activeFile?.path || "");
      const finalPath = targetFile ? targetFile.path : cadPath;
      const codeBlock = buildCadCodeBlock(finalPath, 800, "iso");
      const insertPos = this.getEditorDropPos(editor, evt);
      editor.replaceRange(codeBlock, insertPos);
      new Notice(`CAD Viewer: ${finalPath} のプレビューを挿入しました`);
    }
  };

  /**
   * ドロップ位置のEditorPositionを計算する
   */
  private getEditorDropPos(editor: Editor, evt: DragEvent): any {
    const cm = (editor as any).cm;
    if (cm && typeof cm.posAtCoords === "function") {
      const offset = cm.posAtCoords({ x: evt.clientX, y: evt.clientY });
      if (offset !== null && typeof editor.offsetToPos === "function") {
        return editor.offsetToPos(offset);
      }
    }
    if (typeof (editor as any).posAtCoords === "function") {
      const pos = (editor as any).posAtCoords({ x: evt.clientX, y: evt.clientY });
      if (pos) return pos;
    }
    return editor.getCursor();
  }


  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<StepViewerSettings> | null;
    this.stepSettings = { ...DEFAULT_SETTINGS, ...(data ?? {}) };
    // A malformed/empty stored tier list would silently disable size scaling.
    if (!Array.isArray(this.stepSettings.tiers) || this.stepSettings.tiers.length === 0) {
      this.stepSettings.tiers = tiersForProfile("fastest");
      this.stepSettings.profile = "fastest";
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.stepSettings);
  }

  // onunload: Obsidian de-registers views/extensions registered via this.register*
}

const PROFILE_LABELS: Record<Profile, string> = {
  fastest: "Fastest (lightest, most angular)",
  balanced: "Balanced",
  detailed: "Detailed (slowest, finest)",
  custom: "Custom",
};

/**
 * Keep tiers sane: finite breakpoints sorted ascending, then exactly one
 * catch-all (maxMB = null) last. Synthesises a catch-all if the user deleted it.
 */
function normalizeTiers(tiers: QualityTier[]): QualityTier[] {
  const finite = tiers
    .filter((t) => t.maxMB != null)
    .sort((a, b) => (a.maxMB as number) - (b.maxMB as number));
  const catchAll = tiers.find((t) => t.maxMB == null);
  finite.push({ maxMB: null, deflection: catchAll?.deflection ?? 0.1 });
  return finite;
}

class StepViewerSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: StepViewerPlugin,
  ) {
    super(app, plugin);
  }

  private async commit(profile: Profile): Promise<void> {
    this.plugin.stepSettings.profile = profile;
    this.plugin.stepSettings.tiers = normalizeTiers(this.plugin.stepSettings.tiers);
    await this.plugin.saveSettings();
    this.display();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.stepSettings;

    new Setting(containerEl)
      .setName("Performance profile")
      .setDesc(
        "How aggressively mesh detail is reduced as files grow. The viewer " +
          "favours speed and lightness over fidelity — pick “Detailed” for finer " +
          "meshes on capable machines. Reopen a model for changes to take effect.",
      )
      .addDropdown((dd) => {
        for (const [value, label] of Object.entries(PROFILE_LABELS)) {
          dd.addOption(value, label);
        }
        dd.setValue(s.profile).onChange(async (value) => {
          const p = value as Profile;
          if (p !== "custom") this.plugin.stepSettings.tiers = tiersForProfile(p);
          await this.commit(p);
        });
      });

    // --- Advanced: size → coarseness table ---------------------------------
    new Setting(containerEl).setName("Advanced: quality by file size").setHeading();
    containerEl.createEl("p", {
      text:
        "Each row: files up to the given size use that coarseness. Coarseness is " +
        "a bounding-box ratio — higher = fewer triangles = faster and more " +
        "angular (e.g. 0.005 fairly fine, 0.05 coarse). Editing switches the " +
        "profile to Custom.",
      cls: "setting-item-description",
    });

    s.tiers.forEach((tier, i) => {
      const isCatchAll = tier.maxMB == null;
      const row = new Setting(containerEl);
      row.setName(isCatchAll ? "Larger files" : `Files up to (MB)`);

      if (!isCatchAll) {
        row.addText((t) =>
          t
            .setPlaceholder("MB")
            .setValue(String(tier.maxMB))
            .onChange(async (v) => {
              const n = parseFloat(v);
              if (!isFinite(n) || n <= 0) return; // ignore until valid
              this.plugin.stepSettings.tiers[i].maxMB = n;
              await this.commit("custom");
            }),
        );
      }

      row.addText((t) =>
        t
          .setPlaceholder("coarseness")
          .setValue(String(tier.deflection))
          .onChange(async (v) => {
            const n = parseFloat(v);
            if (!isFinite(n) || n <= 0 || n > 1) return; // ignore until valid
            this.plugin.stepSettings.tiers[i].deflection = n;
            await this.commit("custom");
          }),
      );

      if (!isCatchAll) {
        row.addExtraButton((b) =>
          b
            .setIcon("trash")
            .setTooltip("Remove this tier")
            .onClick(async () => {
              this.plugin.stepSettings.tiers.splice(i, 1);
              await this.commit("custom");
            }),
        );
      }
    });

    new Setting(containerEl).addButton((b) =>
      b.setButtonText("Add tier").onClick(async () => {
        // Insert a new breakpoint just below the catch-all.
        const finite = s.tiers.filter((t) => t.maxMB != null);
        const lastMB = finite.length ? (finite[finite.length - 1].maxMB as number) : 10;
        this.plugin.stepSettings.tiers.push({ maxMB: lastMB * 2, deflection: 0.02 });
        await this.commit("custom");
      }),
    );

    new Setting(containerEl).addButton((b) =>
      b
        .setButtonText("Reset to Fastest")
        .setWarning()
        .onClick(async () => {
          this.plugin.stepSettings.tiers = tiersForProfile("fastest");
          await this.commit("fastest");
          new Notice("STEP Viewer: quality reset to Fastest.");
        }),
    );

    // --- Rendering ---------------------------------------------------------
    new Setting(containerEl).setName("Rendering").setHeading();
    new Setting(containerEl)
      .setName("Reconstruct missing faces")
      .setDesc(
        "Some STEP files describe planar faces the reader can't tessellate, so " +
          "those parts render as hollow, see-through “frames”. When on, the " +
          "plugin rebuilds those flat faces (holes preserved) so the parts show " +
          "solid. Only affects already-broken parts. Reopen a model to apply.",
      )
      .addToggle((t) =>
        t.setValue(s.healFaces).onChange(async (v) => {
          this.plugin.stepSettings.healFaces = v;
          await this.plugin.saveSettings();
        }),
      );

    // --- Cache -------------------------------------------------------------
    new Setting(containerEl).setName("Cache").setHeading();
    containerEl.createEl("p", {
      text:
        "Parsing a large model is slow, so its geometry is cached on disk and " +
        "reused when you reopen it (near-instant). The cache lives outside the " +
        "vault (IndexedDB), so it is never synced. Editing a file or changing " +
        "quality re-parses it. Only files ≥ 15 MB are cached.",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("Cache parsed models")
      .addToggle((t) =>
        t.setValue(s.cacheEnabled).onChange(async (v) => {
          this.plugin.stepSettings.cacheEnabled = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Max cache size (MB)")
      .setDesc("Oldest entries are evicted once the cache exceeds this.")
      .addText((t) =>
        t.setValue(String(s.cacheMaxMB)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (Number.isFinite(n) && n > 0) {
            this.plugin.stepSettings.cacheMaxMB = n;
            await this.plugin.saveSettings();
          }
        }),
      );

    void this.plugin.geometryCache.totalBytes().then((bytes) => {
      new Setting(containerEl)
        .setName("Clear cache")
        .setDesc(`Currently using ${(bytes / (1024 * 1024)).toFixed(1)} MB.`)
        .addButton((b) =>
          b
            .setButtonText("Clear cache")
            .setWarning()
            .onClick(async () => {
              await this.plugin.geometryCache.clear();
              new Notice("STEP Viewer: cache cleared.");
              this.display();
            }),
        );
    });
  }
}
