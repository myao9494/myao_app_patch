/**
 * ファイル一覧の「使い方」モーダル（H キーで表示）
 * - ショートカットキーと主な操作の説明を表示する
 */
import { Modal } from "../Modal";

interface FileListHelpModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function FileListHelpModal({ isOpen, onClose }: FileListHelpModalProps) {
  return (
<Modal
      isOpen={isOpen}
      onClose={onClose}
      title="使い方"
      width="min(760px, 94vw)"
    >
      <div className="help-modal-content">
        <section className="help-section">
          <h3>ショートカットキー</h3>
          <dl className="help-list">
            <div><dt>H</dt><dd>この使い方を表示</dd></div>
            <div><dt>A</dt><dd>左・真ん中ペインでフォルダ作成</dd></div>
            <div><dt>T</dt><dd>左・真ん中ペインで空のテキストファイル作成。ファイル名と拡張子を個別に指定</dd></div>
            <div><dt>O</dt><dd>左・真ん中ペインで現在のフォルダをFinder／Explorerで開く</dd></div>
            <div><dt>R</dt><dd>左・真ん中ペインのファイル一覧を再読み込み（更新）</dd></div>
            <div><dt>N</dt><dd>左・真ん中ペインのアクティブカーソル行をリネーム。ファイル名と拡張子を個別に指定</dd></div>
            <div><dt>L</dt><dd>左・真ん中ペインの表示フィルタを次へ切り替え</dd></div>
            <div><dt>Shift + L</dt><dd>左・真ん中ペインの表示フィルタを前へ切り替え</dd></div>
            <div><dt>D</dt><dd>左・真ん中ペインで、選択中またはカーソル位置のフォルダ配下を集計し、Date列に最新更新日を表示</dd></div>
            <div><dt>G</dt><dd>左・真ん中ペイン内の全フォルダを並列にGit確認。Git列は作業ツリー変更ならG、未PushならPush、未PullならPull、両方ならC、Git管理外または差分なしなら-を表示。GのクリックはVS Codeを開き、Push・Pull・Cのクリックはcd付きGitコマンドをクリップボードへコピー</dd></div>
            <div><dt>Ctrl/Cmd + P</dt><dd>左・真ん中ペインのフォルダ内 indexed 検索を表示</dd></div>
            <div><dt>Ctrl/Cmd + R</dt><dd>左・真ん中ペインのフォルダ履歴検索を表示</dd></div>
            <div><dt>Ctrl/Cmd + H</dt><dd>ホームフォルダへ移動</dd></div>
            <div><dt>Ctrl/Cmd + ← / ↓ / →</dt><dd>戻る / 戻る / 進む</dd></div>
            <div><dt>Ctrl/Cmd + ↑</dt><dd>上の階層へ移動</dd></div>
            <div><dt>Ctrl/Cmd + A</dt><dd>表示中のアイテムを全選択</dd></div>
            <div><dt>Ctrl/Cmd + Shift + A</dt><dd>選択解除</dd></div>
          </dl>
        </section>

        <section className="help-section">
          <h3>設定</h3>
          <dl className="help-list">
            <div><dt>Theme</dt><dd>Light / Dark の表示テーマを切り替え</dd></div>
            <div><dt>Text File Open</dt><dd>テキスト系ファイルをWebエディタで開くか外部アプリで開くかを選択</dd></div>
            <div><dt>Markdown Open</dt><dd>Markdownをアプリ内エディタで開くかObsidian連携を優先するかを選択</dd></div>
            <div><dt>Verify Checksum</dt><dd>移動・コピー時にチェックサム検証を行う安全寄りの設定</dd></div>
            <div><dt>Debug Mode</dt><dd>ファイル操作時の詳細ログやデバッグ情報を有効化</dd></div>
            <div><dt>API Timeout</dt><dd>ネットワークドライブなどのAPI待ち時間上限を秒数で設定</dd></div>
            <div><dt>Folder Date Max Items</dt><dd>Dで最新更新日を集計する際の最大項目数を設定</dd></div>
            <div><dt>Default Text Extension</dt><dd>Tでテキストファイルを作成する際の既定拡張子を設定</dd></div>
            <div><dt>リンク置換設定</dt><dd>古いサーバー名やUNCパスを新しいリンクへ置換するルールを編集</dd></div>
            <div><dt>Reset Storage</dt><dd>保存されたパス、履歴、テーマなどのローカル設定を初期化</dd></div>
            <div><dt>検索ペイン設定</dt><dd>インデックスサービスURLや監視パスを検索ペインの設定から管理</dd></div>
          </dl>
        </section>
      </div>
    </Modal>
  );
}
