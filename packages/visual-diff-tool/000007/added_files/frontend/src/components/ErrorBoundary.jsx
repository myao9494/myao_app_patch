/**
 * 想定外のエラーを受け止める部品。
 * - ErrorBoundary: 描画中のエラーで画面全体が真っ白になるのを防ぎ、案内と復旧ボタンを出す。
 *   resetKey が変わると自動で復旧する（別のファイルを選べば続けて使える）
 * - GlobalErrorNotice: ボタン操作や非同期処理のエラーは ErrorBoundary に届かず、
 *   無反応に見えるため、画面下に通知する
 */
import React, { useEffect, useState } from "react";
import { AlertTriangle, RefreshCw, RotateCcw, X } from "lucide-react";
import { describeError, shouldIgnoreGlobalError } from "../lib/errors.js";

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.retry = this.retry.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("画面の表示中にエラーが発生しました", error, info?.componentStack);
  }

  componentDidUpdate(previousProps) {
    if (this.state.error && previousProps.resetKey !== this.props.resetKey) this.retry();
  }

  retry() {
    this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <section className={`error-fallback ${this.props.fullPage ? "full-page" : ""}`} role="alert">
        <AlertTriangle size={28} />
        <strong>{this.props.title ?? "表示中に問題が発生しました"}</strong>
        <p>{this.props.hint ?? "もう一度試すか、ページを再読み込みしてください。保存済みのファイルやメモはそのまま残っています。"}</p>
        <div className="error-fallback-actions">
          <button type="button" className="btn btn-primary" onClick={this.retry}>
            <RotateCcw size={15} />
            もう一度試す
          </button>
          <button type="button" className="btn" onClick={() => window.location.reload()}>
            <RefreshCw size={15} />
            ページを再読み込み
          </button>
        </div>
        <details>
          <summary>エラーの内容</summary>
          <code>{describeError(error)}</code>
        </details>
      </section>
    );
  }
}

export function GlobalErrorNotice() {
  const [message, setMessage] = useState("");

  useEffect(() => {
    const show = (error) => {
      if (!shouldIgnoreGlobalError(error)) setMessage(describeError(error));
    };
    const handleError = (event) => show(event.error ?? event.message);
    const handleRejection = (event) => show(event.reason);
    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleRejection);
    return () => {
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleRejection);
    };
  }, []);

  if (!message) return null;
  return (
    <div className="banner error global-error-notice" role="alert">
      <AlertTriangle size={16} />
      <span>予期しないエラーが発生しました: {message}</span>
      <button type="button" aria-label="閉じる" onClick={() => setMessage("")}><X size={14} /></button>
    </div>
  );
}
