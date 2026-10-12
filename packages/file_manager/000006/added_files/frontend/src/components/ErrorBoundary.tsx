/**
 * エラーバウンダリコンポーネント
 * React コンポーネントツリー内のエラーをキャッチして適切に表示
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: "20px", color: "red" }}>
          <h2>エラーが発生しました</h2>
          <details style={{ whiteSpace: "pre-wrap" }}>
            <summary>詳細を表示</summary>
            {this.state.error?.toString()}
            <br />
            {this.state.error?.stack}
          </details>
          <button onClick={() => this.setState({ hasError: false, error: null })}>
            リトライ
          </button>
          <button onClick={() => window.location.reload()}>
            ページをリロード
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
