/**
 * 対話型ターミナルパネル (TerminalPanel.jsx)
 *
 * 仕様:
 * 1. 開いたときに xterm.js を読み込み、/api/terminal/ws へ WebSocket 接続する（cwd・実行モードを指定）。
 * 2. ready 受信でシェル名を表示し、output を描画、入力とリサイズをサーバーへ送る。
 * 3. 再起動ボタンで接続し直す。閉じる/アンマウント時は接続と端末を破棄する。
 **/

import { useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import { ChevronDown, RefreshCw, TerminalSquare } from 'lucide-react';

export function TerminalPanel({ path, pythonMode, embeddedDir }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState('offline');
  const [shellName, setShellName] = useState('terminal');
  const [dimensions, setDimensions] = useState('100×28');
  const [restartKey, setRestartKey] = useState(0);
  const terminalHostRef = useRef(null);
  const terminalRef = useRef(null);
  const fitRef = useRef(null);
  const socketRef = useRef(null);
  useEffect(() => {
    if (!open || !terminalHostRef.current) return;
    let disposed = false;
    let resizeObserver;
    let dataSubscription;
    let terminal;
    let socket;
    const workingPath = path || '.';
    Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]).then(([{ Terminal }, { FitAddon }]) => {
      if (disposed || !terminalHostRef.current) return;
      terminal = new Terminal({
        cursorBlink: true, cursorStyle: 'block', scrollback: 8000,
        fontFamily: '"SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        fontSize: 14, lineHeight: 1.25, convertEol: false,
        theme: {
          background: '#171c28', foreground: '#e5e7eb', cursor: '#a8adb8',
          cursorAccent: '#171c28', selectionBackground: '#53617a88',
          black: '#1f2430', red: '#ff657a', green: '#9dd274', yellow: '#eacb64',
          blue: '#72a7ff', magenta: '#ba8cff', cyan: '#5ccfe6', white: '#d8dee9',
          brightBlack: '#666b7a', brightRed: '#ff8b98', brightGreen: '#b8e986',
          brightYellow: '#ffe083', brightBlue: '#8fbcff', brightMagenta: '#cfa8ff',
          brightCyan: '#8be9fd', brightWhite: '#ffffff'
        }
      });
      const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(terminalHostRef.current);
      terminalRef.current = terminal; fitRef.current = fit; fit.fit();
      setDimensions(`${terminal.cols}×${terminal.rows}`);
      terminal.writeln('\x1b[90mConnecting to interactive shell…\x1b[0m');
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const params = new URLSearchParams({ cwd: workingPath, mode: pythonMode, embedded_python_dir: embeddedDir });
      socket = new WebSocket(`${protocol}//${location.host}/api/terminal/ws?${params}`);
      socketRef.current = socket; setStatus('connecting');
      let localEcho = false;
      socket.onopen = () => socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
      socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.type === 'ready') {
          localEcho = Boolean(message.localEcho); setStatus('ready'); setShellName(message.shell || 'shell');
          terminal.clear(); terminal.focus();
        } else if (message.type === 'output') terminal.write(message.data);
        else if (message.type === 'error') terminal.writeln(`\r\n\x1b[31m${message.data}\x1b[0m`);
      };
      socket.onclose = () => { setStatus('offline'); if (!disposed) terminal.writeln('\r\n\x1b[90m[terminal disconnected]\x1b[0m'); };
      socket.onerror = () => { setStatus('error'); terminal.writeln('\r\n\x1b[31m[connection error]\x1b[0m'); };
      dataSubscription = terminal.onData(data => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (localEcho) {
          if (data === '\r') terminal.write('\r\n');
          else if (data === '\x7f') terminal.write('\b \b');
          else if (!data.startsWith('\x1b')) terminal.write(data);
        }
        socket.send(JSON.stringify({ type: 'input', data }));
      });
      resizeObserver = new ResizeObserver(() => {
        if (disposed) return; fit.fit(); setDimensions(`${terminal.cols}×${terminal.rows}`);
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
      });
      resizeObserver.observe(terminalHostRef.current);
    });
    return () => {
      disposed = true; resizeObserver?.disconnect(); dataSubscription?.dispose();
      if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) socket.close();
      terminal?.dispose(); terminalRef.current = null; fitRef.current = null;
    };
  }, [open, path, pythonMode, embeddedDir, restartKey]);
  return <section className={`terminal-panel ${open ? 'open' : ''}`}>
    <div className="terminal-heading">
      <button className="terminal-title" onClick={() => setOpen(!open)}><TerminalSquare/><strong>{path ? path.split(/[\\/]/).filter(Boolean).at(-1) : 'terminal'} — {shellName} — {dimensions}</strong></button>
      <span className={`status-dot ${status}`}/>
      {open && <button className="terminal-restart" title="ターミナルを再起動" onClick={() => setRestartKey(key => key + 1)}><RefreshCw/></button>}
      <button className="terminal-toggle" onClick={() => setOpen(!open)}><ChevronDown/></button>
    </div>
    {open && <div className="terminal-content" ref={terminalHostRef}/>} 
  </section>;
}
