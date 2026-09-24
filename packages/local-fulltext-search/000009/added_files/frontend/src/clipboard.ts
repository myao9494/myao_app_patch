/**
 * クリップボード安全コピーユーティリティ。
 * 非同期処理（数秒かかる通信待ちなど）の後にブラウザの User Activation が失効した場合や、
 * 制限環境（権限未許可、非セキュアコンテキスト等）でも安全にコピーを行い、
 * 失敗時も例外をスローせずフォールバック（document.execCommand）を試行する。
 **/

/**
 * 指定された文字列をクリップボードにコピーする。
 * @param text コピー対象の文字列
 * @returns コピーに成功した場合は true、失敗した場合は false
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;

  // 1. Modern Clipboard API (navigator.clipboard) を試行
  if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // User Activation 失効 (NotAllowedError) や権限拒否時はフォールバックへ進む
    }
  }

  // 2. Legacy DOM フォールバック (textarea + document.execCommand)
  if (typeof document !== "undefined" && typeof document.createElement === "function") {
    try {
      const textArea = document.createElement("textarea");
      textArea.value = text;
      // 画面スクロールやレイアウト崩れを防ぐため画面外に固定配置
      textArea.style.position = "fixed";
      textArea.style.left = "-999999px";
      textArea.style.top = "-999999px";
      textArea.style.opacity = "0";
      textArea.setAttribute("readonly", "");

      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();

      let success = false;
      if (typeof document.execCommand === "function") {
        success = document.execCommand("copy");
      }
      textArea.remove();
      if (success) {
        return true;
      }
    } catch {
      // DOM操作失敗時も例外をスローしない
    }
  }

  return false;
}
