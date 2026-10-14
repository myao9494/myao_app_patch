/**
 * アプリケーションエントリーポイント
 * TanStack Queryのセットアップ
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setupFetchTimeout } from "./utils/fetchTimeout.ts";
import { installGlobalErrorLogging, logError } from "./utils/errorLog.ts";
import "./index.css";
import App from "./App.tsx";

// APIタイムアウトを初期化
setupFetchTimeout();
// 未処理のエラーもコンソールに出す
installGlobalErrorLogging();

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => logError(`クエリ失敗: ${JSON.stringify(query.queryKey)}`, error),
  }),
  mutationCache: new MutationCache({
    onError: (error) => logError("更新処理に失敗", error),
  }),
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60, // 1分間キャッシュ
      retry: 1,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>
);
