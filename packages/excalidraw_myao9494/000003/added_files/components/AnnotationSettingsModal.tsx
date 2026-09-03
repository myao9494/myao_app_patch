/**
 * マーカーおよびアンダーラインの設定モーダルコンポーネント
 * 
 * 仕様:
 * 1. マーカー設定:
 *    - 色の選択（プリセットパレット + カスタムカラーピッカー）
 *    - 不透明度の調整（10%〜100%のスライダー）
 * 2. アンダーライン設定:
 *    - 色の選択（プリセットパレット + カスタムカラーピッカー）
 *    - 線の太さの選択（1px, 2px, 3px, 4px）
 *    - 不透明度の調整（10%〜100%のスライダー）
 * 3. リアルタイムプレビューと初期値リセット機能。
 * 4. 設定変更時に即座に保存・親コンポーネントへ通知。
 * 5. 外側クリック、ESCキー、閉じるボタンでクローズ。
 */

import React, { useEffect, useRef } from 'react';
import type { AnnotationSettings } from '../utils/annotationSettings';
import { DEFAULT_ANNOTATION_SETTINGS } from '../utils/annotationSettings';

interface AnnotationSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AnnotationSettings;
  onUpdateSettings: (newSettings: AnnotationSettings) => void;
}

/** マーカーのプリセットカラーパレット */
const MARKER_PRESET_COLORS = [
  { label: 'イエロー', value: '#fef08a' },
  { label: 'グリーン', value: '#bbf7d0' },
  { label: 'ブルー', value: '#bae6fd' },
  { label: 'ピンク', value: '#fecdd3' },
  { label: 'オレンジ', value: '#fed7aa' },
];

/** アンダーラインのプリセットカラーパレット */
const UNDERLINE_PRESET_COLORS = [
  { label: 'レッド', value: '#e03131' },
  { label: 'ブルー', value: '#1971c2' },
  { label: 'グリーン', value: '#2f9e44' },
  { label: 'オレンジ', value: '#f08c00' },
  { label: 'ブラック', value: '#1e1e1e' },
];

export const AnnotationSettingsModal: React.FC<AnnotationSettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onUpdateSettings,
}) => {
  const modalRef = useRef<HTMLDivElement>(null);

  // ESCキーで閉じる
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // 外側クリックで閉じる
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    // イベント伝播直後の誤判定を防ぐため少し遅延して登録
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 50);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const updateMarker = (patch: Partial<AnnotationSettings['marker']>) => {
    onUpdateSettings({
      ...settings,
      marker: {
        ...settings.marker,
        ...patch,
      },
    });
  };

  const updateUnderline = (patch: Partial<AnnotationSettings['underline']>) => {
    onUpdateSettings({
      ...settings,
      underline: {
        ...settings.underline,
        ...patch,
      },
    });
  };

  const handleReset = () => {
    onUpdateSettings({ ...DEFAULT_ANNOTATION_SETTINGS });
  };

  return (
    <div className="annotation-settings-overlay" role="dialog" aria-modal="true" aria-label="マーカーとアンダーラインの設定">
      <div className="annotation-settings-window" ref={modalRef}>
        <div className="annotation-settings-header">
          <div className="title-area">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
            <h3>マーカーとアンダーラインの設定</h3>
          </div>
          <button type="button" className="close-btn" onClick={onClose} title="閉じる (Esc)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <div className="annotation-settings-body">
          {/* マーカー設定セクション */}
          <section className="settings-section">
            <div className="section-title">
              <span className="section-badge marker-badge">M</span>
              <h4>マーカー設定</h4>
              <span className="shortcut-hint">ショートカット: M</span>
            </div>

            {/* カラーパレット */}
            <div className="form-group">
              <label>ハイライト色</label>
              <div className="color-palette">
                {MARKER_PRESET_COLORS.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    className={`color-swatch ${settings.marker.color === item.value ? 'active' : ''}`}
                    style={{ backgroundColor: item.value }}
                    onClick={() => updateMarker({ color: item.value })}
                    title={item.label}
                  />
                ))}
                <label className="color-picker-label" title="カスタムカラー選択">
                  <input
                    type="color"
                    className="custom-color-input"
                    value={settings.marker.color}
                    onChange={(e) => updateMarker({ color: e.target.value })}
                  />
                  <span className="custom-color-btn" style={{ backgroundColor: settings.marker.color }}>+</span>
                </label>
              </div>
            </div>

            {/* 不透明度スライダー */}
            <div className="form-group">
              <div className="label-with-value">
                <label>透明度</label>
                <span className="value-badge">{settings.marker.opacity}%</span>
              </div>
              <input
                type="range"
                min="10"
                max="100"
                step="5"
                value={settings.marker.opacity}
                onChange={(e) => updateMarker({ opacity: Number(e.target.value) })}
                className="range-slider"
              />
            </div>

            {/* マーカープレビュー */}
            <div className="preview-container">
              <div className="preview-text-box">
                <span
                  className="preview-marker-band"
                  style={{
                    backgroundColor: settings.marker.color,
                    opacity: settings.marker.opacity / 100,
                  }}
                />
                <span className="preview-text">プレビュー テキストのハイライト</span>
              </div>
            </div>
          </section>

          <hr className="section-divider" />

          {/* アンダーライン設定セクション */}
          <section className="settings-section">
            <div className="section-title">
              <span className="section-badge underline-badge">U</span>
              <h4>アンダーライン設定</h4>
              <span className="shortcut-hint">ショートカット: U</span>
            </div>

            {/* カラーパレット */}
            <div className="form-group">
              <label>下線の色</label>
              <div className="color-palette">
                {UNDERLINE_PRESET_COLORS.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    className={`color-swatch ${settings.underline.color === item.value ? 'active' : ''}`}
                    style={{ backgroundColor: item.value }}
                    onClick={() => updateUnderline({ color: item.value })}
                    title={item.label}
                  />
                ))}
                <label className="color-picker-label" title="カスタムカラー選択">
                  <input
                    type="color"
                    className="custom-color-input"
                    value={settings.underline.color}
                    onChange={(e) => updateUnderline({ color: e.target.value })}
                  />
                  <span className="custom-color-btn" style={{ backgroundColor: settings.underline.color }}>+</span>
                </label>
              </div>
            </div>

            {/* 線の太さ */}
            <div className="form-group">
              <label>線の太さ</label>
              <div className="stroke-width-group">
                {[1, 2, 3, 4].map((width) => (
                  <button
                    key={width}
                    type="button"
                    className={`stroke-width-btn ${settings.underline.strokeWidth === width ? 'active' : ''}`}
                    onClick={() => updateUnderline({ strokeWidth: width })}
                  >
                    <span className="stroke-line" style={{ height: `${width}px`, backgroundColor: settings.underline.color }} />
                    <span className="stroke-label">{width}px</span>
                  </button>
                ))}
              </div>
            </div>

            {/* 不透明度スライダー */}
            <div className="form-group">
              <div className="label-with-value">
                <label>透明度</label>
                <span className="value-badge">{settings.underline.opacity}%</span>
              </div>
              <input
                type="range"
                min="10"
                max="100"
                step="5"
                value={settings.underline.opacity}
                onChange={(e) => updateUnderline({ opacity: Number(e.target.value) })}
                className="range-slider"
              />
            </div>

            {/* アンダーラインプレビュー */}
            <div className="preview-container">
              <div className="preview-text-box">
                <span className="preview-text">プレビュー テキストの下線</span>
                <span
                  className="preview-underline-line"
                  style={{
                    backgroundColor: settings.underline.color,
                    height: `${settings.underline.strokeWidth}px`,
                    opacity: settings.underline.opacity / 100,
                  }}
                />
              </div>
            </div>
          </section>
        </div>

        <div className="annotation-settings-footer">
          <button type="button" className="reset-btn" onClick={handleReset}>
            初期値に戻す
          </button>
          <button type="button" className="confirm-btn" onClick={onClose}>
            完了
          </button>
        </div>
      </div>
    </div>
  );
};
