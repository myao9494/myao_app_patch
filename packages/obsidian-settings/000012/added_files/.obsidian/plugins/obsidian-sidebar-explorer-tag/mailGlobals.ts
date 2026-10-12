/**
 * メール解析関数のグローバル公開
 *
 * 仕様:
 * - 00_templates/RegisterCustomCommands.md（サマリー作成）から、このプラグインに同梱した
 *   MSG / TNEF（winmail.dat）パーサーを利用できるよう、解析関数を window へ公開する。
 *   - _sidebarExplorerParseMsgFile / parseMsgFile: MSG ファイルの解析
 *   - _sidebarExplorerParseTnefFile: TNEF（winmail.dat）ファイルの解析
 *   - _sidebarExplorerMailHelpers: 本文の変換ヘルパー（HTMLの表 → Markdown、RTF → プレーンテキスト）
 * - テンプレートはメール解析を自前で持たず、ここで公開する実装だけを使う。
 * - 解除時は自分が公開した関数だけを取り除く（他の処理が差し替えた関数は残す）。
 **/

/** メール本文の変換ヘルパー（テンプレートのサマリー作成から利用する） */
export interface MailTextHelpers {
    convertHtmlTablesToMarkdown: (html: string) => string;
    extractPlainTextFromRtf: (rtf: string | Uint8Array) => string;
}

export interface MailParserGlobals<TFileLike, TMsg, TTnef> {
    parseMsgFile: (file: TFileLike) => Promise<TMsg>;
    parseTnefFile: (file: TFileLike) => Promise<TTnef>;
    helpers: MailTextHelpers;
}

/**
 * 解析関数を target（通常は window）へ公開し、解除用の関数を返す。
 */
export function installMailParserGlobals<TFileLike, TMsg, TTnef>(
    target: Record<string, unknown>,
    parsers: MailParserGlobals<TFileLike, TMsg, TTnef>,
): () => void {
    const installed: Record<string, unknown> = {
        _sidebarExplorerParseMsgFile: parsers.parseMsgFile,
        parseMsgFile: parsers.parseMsgFile,
        _sidebarExplorerParseTnefFile: parsers.parseTnefFile,
        _sidebarExplorerMailHelpers: parsers.helpers,
    };
    for (const [key, value] of Object.entries(installed)) target[key] = value;

    return () => {
        for (const [key, value] of Object.entries(installed)) {
            if (target[key] === value) delete target[key];
        }
    };
}
