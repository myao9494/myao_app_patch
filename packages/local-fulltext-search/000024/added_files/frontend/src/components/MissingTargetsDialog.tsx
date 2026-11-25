/**
 * 見つからない検索対象フォルダを案内するポップアップ。
 * その配下は更新されないので、パスを示し、インデックス済みフォルダ画面で × の付いた行を選んで削除できることを案内する。
 * インデックスは自動では消さない（利用者が選んで削除する）。
 */
import type { UseMissingTargetsResult } from "../hooks/useMissingTargets";

type MissingTargetsDialogProps = {
  targets: UseMissingTargetsResult;
};

export function MissingTargetsDialog({ targets }: MissingTargetsDialogProps) {
  const { handleAcknowledgeMissingTargets, missingTargets } = targets;
  if (missingTargets.length === 0) {
    return null;
  }
  return (
    <div className="rule-add-modal-backdrop">
      <div
        className="rule-add-modal skipped-links-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="見つからない検索対象フォルダの案内"
      >
        <h2>見つからない検索対象フォルダがあります</h2>
        <p>
          次のフォルダは移動・削除されたか、ドライブが接続されていないため、インデックスを更新できません。
          ドライブをつなぐと自動で更新を再開します。
          不要なら「インデックス済みフォルダ」「検索対象フォルダ」の画面で × の付いた行を選んで削除してください。
        </p>
        <ul className="skipped-links-list">
          {missingTargets.map((target) => (
            <li className="missing-target-item" key={target.full_path}>
              <span className="target-missing-badge" aria-hidden="true">×</span>
              <span>{target.full_path}</span>
            </li>
          ))}
        </ul>
        <div className="rule-add-modal-actions">
          <button className="secondary-button" onClick={() => void handleAcknowledgeMissingTargets()} type="button">
            確認しました
          </button>
        </div>
      </div>
    </div>
  );
}
