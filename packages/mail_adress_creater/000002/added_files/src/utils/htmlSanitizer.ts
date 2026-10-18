/**
 * Office/Word特有の複雑なHTMLを、標準的できれいなHTMLにサニタイズ（クリーンアップ）する
 * 
 * OutlookからコピーしたHTMLに含まれる巨大なスタイルシート(<style>)、独自の名前空間タグ(<o:p>など)、
 * classやid、無駄なインラインスタイル(margin, font-familyなど)を取り除き、
 * 重要なリッチテキスト装飾(太字、斜体、下線、リンク、文字色、テーブルなど)はそのまま維持します。
 **/

/**
 * 許可するスタイル名リスト
 */
const ALLOWED_STYLES = [
  'color',
  'background-color',
  'font-weight',
  'font-style',
  'text-decoration',
  'text-align',
];

/**
 * 許可するHTML属性リスト
 */
const ALLOWED_ATTRIBUTES = [
  'href',
  'src',
  'alt',
  'title',
  'colspan',
  'rowspan',
  'border',
  'align',
  'target',
];

/**
 * スクリプトを実行しうるURLスキーム（javascript:, vbscript:）かどうか
 * 制御文字や空白を挟んだ難読化（"java\tscript:"）も同じ扱いにする
 */
function isScriptUrl(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  const compact = value.replace(/[\u0000-\u0020]/g, '').toLowerCase()
  return compact.startsWith('javascript:') || compact.startsWith('vbscript:')
}

/**
 * インラインスタイルのフィルタリングを行う
 */
function filterStyles(styleString: string): string {
  if (!styleString) return '';
  
  const declarations = styleString.split(';');
  const filtered: string[] = [];

  declarations.forEach(decl => {
    const parts = decl.split(':');
    if (parts.length === 2) {
      const prop = parts[0].trim().toLowerCase();
      const val = parts[1].trim();
      
      // 許可リストに含まれており、かつOffice特有の記述を含まないもののみ残す
      if (ALLOWED_STYLES.includes(prop) && !prop.startsWith('mso-')) {
        filtered.push(`${prop}: ${val}`);
      }
    }
  });

  return filtered.join('; ');
}

/**
 * HTML文字列を受け取り、サニタイズしたきれいなHTMLを返す
 */
export function sanitizeHtml(html: string): string {
  if (!html) return '';

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // 1. 不要な要素の完全削除 (style, meta, link, xml, title, script, noscript)
  const removeTags = ['style', 'meta', 'link', 'xml', 'title', 'script', 'noscript'];
  removeTags.forEach(tag => {
    doc.querySelectorAll(tag).forEach(el => el.remove());
  });

  // 2. DOMツリーを巡回して各要素をクリーンアップ
  const allElements = Array.from(doc.getElementsByTagName('*'));
  
  // ネームスペースタグなどの要素が削除されたり順序が変わったりすることを考慮し、後ろからループする
  for (let i = allElements.length - 1; i >= 0; i--) {
    const el = allElements[i] as HTMLElement;
    const tagName = el.tagName.toLowerCase();

    // 2-a. Outlook/Office独自のタグ (名前空間付きのもの。例: <o:p>, <w:wrap>)
    if (tagName.includes(':')) {
      const parent = el.parentNode;
      if (parent) {
        // 子要素やテキストを親要素に引き上げる
        while (el.firstChild) {
          parent.insertBefore(el.firstChild, el);
        }
        el.remove();
      }
      continue;
    }

    // 2-b. 許可しない属性の除去およびstyleのクリーンアップ
    const attributes = Array.from(el.attributes);
    attributes.forEach(attr => {
      const name = attr.name.toLowerCase();
      
      if (name === 'style') {
        const cleanStyle = filterStyles(attr.value);
        if (cleanStyle) {
          el.setAttribute('style', cleanStyle);
        } else {
          el.removeAttribute('style');
        }
      } else if (!ALLOWED_ATTRIBUTES.includes(name)) {
        // classやid、その他Office固有の独自属性(x:strなど)はすべて除去する
        el.removeAttribute(attr.name);
      } else if ((name === 'href' || name === 'src') && isScriptUrl(attr.value)) {
        // 貼り付け元のリンクでスクリプトが実行されないようにする
        el.removeAttribute(attr.name);
      }
    });
  }

  return doc.body.innerHTML;
}
