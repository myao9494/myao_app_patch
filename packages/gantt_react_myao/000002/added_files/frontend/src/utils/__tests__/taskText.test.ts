import { describe, it, expect } from 'vitest';
import { escapeHtml, stripLeadingNoise } from '../taskText';

describe('stripLeadingNoise', () => {
  it('先頭の半角・全角スペースとタブを取り除くこと', () => {
    expect(stripLeadingNoise(' \t\u3000\u3000タスク名')).toBe('タスク名');
  });

  it('UIがタスク名の前に付けるアイコンを取り除くこと', () => {
    expect(stripLeadingNoise('\u3000📁 プロジェクト')).toBe('プロジェクト');
    expect(stripLeadingNoise('📄📌 タスク')).toBe('タスク');
  });

  it('それ以外の絵文字で始まるタスク名は壊さずにそのまま残すこと', () => {
    // u フラグの無い正規表現では、サロゲートペアの片方だけが削れて文字化けしていた
    expect(stripLeadingNoise('📊 レポート')).toBe('📊 レポート');
    expect(stripLeadingNoise('🚀 リリース')).toBe('🚀 リリース');
    expect(stripLeadingNoise('  🔥 重要')).toBe('🔥 重要');
  });

  it('先頭以外のアイコンや空白には触れないこと', () => {
    expect(stripLeadingNoise('資料 📁 整理 ')).toBe('資料 📁 整理 ');
  });

  it('null / undefined は空文字として扱うこと', () => {
    expect(stripLeadingNoise(null)).toBe('');
    expect(stripLeadingNoise(undefined)).toBe('');
  });
});

describe('escapeHtml', () => {
  it('HTMLとして解釈される文字をエスケープすること', () => {
    expect(escapeHtml(`<b>A&B</b> "x" 'y'`)).toBe('&lt;b&gt;A&amp;B&lt;/b&gt; &quot;x&quot; &#39;y&#39;');
  });

  it('文字列以外も文字列化して返すこと', () => {
    expect(escapeHtml(42)).toBe('42');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});
