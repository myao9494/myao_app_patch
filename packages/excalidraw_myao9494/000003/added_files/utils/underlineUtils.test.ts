/**
 * アンダーライン（赤色下線）機能のテスト
 * 
 * 仕様:
 * 1. createUnderlineElement:
 *    - テキスト要素を受け取り、その下端直下（Y座標: y + height + 2）に赤色の直線要素（line）を生成する。
 *    - 線の色は赤色（#e03131）、太さは2、手書き風の粗さroughnessは1、opacityは100。
 *    - pointsは [[0, 0], [width, 0]] となり、矢印ヘッド（startArrowhead, endArrowhead）はnull。
 *    - customData: { underlineFor: textElement.id } が設定される。
 * 
 * 2. toggleUnderlineForElements:
 *    - 選択されたテキスト要素にアンダーラインがない場合、下線を生成して同一のgroupIdでグループ化する。
 *    - すでにアンダーラインが存在する場合（トグル）、そのアンダーライン要素を削除してグループを解除する。
 *    - 選択要素がない場合はシーン要素をそのまま返す。
 * 
 * 3. sendUnderlineWithOverlappingText:
 *    - 手動で描画された下線がテキスト要素と近接・重なっている場合、同一のgroupIdでグループ化する。
 */

import { describe, it, expect } from 'vitest';
import type { NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import {
  createUnderlineElement,
  toggleUnderlineForElements,
  isUnderlineElement,
  sendUnderlineWithOverlappingText,
  UNDERLINE_COLOR,
} from './underlineUtils';

describe('underlineUtils', () => {
  const createMockTextElement = (overrides?: Partial<NonDeletedExcalidrawElement>): NonDeletedExcalidrawElement => ({
    id: 'text-1',
    type: 'text',
    x: 100,
    y: 200,
    width: 120,
    height: 40,
    angle: 0,
    strokeColor: '#000000',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: 12345,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    text: 'あいうえお',
    fontSize: 24,
    fontFamily: 1,
    textAlign: 'left',
    verticalAlign: 'top',
    containerId: null,
    originalText: 'あいうえお',
    autoResize: true,
    lineHeight: 1.25 as any,
    index: 'a1' as any,
    ...overrides,
  });

  describe('createUnderlineElement', () => {
    it('テキスト要素の下端に赤色直線アンダーライン要素を生成する', () => {
      const text = createMockTextElement();
      const line = createUnderlineElement(text);

      expect(line.type).toBe('line');
      expect(line.strokeColor).toBe(UNDERLINE_COLOR);
      expect(line.strokeWidth).toBe(2);
      expect(line.strokeStyle).toBe('solid');
      expect(line.roughness).toBe(1);
      expect(line.opacity).toBe(100);

      // 直線の座標と寸法
      expect(line.x).toBe(text.x);
      expect(line.y).toBeCloseTo(text.y + text.height + 2, 1);
      expect(line.width).toBe(text.width);
      expect((line as any).points).toEqual([
        [0, 0],
        [text.width, 0],
      ]);
      expect((line as any).startArrowhead).toBeNull();
      expect((line as any).endArrowhead).toBeNull();

      // 紐付けデータ
      expect(line.customData).toEqual({ underlineFor: text.id });
    });

    it('カスタムオフセットとパディングを反映できる', () => {
      const text = createMockTextElement();
      const line = createUnderlineElement(text, { paddingX: 4, yOffset: 6, strokeWidth: 3 });

      expect(line.x).toBe(text.x - 4);
      expect(line.width).toBe(text.width + 8);
      expect(line.y).toBeCloseTo(text.y + text.height + 6, 1);
      expect(line.strokeWidth).toBe(3);
      expect((line as any).points).toEqual([
        [0, 0],
        [text.width + 8, 0],
      ]);
    });
  });

  describe('isUnderlineElement', () => {
    it('アンダーライン要素を正しく識別する', () => {
      const text = createMockTextElement();
      const line = createUnderlineElement(text);

      expect(isUnderlineElement(line)).toBe(true);
      expect(isUnderlineElement(text)).toBe(false);
    });
  });

  describe('toggleUnderlineForElements', () => {
    it('アンダーラインのないテキスト要素に対して下線を生成し、グループ化する', () => {
      const text = createMockTextElement();
      const elements: readonly NonDeletedExcalidrawElement[] = [text];
      const selectedIds = { [text.id]: true };

      const { updatedElements, createdUnderlineIds } = toggleUnderlineForElements(elements, selectedIds);

      expect(updatedElements.length).toBe(2);
      expect(createdUnderlineIds.length).toBe(1);

      const updatedText = updatedElements[0];
      const line = updatedElements[1];

      expect(line.id).toBe(createdUnderlineIds[0]);
      expect(isUnderlineElement(line)).toBe(true);
      expect(updatedText.id).toBe(text.id);

      // 同一のグループIDが付与されていること
      expect(line.groupIds.length).toBe(1);
      expect(updatedText.groupIds.length).toBe(1);
      expect(line.groupIds[0]).toBe(updatedText.groupIds[0]);
    });

    it('すでにアンダーラインが存在するテキスト要素に対してトグル実行すると下線を削除する', () => {
      const text = createMockTextElement();
      const elements: readonly NonDeletedExcalidrawElement[] = [text];
      const selectedIds = { [text.id]: true };

      // 1回目（追加）
      const firstResult = toggleUnderlineForElements(elements, selectedIds);
      expect(firstResult.updatedElements.length).toBe(2);

      // 2回目（削除）
      const secondResult = toggleUnderlineForElements(firstResult.updatedElements, selectedIds);
      expect(secondResult.updatedElements.length).toBe(1);
      expect(secondResult.updatedElements[0].id).toBe(text.id);
      expect(secondResult.createdUnderlineIds.length).toBe(0);
    });
  });

  describe('sendUnderlineWithOverlappingText', () => {
    it('手動で描画された下線がテキスト要素と近接している場合、グループ化する', () => {
      const text = createMockTextElement({ id: 'text-1', x: 100, y: 100, width: 100, height: 40 });
      const line: NonDeletedExcalidrawElement = {
        id: 'line-manual',
        type: 'line',
        x: 95,
        y: 142, // テキスト下端(140)付近
        width: 110,
        height: 2,
        angle: 0,
        strokeColor: UNDERLINE_COLOR,
        backgroundColor: 'transparent',
        fillStyle: 'solid',
        strokeWidth: 2,
        strokeStyle: 'solid',
        roughness: 1,
        opacity: 100,
        groupIds: [],
        frameId: null,
        roundness: null,
        seed: 999,
        version: 1,
        versionNonce: 1,
        isDeleted: false,
        boundElements: null,
        updated: 1,
        link: null,
        locked: false,
        customData: {},
        index: 'a2' as any,
      };

      const initialElements = [text, line];
      const updatedElements = sendUnderlineWithOverlappingText(initialElements, line.id);

      expect(updatedElements[0].groupIds.length).toBeGreaterThan(0);
      expect(updatedElements[1].groupIds).toContain(updatedElements[0].groupIds[0]);
    });
  });
});
