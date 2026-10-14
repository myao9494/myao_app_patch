/**
 * タイムラインのスクロール操作
 * - 空き領域の左ドラッグ／中ボタンドラッグで、掴んで動かすようにスクロールする
 * - マウスホイールの縦方向入力で、Gantt全体を縦スクロールする
 */
import { useEffect, type RefObject } from 'react';
import { gantt } from 'dhtmlx-gantt';

const MIDDLE_BUTTON = 1;
const LEFT_BUTTON = 0;

// DHTMLXがドラッグ・クリックを処理する要素。ここから始まる左ドラッグはスクロールにしない
const DHTMLX_INTERACTIVE_SELECTOR =
  '.gantt_task_line, .gantt_task_content, .gantt_task_progress, .gantt_task_drag, .gantt_link_control, .gantt_link_point, .gantt_task_link';
const INTERACTIVE_CLASSES = [
  'gantt_task_line', 'gantt_task_content',
  'gantt_link_control', 'gantt_link_point', 'gantt_link_line',
  'gantt_task_drag',
  'gantt_hor_scroll', 'gantt_ver_scroll',
];
const INTERACTIVE_TAGS = ['circle', 'path', 'INPUT', 'TEXTAREA', 'A', 'SELECT'];
// 左側グリッドと日付ヘッダーでは、左ドラッグでのスクロールを行わない
const NON_SCROLL_AREA_SELECTOR = '.gantt_grid, .gantt_grid_scale, .gantt_task_scale';

/** 左ボタンでのドラッグスクロールを開始してよい「空き領域」かどうか */
function isEmptyTimelineArea(event: MouseEvent, container: HTMLElement): boolean {
  // DHTMLXが既にドラッグを処理中
  if ((gantt.getState() as { drag_id?: unknown }).drag_id) return false;

  // z-index の都合で event.target が背景になることがあるため、クリック位置にある全要素を調べる
  const elementsAtPoint = document.elementsFromPoint(event.clientX, event.clientY);
  if (elementsAtPoint.some((element) => element.closest(DHTMLX_INTERACTIVE_SELECTOR))) return false;

  const targetNode = event.target as Node | null;
  const target = targetNode instanceof Element ? targetNode : targetNode?.parentElement;
  if (!target) return false;

  if (target.closest(NON_SCROLL_AREA_SELECTOR)) return false;
  if (gantt.locate(event)) return false;

  for (let current: Element | null = target; current && current !== container; current = current.parentElement) {
    const element = current;
    if (
      element.closest(DHTMLX_INTERACTIVE_SELECTOR) ||
      INTERACTIVE_CLASSES.some((className) => element.classList.contains(className)) ||
      INTERACTIVE_TAGS.includes(element.tagName)
    ) {
      return false;
    }
  }
  return true;
}

export function useTimelineDragScroll(containerRef: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let startScrollX = 0;
    let startScrollY = 0;

    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== MIDDLE_BUTTON && event.button !== LEFT_BUTTON) return;
      if (event.button === LEFT_BUTTON && !isEmptyTimelineArea(event, container)) return;

      event.preventDefault();
      isDragging = true;
      startX = event.clientX;
      startY = event.clientY;
      const scrollState = gantt.getScrollState();
      startScrollX = scrollState.x;
      startScrollY = scrollState.y;
      container.style.cursor = 'grabbing';
    };

    const handleMouseMove = (event: MouseEvent) => {
      if (!isDragging) return;
      event.preventDefault();
      gantt.scrollTo(startScrollX - (event.clientX - startX), startScrollY - (event.clientY - startY));
    };

    const handleMouseUp = (event: MouseEvent) => {
      if (!isDragging) return;
      if (event.button === MIDDLE_BUTTON) event.preventDefault();
      isDragging = false;
      container.style.cursor = 'default';
    };

    container.addEventListener('mousedown', handleMouseDown, { capture: true });
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      container.removeEventListener('mousedown', handleMouseDown, { capture: true });
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [containerRef]);
}

export function useVerticalWheelScroll(containerRef: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (event: WheelEvent) => {
      if (event.defaultPrevented) return;
      // 横方向が主のスクロールはDHTMLXに任せる
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;

      const target = event.target;
      if (target instanceof Element && target.closest('.gantt_hor_scroll, .gantt_ver_scroll')) {
        return;
      }

      const scrollState = gantt.getScrollState();
      const nextY = Math.max(0, scrollState.y + event.deltaY);
      if (nextY === scrollState.y) return;

      event.preventDefault();
      gantt.scrollTo(scrollState.x, nextY);
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      container.removeEventListener('wheel', handleWheel);
    };
  }, [containerRef]);
}
