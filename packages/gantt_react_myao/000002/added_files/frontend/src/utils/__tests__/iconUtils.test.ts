import { describe, it, expect } from 'vitest';
import { getTaskIconName } from '../iconUtils';
import type { Task } from '../../types/gantt';

describe('getTaskIconName', () => {
  it('プロジェクトの場合は folder_project を返すこと', () => {
    const task: Partial<Task> = { kind_task: 2 };
    expect(getTaskIconName(task as Task)).toBe('folder_project');
  });

  it('文字列の2が渡された場合も folder_project を返すこと', () => {
    const task = { kind_task: '2' };
    expect(getTaskIconName(task as unknown as Task)).toBe('folder_project');
  });

  it('プロジェクトが開いている場合は folder_project_open を返すこと', () => {
    const task: Partial<Task> = { kind_task: 2 };
    expect(getTaskIconName(task as Task, true)).toBe('folder_project_open');
  });

  it('プロジェクト以外のフォルダの場合は folder を返すこと', () => {
    const task: Partial<Task> = { kind_task: 1 };
    expect(getTaskIconName(task as Task, false, true)).toBe('folder');
  });

  it('プロジェクト以外の開いているフォルダの場合は folder_open を返すこと', () => {
    const task: Partial<Task> = { kind_task: 1 };
    expect(getTaskIconName(task as Task, true, true)).toBe('folder_open');
  });

  it('リンク付きPDFタスクの場合は pdf を返すこと', () => {
    const task: Partial<Task> = { kind_task: 1, hyperlink: 'test.pdf' };
    expect(getTaskIconName(task as Task)).toBe('pdf');
  });

  it('リンク付きMarkdownタスクの場合は markdown を返すこと', () => {
    const task: Partial<Task> = { kind_task: 1, hyperlink: 'test.md' };
    expect(getTaskIconName(task as Task)).toBe('markdown');
  });

  it('リンク付きPythonタスクの場合は python を返すこと', () => {
    const task: Partial<Task> = { kind_task: 1, hyperlink: 'test.py' };
    expect(getTaskIconName(task as Task)).toBe('python');
  });

  it('リンク付き一般的なURLの場合は url を返すこと', () => {
    const task: Partial<Task> = { kind_task: 1, hyperlink: 'https://example.com' };
    expect(getTaskIconName(task as Task)).toBe('url');
  });

  it('Excalidrawタスクの場合は excalidraw を返すこと', () => {
    const task: Partial<Task> = { kind_task: 1, hyperlink: 'drawing.excalidraw.md' };
    expect(getTaskIconName(task as Task)).toBe('excalidraw');
  });

  it('リンクなしタスクの場合は file を返すこと', () => {
    const task: Partial<Task> = { kind_task: 1, hyperlink: '' };
    expect(getTaskIconName(task as Task)).toBe('file');
  });

  it('リンクなしマイルストーンの場合は file を返すこと', () => {
    const task: Partial<Task> = { kind_task: 3 };
    expect(getTaskIconName(task as Task)).toBe('file');
  });
});
