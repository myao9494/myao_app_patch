/**
 * ノート本文の「# note一覧」セクションの置換
 *
 * 仕様:
 * - タグからノート一覧を追加・更新するとき、既存の「# note一覧」セクションを新しい内容で置き換える。
 * - 目印（<!-- custom-note-list:start --> 〜 <!-- custom-note-list:end -->）で囲まれた範囲があれば、
 *   その範囲だけを置き換える（見出しの後に続く通常の本文を消さない）。
 * - 目印が無い旧形式は、見出し直下の表または箇条書きだけを置き換える。
 * - 「# note一覧」が無い場合は null を返す（呼び出し側が末尾へ追加する）。
 * - 同じ処理が 00_templates/RegisterCustomCommands.md にもある。変更するときは両方を直し、
 *   scratch/test_template_plugin_parity.js で同じ結果になることを確認する。
 **/

export const NOTE_LIST_MARKER_START = "<!-- custom-note-list:start -->";
export const NOTE_LIST_MARKER_END = "<!-- custom-note-list:end -->";

export function replaceNoteListSection(fileContent: string, noteListContent: string): string | null {
    // 一覧の内容に「$&」などが含まれても置換パターンとして解釈されないよう、関数で置き換える。
    const markedListRegex = /# note一覧[^\n]*\n\s*<!-- custom-note-list:start -->[\s\S]*?<!-- custom-note-list:end -->\n?/;
    if (markedListRegex.test(fileContent)) {
        return fileContent.replace(markedListRegex, () => noteListContent);
    }

    const legacyListRegex = /# note一覧[^\n]*\n(?:\s*\n)?(?:(?:\|.*\|\s*\n)|(?:- .*(?:\n|$)))*/;
    if (legacyListRegex.test(fileContent)) {
        return fileContent.replace(legacyListRegex, () => noteListContent);
    }

    return null;
}
