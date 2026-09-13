import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { buildBacklinkCountMap, calculateFileImportanceScore, getOpenFolderCommand, getOpenFolderCommandArgs, getDragText, getBacklinkPaths, collectLinkedFiles, isAttachmentFile, shouldMoveToMoc, getTodayFolderPath, buildExcalidrawWebUrl, isExcalidrawBackedMarkdown, openFileInMarkdownView, switchToMarkdownViewIfExcalidraw, filterFolderFiles, buildFileManagerWebUrl } from './utils';


describe('getOpenFolderCommand', () => {
    test('macOS (darwin) の場合は open コマンドを返す', () => {
        const cmd = getOpenFolderCommand('darwin', '/Users/test/folder');
        assert.strictEqual(cmd, 'open "/Users/test/folder"');
    });

    test('Windows (win32) の場合は explorer コマンドとバックスラッシュのパスを返す', () => {
        const cmd = getOpenFolderCommand('win32', 'C:/Users/test/folder');
        assert.strictEqual(cmd, 'explorer "C:\\Users\\test\\folder"');
    });

    test('想定外のOSの場合は空文字を返す', () => {
        const cmd = getOpenFolderCommand('linux', '/home/test/folder');
        assert.strictEqual(cmd, '');
    });

    test('shellを通さずに実行できるコマンドと引数を返す', () => {
        assert.deepStrictEqual(getOpenFolderCommandArgs('darwin', '/Users/test/folder "quoted"'), {
            command: 'open',
            args: ['/Users/test/folder "quoted"'],
        });
        assert.deepStrictEqual(getOpenFolderCommandArgs('win32', 'C:/Users/test/folder'), {
            command: 'explorer',
            args: ['C:\\Users\\test\\folder'],
        });
    });
});

describe('getDragText', () => {
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

    test('Excalidraw Web URLはWindowsパスをスラッシュ区切りに正規化してエンコードする', () => {
        const url = buildExcalidrawWebUrl('C:\\Users\\test\\vault\\01_data\\図 test.excalidraw.md');
        assert.strictEqual(url, 'http://localhost:3001/?filepath=C%3A/Users/test/vault/01_data/%E5%9B%B3%20test.excalidraw.md');
    });
});

describe('Excalidraw-backed Markdown opening', () => {
    test('通常のmdでもexcalidraw-plugin frontmatterがあればExcalidraw-backedと判定する', () => {
        const file = { name: 'りんご.md', extension: 'md', path: '01_data/りんご.md' };
        const app = {
            metadataCache: {
                getFileCache: () => ({ frontmatter: { 'excalidraw-plugin': 'parsed' } }),
            },
            plugins: { plugins: {} },
        };

        assert.strictEqual(isExcalidrawBackedMarkdown(app, file), true);
    });

    test('Excalidrawビューで開いたmdをMarkdownビューへ切り替える', async () => {
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
        assert.strictEqual(opened, true);
        assert.strictEqual(switched, true);
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
        assert.strictEqual(switched, false);
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
        assert.strictEqual(switched, false);
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
        assert.strictEqual(switched, true);
        assert.strictEqual(fallbackCalled, true);
    });
});

describe('attachment helpers', () => {
    test('添付ファイル判定で markdown を除外する', () => {
        assert.strictEqual(isAttachmentFile({ extension: 'png' }), true);
        assert.strictEqual(isAttachmentFile({ extension: 'md' }), false);
        assert.strictEqual(isAttachmentFile({ extension: 'docx' }), true);
    });

    test('links と embeds から markdown / 添付ファイルを重複なく収集する', () => {
        const result = collectLinkedFiles(
            {
                getFirstLinkpathDest: (link: string) => {
                    const table: Record<string, { path: string; extension: string } | null> = {
                        'note': { path: 'note.md', extension: 'md' },
                        'image': { path: 'image.png', extension: 'png' },
                        'doc': { path: 'doc.docx', extension: 'docx' },
                        'dup-image': { path: 'image.png', extension: 'png' },
                    };
                    return table[link] ?? null;
                },
            },
            { path: 'source.md' },
            [{ link: 'note' }, { link: 'image' }, { link: 'dup-image' }, { link: 'doc' }],
        );

        assert.deepStrictEqual(result.markdownFiles, ['note.md']);
        assert.deepStrictEqual(result.attachmentFiles.sort(), ['doc.docx', 'image.png'].sort());
    });
});

describe('calculateFileImportanceScore', () => {
    test('被リンク数が多いファイルを高く評価する', () => {
        const now = Date.UTC(2026, 0, 1);
        const lowBacklinkScore = calculateFileImportanceScore({
            accessCount: 20,
            backlinkCount: 0,
            lastOpenedAt: now,
            modifiedAt: now,
        }, now);
        const highBacklinkScore = calculateFileImportanceScore({
            accessCount: 1,
            backlinkCount: 10,
            lastOpenedAt: now,
            modifiedAt: now,
        }, now);

        assert.ok(highBacklinkScore > lowBacklinkScore);
    });
});

describe('getBacklinkPaths', () => {
    test('resolvedLinksとunresolvedLinksの両方からバックリンクパスを取得できる', () => {
        // Mock app.metadataCache 
        const mockMetadataCache = {
            resolvedLinks: {
                'source1.md': {
                    'target.md': 1
                },
                'source2.md': {
                    'other.md': 1
                }
            },
            unresolvedLinks: {
                'source3.md': {
                    'target.excalidraw': 1
                },
                'source4.md': {
                    'missing.excalidraw': 1
                }
            },
            getFirstLinkpathDest: (linkpath: string, sourcePath: string) => {
                if (linkpath === 'target.excalidraw') {
                    return { path: 'target.md' }; // Resolves to our target
                }
                return null;
            }
        };

        const targetFilePath = 'target.md';

        // @ts-ignore - Mocking just enough for the test
        const paths = getBacklinkPaths(mockMetadataCache, targetFilePath);

        assert.deepStrictEqual(paths.sort(), ['source1.md', 'source3.md'].sort());
    });

    test('同じ revision ではキャッシュを返し、revision 更新で再計算する', () => {
        let resolveCalls = 0;
        const mockMetadataCache = {
            resolvedLinks: {
                'source1.md': {
                    'target.md': 1
                }
            } as Record<string, Record<string, number>>,
            unresolvedLinks: {
                'source2.md': {
                    'target.excalidraw': 1
                }
            } as Record<string, Record<string, number>>,
            getFirstLinkpathDest: (linkpath: string) => {
                resolveCalls += 1;
                if (linkpath === 'target.excalidraw') {
                    return { path: 'target.md' };
                }
                return null;
            }
        };

        const first = getBacklinkPaths(mockMetadataCache, 'target.md', 1);
        const second = getBacklinkPaths(mockMetadataCache, 'target.md', 1);

        mockMetadataCache.unresolvedLinks['source3.md'] = {
            'target-2.excalidraw': 1
        };
        mockMetadataCache.getFirstLinkpathDest = (linkpath: string) => {
            resolveCalls += 1;
            if (linkpath === 'target.excalidraw' || linkpath === 'target-2.excalidraw') {
                return { path: 'target.md' };
            }
            return null;
        };

        const third = getBacklinkPaths(mockMetadataCache, 'target.md', 2);

        assert.deepStrictEqual(first.sort(), ['source1.md', 'source2.md'].sort());
        assert.deepStrictEqual(second.sort(), ['source1.md', 'source2.md'].sort());
        assert.deepStrictEqual(third.sort(), ['source1.md', 'source2.md', 'source3.md'].sort());
        assert.strictEqual(resolveCalls, 3);
    });
});

describe('buildBacklinkCountMap', () => {
    test('resolvedLinksとunresolvedLinksを一度の走査でファイル別の被リンク数に集計する', () => {
        const mockMetadataCache = {
            resolvedLinks: {
                'source1.md': {
                    'target.md': 1,
                    'other.md': 1,
                },
                'source2.md': {
                    'target.md': 1,
                },
            },
            unresolvedLinks: {
                'source3.md': {
                    'target.excalidraw': 1,
                },
                'source1.md': {
                    'target-alias': 1,
                },
            },
            getFirstLinkpathDest: (linkpath: string) => {
                if (linkpath === 'target.excalidraw' || linkpath === 'target-alias') {
                    return { path: 'target.md' };
                }
                return null;
            },
        };

        const counts = buildBacklinkCountMap(mockMetadataCache);

        assert.strictEqual(counts['target.md'], 3);
        assert.strictEqual(counts['other.md'], 1);
    });
});

describe('openFileInSplitTab', () => {
    test('アクティブタブを上下分割（horizontal）した新しいタブを作成し、指定ファイルを開く', async () => {
        let splitTypeCalled: string | null = null;
        let splitDirectionCalled: string | null = null;
        let openedFile: any = null;

        const mockLeaf = {
            openFile: async (file: any) => {
                openedFile = file;
            }
        };

        const mockApp = {
            workspace: {
                getLeaf: (type: string, direction: string) => {
                    splitTypeCalled = type;
                    splitDirectionCalled = direction;
                    return mockLeaf;
                }
            }
        };

        const mockFile = { path: '02_view/data_cards.base' };

        // 実装前のモジュールから関数を読み込む
        // @ts-ignore
        const { openFileInSplitTab } = require('./utils');
        await openFileInSplitTab(mockApp as any, mockFile as any);

        assert.strictEqual(splitTypeCalled, 'split');
        assert.strictEqual(splitDirectionCalled, 'horizontal');
        assert.strictEqual(openedFile, mockFile);
    });
});

describe('toggleFileView', () => {
    test('すでにファイルが開いているタブがある場合、そのタブを閉じる（detach）', async () => {
        let detached = false;
        let iterateCalled = false;

        const mockTargetLeaf = {
            view: {
                file: { path: '02_view/data_cards.base' }
            },
            detach: () => {
                detached = true;
            }
        };

        const mockApp = {
            workspace: {
                iterateAllLeaves: (callback: (leaf: any) => void) => {
                    iterateCalled = true;
                    callback(mockTargetLeaf);
                }
            }
        };

        // @ts-ignore
        const { toggleFileView } = require('./utils');
        await toggleFileView(mockApp as any, '02_view/data_cards.base');

        assert.ok(iterateCalled);
        assert.ok(detached);
    });

    test('ファイルが開いていない場合、新しく上下分割して開く', async () => {
        let iterateCalled = false;
        let splitTypeCalled: string | null = null;
        let splitDirectionCalled: string | null = null;
        let openedFile: any = null;

        const mockLeaf = {
            openFile: async (file: any) => {
                openedFile = file;
            }
        };

        const mockFile = { path: '02_view/data_cards.base' };

        const mockApp = {
            vault: {
                getAbstractFileByPath: (path: string) => {
                    if (path === '02_view/data_cards.base') return mockFile;
                    return null;
                }
            },
            workspace: {
                iterateAllLeaves: (callback: (leaf: any) => void) => {
                    iterateCalled = true;
                    // 他のファイルが開いているモック
                    callback({
                        view: {
                            file: { path: 'other.md' }
                        }
                    });
                },
                getActiveLeaf: () => null,
                getLeaf: (type: string, direction: string) => {
                    splitTypeCalled = type;
                    splitDirectionCalled = direction;
                    return mockLeaf;
                }
            }
        };

        // @ts-ignore
        const { toggleFileView } = require('./utils');
        await toggleFileView(mockApp as any, '02_view/data_cards.base');

        assert.ok(iterateCalled);
        assert.strictEqual(splitTypeCalled, 'split');
        assert.strictEqual(splitDirectionCalled, 'horizontal');
        assert.strictEqual(openedFile, mockFile);
    });

    test('ファイルを開く際、元のアクティブなLeafにフォーカスを戻す', async () => {
        let activeLeafSet: any = null;
        let setActiveLeafOptions: any = null;

        const mockActiveLeaf = { id: 'active-markdown-leaf' };
        const mockLeaf = {
            openFile: async (file: any) => {}
        };
        const mockFile = { path: '02_view/common_image_cards.base' };

        const mockApp = {
            vault: {
                getAbstractFileByPath: (path: string) => mockFile
            },
            workspace: {
                iterateAllLeaves: (callback: (leaf: any) => void) => {
                    // 他の無関係なファイルが開いている状態
                    callback({
                        view: {
                            file: { path: 'other.md' }
                        }
                    });
                },
                getActiveLeaf: () => mockActiveLeaf,
                getLeaf: (type: string, direction: string) => mockLeaf,
                setActiveLeaf: (leaf: any, options?: any) => {
                    activeLeafSet = leaf;
                    setActiveLeafOptions = options;
                }
            }
        };

        // @ts-ignore
        const { toggleFileView } = require('./utils');
        await toggleFileView(mockApp as any, '02_view/common_image_cards.base');

        // setTimeoutによる非同期フォーカス復帰の実行完了を待つ
        await new Promise(resolve => setTimeout(resolve, 100));

        assert.strictEqual(activeLeafSet, mockActiveLeaf, '元のアクティブなLeafにフォーカスが戻されること');
        assert.deepStrictEqual(setActiveLeafOptions, { focus: true }, 'setActiveLeafに { focus: true } オプションが渡されること');
    });

    test('getActiveLeafが未定義の場合、getMostRecentLeafからアクティブなLeafを取得してフォーカスを戻す', async () => {
        let activeLeafSet: any = null;
        const mockActiveLeaf = { id: 'active-markdown-leaf-recent' };
        const mockLeaf = { openFile: async (file: any) => {} };
        const mockFile = { path: '02_view/common_image_cards.base' };

        const mockApp = {
            vault: {
                getAbstractFileByPath: () => mockFile
            },
            workspace: {
                iterateAllLeaves: (callback: any) => {},
                getActiveLeaf: undefined,
                getMostRecentLeaf: () => mockActiveLeaf,
                getLeaf: () => mockLeaf,
                setActiveLeaf: (leaf: any) => {
                    activeLeafSet = leaf;
                }
            }
        };

        const { toggleFileView } = require('./utils');
        await toggleFileView(mockApp as any, '02_view/common_image_cards.base');

        await new Promise(resolve => setTimeout(resolve, 100));
        assert.strictEqual(activeLeafSet, mockActiveLeaf, 'getActiveLeafがなくてもgetMostRecentLeafから取得してフォーカスが戻されること');
    });

    test('getActiveLeafとgetMostRecentLeafが未定義の場合、activeLeafプロパティから取得してフォーカスを戻す', async () => {
        let activeLeafSet: any = null;
        const mockActiveLeaf = { id: 'active-markdown-leaf-property' };
        const mockLeaf = { openFile: async (file: any) => {} };
        const mockFile = { path: '02_view/common_image_cards.base' };

        const mockApp = {
            vault: {
                getAbstractFileByPath: () => mockFile
            },
            workspace: {
                iterateAllLeaves: (callback: any) => {},
                getActiveLeaf: undefined,
                getMostRecentLeaf: undefined,
                activeLeaf: mockActiveLeaf,
                getLeaf: () => mockLeaf,
                setActiveLeaf: (leaf: any) => {
                    activeLeafSet = leaf;
                }
            }
        };

        const { toggleFileView } = require('./utils');
        await toggleFileView(mockApp as any, '02_view/common_image_cards.base');

        await new Promise(resolve => setTimeout(resolve, 100));
        assert.strictEqual(activeLeafSet, mockActiveLeaf, 'getActiveLeafとgetMostRecentLeafがなくてもactiveLeafプロパティから取得してフォーカスが戻されること');
    });

    test('すでにファイルが開いているタブがある場合、そのタブを閉じ、元のアクティブなエディタにフォーカスを戻す', async () => {
        let detached = false;
        let activeLeafSet: any = null;

        const mockTargetLeaf = {
            id: 'target-bases-leaf',
            view: {
                file: { path: '02_view/data_cards.base' }
            },
            detach: () => {
                detached = true;
            }
        };

        const mockActiveLeaf = { id: 'active-markdown-leaf-editor' };

        const mockApp = {
            workspace: {
                iterateAllLeaves: (callback: (leaf: any) => void) => {
                    callback(mockTargetLeaf);
                },
                getActiveLeaf: () => mockActiveLeaf,
                setActiveLeaf: (leaf: any) => {
                    activeLeafSet = leaf;
                }
            }
        };

        const { toggleFileView } = require('./utils');
        await toggleFileView(mockApp as any, '02_view/data_cards.base');

        await new Promise(resolve => setTimeout(resolve, 100));

        assert.ok(detached);
        assert.strictEqual(activeLeafSet, mockActiveLeaf, '閉じられた後に元のアクティブなLeafにフォーカスが戻されること');
    });

});

describe('shouldMoveToMoc', () => {
    test('MOCタグが本文中に含まれる場合は true を返す', () => {
        const file = { path: '01_data/memo.md', extension: 'md', name: 'memo.md' };
        const cache = { tags: [{ tag: '#MOC' }] };
        assert.strictEqual(shouldMoveToMoc(file, cache), true);
    });

    test('MOCタグがフロントマターに含まれる場合は true を返す', () => {
        const file = { path: '01_data/my-moc.md', extension: 'md', name: 'my-moc.md' };
        const cache = { frontmatter: { tags: ['MOC'] } };
        assert.strictEqual(shouldMoveToMoc(file, cache), true);
    });

    test('小文字の moc タグがフロントマターの配列に含まれる場合も true を返す', () => {
        const file = { path: '01_data/my-moc.md', extension: 'md', name: 'my-moc.md' };
        const cache = { frontmatter: { tags: ['project', 'moc'] } };
        assert.strictEqual(shouldMoveToMoc(file, cache), true);
    });

    test('フロントマターのタグがカンマ区切りの文字列の場合も正しく判定して true を返す', () => {
        const file = { path: '01_data/my-moc.md', extension: 'md', name: 'my-moc.md' };
        const cache = { frontmatter: { tags: 'project, MOC, test' } };
        assert.strictEqual(shouldMoveToMoc(file, cache), true);
    });

    test('MOCタグが含まれていても 00_templates 配下のファイルなら false を返す', () => {
        const file = { path: '00_templates/template.md', extension: 'md', name: 'template.md' };
        const cache = { tags: [{ tag: '#MOC' }] };
        assert.strictEqual(shouldMoveToMoc(file, cache), false);
    });

    test('MOCタグが含まれていてもすでに 02_MOC 配下のファイルなら false を返す', () => {
        const file = { path: '02_MOC/existing.md', extension: 'md', name: 'existing.md' };
        const cache = { tags: [{ tag: '#MOC' }] };
        assert.strictEqual(shouldMoveToMoc(file, cache), false);
    });

    test('MOCタグが含まれていても非マークダウンファイルなら false を返す', () => {
        const file = { path: '01_data/image.png', extension: 'png', name: 'image.png' };
        const cache = { tags: [{ tag: '#MOC' }] };
        assert.strictEqual(shouldMoveToMoc(file, cache), false);
    });

    test('MOCタグが含まれていても Excalidraw ファイルなら false を返す', () => {
        const file = { path: '01_data/diagram.excalidraw.md', extension: 'md', name: 'diagram.excalidraw.md' };
        const cache = { tags: [{ tag: '#MOC' }] };
        assert.strictEqual(shouldMoveToMoc(file, cache), false);
    });

    test('MOCタグが含まれていないマークダウンファイルなら false を返す', () => {
        const file = { path: '01_data/memo.md', extension: 'md', name: 'memo.md' };
        const cache = { tags: [{ tag: '#normal' }] };
        assert.strictEqual(shouldMoveToMoc(file, cache), false);
    });
});

describe('getTodayFolderPath', () => {
    test('指定された日付に応じた01_data/YYYY/MM/DDパスを返す', () => {
        const date = new Date(2026, 5, 11); // 2026年6月11日 (getMonthは0から始まるので5は6月)
        const path = getTodayFolderPath(date);
        assert.strictEqual(path, '01_data/2026/06/11');
    });

    test('月や日が1桁の場合に適切にパディングされる', () => {
        const date = new Date(2026, 0, 5); // 2026年1月5日
        const path = getTodayFolderPath(date);
        assert.strictEqual(path, '01_data/2026/01/05');
    });
});

describe('filterFolderFiles', () => {
    const mockFiles = [
        { name: 'apple.md', stat: { mtime: 1000 } },
        { name: 'banana_doc.pdf', stat: { mtime: 3000 } },
        { name: 'cherry_test.png', stat: { mtime: 2000 } },
        { name: 'banana_note.md', stat: { mtime: 4000 } },
    ] as any[];

    test('更新日時 (mtime) の降順でファイルをソートすること', () => {
        const result = filterFolderFiles(mockFiles);
        assert.strictEqual(result.length, 4);
        assert.strictEqual(result[0].name, 'banana_note.md'); // 4000
        assert.strictEqual(result[1].name, 'banana_doc.pdf');  // 3000
        assert.strictEqual(result[2].name, 'cherry_test.png'); // 2000
        assert.strictEqual(result[3].name, 'apple.md');        // 1000
    });

    test('検索クエリが指定された場合、大文字小文字を区別せず部分一致で絞り込むこと', () => {
        const result = filterFolderFiles(mockFiles, 'BANANA');
        assert.strictEqual(result.length, 2);
        assert.strictEqual(result[0].name, 'banana_note.md');
        assert.strictEqual(result[1].name, 'banana_doc.pdf');
    });

    test('複数の検索キーワード（全角・半角スペース区切り）でAND検索ができること', () => {
        const result = filterFolderFiles(mockFiles, 'banana　doc');
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].name, 'banana_doc.pdf');
    });

    test('検索クエリが空または空白のみの場合は全件を返すこと', () => {
        const result = filterFolderFiles(mockFiles, '   ');
        assert.strictEqual(result.length, 4);
    });

    test('マッチするファイルがない場合は空配列を返すこと', () => {
        const result = filterFolderFiles(mockFiles, 'orange');
        assert.strictEqual(result.length, 0);
    });
});

describe('buildFileManagerWebUrl', () => {
    test('指定されたフォルダパスをエンコードしてhttp://localhost:8001/?path=形式のURLを生成すること', () => {
        const url = buildFileManagerWebUrl('/Users/test/vault/01_data/2026/09/13');
        assert.strictEqual(url, 'http://localhost:8001/?path=%2FUsers%2Ftest%2Fvault%2F01_data%2F2026%2F09%2F13');
    });

    test('空白や日本語を含むパスを正しくパーセントエンコードすること', () => {
        const url = buildFileManagerWebUrl('/Users/test/フォルダ A/ファイル 1');
        assert.strictEqual(
            url,
            'http://localhost:8001/?path=%2FUsers%2Ftest%2F%E3%83%95%E3%82%A9%E3%83%AB%E3%83%80%20A%2F%E3%83%95%E3%82%A1%E3%82%A4%E3%83%AB%201'
        );
    });

    test('Windowsのバックスラッシュを含むパスも正しくエンコードすること', () => {
        const url = buildFileManagerWebUrl('C:\\Users\\test\\vault\\01_data');
        assert.strictEqual(
            url,
            'http://localhost:8001/?path=C%3A%5CUsers%5Ctest%5Cvault%5C01_data'
        );
    });
});

