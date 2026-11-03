/**
 * 出力テキストの文字数表示 (charCount.js)
 *
 * 仕様:
 * 1. countChars: サロゲートペア(絵文字など)を1文字として数える（バックエンドのPython len と同じ数え方）。
 * 2. formatMan: 文字数を「12.35万文字」の形式にする。
 **/

const SURROGATE_PAIR = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;

export const countChars = text => {
  const value = text || '';
  return value.length - (value.match(SURROGATE_PAIR)?.length || 0);
};

export const formatMan = count => `${(count / 10000).toFixed(2)}万文字`;
