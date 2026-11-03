/**
 * タッチパッドの2本指の横スワイプで、履歴の戻る・進むを行うプラグイン
 * - 横スクロールできる表やコード、Excalidraw、CAD の図の上では、スクロールや移動を優先して戻る・進むにしない
 * - 戻る・進むは Obsidian のコマンドで行う（新しいタブを作らない）
 */
const { Plugin, Notice } = require('obsidian');

module.exports = class TouchpadSwipeNavPlugin extends Plugin {
    async onload() {
        console.log('Touchpad Swipe Navigation: Loading...');
        // Visual confirmation only on first load if needed, or remove for silence
        new Notice('Swipe Nav: Loaded');

        // State for swipe detection
        this.accumulatedDeltaX = 0;
        this.lastWheelTime = 0;
        this.RESET_TIMEOUT = 100; // Reset accumulation if no events
        this.TRIGGER_THRESHOLD = 550; // Increased from 1 back to 150 for natural feel
        this.COOLDOWN = 1000;
        this.lastTriggerTime = 0;

        // スクロールを抑止しないため passive 化し、通常スクロールの開始を待たせない。
        this.registerDomEvent(window, 'wheel', (e) => this.handleWheel(e), { capture: true, passive: true });
    }

    onunload() {
        console.log('Touchpad Swipe Navigation: Unloading');
    }

    handleWheel(e) {
        // Filter out vertical scrolling first
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            this.accumulatedDeltaX = 0;
            return;
        }

        if (this.isHorizontalPanTarget(e.target)) {
            this.accumulatedDeltaX = 0;
            return;
        }

        const now = Date.now();

        // Reset accumulation if too much time passed
        if (now - this.lastWheelTime > this.RESET_TIMEOUT) {
            this.accumulatedDeltaX = 0;
        }
        this.lastWheelTime = now;

        // Accumulate deltaX
        this.accumulatedDeltaX += e.deltaX;

        // Check for trigger
        if (now - this.lastTriggerTime > this.COOLDOWN) {
            if (this.accumulatedDeltaX < -this.TRIGGER_THRESHOLD) {
                new Notice("Swipe: Back");
                this.triggerBack();
                this.lastTriggerTime = now;
                this.accumulatedDeltaX = 0;
            } else if (this.accumulatedDeltaX > this.TRIGGER_THRESHOLD) {
                new Notice("Swipe: Forward");
                this.triggerForward();
                this.lastTriggerTime = now;
                this.accumulatedDeltaX = 0;
            }
        }
    }

    // 横へのスクロールや移動に使う場所か（図の上、または横にはみ出してスクロールできる要素の中）
    isHorizontalPanTarget(target) {
        for (let el = target; el && el.nodeType === 1; el = el.parentElement) {
            if (el.matches('.excalidraw, .step-viewer-embed, .step-viewer-content, canvas')) return true;
            if (el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(el).overflowX)) return true;
        }
        return false;
    }

    triggerBack() {
        this.app.commands.executeCommandById('app:go-back');
    }

    triggerForward() {
        this.app.commands.executeCommandById('app:go-forward');
    }
}
