/**
 * エントリポイント。URLに応じてメイン画面・差分メモ画面・API説明ページを切り替える。
 */
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./theme.css";
import "./styles.css";
import { ApiGuideApp } from "./api-guide/ApiGuideApp.jsx";
import { App } from "./app/App.jsx";
import { MemoDiffApp } from "./memo/MemoDiffApp.jsx";

function Root() {
  const [route, setRoute] = useState({ hash: window.location.hash, pathname: window.location.pathname });
  useEffect(() => {
    const updateRoute = () => setRoute({ hash: window.location.hash, pathname: window.location.pathname });
    const originalPushState = window.history.pushState;
    const originalReplaceState = window.history.replaceState;
    window.history.pushState = function pushState(...args) {
      originalPushState.apply(this, args);
      updateRoute();
    };
    window.history.replaceState = function replaceState(...args) {
      originalReplaceState.apply(this, args);
      updateRoute();
    };
    const onHashChange = updateRoute;
    const onPopState = updateRoute;
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener("popstate", onPopState);
    return () => {
      window.history.pushState = originalPushState;
      window.history.replaceState = originalReplaceState;
      window.removeEventListener("hashchange", onHashChange);
      window.removeEventListener("popstate", onPopState);
    };
  }, []);
  if (route.pathname === "/api-guide") return <ApiGuideApp />;
  return route.hash.startsWith("#diff-memo") ? <MemoDiffApp /> : <App />;
}

createRoot(document.getElementById("root")).render(<Root />);
