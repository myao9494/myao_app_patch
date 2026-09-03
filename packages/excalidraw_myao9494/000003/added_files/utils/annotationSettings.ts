/**
 * マーカーおよびアンダーラインの設定管理ユーティリティ
 * 
 * 仕様:
 * 1. マーカー設定（MarkerSettings）:
 *    - color: 背景色（デフォルト: '#fef08a'）
 *    - opacity: 不透明度（10〜100%、デフォルト: 50%）
 * 
 * 2. アンダーライン設定（UnderlineSettings）:
 *    - color: 線の色（デフォルト: '#e03131'）
 *    - strokeWidth: 線の太さ（1〜4px、デフォルト: 2px）
 *    - opacity: 不透明度（10〜100%、デフォルト: 100%）
 * 
 * 3. localStorage（キー: 'excalidraw_annotation_settings'）と連動し、
 *    設定の永続化および安全なフォールバック読み込みを行う。
 */

import { MARKER_COLOR, DEFAULT_MARKER_OPACITY } from './markerUtils';
import { UNDERLINE_COLOR, DEFAULT_UNDERLINE_STROKE_WIDTH } from './underlineUtils';

/** localStorage保存用のキー */
export const ANNOTATION_SETTINGS_STORAGE_KEY = 'excalidraw_annotation_settings';

/** マーカー設定の型 */
export interface MarkerSettings {
  /** マーカーの背景色 */
  color: string;
  /** 不透明度（10〜100%） */
  opacity: number;
}

/** アンダーライン設定の型 */
export interface UnderlineSettings {
  /** 下線の色 */
  color: string;
  /** 線の太さ（px） */
  strokeWidth: number;
  /** 不透明度（10〜100%） */
  opacity: number;
}

/** アノテーション（マーカー & アンダーライン）統合設定の型 */
export interface AnnotationSettings {
  marker: MarkerSettings;
  underline: UnderlineSettings;
}

/** デフォルト設定 */
export const DEFAULT_ANNOTATION_SETTINGS: AnnotationSettings = {
  marker: {
    color: MARKER_COLOR,
    opacity: DEFAULT_MARKER_OPACITY,
  },
  underline: {
    color: UNDERLINE_COLOR,
    strokeWidth: DEFAULT_UNDERLINE_STROKE_WIDTH,
    opacity: 100,
  },
};

/**
 * localStorageからアノテーション設定を読み込む
 * データがない場合や不正な形式の場合はデフォルト値で安全にフォールバックする
 * 
 * @returns 読み込まれた設定オブジェクト
 */
export const loadAnnotationSettings = (): AnnotationSettings => {
  try {
    const raw = localStorage.getItem(ANNOTATION_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_ANNOTATION_SETTINGS };
    }

    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return { ...DEFAULT_ANNOTATION_SETTINGS };
    }

    const marker: MarkerSettings = {
      color: typeof parsed.marker?.color === 'string' ? parsed.marker.color : DEFAULT_ANNOTATION_SETTINGS.marker.color,
      opacity: typeof parsed.marker?.opacity === 'number' ? parsed.marker.opacity : DEFAULT_ANNOTATION_SETTINGS.marker.opacity,
    };

    const underline: UnderlineSettings = {
      color: typeof parsed.underline?.color === 'string' ? parsed.underline.color : DEFAULT_ANNOTATION_SETTINGS.underline.color,
      strokeWidth: typeof parsed.underline?.strokeWidth === 'number' ? parsed.underline.strokeWidth : DEFAULT_ANNOTATION_SETTINGS.underline.strokeWidth,
      opacity: typeof parsed.underline?.opacity === 'number' ? parsed.underline.opacity : DEFAULT_ANNOTATION_SETTINGS.underline.opacity,
    };

    return {
      marker,
      underline,
    };
  } catch (error) {
    console.warn('アノテーション設定の読み込みに失敗しました。デフォルト値を使用します:', error);
    return { ...DEFAULT_ANNOTATION_SETTINGS };
  }
};

/**
 * アノテーション設定をlocalStorageに保存する
 * 
 * @param settings - 保存する設定オブジェクト
 */
export const saveAnnotationSettings = (settings: AnnotationSettings): void => {
  try {
    localStorage.setItem(ANNOTATION_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch (error) {
    console.error('アノテーション設定の保存に失敗しました:', error);
  }
};
