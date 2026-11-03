import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { getDragText, rewriteLocalhostLinkForMac, filterFilesByTagQuery, getMocFilename, extractTagsFromMetadata, isExcalidrawBackedMarkdown, openFileInMarkdownView, switchToMarkdownViewIfExcalidraw, isTextEditingTarget } from './utils.ts';

describe('getDragText', () => {
    test('excalidrawファイルの場合は1475の埋め込みとともにwebアプリURLリンクを返す', () => {
        const text = getDragText({ extension: 'md', name: '図_確定申告.excalidraw.md', basename: '図_確定申告.excalidraw', path: '01_data/2026/01/29/図_確定申告.excalidraw.md' }, '/Users/mine/000_work/obsidian-dagnetz');
        const expected = `[図_確定申告](http://localhost:3001/?filepath=/Users/mine/000_work/obsidian-dagnetz/01_data/2026/01/29/%E5%9B%B3_%E7%A2%BA%E5%AE%9A%E7%94%B3%E5%91%8A.excalidraw.md)\n![[図_確定申告.excalidraw|1475]]`;
        assert.strictEqual(text, expected);

        const text2 = getDragText({ extension: 'excalidraw', name: '図_確定申告.excalidraw', basename: '図_確定申告', path: '01_data/2026/01/29/図_確定申告.excalidraw' }, '/Users/mine/000_work/obsidian-dagnetz');
        const expected2 = `[図_確定申告](http://localhost:3001/?filepath=/Users/mine/000_work/obsidian-dagnetz/01_data/2026/01/29/%E5%9B%B3_%E7%A2%BA%E5%AE%9A%E7%94%B3%E5%91%8A.excalidraw)\n![[図_確定申告.excalidraw|1475]]`;
        assert.strictEqual(text2, expected2);
    });

    test('画像やPDFファイルの場合は埋め込みリンクを返す', () => {
        const textPng = getDragText({ extension: 'png', name: 'image.png', basename: 'image' });
        assert.strictEqual(textPng, '![[image.png]]');

        const textPdf = getDragText({ extension: 'pdf', name: 'document.pdf', basename: 'document' });
        assert.strictEqual(textPdf, '![[document.pdf]]');
    });

    test('その他のMarkdownファイルや一般ファイルの場合は通常リンクを返す', () => {
        const textMd = getDragText({ extension: 'md', name: 'memo.md', basename: 'memo' });
        assert.strictEqual(textMd, '[[memo]]');

        const textTxt = getDragText({ extension: 'txt', name: 'data.txt', basename: 'data' });
        assert.strictEqual(textTxt, '[[data.txt]]');
    });
});

describe('rewriteLocalhostLinkForMac', () => {
    test('macOSにおいて、localhost:3001/?filepath= のリンク内のユーザー名を現在のユーザー名に置換する', () => {
        const url = 'http://localhost:3001/?filepath=/Users/mine/000_work/obsidian-dagnetz/01_data/2026/03/06/図_システム_top.excalidraw.md';
        const result = rewriteLocalhostLinkForMac(url, 'darwin', 'sudoupousei');
        assert.strictEqual(result, 'http://localhost:3001/?filepath=/Users/sudoupousei/000_work/obsidian-dagnetz/01_data/2026/03/06/図_システム_top.excalidraw.md');
    });

    test('macOSにおいて、localhost:8001/api/open-path?path= のリンク内のユーザー名を現在のユーザー名に置換する', () => {
        const url = 'http://localhost:8001/api/open-path?path=/Users/mine/000_work/app/excalidraw_myao9494';
        const result = rewriteLocalhostLinkForMac(url, 'darwin', 'sudoupousei');
        assert.strictEqual(result, 'http://localhost:8001/api/open-path?path=/Users/sudoupousei/000_work/app/excalidraw_myao9494');
    });

    test('macOSにおいて、別パターンのユーザー名でも現在のユーザー名に置換する', () => {
        const url = 'http://localhost:3001/?filepath=/Users/otheruser/Documents/test.md';
        const result = rewriteLocalhostLinkForMac(url, 'darwin', 'newuser');
        assert.strictEqual(result, 'http://localhost:3001/?filepath=/Users/newuser/Documents/test.md');
    });

    test('URLに使えない文字を含むユーザー名をエンコードする', () => {
        const url = 'http://localhost:3001/?filepath=/Users/old/Documents/test.md';
        const result = rewriteLocalhostLinkForMac(url, 'darwin', 'new user');
        assert.strictEqual(result, 'http://localhost:3001/?filepath=/Users/new%20user/Documents/test.md');
    });

    test('macOS以外の場合は何も変更せずに元のURLを返す', () => {
        const url = 'http://localhost:3001/?filepath=/Users/mine/000_work/obsidian-dagnetz/test.md';
        const result = rewriteLocalhostLinkForMac(url, 'win32', 'sudoupousei');
        assert.strictEqual(result, url);
    });

    test('対象のURL形式(localhost:3001/?filepath=)でない場合は置換しない', () => {
        const url1 = 'https://example.com/?filepath=/Users/mine/test.md';
        const result1 = rewriteLocalhostLinkForMac(url1, 'darwin', 'sudoupousei');
        assert.strictEqual(result1, url1);

        const url2 = 'http://localhost:3001/otherpath=/Users/mine/test.md';
        const result2 = rewriteLocalhostLinkForMac(url2, 'darwin', 'sudoupousei');
        assert.strictEqual(result2, url2);
    });
});

describe('Excalidraw-backed Markdown opening', () => {
    test('通常のmdでもexcalidraw-plugin frontmatterがあれば対象になる', () => {
        const file = { name: 'りんご.md', extension: 'md', path: '01_data/りんご.md' };
        const app = {
            metadataCache: {
                getFileCache: () => ({ frontmatter: { 'excalidraw-plugin': 'parsed' } }),
            },
            plugins: { plugins: {} },
        };

        assert.equal(isExcalidrawBackedMarkdown(app, file), true);
    });

    test('ファイルを開いた後にMarkdownビューへ切り替える', async () => {
        const file = { name: 'りんご.md', extension: 'md', path: '01_data/りんご.md' };
        let opened = false;
        let switched = false;
        const leaf = {
            view: { getViewType: () => 'excalidraw' },
            openFile: async () => { opened = true; },
        };
        const app = {
            metadataCache: {
                getFileCache: () => ({ frontmatter: { 'excalidraw-plugin': 'parsed' } }),
            },
            plugins: {
                plugins: {
                    'obsidian-excalidraw-plugin': {
                        setMarkdownView: async (target: any) => {
                            switched = target === leaf;
                            target.view.getViewType = () => 'markdown';
                        },
                    },
                },
            },
        };

        await openFileInMarkdownView(app, leaf, file);
        assert.equal(opened, true);
        assert.equal(switched, true);
    });

    test('専用の.excalidraw.mdはExcalidrawビューのままにする', async () => {
        const file = { name: 'あは.excalidraw.md', extension: 'md', path: '01_data/あは.excalidraw.md' };
        let switched = false;
        const leaf = {
            view: { getViewType: () => 'excalidraw' },
            openFile: async () => {},
        };
        const app = {
            plugins: {
                plugins: {
                    'obsidian-excalidraw-plugin': {
                        setMarkdownView: async () => { switched = true; },
                    },
                },
            },
        };

        await openFileInMarkdownView(app, leaf, file);
        assert.equal(switched, false);
    });

    test('通常のMarkdownを明示的にExcalidraw表示した場合はMarkdownへ戻さない', async () => {
        const file = { name: '通常ノート.md', extension: 'md', path: '01_data/通常ノート.md' };
        let switched = false;
        const leaf = {
            view: { getViewType: () => 'excalidraw' },
            openFile: async () => {},
        };
        const app = {
            metadataCache: { getFileCache: () => ({ frontmatter: {} }) },
            plugins: {
                plugins: {
                    'obsidian-excalidraw-plugin': {
                        isExcalidrawFile: () => false,
                        setMarkdownView: async () => { switched = true; },
                    },
                },
            },
        };

        await openFileInMarkdownView(app, leaf, file);
        assert.equal(switched, false);
    });

    test('Excalidraw側APIが表示を変えない場合はObsidian標準APIへフォールバックする', async () => {
        const file = { name: 'りんご.md', extension: 'md', path: '01_data/りんご.md' };
        let viewType = 'excalidraw';
        let fallbackCalled = false;
        const leaf = {
            view: {
                getViewType: () => viewType,
                setMarkdownView: async () => {},
            },
            setViewState: async (state: any) => {
                fallbackCalled = state.type === 'markdown';
                viewType = state.type;
            },
        };
        const app = {
            metadataCache: { getFileCache: () => ({ frontmatter: { 'excalidraw-plugin': 'parsed' } }) },
            plugins: { plugins: { 'obsidian-excalidraw-plugin': { setMarkdownView: async () => {} } } },
        };

        const switched = await switchToMarkdownViewIfExcalidraw(app, leaf, file);
        assert.equal(switched, true);
        assert.equal(fallbackCalled, true);
    });
});

describe('filterFilesByTagQuery', () => {
    const mockFiles = [
        { path: 'file1.md', basename: 'file1', stat: { mtime: 1000 } },
        { path: 'file2.md', basename: 'file2', stat: { mtime: 2000 } },
        { path: 'file3.md', basename: 'file3', stat: { mtime: 1500 } },
        { path: 'file4.md', basename: 'file4', stat: { mtime: 3000 } },
    ];

    const fileTagsMap: Record<string, string[]> = {
        'file1.md': ['tag1', 'tag2'],
        'file2.md': [],
        'file3.md': ['tag2', 'tag3'],
        'file4.md': [],
    };

    const getFileTags = (file: typeof mockFiles[0]) => fileTagsMap[file.path] || [];

    test('クエリが空のときはタグが設定されていないファイルのみをmtime降順で返す', () => {
        // @ts-ignore
        const result = filterFilesByTagQuery(mockFiles, '', getFileTags);
        assert.strictEqual(result.length, 2);
        assert.strictEqual(result[0].path, 'file4.md'); // mtime: 3000
        assert.strictEqual(result[1].path, 'file2.md'); // mtime: 2000
    });

    test('クエリがあるときはタグに部分一致（大文字小文字を区別しない）するファイルをmtime降順で返す', () => {
        // @ts-ignore
        const result = filterFilesByTagQuery(mockFiles, 'TAG2', getFileTags);
        assert.strictEqual(result.length, 2);
        assert.strictEqual(result[0].path, 'file3.md'); // mtime: 1500
        assert.strictEqual(result[1].path, 'file1.md'); // mtime: 1000
    });

    test('複数キーワードがスペース区切りで指定されたときはAND検索（すべて一致）される', () => {
        // @ts-ignore
        const result1 = filterFilesByTagQuery(mockFiles, 'tag1 tag2', getFileTags);
        assert.strictEqual(result1.length, 1);
        assert.strictEqual(result1[0].path, 'file1.md');

        // @ts-ignore
        const result2 = filterFilesByTagQuery(mockFiles, 'tag1 tag3', getFileTags);
        assert.strictEqual(result2.length, 0);
    });

    test('マイナス記号で始まるキーワード（例: -tag1）が指定されたときはそのタグを持つファイルを除外する', () => {
        // @ts-ignore
        const result = filterFilesByTagQuery(mockFiles, 'tag2 -tag1', getFileTags);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].path, 'file3.md');
    });

    test('ノート一覧ではtopタグ付きノートだけ除外キーワードを無視して残せる', () => {
        const files = [
            { path: 'normal.md', basename: 'normal', stat: { mtime: 1000 } },
            { path: 'moc.md', basename: 'moc', stat: { mtime: 2000 } },
        ];
        const tags: Record<string, string[]> = {
            'normal.md': ['teamcenter', 'issue'],
            'moc.md': ['top', 'teamcenter', 'issue'],
        };
        const getTags = (file: typeof files[0]) => tags[file.path];

        const normalSearch = filterFilesByTagQuery(files, 'teamcenter -issue', getTags);
        assert.strictEqual(normalSearch.length, 0, '通常のtag_key検索ではtopノートも除外される');

        const noteListSearch = filterFilesByTagQuery(files, 'teamcenter -issue', getTags, {
            includeTopTaggedExcluded: true,
        });
        assert.deepStrictEqual(noteListSearch.map(file => file.path), ['moc.md']);
    });

    test('除外キーワード単体（例: -tag2）が指定されたときはそのタグを持たないファイルのみを返す', () => {
        // @ts-ignore
        const result = filterFilesByTagQuery(mockFiles, '-tag2', getFileTags);
        assert.strictEqual(result.length, 2);
        assert.strictEqual(result[0].path, 'file4.md');
        assert.strictEqual(result[1].path, 'file2.md');
    });

    test('大文字小文字を区別せず除外判定が行われること', () => {
        // @ts-ignore
        const result = filterFilesByTagQuery(mockFiles, 'TAG2 -TAG1', getFileTags);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].path, 'file3.md');
    });

    test('マイナス記号のみ（-）が指定されたときは無視されること', () => {
        // @ts-ignore
        const result = filterFilesByTagQuery(mockFiles, 'tag2 -', getFileTags);
        assert.strictEqual(result.length, 2);
        assert.strictEqual(result[0].path, 'file3.md');
        assert.strictEqual(result[1].path, 'file1.md');
    });
});

describe('getMocFilename', () => {
    test('クエリが空のときは「タグなしファイル」を返す', () => {
        const name = getMocFilename('');
        assert.strictEqual(name, 'タグなしファイル');

        const nameSpace = getMocFilename('   ');
        assert.strictEqual(nameSpace, 'タグなしファイル');
    });

    test('通常キーワードのみの場合はアンダースコアで連結される', () => {
        const name1 = getMocFilename('株');
        assert.strictEqual(name1, '株');

        const name2 = getMocFilename('株 投資');
        assert.strictEqual(name2, '株_投資');
    });

    test('除外キーワードのみの場合は括弧と「除く」が付く', () => {
        const name1 = getMocFilename('-開発');
        assert.strictEqual(name1, '(開発除く)');

        const name2 = getMocFilename('-開発 -海外');
        assert.strictEqual(name2, '(開発・海外除く)');
    });

    test('通常キーワードと除外キーワードが混在する場合はルール通り連結される', () => {
        const name1 = getMocFilename('株 -開発');
        assert.strictEqual(name1, '株(開発除く)');

        const name2 = getMocFilename('株 投資 -開発 -海外');
        assert.strictEqual(name2, '株_投資(開発・海外除く)');
    });

    test('マイナス単体の指定は無視される', () => {
        const name = getMocFilename('株 - 投資');
        assert.strictEqual(name, '株_投資');
    });
});

describe('extractTagsFromMetadata', () => {
    test('includeBodyTagsがfalseのときはフロントマターのタグのみが抽出される', () => {
        const cache = {
            frontmatter: {
                tags: ['tag1', 'tag2']
            },
            tags: [
                { tag: '#tag3' }
            ]
        };
        const result = extractTagsFromMetadata(cache, false);
        assert.deepStrictEqual(result, ['tag1', 'tag2']);
    });

    test('includeBodyTagsがtrueのときはフロントマターと本文のタグがマージされて抽出される', () => {
        const cache = {
            frontmatter: {
                tags: ['tag1', 'tag2']
            },
            tags: [
                { tag: '#tag3' },
                { tag: '#tag1' } // 重複タグ
            ]
        };
        const result = extractTagsFromMetadata(cache, true);
        assert.deepStrictEqual(result, ['tag1', 'tag2', 'tag3']);
    });

    test('フロントマターのtagキー（単数形）や文字列・数値の形式も正しく抽出できる', () => {
        const cache1 = {
            frontmatter: {
                tag: 'singleTag'
            }
        };
        assert.deepStrictEqual(extractTagsFromMetadata(cache1, false), ['singleTag']);

        const cache2 = {
            frontmatter: {
                tags: 12345
            }
        };
        assert.deepStrictEqual(extractTagsFromMetadata(cache2, false), ['12345']);
    });
});

describe('extractTagsFromMetadata の文字列のタグ', () => {
    test('カンマ区切りの文字列を別々のタグにする', () => {
        assert.deepStrictEqual(extractTagsFromMetadata({ frontmatter: { tags: 'a, #b,c' } }, false), ['a', 'b', 'c']);
    });
});

describe('isTextEditingTarget', () => {
    test('入力欄とテキストエリアと編集可能な要素', () => {
        assert.strictEqual(isTextEditingTarget({ tagName: 'INPUT' }), true);
        assert.strictEqual(isTextEditingTarget({ tagName: 'TEXTAREA' }), true);
        assert.strictEqual(isTextEditingTarget({ tagName: 'DIV', isContentEditable: true }), true);
    });

    test('それ以外の要素', () => {
        assert.strictEqual(isTextEditingTarget({ tagName: 'DIV', isContentEditable: false }), false);
        assert.strictEqual(isTextEditingTarget(null), false);
    });
});
