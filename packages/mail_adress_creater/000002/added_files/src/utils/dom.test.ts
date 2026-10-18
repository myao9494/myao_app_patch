/**
 * DOM判定ユーティリティのテスト
 **/
import { describe, it, expect } from 'vitest'
import { isTextEntryTarget } from './dom'

describe('isTextEntryTarget', () => {
  it('input / textarea / select は文字入力対象', () => {
    expect(isTextEntryTarget(document.createElement('input'))).toBe(true)
    expect(isTextEntryTarget(document.createElement('textarea'))).toBe(true)
    expect(isTextEntryTarget(document.createElement('select'))).toBe(true)
  })

  it('contenteditable の要素とその子孫は文字入力対象', () => {
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    const child = document.createElement('b')
    editor.appendChild(child)
    document.body.appendChild(editor)

    expect(isTextEntryTarget(editor)).toBe(true)
    expect(isTextEntryTarget(child)).toBe(true)

    editor.remove()
  })

  it('通常の要素やnullは文字入力対象ではない', () => {
    expect(isTextEntryTarget(document.createElement('div'))).toBe(false)
    expect(isTextEntryTarget(document.createElement('button'))).toBe(false)
    expect(isTextEntryTarget(null)).toBe(false)
  })
})
