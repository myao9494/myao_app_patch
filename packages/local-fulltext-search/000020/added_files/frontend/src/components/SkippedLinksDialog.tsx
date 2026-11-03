/**
 * 走査でたどらなかったフォルダのリンクを案内するポップアップ。
 * リンクの先は検索しないので、リンクの場所と元のフォルダを示し、元のフォルダの登録を案内する。
 */
import type { UseSkippedLinksResult } from "../hooks/useSkippedLinks";

const LINK_TYPE_LABELS: Record<string, string> = {
  junction: "ジャンクション",
  symlink: "シンボリックリンク",
};

type SkippedLinksDialogProps = {
  links: UseSkippedLinksResult;
};

export function SkippedLinksDialog({ links }: SkippedLinksDialogProps) {
  const { handleAcknowledgeSkippedLinks, skippedLinks } = links;
  if (skippedLinks.length === 0) {
    return null;
  }
  return (
    <div className="rule-add-modal-backdrop">
      <div className="rule-add-modal skipped-links-dialog" role="dialog" aria-modal="true" aria-label="検索しないフォルダの案内">
        <h2>検索しないフォルダがあります</h2>
        <p>
          次のフォルダは別の場所へのリンクなので、中のファイルは検索しません。
          検索したいときは、元のフォルダを検索対象に追加してください。
        </p>
        <ul className="skipped-links-list">
          {skippedLinks.map((link) => (
            <li key={link.link_path}>
              <strong>{LINK_TYPE_LABELS[link.link_type] ?? link.link_type}</strong>
              <dl>
                <dt>リンク</dt>
                <dd>{link.link_path}</dd>
                <dt>元のフォルダ</dt>
                <dd>{link.target_path}</dd>
              </dl>
              {link.is_covered ? <p>元のフォルダは検索対象に含まれています。追加の操作は不要です。</p> : null}
            </li>
          ))}
        </ul>
        <div className="rule-add-modal-actions">
          <button className="secondary-button" onClick={() => void handleAcknowledgeSkippedLinks()} type="button">
            確認しました
          </button>
        </div>
      </div>
    </div>
  );
}
