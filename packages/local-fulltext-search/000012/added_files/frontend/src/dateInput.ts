/**
 * 日付・日時入力欄（`<input type="date">` / `datetime-local`）用の値変換。
 * 入力欄の値は利用者のローカル時刻で扱う。UTC へ丸めると、日本時間の午前 0〜9 時に「今日」が前日になるため、
 * 日付はローカルの年月日から組み立てる。
 **/

/**
 * Date をローカル時刻の `YYYY-MM-DD` へ整形する。
 */
function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * datetime-local 入出力用に ISO 文字列をローカル日時へ丸める。
 */
export function toLocalDateTimeInputValue(value: string | null): string {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  const offset = date.getTimezoneOffset();
  const localDate = new Date(date.getTime() - offset * 60_000);
  return localDate.toISOString().slice(0, 16);
}

/**
 * 画面入力のローカル日時を API 保存用の ISO 文字列へ変換する。
 */
export function toSchedulerStartAtIso(value: string): string {
  return new Date(value).toISOString();
}

/**
 * 日付入力のショートカット用に、今日の日付を `YYYY-MM-DD` 形式で返す。
 */
export function resolveTodayDateInputValue(now: Date = new Date()): string {
  return formatLocalDate(now);
}

/**
 * 今日から指定日数ぶんさかのぼった日付を `YYYY-MM-DD` 形式で返す。
 */
export function resolveRelativeDateInputValue(days: number, now: Date = new Date()): string {
  const baseDate = new Date(now.getTime());
  baseDate.setDate(baseDate.getDate() - days);
  return formatLocalDate(baseDate);
}
