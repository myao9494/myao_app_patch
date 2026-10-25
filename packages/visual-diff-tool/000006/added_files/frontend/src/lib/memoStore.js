/**
 * 差分メモ（別タブ）の比較画像・メモ・レイアウトの保存と、メモタブの開閉。
 * 保存先は IndexedDB を基本とし、利用できない場合のみ localStorage にフォールバックする。
 * Git画像のメモIDはリポジトリとパスから決まる（同じファイルを開けば前回のメモを引き継ぐ）。
 */

const MEMO_DB_NAME = "visual-diff-memo";

const MEMO_DB_STORE = "payloads";

const MEMO_STORAGE_KEY = "visual-diff-memo-fallback";

export async function storeMemoPayload(id, payload) {
  try {
    const db = await openMemoDb();
    await idbRequest(db.transaction(MEMO_DB_STORE, "readwrite").objectStore(MEMO_DB_STORE).put({ id, payload, createdAt: Date.now() }));
  } catch {
    localStorage.setItem(`${MEMO_STORAGE_KEY}:${id}`, JSON.stringify(payload));
  }
}

export async function readMemoPayload(id) {
  if (!id) return null;
  try {
    const db = await openMemoDb();
    const record = await idbRequest(db.transaction(MEMO_DB_STORE, "readonly").objectStore(MEMO_DB_STORE).get(id));
    if (record?.payload) return record.payload;
  } catch {
    // Fall back to localStorage below.
  }
  try {
    const raw = localStorage.getItem(`${MEMO_STORAGE_KEY}:${id}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

let memoDbPromise = null;

// 接続は1つを使い回す（呼び出しごとに indexedDB.open すると接続が溜まり続けるため）。
function openMemoDb() {
  if (!memoDbPromise) {
    memoDbPromise = openMemoDbConnection().catch((error) => {
      memoDbPromise = null; // 失敗した場合は次回に再試行する
      throw error;
    });
  }
  return memoDbPromise;
}

function openMemoDbConnection() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("IndexedDB is not available"));
      return;
    }
    const request = indexedDB.open(MEMO_DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(MEMO_DB_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => {
      const db = request.result;
      // ブラウザ側で閉じられた接続は使い回さない
      db.onclose = () => { memoDbPromise = null; };
      db.onversionchange = () => { db.close(); memoDbPromise = null; };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("Could not open memo storage"));
  });
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Memo storage request failed"));
  });
}

export function memoPayloadIdFromHash() {
  const [, id] = window.location.hash.match(/^#diff-memo\/(.+)$/) ?? [];
  return id ? decodeURIComponent(id) : null;
}

export async function openDiffMemoTab(result, left, right, onError, fixedId = null, extraPayload = {}) {
  const id = fixedId ?? (crypto.randomUUID?.() ?? String(Date.now()));
  const existing = fixedId ? await readMemoPayload(id) : null;
  const payload = {
    imageA: result.image_a,
    imageB: result.image_b_aligned,
    nameA: left?.file?.name,
    nameB: right?.file?.name,
    notes: existing?.notes ?? [],
    stickies: existing?.stickies ?? [],
    stageSize: existing?.stageSize ?? null,
    memoZoom: existing?.memoZoom ?? 100,
    memoImageScale: existing?.memoImageScale ?? 100,
    memoGeometryVersion: existing?.memoGeometryVersion ?? null,
    reportOptions: existing?.reportOptions ?? null,
    ...extraPayload,
  };
  try {
    await storeMemoPayload(id, payload);
    window.open(`${window.location.origin}${window.location.pathname}${window.location.search}#diff-memo/${id}`, "_blank");
  } catch (err) {
    onError?.(`差分メモを開けませんでした: ${err.message}`);
  }
}

export async function openStoredMemoTab(id) {
  const stored = await readMemoPayload(id);
  if (stored) await storeMemoPayload(id, { ...stored, reportPreviewReturn: true });
  window.open(`${window.location.origin}${window.location.pathname}${window.location.search}#diff-memo/${encodeURIComponent(id)}`, "_blank");
}

export function returnToReportPreview() {
  if (window.opener && !window.opener.closed) {
    window.opener.focus();
    window.close();
    return;
  }
  window.location.href = `${window.location.origin}${window.location.pathname}${window.location.search}`;
}

export function gitMemoKey(repo, path) {
  return `${repo || "repo"}::${path}`;
}

export function gitImageMemoId(repo, path) {
  const source = gitMemoKey(repo, path);
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `git-image-${(hash >>> 0).toString(16)}`;
}
