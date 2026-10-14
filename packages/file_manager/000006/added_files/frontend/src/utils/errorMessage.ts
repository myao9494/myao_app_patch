/**
 * catch した値（unknown）から表示用のエラーメッセージを取り出す
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
