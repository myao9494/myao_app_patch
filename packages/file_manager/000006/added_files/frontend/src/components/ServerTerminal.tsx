/**
 * サーバーターミナルコンポーネント
 * 右ペイン下部にJupyter風の対話型ターミナルを表示し、
 * WebSocket経由でバックエンドのシェルへ接続する
 */
import { useEffect, useRef, useState } from "react";
import { RefreshCw, PlugZap, PlugZap2 } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { API_BASE_URL } from "../config";
import "./ServerTerminal.css";
import {
  buildLocalLineReplacement,
  getTerminalReconnectDelay,
  isPrintableTerminalInput,
  shouldPreventTerminalTabFocus,
} from "../utils/terminalInput";

interface ServerTerminalProps {
  leftCwd: string;
  centerCwd: string;
  requestedCwd?: string | null;
  focusRequestSeq?: number;
  isFocused?: boolean;
  onRequestFocus?: () => void;
  onEscape?: () => void;
}

type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

interface TerminalSocketMessage {
  type: string;
  data?: string;
  code?: number;
  append?: string;
  line?: string;
  localEcho?: boolean;
  cwd?: string;
}

function sendTerminalMessage(socket: WebSocket | null, payload: object): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function buildTerminalWebSocketUrl(cwd: string): string {
  const apiUrl = new URL(`${API_BASE_URL}/api/terminal/ws`, window.location.origin);
  apiUrl.protocol = apiUrl.protocol === "https:" ? "wss:" : "ws:";
  apiUrl.searchParams.set("cwd", cwd);
  return apiUrl.toString();
}

export function ServerTerminal({
  leftCwd,
  centerCwd,
  requestedCwd = null,
  focusRequestSeq = 0,
  isFocused = false,
  onRequestFocus,
  onEscape,
}: ServerTerminalProps) {
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const localEchoEnabledRef = useRef(false);
  const currentInputLineRef = useRef("");
  const cursorIndexRef = useRef(0);
  const completionPendingRef = useRef(false);
  const pendingEnterRef = useRef(false);
  const commandHistoryRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number | null>(null);
  const onEscapeRef = useRef(onEscape);
  const isFocusedRef = useRef(isFocused);
  const onRequestFocusRef = useRef(onRequestFocus);
  const handledFocusRequestSeqRef = useRef(0);
  const reconnectAttemptRef = useRef(0);
  const activeSessionCwdRef = useRef<string | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [sessionCwd, setSessionCwd] = useState(centerCwd);
  const [displayCwd, setDisplayCwd] = useState(centerCwd);
  const [reconnectGeneration, setReconnectGeneration] = useState(0);

  const blurTerminalFocus = () => {
    const helperTextarea = terminalRef.current?.querySelector(".xterm-helper-textarea");
    if (helperTextarea instanceof HTMLTextAreaElement) {
      helperTextarea.blur();
    }
  };

  useEffect(() => {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    isFocusedRef.current = isFocused;
  }, [isFocused]);

  useEffect(() => {
    onRequestFocusRef.current = onRequestFocus;
  }, [onRequestFocus]);

  const focusTerminal = () => {
    onRequestFocus?.();
    xtermRef.current?.focus();
  };

  useEffect(() => {
    if (!isFocused) {
      blurTerminalFocus();
      return;
    }

    xtermRef.current?.focus();
  }, [isFocused]);

  const replaceCurrentInputLine = (nextLine: string, nextCursorIndex = nextLine.length) => {
    const xterm = xtermRef.current;
    if (!xterm) {
      return;
    }

    const currentLine = currentInputLineRef.current;
    const currentCursor = cursorIndexRef.current;
    const moveCursorToEnd = currentLine.length > currentCursor ? `\u001B[${currentLine.length - currentCursor}C` : "";
    xterm.write(`${moveCursorToEnd}${buildLocalLineReplacement(currentLine, nextLine, nextCursorIndex)}`);
    currentInputLineRef.current = nextLine;
    cursorIndexRef.current = nextCursorIndex;
  };

  const commitCurrentInputLine = (socket: WebSocket) => {
    const line = currentInputLineRef.current;
    if (line.trim()) {
      const history = commandHistoryRef.current;
      if (history[history.length - 1] !== line) {
        history.push(line);
        if (history.length > 200) {
          history.shift();
        }
      }
    }

    historyIndexRef.current = null;
    cursorIndexRef.current = 0;
    currentInputLineRef.current = "";
    xtermRef.current?.write("\r\n");

    if (line) {
      sendTerminalMessage(socket, { type: "input", data: line });
    }
    sendTerminalMessage(socket, { type: "input", data: "\r" });
  };

  useEffect(() => {
    setSessionCwd((current) => current || centerCwd);
    setDisplayCwd((current) => current || centerCwd);
  }, [centerCwd]);

  useEffect(() => {
    if (focusRequestSeq === 0 || handledFocusRequestSeqRef.current === focusRequestSeq) {
      return;
    }

    handledFocusRequestSeqRef.current = focusRequestSeq;
    onRequestFocusRef.current?.();

    if (requestedCwd && requestedCwd !== sessionCwd) {
      setSessionCwd(requestedCwd);
      return;
    }

    xtermRef.current?.focus();
  }, [focusRequestSeq, requestedCwd, sessionCwd]);

  useEffect(() => {
    if (!terminalRef.current) {
      return;
    }

    const xterm = new Terminal({
      cursorBlink: true,
      fontFamily: '"SFMono-Regular", "Menlo", "Monaco", "Consolas", monospace',
      fontSize: 13,
      lineHeight: 1.15,
      theme: {
        background: "#111318",
        foreground: "#f4f7fb",
        cursor: "#f4f7fb",
        selectionBackground: "rgba(120, 177, 255, 0.35)",
      },
      convertEol: true,
      scrollback: 5000,
      allowTransparency: false,
    });

    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.attachCustomKeyEventHandler((event) => {
      if (
        event.key === "Escape" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        event.preventDefault();
        blurTerminalFocus();
        onEscapeRef.current?.();
        return false;
      }

      if (shouldPreventTerminalTabFocus(event)) {
        event.preventDefault();
      }
      return true;
    });
    xterm.open(terminalRef.current);
    fitAddon.fit();
    if (isFocusedRef.current) {
      xterm.focus();
    }

    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    const observer = new ResizeObserver(() => {
      fitAddon.fit();

      if (socketRef.current?.readyState === WebSocket.OPEN) {
        sendTerminalMessage(socketRef.current, {
          type: "resize",
          cols: xterm.cols,
          rows: xterm.rows,
        });
      }
    });

    observer.observe(terminalRef.current);
    resizeObserverRef.current = observer;

    return () => {
      observer.disconnect();
      resizeObserverRef.current = null;
      fitAddonRef.current = null;
      xtermRef.current = null;
      xterm.dispose();
    };
  }, []);

  useEffect(() => {
    const xterm = xtermRef.current;
    const fitAddon = fitAddonRef.current;

    if (!xterm || !fitAddon) {
      return;
    }

    const cwdChanged = activeSessionCwdRef.current !== sessionCwd;
    activeSessionCwdRef.current = sessionCwd;
    setStatus("connecting");
    localEchoEnabledRef.current = false;
    currentInputLineRef.current = "";
    cursorIndexRef.current = 0;
    completionPendingRef.current = false;
    pendingEnterRef.current = false;
    historyIndexRef.current = null;
    setDisplayCwd(sessionCwd);
    if (cwdChanged) {
      reconnectAttemptRef.current = 0;
      xterm.clear();
      xterm.writeln(`Connecting to server terminal...`);
      xterm.writeln(`cwd: ${sessionCwd}`);
      xterm.writeln("");
    }

    let socket: WebSocket | null = null;
    let dataDisposable: { dispose: () => void } | null = null;
    let resizeDisposable: { dispose: () => void } | null = null;
    let reconnectTimer: number | undefined;
    let disposed = false;
    let shellExited = false;

    // StrictModeによるuseEffectの即時クリーンアップ時にWebSocketが接続中だと
    // ブラウザがエラーを吐きViteプロキシがクラッシュするのを防ぐため、少し遅延させる
    const connectId = setTimeout(() => {
      socket = new WebSocket(buildTerminalWebSocketUrl(sessionCwd));
      socketRef.current = socket;

      dataDisposable = xterm.onData((data) => {
        if (socket && socket.readyState === WebSocket.OPEN) {
          if (!localEchoEnabledRef.current) {
            sendTerminalMessage(socket, { type: "input", data });
            return;
          }

          if (data === "\u001B[A" || data === "\u001B[B") {
            const history = commandHistoryRef.current;
            if (history.length === 0) {
              return;
            }

            let nextIndex = historyIndexRef.current;

            if (data === "\u001B[A") {
              nextIndex = nextIndex === null ? history.length - 1 : Math.max(0, nextIndex - 1);
            } else if (nextIndex !== null) {
              nextIndex = nextIndex >= history.length - 1 ? null : nextIndex + 1;
            } else {
              return;
            }

            const nextLine = nextIndex === null ? "" : history[nextIndex] ?? "";
            historyIndexRef.current = nextIndex;
            replaceCurrentInputLine(nextLine);
            return;
          }

          if (data === "\u001B[D") {
            if (cursorIndexRef.current > 0) {
              cursorIndexRef.current -= 1;
              xterm.write("\u001B[D");
            }
            return;
          }

          if (data === "\u001B[C") {
            if (cursorIndexRef.current < currentInputLineRef.current.length) {
              cursorIndexRef.current += 1;
              xterm.write("\u001B[C");
            }
            return;
          }

          if (data === "\u001B[H") {
            if (cursorIndexRef.current > 0) {
              xterm.write(`\u001B[${cursorIndexRef.current}D`);
              cursorIndexRef.current = 0;
            }
            return;
          }

          if (data === "\u001B[F") {
            const distance = currentInputLineRef.current.length - cursorIndexRef.current;
            if (distance > 0) {
              xterm.write(`\u001B[${distance}C`);
              cursorIndexRef.current = currentInputLineRef.current.length;
            }
            return;
          }

          if (data === "\u001B[3~") {
            const line = currentInputLineRef.current;
            const cursor = cursorIndexRef.current;
            if (cursor < line.length) {
              replaceCurrentInputLine(line.slice(0, cursor) + line.slice(cursor + 1), cursor);
            }
            return;
          }

          if (data === "\u007F") {
            const line = currentInputLineRef.current;
            const cursor = cursorIndexRef.current;
            if (cursor > 0) {
              replaceCurrentInputLine(line.slice(0, cursor - 1) + line.slice(cursor), cursor - 1);
            }
            return;
          }

          if (data === "\t") {
            completionPendingRef.current = true;
            sendTerminalMessage(socket, {
              type: "complete",
              line: currentInputLineRef.current,
            });
            return;
          }

          if (data === "\r") {
            if (completionPendingRef.current) {
              pendingEnterRef.current = true;
              return;
            }
            commitCurrentInputLine(socket);
            return;
          }

          if (completionPendingRef.current) {
            if (data === "\r") {
              pendingEnterRef.current = true;
            }
            return;
          }

          if (data === "\u0003") {
            xterm.write("^C\r\n");
            currentInputLineRef.current = "";
            cursorIndexRef.current = 0;
            historyIndexRef.current = null;
            sendTerminalMessage(socket, { type: "input", data });
            return;
          }

          if (isPrintableTerminalInput(data)) {
            const line = currentInputLineRef.current;
            const cursor = cursorIndexRef.current;
            const nextLine = `${line.slice(0, cursor)}${data}${line.slice(cursor)}`;
            replaceCurrentInputLine(nextLine, cursor + data.length);
          }
        }
      });

      resizeDisposable = xterm.onResize(({ cols, rows }) => {
        if (socket && socket.readyState === WebSocket.OPEN) {
          sendTerminalMessage(socket, { type: "resize", cols, rows });
        }
      });

      socket.addEventListener("open", () => {
        if (disposed) return;
        setStatus("connecting");
        fitAddon.fit();
        if (isFocusedRef.current) {
          xterm.focus();
        }
        if (socket) {
          sendTerminalMessage(socket, {
            type: "resize",
            cols: xterm.cols,
            rows: xterm.rows,
          });
        }
      });

      socket.addEventListener("message", (event) => {
        if (disposed) return;
        let payload: TerminalSocketMessage;
        try {
          payload = JSON.parse(event.data) as TerminalSocketMessage;
        } catch {
          return;
        }

        if (payload.type === "ready") {
          reconnectAttemptRef.current = 0;
          setStatus("connected");
          localEchoEnabledRef.current = Boolean(payload.localEcho);
          currentInputLineRef.current = "";
          cursorIndexRef.current = 0;
          completionPendingRef.current = false;
          pendingEnterRef.current = false;
          historyIndexRef.current = null;
          setDisplayCwd(payload.cwd ?? sessionCwd);
          return;
        }

        if (payload.type === "cwd") {
          if (payload.cwd) {
            setDisplayCwd(payload.cwd);
          }
          return;
        }

        if (payload.type === "output" && payload.data) {
          xterm.write(payload.data);
        }

        if (payload.type === "completion" && localEchoEnabledRef.current) {
          completionPendingRef.current = false;
          replaceCurrentInputLine(payload.line ?? currentInputLineRef.current);
          if (pendingEnterRef.current && socket) {
            commitCurrentInputLine(socket);
            pendingEnterRef.current = false;
          }
        }

        if (payload.type === "exit") {
          shellExited = true;
          setStatus("disconnected");
          currentInputLineRef.current = "";
          cursorIndexRef.current = 0;
          completionPendingRef.current = false;
          pendingEnterRef.current = false;
          historyIndexRef.current = null;
          xterm.writeln("");
          xterm.writeln(`[terminal exited: ${payload.code ?? 0}]`);
        }
      });

      socket.addEventListener("close", () => {
        completionPendingRef.current = false;
        pendingEnterRef.current = false;
        cursorIndexRef.current = 0;
        historyIndexRef.current = null;
        if (disposed) {
          return;
        }
        if (shellExited) {
          setStatus((current) => (current === "error" ? current : "disconnected"));
          return;
        }

        const delay = getTerminalReconnectDelay(reconnectAttemptRef.current);
        reconnectAttemptRef.current += 1;
        setStatus("connecting");
        xterm.writeln("");
        xterm.writeln(`[connection lost; reconnecting in ${delay / 1000}s]`);
        reconnectTimer = window.setTimeout(() => {
          setReconnectGeneration((current) => current + 1);
        }, delay);
      });

      socket.addEventListener("error", () => {
        if (disposed) return;
        completionPendingRef.current = false;
        pendingEnterRef.current = false;
        cursorIndexRef.current = 0;
        historyIndexRef.current = null;
        setStatus("error");
        xterm.writeln("");
        xterm.writeln("[connection error]");
      });
    }, 100);

    return () => {
      disposed = true;
      clearTimeout(connectId);
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (dataDisposable) dataDisposable.dispose();
      if (resizeDisposable) resizeDisposable.dispose();
      if (socket) {
        if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
          socket.close();
        }
      }
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
    };
  }, [sessionCwd, reconnectGeneration]);

  const reconnectAt = (cwd: string) => {
    reconnectAttemptRef.current = 0;
    if (cwd === sessionCwd) {
      setReconnectGeneration((current) => current + 1);
    } else {
      setSessionCwd(cwd);
    }
  };

  return (
    <section className="server-terminal" onMouseDown={focusTerminal}>
      <div className="server-terminal-header">
        <div className="server-terminal-title">Server Terminal</div>
        <div className={`server-terminal-status is-${status}`}>
          {status === "connected" ? <PlugZap size={14} /> : <PlugZap2 size={14} />}
          <span>{status}</span>
        </div>
        <button
          type="button"
          className="server-terminal-button"
          onClick={() => reconnectAt(leftCwd)}
          title="左ペインのパスで再接続"
        >
          <RefreshCw size={14} />
          <span>Open Left</span>
        </button>
        <button
          type="button"
          className="server-terminal-button"
          onClick={() => reconnectAt(centerCwd)}
          title="中央ペインのパスで再接続"
        >
          <RefreshCw size={14} />
          <span>Open Center</span>
        </button>
      </div>
      <div className="server-terminal-subtitle" title={displayCwd}>
        {displayCwd}
      </div>
      <div className="server-terminal-body" ref={terminalRef} onMouseDown={focusTerminal} />
    </section>
  );
}
