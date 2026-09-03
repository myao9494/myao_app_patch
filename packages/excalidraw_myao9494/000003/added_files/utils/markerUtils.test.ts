/**
 * マーカー（テキストハイライト）機能のテスト
 * 
 * 仕様:
 * 1. createMarkerElement:
 *    - テキスト要素を受け取り、その下半分に重なるマーカー要素（rectangle）を生成する。
 *    - マーカーはテキストの幅 + 左右余白を持ち、テキスト下部（Y座標 y + height * 0.55 付近、高さ height * 0.45 付近）に配置される。
 *    - マーカーの背景色は淡い黄色（#fef08a）、枠線は透明（transparent）、塗りつぶしはsolid、粗さroughnessは1（手書き風）、角丸roundnessはtype 3。
 *    - マーカーには customData: { markerFor: textElement.id } が設定される。
 * 
 * 2. toggleMarkerForElements:
 *    - 選択されたテキスト要素にマーカーがない場合、テキストの直前（背面）にマーカー要素を挿入し、同一のgroupIdでグループ化する。
 *    - すでにマーカーが存在する場合（トグル）、そのマーカー要素を削除してグループを解除する。
 *    - テキスト以外の要素が選択されている場合や何も選択されていない場合はシーン要素をそのまま返す。
 */

import { describe, it, expect } from 'vitest';
import type { NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import {
  createMarkerElement,
  toggleMarkerForElements,
  isMarkerElement,
  sendMarkerBehindOverlappingText,
  MARKER_COLOR,
} from './markerUtils';

describe('markerUtils', () => {
  // テスト用のテキスト要素
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

  describe('createMarkerElement', () => {
    it('テキスト要素の下半分に重なるマーカー要素を生成する', () => {
      const text = createMockTextElement();
      const marker = createMarkerElement(text);

      expect(marker.type).toBe('rectangle');
      expect(marker.backgroundColor).toBe(MARKER_COLOR);
      expect(marker.strokeColor).toBe('transparent');
      expect(marker.fillStyle).toBe('solid');
      expect(marker.roughness).toBe(1);
      expect(marker.roundness).toEqual({ type: 3 });
      expect(marker.opacity).toBe(50);

      // マーカーのY座標はテキストの下半分（y + height * 0.55）付近
      expect(marker.y).toBeCloseTo(text.y + text.height * 0.55, 1);
      // マーカーの高さはテキスト高さの約45%
      expect(marker.height).toBeCloseTo(text.height * 0.45, 1);
      // マーカーの幅はテキスト幅より左右パディング分広い
      expect(marker.width).toBeGreaterThan(text.width);
      expect(marker.x).toBeLessThan(text.x);

      // 紐付けデータ
      expect(marker.customData).toEqual({ markerFor: text.id });
    });

    it('カスタムパディングとオフセット、透明度を反映できる', () => {
      const text = createMockTextElement();
      const marker = createMarkerElement(text, { paddingX: 10, yOffsetRatio: 0.6, heightRatio: 0.4, opacity: 70 });

      expect(marker.x).toBe(text.x - 10);
      expect(marker.width).toBe(text.width + 20);
      expect(marker.y).toBeCloseTo(text.y + text.height * 0.6, 1);
      expect(marker.height).toBeCloseTo(text.height * 0.4, 1);
      expect(marker.opacity).toBe(70);
    });
  });

  describe('isMarkerElement', () => {
    it('マーカー要素を正しく識別する', () => {
      const text = createMockTextElement();
      const marker = createMarkerElement(text);

      expect(isMarkerElement(marker)).toBe(true);
      expect(isMarkerElement(text)).toBe(false);
    });
  });

  describe('toggleMarkerForElements', () => {
    it('マーカーのないテキスト要素に対してマーカーを背面に生成し、グループ化する', () => {
      const text = createMockTextElement();
      const elements: readonly NonDeletedExcalidrawElement[] = [text];
      const selectedIds = { [text.id]: true };

      const { updatedElements, createdMarkerIds } = toggleMarkerForElements(elements, selectedIds);

      expect(updatedElements.length).toBe(2);
      expect(createdMarkerIds.length).toBe(1);

      const marker = updatedElements[0];
      const updatedText = updatedElements[1];

      // マーカーがテキストの直前（背面）に配置されていること
      expect(marker.id).toBe(createdMarkerIds[0]);
      expect(isMarkerElement(marker)).toBe(true);
      expect(updatedText.id).toBe(text.id);

      // 同一のグループIDが付与されていること
      expect(marker.groupIds.length).toBe(1);
      expect(updatedText.groupIds.length).toBe(1);
      expect(marker.groupIds[0]).toBe(updatedText.groupIds[0]);
    });

    it('すでにマーカーが存在するテキスト要素に対してトグル実行するとマーカーを削除する', () => {
      const text = createMockTextElement();
      const elements: readonly NonDeletedExcalidrawElement[] = [text];
      const selectedIds = { [text.id]: true };

      // 1回目の実行（マーカー付加）
      const firstResult = toggleMarkerForElements(elements, selectedIds);
      expect(firstResult.updatedElements.length).toBe(2);

      // 2回目の実行（トグル解除）
      const secondResult = toggleMarkerForElements(firstResult.updatedElements, selectedIds);
      expect(secondResult.updatedElements.length).toBe(1);
      expect(secondResult.updatedElements[0].id).toBe(text.id);
      expect(secondResult.createdMarkerIds.length).toBe(0);
    });

    it('選択された要素がない場合は元の要素配列をそのまま返す', () => {
      const text = createMockTextElement();
      const elements: readonly NonDeletedExcalidrawElement[] = [text];
      const selectedIds = {};

      const result = toggleMarkerForElements(elements, selectedIds);
      expect(result.updatedElements).toBe(elements);
      expect(result.createdMarkerIds.length).toBe(0);
    });
  });

  describe('sendMarkerBehindOverlappingText', () => {
    it('手動で描画されたマーカーがテキスト要素と重なっている場合、テキストの背面に移動する', () => {
      const text = createMockTextElement({ id: 'text-1', x: 100, y: 100, width: 100, height: 40 });
      // マーカーがテキストの後に描画され、配列の末尾（最前面）にある状態
      const marker: NonDeletedExcalidrawElement = {
        id: 'marker-manual',
        type: 'rectangle',
        x: 90,
        y: 110,
        width: 120,
        height: 25,
        angle: 0,
        strokeColor: 'transparent',
        backgroundColor: MARKER_COLOR,
        fillStyle: 'solid',
        strokeWidth: 1,
        strokeStyle: 'solid',
        roughness: 1,
        opacity: 100,
        groupIds: [],
        frameId: null,
        roundness: { type: 3 },
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

      // 最初は [text, marker] の順（markerが手前）
      const initialElements = [text, marker];
      const updatedElements = sendMarkerBehindOverlappingText(initialElements, marker.id);

      // マーカーがテキストの直前（背面）に移動し、[marker, text] の順になること
      expect(updatedElements[0].id).toBe(marker.id);
      expect(updatedElements[1].id).toBe(text.id);

      // マーカーとテキストが同一のgroupIdでグループ化されること
      expect(updatedElements[0].groupIds.length).toBeGreaterThan(0);
      expect(updatedElements[1].groupIds).toContain(updatedElements[0].groupIds[0]);
    });

    it('重なるテキスト要素がない場合、要素順序を変更しない', () => {
      const text = createMockTextElement({ id: 'text-1', x: 500, y: 500, width: 100, height: 40 });
      const marker: NonDeletedExcalidrawElement = {
        id: 'marker-separate',
        type: 'rectangle',
        x: 10,
        y: 10,
        width: 100,
        height: 30,
        angle: 0,
        strokeColor: 'transparent',
        backgroundColor: MARKER_COLOR,
        fillStyle: 'solid',
        strokeWidth: 1,
        strokeStyle: 'solid',
        roughness: 1,
        opacity: 100,
        groupIds: [],
        frameId: null,
        roundness: { type: 3 },
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

      const initialElements = [text, marker];
      const updatedElements = sendMarkerBehindOverlappingText(initialElements, marker.id);

      expect(updatedElements[0].id).toBe(text.id);
      expect(updatedElements[1].id).toBe(marker.id);
    });
  });
});
