/**
 * Git差分の「ファイルの履歴」。変更一覧の1ファイルについて、コミットごとの差分を古い順に並べる。
 * - 各段は「直前のコミット（1つ目の親）→ そのコミット」の比較。最後の段は「HEAD → 作業ツリー」（一覧の項目そのもの）
 * - 段は変更一覧の項目と同じ形のオブジェクト（path / head_path / has_head / has_current / diffable / change_type）に
 *   old_rev（変更前の版）と new_rev（変更後の版）を足したもの。API にそのまま渡せば、同じビューアで過去を比べられる
 * - 過去のコミットは読み取り専用（編集・1行復元・メモはしない）。範囲指定や画像メモは版ごとに別のキーで持つ
 * DOMに依存しない（node --test で検査する）。
 */
import { cadViewMode } from "../cad-view/cadViewModel.js";

/** ファイル1つ分の表示対象（本体と、Markdown内の Excalidraw図・3D表示のサブ項目）。変更一覧と履歴で共通。 */
export function gitFileTargets(file) {
  if (file.kind === "3d") return [{ file, mode: "3d" }];
  const targets = [{ file, mode: file.kind === "text" ? "text" : "image" }];
  if (file.kind === "text" && file.embedded_excalidraw) targets.push({ file, mode: "excalidraw" });
  // ノートに表示している3D（```step / ```cad）は、1つずつ画像として比べられるサブ項目にする
  if (file.kind === "text") (file.cad_views ?? []).forEach((view) => targets.push({ file, mode: cadViewMode(view.key) }));
  return targets;
}

/**
 * 履歴の段（古い順）。commits は /api/git/history の commits。
 * 作業ツリーに変更があるファイル（変更一覧の項目）なので、最後に「HEAD → 作業ツリー」の段として file 自身を足す。
 */
export function gitHistorySteps(file, commits = []) {
  const steps = commits.map((commit) => ({
    kind: file.kind,
    comparable: true,
    reason: null,
    status: commit.status,
    embedded_excalidraw: Boolean(commit.embedded_excalidraw),
    cad_views: commit.cad_views ?? [],
    path: commit.path,
    head_path: commit.head_path,
    change_type: commit.change_type,
    has_head: commit.has_head,
    has_current: commit.has_current,
    diffable: commit.has_head && commit.has_current,
    old_rev: commit.old_rev,
    new_rev: commit.new_rev,
    commit: {
      sha: commit.commit,
      short: commit.short ?? String(commit.commit).slice(0, 7),
      parent: commit.parent ?? null,
      author: commit.author ?? "",
      date: commit.date ?? "",
      subject: commit.subject ?? "",
    },
  }));
  steps.push({ ...file, commit: null });
  return steps;
}

/** 段の一覧を表示対象（ナビゲーションの単位）に展開する。 */
export function gitHistoryTargets(steps) {
  return steps.flatMap((step) => gitFileTargets(step));
}

/** 履歴を開いたときに選ぶ段: いちばん新しいコミット（作業ツリーの変更は変更一覧で見ているので）。無ければ作業ツリー。 */
export function initialHistoryIndex(targets) {
  for (let index = targets.length - 1; index >= 0; index -= 1) {
    const { file, mode } = targets[index];
    if (file.new_rev && (mode === "text" || mode === "image" || mode === "3d")) return index;
  }
  return Math.max(0, targets.length - 1);
}

/** 過去のコミットを表示しているか（変更後の側が作業ツリーでない）。読み取り専用にする判定。 */
export function isHistoricalStep(file) {
  return Boolean(file?.new_rev);
}

/**
 * 範囲指定・画像メモのキーに使うパス。作業ツリーの段は従来どおりパスだけ（既存のメモ・HTML出力と共有する）、
 * 過去のコミットは「パス@コミット」で、同じファイルのほかの段と混ざらないようにする。
 */
export function gitRevisionPath(file) {
  return isHistoricalStep(file) ? `${file.path}@${file.new_rev}` : file.path;
}

/** 版の短い名前（HEAD / 短いコミットID / 作業ツリー）。 */
export function revisionLabel(rev) {
  if (!rev) return "作業ツリー";
  return rev === "HEAD" ? "HEAD" : String(rev).slice(0, 7);
}

/** 履歴の段の変更前の版の名前。最初のコミット（親がない・追加）は「なし」。 */
export function oldRevisionLabel(file) {
  return file?.old_rev ? revisionLabel(file.old_rev) : "なし";
}

/** 変更前の側の見出し。作業ツリーの段は従来どおり「変更前（HEAD）」。 */
export function oldSideTitle(file) {
  return isHistoricalStep(file) ? `変更前（${oldRevisionLabel(file)}）` : "変更前（HEAD）";
}

/** 変更後の側の見出し。作業ツリーの段は従来どおり「変更後（作業ツリー）」。 */
export function newSideTitle(file) {
  return isHistoricalStep(file) ? `変更後（${revisionLabel(file.new_rev)}）` : "変更後（作業ツリー）";
}

/** コミットの日時を「2026-11-19 14:05」の形にする（タイムゾーンはコミットに記録されたまま）。 */
export function formatCommitDate(iso) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(iso ?? ""));
  return match ? `${match[1]} ${match[2]}` : String(iso ?? "");
}
