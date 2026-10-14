/**
 * 注記の変更をコードブロック（YAML）へ自動保存する制御
 *
 * 1. コードブロックが注記の保存先になっている埋め込み（ロック中、またはコードブロックに注記がある）では、
 *    注記を編集するたびにコードブロックへ保存する。次回の表示ではコードブロックの注記が優先されるため、
 *    保存しないと編集内容が失われる。
 * 2. コードブロックを書き換えると埋め込みが再描画されるため、連続した変更は1回にまとめ、
 *    注記のテキスト編集中は保存を保留する（入力中の編集ボックスを閉じない）。
 * 3. ビューア破棄時は保留中の変更を即座に保存する（flush）。
 **/

export interface AutoSaveTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** 最後の変更から保存までの待ち時間（ミリ秒）。 */
export const ANNOTATION_AUTOSAVE_DELAY_MS = 600;

/**
 * 注記の変更をコードブロックへ自動保存する埋め込みかどうかを判定する。
 * 固定も注記の保存もしていない埋め込みは対象外とし、コードブロックを勝手に書き換えない
 * （その場合の注記は data.json から読み込まれるため失われない）。
 */
export function shouldAutoSaveAnnotations(state: {
  /** 保存先のコードブロックがあるか（CADファイルを直接開いたビューには無い） */
  canSave: boolean;
  locked: boolean;
  /** 表示時点でコードブロックに保存されていた注記の数 */
  codeBlockAnnotationCount: number;
}): boolean {
  if (!state.canSave) return false;
  return state.locked || state.codeBlockAnnotationCount > 0;
}

export class AnnotationAutoSaver {
  private timer: unknown = null;
  private pending = false;
  private readonly delayMs: number;
  private readonly timers: AutoSaveTimers;

  constructor(
    private readonly options: {
      /** 注記のテキストを編集中かどうか */
      isEditing: () => boolean;
      /** 現在の状態をコードブロックへ保存する */
      save: () => void | Promise<void>;
      delayMs?: number;
      timers?: AutoSaveTimers;
    },
  ) {
    this.delayMs = options.delayMs ?? ANNOTATION_AUTOSAVE_DELAY_MS;
    this.timers = options.timers ?? {
      set: (fn, ms) => window.setTimeout(fn, ms),
      clear: (handle) => window.clearTimeout(handle as number),
    };
  }

  /** 注記が変更されたことを通知する。 */
  notifyChanged(): void {
    this.pending = true;
    this.arm();
  }

  hasPending(): boolean {
    return this.pending;
  }

  /** 保留中の変更があれば即座に保存する。 */
  flush(): void {
    if (!this.pending) return;
    this.clearTimer();
    this.runSave();
  }

  /** 保留中の保存を取り消す（他の処理が同じ内容を保存する場合）。 */
  cancel(): void {
    this.clearTimer();
    this.pending = false;
  }

  private arm(): void {
    this.clearTimer();
    this.timer = this.timers.set(() => {
      this.timer = null;
      // テキスト編集中に保存すると再描画で編集ボックスが閉じるため、編集が終わるまで待つ。
      if (this.options.isEditing()) {
        this.arm();
        return;
      }
      this.runSave();
    }, this.delayMs);
  }

  private runSave(): void {
    this.pending = false;
    try {
      const result = this.options.save();
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch((err) => {
          console.error("[CAD Viewer] Failed to auto-save annotations", err);
        });
      }
    } catch (err) {
      console.error("[CAD Viewer] Failed to auto-save annotations", err);
    }
  }

  private clearTimer(): void {
    if (this.timer != null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
  }
}
