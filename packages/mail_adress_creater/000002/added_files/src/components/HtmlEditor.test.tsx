/**
 * HtmlEditorコンポーネントのテスト
 * 外部からの値の反映、編集内容の通知、Office HTML貼り付け時のサニタイズを確認する
 */
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { HtmlEditor } from './HtmlEditor'

const getEditor = (container: HTMLElement) => container.querySelector('[contenteditable="true"]') as HTMLElement

describe('HtmlEditor', () => {
  it('valueをエディタに反映し、外部から変わったら更新する', () => {
    const { container, rerender } = render(<HtmlEditor value="<p>最初</p>" onChange={() => {}} />)
    expect(getEditor(container).innerHTML).toBe('<p>最初</p>')

    rerender(<HtmlEditor value="<p>更新後</p>" onChange={() => {}} />)

    expect(getEditor(container).innerHTML).toBe('<p>更新後</p>')
  })

  it('フォーカスが外れたときに編集内容をHTMLとして通知する', () => {
    const onChange = vi.fn()
    const { container } = render(<HtmlEditor value="" onChange={onChange} />)
    const editor = getEditor(container)

    editor.innerHTML = '<b>太字</b>'
    fireEvent.blur(editor)

    expect(onChange).toHaveBeenCalledWith('<b>太字</b>')
  })

  it('HTMLの貼り付けはOffice固有の属性やタグを除いて挿入する', () => {
    const onChange = vi.fn()
    const { container } = render(<HtmlEditor value="" onChange={onChange} />)
    const editor = getEditor(container)
    const range = document.createRange()
    range.selectNodeContents(editor)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    const officeHtml = '<p class="MsoNormal" style="margin:0;color:red"><o:p></o:p><a href="https://example.com" class="x">リンク</a></p>'
    const notPrevented = fireEvent.paste(editor, {
      clipboardData: { getData: (type: string) => (type === 'text/html' ? officeHtml : '') },
    })

    expect(notPrevented).toBe(false)
    expect(editor.innerHTML).toBe('<p style="color: red"><a href="https://example.com">リンク</a></p>')
    expect(onChange).toHaveBeenLastCalledWith(editor.innerHTML)
  })

  it('HTMLを含まない貼り付けはブラウザの標準動作に任せる', () => {
    const { container } = render(<HtmlEditor value="" onChange={() => {}} />)

    const notPrevented = fireEvent.paste(getEditor(container), {
      clipboardData: { getData: () => '' },
    })

    expect(notPrevented).toBe(true)
  })
})
