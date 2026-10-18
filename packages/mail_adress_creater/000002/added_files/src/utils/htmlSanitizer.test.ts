/**
 * HTMLサニタイザー (htmlSanitizer) のテスト
 **/
import { describe, it, expect } from 'vitest'
import { sanitizeHtml } from './htmlSanitizer'

describe('sanitizeHtml', () => {
  it('通常のクリーンなHTMLは装飾を維持すること', () => {
    const input = '<p>テスト <b>太字</b> <a href="http://example.com" target="_blank">リンク</a></p>'
    const output = sanitizeHtml(input)
    expect(output).toContain('テスト')
    expect(output).toContain('<b>太字</b>')
    expect(output).toContain('<a href="http://example.com" target="_blank">リンク</a>')
  })

  it('Word固有のXMLネームスペースタグ (o:p) は除去され、中のテキストが維持されること', () => {
    const input = '<p>段落の開始<o:p>ネームスペース内のテキスト</o:p>段落の終了</p>'
    const output = sanitizeHtml(input)
    expect(output).toContain('段落の開始')
    expect(output).toContain('ネームスペース内のテキスト')
    expect(output).toContain('段落の終了')
    expect(output).not.toContain('o:p')
  })

  it('不要なタグ (style, meta, xml, link) は完全に削除されること', () => {
    const input = `
      <html>
        <head>
          <meta charset="utf-8">
          <style>p { margin: 0; }</style>
          <xml><x:asd>123</x:asd></xml>
        </head>
        <body>
          <p>本文です</p>
        </body>
      </html>
    `
    const output = sanitizeHtml(input)
    expect(output).toContain('本文です')
    expect(output).not.toContain('<style>')
    expect(output).not.toContain('<meta>')
    expect(output).not.toContain('<xml>')
  })

  it('class属性やid属性は完全に除去されること', () => {
    const input = '<p class="MsoNormal" id="paragraph1">テスト段落</p>'
    const output = sanitizeHtml(input)
    expect(output).toContain('<p>テスト段落</p>')
    expect(output).not.toContain('class=')
    expect(output).not.toContain('id=')
  })

  it('style属性のクリーンアップが行われ、独自スタイルやfont-family, margin等は消えるが、文字色や太字指定等は維持されること', () => {
    const input = '<span style="font-family: Calibri, sans-serif; font-size: 11pt; color: #ff0000; font-weight: bold; mso-ansi-language: JA; margin: 0px;">赤い太字</span>'
    const output = sanitizeHtml(input)
    expect(output).toContain('赤い太字')
    // 許可するスタイルのみが残っていること
    expect(output).toContain('color: #ff0000')
    expect(output).toContain('font-weight: bold')
    expect(output).not.toContain('font-family')
    expect(output).not.toContain('mso-ansi-language')
    expect(output).not.toContain('margin')
  })

  it('テーブル構造 (table, tr, td, th) が正しく維持されること', () => {
    const input = '<table><tr><td colspan="2">セル1</td></tr></table>'
    const output = sanitizeHtml(input)
    expect(output).toContain('<table>')
    expect(output).toContain('<tr>')
    expect(output).toContain('<td colspan="2">セル1</td>')
  })

  it('javascript: などスクリプトを実行するURLは href / src から取り除き、通常のURLは残す', () => {
    const html = [
      '<a href="javascript:alert(1)">a</a>',
      '<a href=" JaVa\tScRiPt:alert(1)">b</a>',
      '<img src="vbscript:msgbox(1)">',
      '<a href="https://example.com/?q=javascript:">c</a>',
      '<a href="mailto:user@example.com">d</a>',
    ].join('')

    const result = sanitizeHtml(html)

    expect(result).not.toMatch(/javascript:alert|vbscript/i)
    expect(result).toContain('<a>a</a>')
    expect(result).toContain('<a>b</a>')
    expect(result).toContain('href="https://example.com/?q=javascript:"')
    expect(result).toContain('href="mailto:user@example.com"')
  })
})
