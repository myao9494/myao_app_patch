/**
 * 3D 埋め込みの名前の自動採番と、R キーでの名前の変更
 *
 * 1. 埋め込みを描画したら、そのノートの名前の無い・重なった埋め込みに名前を付ける（ノートごとにまとめて1回）
 * 2. 埋め込みをクリックすると「選択中」にする（枠を強調）。外をクリックする、Esc を押す、
 *    埋め込みの外で他のキーを押す（矢印キーで本文へ戻ったなど）と選択を外す
 * 3. 選択中に R を押すと、名前を変える小さな画面を開く（同じノートの他の埋め込みと同じ名前は不可）
 * 4. ノートの書き換えは、編集モードで開いていればエディタへ（保存前の入力を失わない）、
 *    それ以外はファイルへ直接行う。変えるのは name の行だけ（他の埋め込みを再描画させない）
 **/

import { App, MarkdownView, Modal, Notice, TFile } from "obsidian";
import {
  applyTextEdits,
  cadEmbedNameEdits,
  isRenameShortcut,
  listCadBlocks,
  renameCadEmbedEdit,
  RenameTarget,
  TextEdit,
  validateCadEmbedName,
} from "./embedNames";

/** 名前を変えられる埋め込み（StepEmbed）が提供する情報 */
export interface NamedEmbed {
  /** 埋め込みのある ノートのパス */
  readonly sourcePath: string;
  /** 今の名前と、名前で見つからない場合のフェンス行の行番号 */
  renameTarget(): RenameTarget;
}

export interface HasEmbedNames {
  embedNames: EmbedNameManager;
}

/** 文字を入力中の要素（注記の編集欄など）か。エディタ本文（contenteditable）は含めない。 */
function isTextField(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

const ACTIVE_CLASS = "is-name-selected";
const ASSIGN_DELAY_MS = 300;

export class EmbedNameManager {
  private embeds = new WeakMap<HTMLElement, NamedEmbed>();
  private activeEl: HTMLElement | null = null;
  private assignTimers = new Map<string, number>();

  constructor(private app: App) {}

  /** 埋め込みの要素を登録する（クリックで選択できるようにする）。 */
  attach(el: HTMLElement, embed: NamedEmbed): void {
    this.embeds.set(el, embed);
  }

  detach(el: HTMLElement): void {
    this.embeds.delete(el);
    if (this.activeEl === el) this.setActive(null);
  }

  /** 名前の無い・重なった埋め込みに名前を付ける（同じノートへの要求はまとめる）。 */
  scheduleAssign(sourcePath: string): void {
    if (!sourcePath.toLowerCase().endsWith(".md")) return;
    const previous = this.assignTimers.get(sourcePath);
    if (previous !== undefined) window.clearTimeout(previous);
    this.assignTimers.set(
      sourcePath,
      window.setTimeout(() => {
        this.assignTimers.delete(sourcePath);
        void this.assignNow(sourcePath);
      }, ASSIGN_DELAY_MS),
    );
  }

  async assignNow(sourcePath: string): Promise<boolean> {
    try {
      return await editNote(this.app, sourcePath, cadEmbedNameEdits);
    } catch (err) {
      console.error("[CAD Viewer] Failed to name 3D embeds", sourcePath, err);
      return false;
    }
  }

  /** 保管庫の全ノートの埋め込みに名前を付ける。名前を付けたノートの数を返す。 */
  async assignAll(): Promise<number> {
    let count = 0;
    for (const file of this.app.vault.getMarkdownFiles()) {
      const text = await this.app.vault.cachedRead(file);
      if (!/```|~~~/.test(text) || cadEmbedNameEdits(text).length === 0) continue;
      if (await this.assignNow(file.path)) count++;
    }
    return count;
  }

  onPointerDown = (e: PointerEvent): void => {
    const target = e.target as HTMLElement | null;
    const el = target?.closest?.<HTMLElement>(".step-viewer-embed") ?? null;
    this.setActive(el && this.embeds.has(el) ? el : null);
  };

  onKeyDown = (e: KeyboardEvent): void => {
    const el = this.activeEl;
    if (!el) return;
    if (!el.isConnected || !this.embeds.has(el)) {
      this.setActive(null);
      return;
    }
    const focused = document.activeElement;
    const focusInside = !!focused && el.contains(focused);
    if (e.key === "Escape" && !focusInside) {
      this.setActive(null);
      return;
    }
    if (!isRenameShortcut(e)) {
      // 埋め込みの外（エディタ本文など）でキーを押したら、文字の入力へ戻ったとみなす
      if (!focusInside && !["Shift", "Control", "Alt", "Meta"].includes(e.key)) this.setActive(null);
      return;
    }
    // 注記の編集欄での入力、没入モード（ポインターロック中の移動操作）はそのまま通す
    if (isTextField(focused) || document.pointerLockElement) return;
    if (document.querySelector(".modal-container")) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const embed = this.embeds.get(el)!;
    // キーを押した直後のイベントが名前の入力欄へ流れ込まないよう、次の処理で開く
    window.setTimeout(() => this.openRename(embed), 0);
  };

  /** 名前を変える画面を開く。 */
  async openRename(embed: NamedEmbed): Promise<void> {
    const text = await readNote(this.app, embed.sourcePath);
    if (text === null) return;
    const target = embed.renameTarget();
    const blocks = listCadBlocks(text);
    const block =
      (target.name ? blocks.find((b) => b.name === target.name) : undefined) ??
      blocks.find((b) => b.lineStart === target.lineStart);
    if (!block) {
      new Notice("CAD Viewer: ノートの中に対象の3D埋め込みが見つかりません");
      return;
    }
    const others = blocks.filter((b) => b !== block && b.name).map((b) => b.name as string);
    new EmbedNameModal(this.app, block.name ?? "", others, async (newName) => {
      let error: string | null = null;
      const changed = await editNote(this.app, embed.sourcePath, (current) => {
        const result = renameCadEmbedEdit(current, { name: block.name, lineStart: block.lineStart }, newName);
        if ("error" in result) {
          error = result.error;
          return [];
        }
        return [result.edit];
      });
      if (error) {
        new Notice(`CAD Viewer: ${error}`);
        return false;
      }
      if (changed) new Notice(`CAD Viewer: 3D埋め込みの名前を「${newName.trim()}」にしました`);
      return true;
    }).open();
  }

  private setActive(el: HTMLElement | null): void {
    if (this.activeEl === el) return;
    this.activeEl?.removeClass(ACTIVE_CLASS);
    this.activeEl = el;
    el?.addClass(ACTIVE_CLASS);
  }

  dispose(): void {
    for (const timer of this.assignTimers.values()) window.clearTimeout(timer);
    this.assignTimers.clear();
    this.setActive(null);
  }
}

/** 編集モードで開いているノートのエディタ */
function findSourceEditor(app: App, path: string): MarkdownView | null {
  let found: MarkdownView | null = null;
  app.workspace.iterateAllLeaves((leaf) => {
    const view = leaf.view;
    if (!found && view instanceof MarkdownView && view.file?.path === path && view.getMode() === "source") {
      found = view;
    }
  });
  return found;
}

async function readNote(app: App, path: string): Promise<string | null> {
  const view = findSourceEditor(app, path);
  if (view) return view.editor.getValue();
  const file = app.vault.getAbstractFileByPath(path);
  return file instanceof TFile ? app.vault.read(file) : null;
}

/**
 * ノートを書き換える。編集モードで開いていればエディタへ当て（保存前の入力を失わず、スクロールもしない）、
 * それ以外（閲覧モード、開いていない）はファイルを直接書き換える。書き換えたら true。
 */
async function editNote(app: App, path: string, compute: (text: string) => TextEdit[]): Promise<boolean> {
  const view = findSourceEditor(app, path);
  if (view) {
    const editor = view.editor;
    const edits = compute(editor.getValue());
    if (edits.length === 0) return false;
    const cm = (editor as any).cm;
    if (cm && typeof cm.dispatch === "function") {
      cm.dispatch({ changes: edits.map((e) => ({ from: e.from, to: e.to, insert: e.text })) });
    } else {
      editor.transaction({
        changes: edits.map((e) => ({ from: editor.offsetToPos(e.from), to: editor.offsetToPos(e.to), text: e.text })),
      });
    }
    return true;
  }
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile) || file.extension !== "md") return false;
  let changed = false;
  await app.vault.process(file, (data) => {
    const edits = compute(data);
    changed = edits.length > 0;
    return changed ? applyTextEdits(data, edits) : data;
  });
  return changed;
}

/** 名前を変える画面（タイトルをつかんで動かせる） */
class EmbedNameModal extends Modal {
  constructor(
    app: App,
    private currentName: string,
    private otherNames: string[],
    private onSubmit: (name: string) => Promise<boolean>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, titleEl, modalEl } = this;
    modalEl.addClass("step-viewer-name-modal");
    titleEl.setText("3D埋め込みの名前");
    this.makeDraggable(titleEl, modalEl);

    const input = contentEl.createEl("input", { type: "text", cls: "step-viewer-name-input" });
    input.value = this.currentName;
    const errorEl = contentEl.createDiv({ cls: "step-viewer-name-error" });
    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    const save = buttons.createEl("button", { text: "保存", cls: "mod-cta" });
    const cancel = buttons.createEl("button", { text: "キャンセル" });

    const check = (): string | null => {
      const error = validateCadEmbedName(input.value, this.otherNames);
      errorEl.setText(error ?? "");
      save.disabled = !!error;
      return error;
    };
    let busy = false;
    const submit = async (): Promise<void> => {
      if (busy || check()) return;
      if (input.value.trim() === this.currentName) {
        this.close();
        return;
      }
      busy = true;
      try {
        if (await this.onSubmit(input.value)) this.close();
      } finally {
        busy = false;
      }
    };

    input.addEventListener("input", check);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        void submit();
      }
    });
    save.addEventListener("click", () => void submit());
    cancel.addEventListener("click", () => this.close());

    check();
    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }

  private makeDraggable(handle: HTMLElement, modalEl: HTMLElement): void {
    handle.addClass("step-viewer-name-modal-handle");
    handle.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      const rect = modalEl.getBoundingClientRect();
      const dx = e.clientX - rect.left;
      const dy = e.clientY - rect.top;
      modalEl.style.position = "fixed";
      modalEl.style.margin = "0";
      handle.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const left = Math.min(Math.max(0, ev.clientX - dx), window.innerWidth - rect.width);
        const top = Math.min(Math.max(0, ev.clientY - dy), window.innerHeight - 40);
        modalEl.style.left = `${left}px`;
        modalEl.style.top = `${top}px`;
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
