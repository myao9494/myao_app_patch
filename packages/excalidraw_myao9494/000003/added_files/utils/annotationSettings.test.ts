/**
 * アノテーション（マーカー・アンダーライン）設定管理のテスト
 * 
 * 仕様:
 * 1. DEFAULT_ANNOTATION_SETTINGS:
 *    - marker: { color: '#fef08a', opacity: 50 }
 *    - underline: { color: '#e03131', strokeWidth: 2, opacity: 100 }
 * 
 * 2. loadAnnotationSettings:
 *    - localStorageにデータがない場合、DEFAULT_ANNOTATION_SETTINGSを返す。
 *    - localStorageにデータがある場合、パースして各プロパティを反映したAnnotationSettingsを返す。
 *    - 不正なJSONや一部値が欠損している場合、デフォルト値で安全に補完する。
 * 
 * 3. saveAnnotationSettings:
 *    - 指定された設定オブジェクトをJSON文字列としてlocalStorageに保存する。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DEFAULT_ANNOTATION_SETTINGS,
  loadAnnotationSettings,
  saveAnnotationSettings,
  ANNOTATION_SETTINGS_STORAGE_KEY,
  type AnnotationSettings,
} from './annotationSettings';

describe('annotationSettings', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  describe('DEFAULT_ANNOTATION_SETTINGS', () => {
    it('適切な初期値が設定されている', () => {
      expect(DEFAULT_ANNOTATION_SETTINGS.marker.color).toBe('#fef08a');
      expect(DEFAULT_ANNOTATION_SETTINGS.marker.opacity).toBe(50);
      expect(DEFAULT_ANNOTATION_SETTINGS.underline.color).toBe('#e03131');
      expect(DEFAULT_ANNOTATION_SETTINGS.underline.strokeWidth).toBe(2);
      expect(DEFAULT_ANNOTATION_SETTINGS.underline.opacity).toBe(100);
    });
  });

  describe('loadAnnotationSettings', () => {
    it('localStorageが空の場合はデフォルト設定を返す', () => {
      const settings = loadAnnotationSettings();
      expect(settings).toEqual(DEFAULT_ANNOTATION_SETTINGS);
    });

    it('localStorageに保存された設定を正しく読み込む', () => {
      const customSettings: AnnotationSettings = {
        marker: {
          color: '#bae6fd',
          opacity: 75,
        },
        underline: {
          color: '#1971c2',
          strokeWidth: 3,
          opacity: 90,
        },
      };

      localStorage.setItem(ANNOTATION_SETTINGS_STORAGE_KEY, JSON.stringify(customSettings));

      const loaded = loadAnnotationSettings();
      expect(loaded).toEqual(customSettings);
    });

    it('JSONが壊れている場合はデフォルト設定にフォールバックする', () => {
      localStorage.setItem(ANNOTATION_SETTINGS_STORAGE_KEY, 'invalid-json');

      const loaded = loadAnnotationSettings();
      expect(loaded).toEqual(DEFAULT_ANNOTATION_SETTINGS);
    });

    it('一部のプロパティが欠けている場合はデフォルト値で安全に補完する', () => {
      const partial = {
        marker: {
          color: '#bbf7d0',
        },
      };
      localStorage.setItem(ANNOTATION_SETTINGS_STORAGE_KEY, JSON.stringify(partial));

      const loaded = loadAnnotationSettings();
      expect(loaded.marker.color).toBe('#bbf7d0');
      expect(loaded.marker.opacity).toBe(50); // デフォルト値補完
      expect(loaded.underline).toEqual(DEFAULT_ANNOTATION_SETTINGS.underline); // デフォルト値補完
    });
  });

  describe('saveAnnotationSettings', () => {
    it('設定をlocalStorageにJSON形式で保存する', () => {
      const newSettings: AnnotationSettings = {
        marker: {
          color: '#fecdd3',
          opacity: 40,
        },
        underline: {
          color: '#2f9e44',
          strokeWidth: 4,
          opacity: 80,
        },
      };

      saveAnnotationSettings(newSettings);

      const savedJson = localStorage.getItem(ANNOTATION_SETTINGS_STORAGE_KEY);
      expect(savedJson).not.toBeNull();
      expect(JSON.parse(savedJson!)).toEqual(newSettings);
    });
  });
});
