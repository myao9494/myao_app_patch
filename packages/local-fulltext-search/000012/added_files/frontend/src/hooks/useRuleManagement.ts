/**
 * 検索ルール管理（除外キーワード・類似語・インデックス対象の拡張子）の状態と操作。
 * - 除外キーワードと類似語は下書きを編集し、変更から少し後に自動で保存する。編集は元に戻す / やり直しができる。
 * - 拡張子は、標準の拡張子と利用者が追加した拡張子（本文も検索 / ファイル名だけ検索）を選び、保存ボタンで保存する。
 * - キーボード操作（追加・削除・元に戻す）は、検索ルール管理画面を開いているときだけ有効にする。
 */
import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import { updateAppSettings } from "../api/client";
import { DEFAULT_EXCLUDE_KEYWORDS, DEFAULT_SYNONYM_GROUPS } from "../appDefaults";
import type { RuleContextMenu, RuleKind, RuleSnapshot } from "../appTypes";
import { normalizeExtensionToken } from "../extensionFilter";
import {
  DEFAULT_INDEX_EXTENSIONS,
  buildAvailableExtensions,
  normalizeCustomExtensions,
  normalizeIndexExtensions,
  parseExtensionText,
} from "../indexExtensions";
import { normalizeExcludeKeywords, normalizeSynonymGroups } from "../settingsNormalization";
import type { AppSettings } from "../types";

type UseRuleManagementDeps = {
  confirmIndexDeletion: boolean;
  isRuleManagementPage: boolean;
  setErrorMessage: React.Dispatch<React.SetStateAction<string>>;
  setNoticeMessage: React.Dispatch<React.SetStateAction<string>>;
};

export function useRuleManagement({
  confirmIndexDeletion,
  isRuleManagementPage,
  setErrorMessage,
  setNoticeMessage,
}: UseRuleManagementDeps) {
  const [savedExcludeKeywords, setSavedExcludeKeywords] = useState(DEFAULT_EXCLUDE_KEYWORDS);
  const [excludeKeywordsDraft, setExcludeKeywordsDraft] = useState(DEFAULT_EXCLUDE_KEYWORDS);
  const [savedSynonymGroups, setSavedSynonymGroups] = useState(DEFAULT_SYNONYM_GROUPS);
  const [synonymGroupsDraft, setSynonymGroupsDraft] = useState(DEFAULT_SYNONYM_GROUPS);
  const [excludeRuleFilterText, setExcludeRuleFilterText] = useState("");
  const [synonymRuleFilterText, setSynonymRuleFilterText] = useState("");
  const [newExcludeKeyword, setNewExcludeKeyword] = useState("");
  const [newSynonymGroup, setNewSynonymGroup] = useState("");
  const [newSynonymDesc, setNewSynonymDesc] = useState("");
  const [editingExcludeKeyword, setEditingExcludeKeyword] = useState<string | null>(null);
  const [editingExcludeKeywordValue, setEditingExcludeKeywordValue] = useState("");
  const [editingSynonymGroup, setEditingSynonymGroup] = useState<string | null>(null);
  const [editingSynonymGroupValue, setEditingSynonymGroupValue] = useState("");
  const [ruleContextMenu, setRuleContextMenu] = useState<RuleContextMenu | null>(null);
  const [draggedRule, setDraggedRule] = useState<{ kind: RuleKind; item: string } | null>(null);
  const [isRuleAddModalOpen, setIsRuleAddModalOpen] = useState(false);
  const [ruleAddKind, setRuleAddKind] = useState<RuleKind>("exclude");
  const [activeRuleKind, setActiveRuleKind] = useState<RuleKind>("exclude");
  const [selectedRuleItem, setSelectedRuleItem] = useState<{ kind: RuleKind; item: string } | null>(null);
  const [savedCustomContentExtensions, setSavedCustomContentExtensions] = useState<string[]>([]);
  const [customContentExtensions, setCustomContentExtensions] = useState<string[]>([]);
  const [savedCustomFilenameExtensions, setSavedCustomFilenameExtensions] = useState<string[]>([]);
  const [customFilenameExtensions, setCustomFilenameExtensions] = useState<string[]>([]);
  const [newContentExtension, setNewContentExtension] = useState("");
  const [newFilenameExtension, setNewFilenameExtension] = useState("");
  const [selectedIndexExtensions, setSelectedIndexExtensions] = useState<string[]>(DEFAULT_INDEX_EXTENSIONS);
  const [savedIndexExtensions, setSavedIndexExtensions] = useState<string[]>(DEFAULT_INDEX_EXTENSIONS);
  const [extensionRuleFilterText, setExtensionRuleFilterText] = useState("");
  const [isSavingExcludeKeywords, setIsSavingExcludeKeywords] = useState(false);
  const [isSavingSynonymGroups, setIsSavingSynonymGroups] = useState(false);
  const [isSavingIndexExtensions, setIsSavingIndexExtensions] = useState(false);
  const ruleHistoryRef = useRef<RuleSnapshot[]>([]);
  const ruleHistoryIndexRef = useRef(-1);
  const availableIndexExtensions = buildAvailableExtensions(customContentExtensions, customFilenameExtensions);
  const normalizedExcludeKeywordsDraft = normalizeExcludeKeywords(excludeKeywordsDraft);
  const hasUnsavedExcludeKeywords = normalizedExcludeKeywordsDraft !== savedExcludeKeywords;
  const normalizedSynonymGroupsDraft = normalizeSynonymGroups(synonymGroupsDraft);
  const hasUnsavedSynonymGroups = normalizedSynonymGroupsDraft !== savedSynonymGroups;
  const hasUnsavedIndexExtensions =
    selectedIndexExtensions.join(" ") !== savedIndexExtensions.join(" ") ||
    customContentExtensions.join(" ") !== savedCustomContentExtensions.join(" ") ||
    customFilenameExtensions.join(" ") !== savedCustomFilenameExtensions.join(" ");
  const excludeKeywordEntries = normalizedExcludeKeywordsDraft.split("\n").filter(Boolean);
  const synonymGroupEntries = normalizedSynonymGroupsDraft.split("\n").filter(Boolean);
  const filteredExcludeKeywordEntries = excludeKeywordEntries.filter((item) => item.toLowerCase().includes(excludeRuleFilterText.trim().toLowerCase()));
  const filteredSynonymGroupEntries = synonymGroupEntries.filter((item) => item.toLowerCase().includes(synonymRuleFilterText.trim().toLowerCase()));
  const normalizedExtensionFilter = extensionRuleFilterText.trim().toLowerCase();
  const filteredStandardExtensions = !normalizedExtensionFilter
    ? DEFAULT_INDEX_EXTENSIONS
    : DEFAULT_INDEX_EXTENSIONS.filter((ext) => ext.toLowerCase().includes(normalizedExtensionFilter));
  const filteredCustomContentExtensions = !normalizedExtensionFilter
    ? customContentExtensions
    : customContentExtensions.filter((ext) => ext.toLowerCase().includes(normalizedExtensionFilter));
  const filteredCustomFilenameExtensions = !normalizedExtensionFilter
    ? customFilenameExtensions
    : customFilenameExtensions.filter((ext) => ext.toLowerCase().includes(normalizedExtensionFilter));
  const excludeKeywordSet = new Set(excludeKeywordEntries.map((item) => item.toLowerCase()));

  /** 検索ルールの変更を履歴へ積み、Ctrl+Z / Ctrl+Shift+Z の対象にする。 */
  function applyRuleChanges(nextExcludeKeywords: string, nextSynonymGroups: string): void {
    const current: RuleSnapshot = {
      excludeKeywords: normalizedExcludeKeywordsDraft,
      synonymGroups: normalizedSynonymGroupsDraft,
    };
    const next: RuleSnapshot = {
      excludeKeywords: normalizeExcludeKeywords(nextExcludeKeywords),
      synonymGroups: normalizeSynonymGroups(nextSynonymGroups),
    };
    if (current.excludeKeywords === next.excludeKeywords && current.synonymGroups === next.synonymGroups) return;
    if (ruleHistoryIndexRef.current < 0) {
      ruleHistoryRef.current = [current];
      ruleHistoryIndexRef.current = 0;
    }
    ruleHistoryRef.current = ruleHistoryRef.current.slice(0, ruleHistoryIndexRef.current + 1);
    ruleHistoryRef.current.push(next);
    ruleHistoryIndexRef.current += 1;
    setExcludeKeywordsDraft(next.excludeKeywords);
    setSynonymGroupsDraft(next.synonymGroups);
  }

  /** 最後の検索ルール変更を取り消す。 */
  function handleUndoRuleChange(): void {
    if (ruleHistoryIndexRef.current <= 0) return;
    ruleHistoryIndexRef.current -= 1;
    const snapshot = ruleHistoryRef.current[ruleHistoryIndexRef.current];
    setExcludeKeywordsDraft(snapshot.excludeKeywords);
    setSynonymGroupsDraft(snapshot.synonymGroups);
    setNoticeMessage("検索ルールの変更を取り消しました。自動保存します。");
  }

  /** 取り消した検索ルール変更をやり直す。 */
  function handleRedoRuleChange(): void {
    if (ruleHistoryIndexRef.current >= ruleHistoryRef.current.length - 1) return;
    ruleHistoryIndexRef.current += 1;
    const snapshot = ruleHistoryRef.current[ruleHistoryIndexRef.current];
    setExcludeKeywordsDraft(snapshot.excludeKeywords);
    setSynonymGroupsDraft(snapshot.synonymGroups);
    setNoticeMessage("検索ルールの変更をやり直しました。自動保存します。");
  }

  /** 同じ種類のルールをドラッグ先へ移動し、表示順も保存対象にする。 */
  function handleMoveRuleItem(kind: RuleKind, sourceItem: string, targetItem: string): void {
    if (sourceItem === targetItem) return;
    const sourceEntries = kind === "exclude" ? excludeKeywordEntries : synonymGroupEntries;
    const fromIndex = sourceEntries.indexOf(sourceItem);
    const toIndex = sourceEntries.indexOf(targetItem);
    if (fromIndex < 0 || toIndex < 0) return;
    const nextEntries = [...sourceEntries];
    const [moved] = nextEntries.splice(fromIndex, 1);
    nextEntries.splice(toIndex, 0, moved);
    if (kind === "exclude") {
      applyRuleChanges(nextEntries.join("\n"), normalizedSynonymGroupsDraft);
    } else {
      applyRuleChanges(normalizedExcludeKeywordsDraft, nextEntries.join("\n"));
    }
  }

  /** 右クリックメニューから、確認を経てルールを削除する。 */
  function handleDeleteRuleItem(kind: RuleKind, item: string): void {
    setRuleContextMenu(null);
    if (!window.confirm("本当に削除しますか？")) return;
    setSelectedRuleItem((current) => current?.kind === kind && current.item === item ? null : current);
    if (kind === "exclude") {
      applyRuleChanges(excludeKeywordEntries.filter((entry) => entry !== item).join("\n"), normalizedSynonymGroupsDraft);
    } else {
      applyRuleChanges(normalizedExcludeKeywordsDraft, synonymGroupEntries.filter((entry) => entry !== item).join("\n"));
    }
  }

  /** 見出しの追加ボタンから、対象リスト専用の入力ポップアップを開く。 */
  function handleOpenRuleAddModal(kind: RuleKind): void {
    setActiveRuleKind(kind);
    setRuleAddKind(kind);
    setIsRuleAddModalOpen(true);
  }

  /** ポップアップの入力を追加し、成功時だけ閉じる。 */
  function handleSubmitRuleAdd(): void {
    const added = ruleAddKind === "exclude" ? handleAddExcludeKeyword() : handleAddSynonymGroup();
    if (added) setIsRuleAddModalOpen(false);
  }

  /** 除外キーワードを重複なく下書きへ追加する。 */
  function handleAddExcludeKeyword(): boolean {
    const keyword = newExcludeKeyword.trim();
    if (!keyword) return false;
    if (excludeKeywordSet.has(keyword.toLowerCase())) {
      setNoticeMessage(`「${keyword}」は除外リストに登録済みです。`);
      return false;
    }
    applyRuleChanges([...excludeKeywordEntries, keyword].join("\n"), normalizedSynonymGroupsDraft);
    setNewExcludeKeyword("");
    setNoticeMessage(`「${keyword}」を追加しました。自動保存します。`);
    return true;
  }

  /** 類似語・専門用語グループを正規化して下書きへ追加し、語の重複や除外語との競合を知らせる。 */
  function handleAddSynonymGroup(): boolean {
    const rawInput = newSynonymDesc.trim()
      ? `${newSynonymGroup}:${newSynonymDesc.trim()}`
      : newSynonymGroup;
    const group = normalizeSynonymGroups(rawInput);
    if (!group) return false;
    const termsPart = group.includes(":") ? group.split(":")[0] : group;
    const tokens = termsPart.split(",").map((item) => item.toLowerCase());
    const registeredTokens = new Set(
      synonymGroupEntries.flatMap((item) => (item.includes(":") ? item.split(":")[0] : item).split(",").map((token) => token.toLowerCase()))
    );
    const duplicatedToken = tokens.find((item) => registeredTokens.has(item));
    if (duplicatedToken) {
      setNoticeMessage(`「${duplicatedToken}」は同義語内で重複して登録されています。`);
      return false;
    }
    const excludedToken = tokens.find((item) => excludeKeywordSet.has(item));
    if (excludedToken) {
      setNoticeMessage(`「${excludedToken}」は除外リストに登録済みです。内容を確認してから追加してください。`);
      return false;
    }
    applyRuleChanges(normalizedExcludeKeywordsDraft, [...synonymGroupEntries, group].join("\n"));
    setNewSynonymGroup("");
    setNewSynonymDesc("");
    setNoticeMessage("類似語・専門用語を追加しました。自動保存します。");
    return true;
  }

  /** ダブルクリックで開始した除外キーワードのインライン編集を確定する。 */
  function handleUpdateExcludeKeyword(original: string): void {
    const next = editingExcludeKeywordValue.trim();
    setEditingExcludeKeyword(null);
    if (!next || next === original) return;
    if (excludeKeywordEntries.some((item) => item !== original && item.toLowerCase() === next.toLowerCase())) {
      setNoticeMessage(`「${next}」は除外リストに登録済みです。`);
      return;
    }
    applyRuleChanges(excludeKeywordEntries.map((item) => item === original ? next : item).join("\n"), normalizedSynonymGroupsDraft);
  }

  /** ダブルクリックで開始した類似語・専門用語のインライン編集を確定する。 */
  function handleUpdateSynonymGroup(original: string): void {
    const next = normalizeSynonymGroups(editingSynonymGroupValue);
    setEditingSynonymGroup(null);
    if (!next || next === original) return;
    const otherTokens = new Set(
      synonymGroupEntries
        .filter((item) => item !== original)
        .flatMap((item) => (item.includes(":") ? item.split(":")[0] : item).split(",").map((token) => token.toLowerCase()))
    );
    const nextTermsPart = next.includes(":") ? next.split(":")[0] : next;
    const duplicate = nextTermsPart.split(",").map((item) => item.toLowerCase()).find((item) => otherTokens.has(item));
    if (duplicate) {
      setNoticeMessage(`「${duplicate}」は同義語内で重複して登録されています。`);
      return;
    }
    applyRuleChanges(normalizedExcludeKeywordsDraft, synonymGroupEntries.map((item) => item === original ? next : item).join("\n"));
  }

  function toggleIndexExtension(extension: string): void {
    setSelectedIndexExtensions((current) =>
      current.includes(extension) ? current.filter((item) => item !== extension) : [...current, extension],
    );
  }

  function setAllIndexExtensions(): void {
    setSelectedIndexExtensions([...availableIndexExtensions]);
  }

  function clearAllIndexExtensions(): void {
    setSelectedIndexExtensions([]);
  }

  /**
   * 利用者追加拡張子を下書きへ加え、同時にインデックス対象としても選択状態にする。
   */
  function handleAddCustomExtension(kind: "content" | "filename"): void {
    const nextExtension = normalizeExtensionToken(kind === "content" ? newContentExtension : newFilenameExtension);
    if (!nextExtension) {
      setErrorMessage("追加する拡張子を入力してください。");
      return;
    }
    if (availableIndexExtensions.includes(nextExtension)) {
      setErrorMessage(`拡張子 ${nextExtension} は既に登録されています。`);
      return;
    }

    if (kind === "content") {
      setCustomContentExtensions((current) => [...current, nextExtension]);
      setNewContentExtension("");
    } else {
      setCustomFilenameExtensions((current) => [...current, nextExtension]);
      setNewFilenameExtension("");
    }
    setSelectedIndexExtensions((current) => [...current, nextExtension]);
    setErrorMessage("");
    setNoticeMessage("");
  }

  /**
   * 追加拡張子を下書きから外し、選択状態にも残さない。
   */
  function handleRemoveCustomExtension(extension: string, kind: "content" | "filename"): void {
    if (kind === "content") {
      setCustomContentExtensions((current) => current.filter((item) => item !== extension));
    } else {
      setCustomFilenameExtensions((current) => current.filter((item) => item !== extension));
    }
    setSelectedIndexExtensions((current) => current.filter((item) => item !== extension));
    setErrorMessage("");
    setNoticeMessage("");
  }

  /**
   * インデックス対象拡張子と追加拡張子一覧をテキストファイル管理の設定として保存する。
   */
  async function handleSaveIndexExtensions(): Promise<void> {
    const normalizedCustomContentExtensions = normalizeCustomExtensions(customContentExtensions);
    const normalizedCustomFilenameExtensions = normalizeCustomExtensions(customFilenameExtensions);
    const normalizedAvailableExtensions = buildAvailableExtensions(
      normalizedCustomContentExtensions,
      normalizedCustomFilenameExtensions,
    );
    const normalizedSelectedIndexExtensions = normalizeIndexExtensions(selectedIndexExtensions, normalizedAvailableExtensions);

    const removedExtensions = savedIndexExtensions.filter(
      (ext) => !normalizedSelectedIndexExtensions.includes(ext),
    );

    let cleanExcludedFiles = false;
    if (removedExtensions.length > 0) {
      if (confirmIndexDeletion) {
        cleanExcludedFiles = window.confirm(
          `以下の拡張子がインデックス対象から外れました:\n${removedExtensions.join(", ")}\n\nこれら除外された拡張子の既存インデックスデータを削除しますか？\n（「キャンセル」を選択した場合は既存インデックスを保持し、設定のみ更新します）`,
        );
      }
    }

    try {
      setIsSavingIndexExtensions(true);
      const savedSettings = await updateAppSettings({
        index_selected_extensions: normalizedSelectedIndexExtensions.join("\n"),
        custom_content_extensions: normalizedCustomContentExtensions.join("\n"),
        custom_filename_extensions: normalizedCustomFilenameExtensions.join("\n"),
        clean_excluded_files: cleanExcludedFiles,
      });
      const savedCustomContent = parseExtensionText(savedSettings.custom_content_extensions);
      const savedCustomFilename = parseExtensionText(savedSettings.custom_filename_extensions);
      const savedAvailableExtensions = buildAvailableExtensions(savedCustomContent, savedCustomFilename);
      const savedSelected = normalizeIndexExtensions(parseExtensionText(savedSettings.index_selected_extensions), savedAvailableExtensions);
      setSavedCustomContentExtensions(savedCustomContent);
      setCustomContentExtensions(savedCustomContent);
      setSavedCustomFilenameExtensions(savedCustomFilename);
      setCustomFilenameExtensions(savedCustomFilename);
      setSavedIndexExtensions(savedSelected);
      setSelectedIndexExtensions(savedSelected);
      setErrorMessage("");
      const cleanupNotice = cleanExcludedFiles ? "（除外拡張子のインデックスを削除しました）" : "";
      setNoticeMessage(
        savedSelected.length > 0
          ? `インデックス対象拡張子を保存しました。${cleanupNotice}テキストファイルを編集した内容もここに反映されます。`
          : `インデックス対象の拡張子をすべて解除した状態で保存しました。${cleanupNotice}`,
      );
    } catch (error) {
      setNoticeMessage("");
      setErrorMessage(error instanceof Error ? error.message : "インデックス対象拡張子の保存に失敗しました。");
    } finally {
      setIsSavingIndexExtensions(false);
    }
  }

  /**
   * 除外キーワードを 1 件追加して、すぐに保存する（検索結果の「無視」から呼ぶ）。
   * 追加して保存したら true、すでに登録済みで何もしなかったら false を返す。保存に失敗したら例外を投げる。
   */
  async function addExcludeKeyword(keyword: string): Promise<boolean> {
    const nextExcludeKeywords = normalizeExcludeKeywords([savedExcludeKeywords, keyword].filter(Boolean).join("\n"));
    if (nextExcludeKeywords === savedExcludeKeywords) {
      return false;
    }
    const savedSettings = await updateAppSettings({ exclude_keywords: nextExcludeKeywords });
    const savedValue = normalizeExcludeKeywords(savedSettings.exclude_keywords);
    setSavedExcludeKeywords(savedValue);
    setExcludeKeywordsDraft(savedValue);
    return true;
  }

  /** 除外キーワードの下書きへ 1 件追記する（保存は検索ルール管理の画面で行う）。 */
  function appendExcludeKeywordDraft(keyword: string): void {
    setExcludeKeywordsDraft((current) => normalizeExcludeKeywords([current, keyword].filter(Boolean).join("\n")));
  }

  /**
   * 除外キーワードは明示的な保存ボタンでだけ確定し、次回検索から必ず同じ値を使う。
   */
  async function handleSaveExcludeKeywords(): Promise<void> {
    const normalized = normalizeExcludeKeywords(excludeKeywordsDraft);
    try {
      setIsSavingExcludeKeywords(true);
      const savedSettings = await updateAppSettings({ exclude_keywords: normalized });
      const savedValue = normalizeExcludeKeywords(savedSettings.exclude_keywords);
      setSavedExcludeKeywords(savedValue);
      setExcludeKeywordsDraft(savedValue);
      setErrorMessage("");
      setNoticeMessage("除外キーワードを保存しました。次回検索から反映されます。");
    } catch (error) {
      setNoticeMessage("");
      setErrorMessage(error instanceof Error ? error.message : "除外キーワードの保存に失敗しました。");
    } finally {
      setIsSavingExcludeKeywords(false);
    }
  }

  /**
   * 同義語リストは明示的な保存ボタンでだけ確定し、通常検索の表記ゆれ対応へ反映する。
   */
  async function handleSaveSynonymGroups(): Promise<void> {
    const normalized = normalizeSynonymGroups(synonymGroupsDraft);
    try {
      setIsSavingSynonymGroups(true);
      const savedSettings = await updateAppSettings({ synonym_groups: normalized });
      const savedValue = normalizeSynonymGroups(savedSettings.synonym_groups);
      setSavedSynonymGroups(savedValue);
      setSynonymGroupsDraft(savedValue);
      setErrorMessage("");
      setNoticeMessage("同義語リストを保存しました。次回検索から反映されます。");
    } catch (error) {
      setNoticeMessage("");
      setErrorMessage(error instanceof Error ? error.message : "同義語リストの保存に失敗しました。");
    } finally {
      setIsSavingSynonymGroups(false);
    }
  }

  /** 検索ルール画面での変更は短い待機後に自動保存する。 */
  useEffect(() => {
    if (!isRuleManagementPage || (!hasUnsavedExcludeKeywords && !hasUnsavedSynonymGroups)) return;
    const timer = window.setTimeout(() => {
      if (hasUnsavedExcludeKeywords) void handleSaveExcludeKeywords();
      if (hasUnsavedSynonymGroups) void handleSaveSynonymGroups();
    }, 120);
    return () => window.clearTimeout(timer);
  }, [excludeKeywordsDraft, synonymGroupsDraft, isRuleManagementPage, hasUnsavedExcludeKeywords, hasUnsavedSynonymGroups]);

  /** Ctrl+Z / Ctrl+Shift+Z（macOS は Command）で検索ルール履歴を操作する。 */
  useEffect(() => {
    if (!isRuleManagementPage) return;
    const handleRuleHistoryShortcut = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
      event.preventDefault();
      if (event.shiftKey) {
        handleRedoRuleChange();
      } else {
        handleUndoRuleChange();
      }
    };
    window.addEventListener("keydown", handleRuleHistoryShortcut);
    return () => window.removeEventListener("keydown", handleRuleHistoryShortcut);
  }, [isRuleManagementPage, excludeKeywordsDraft, synonymGroupsDraft]);

  /** 入力欄を操作していないときだけ、A キーで選択中カードの追加画面を開く。 */
  useEffect(() => {
    if (!isRuleManagementPage || isRuleAddModalOpen) return;
    const handleRuleAddShortcut = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.key.toLowerCase() !== "a") return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable)) return;
      event.preventDefault();
      handleOpenRuleAddModal(activeRuleKind);
    };
    window.addEventListener("keydown", handleRuleAddShortcut);
    return () => window.removeEventListener("keydown", handleRuleAddShortcut);
  }, [isRuleManagementPage, isRuleAddModalOpen, activeRuleKind]);

  /** 選択中のルールは、入力中以外なら Delete キーでも確認削除できる。 */
  useEffect(() => {
    if (!isRuleManagementPage || !selectedRuleItem || isRuleAddModalOpen) return;
    const handleRuleDeleteShortcut = (event: KeyboardEvent): void => {
      if (event.key !== "Delete") return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable)) return;
      event.preventDefault();
      handleDeleteRuleItem(selectedRuleItem.kind, selectedRuleItem.item);
    };
    window.addEventListener("keydown", handleRuleDeleteShortcut);
    return () => window.removeEventListener("keydown", handleRuleDeleteShortcut);
  }, [isRuleManagementPage, isRuleAddModalOpen, selectedRuleItem, excludeKeywordsDraft, synonymGroupsDraft]);

  /** 読み込んだ共有設定を、保存済みの値と下書きの両方へ反映する。 */
  function applyLoadedSettings(appSettings: AppSettings): void {
    const loadedExcludeKeywords = normalizeExcludeKeywords(appSettings.exclude_keywords);
    const loadedSynonymGroups = normalizeSynonymGroups(appSettings.synonym_groups);
    const loadedCustomContentExtensions = parseExtensionText(appSettings.custom_content_extensions);
    const loadedCustomFilenameExtensions = parseExtensionText(appSettings.custom_filename_extensions);
    const loadedSelectedIndexExtensions = normalizeIndexExtensions(
      parseExtensionText(appSettings.index_selected_extensions),
      buildAvailableExtensions(loadedCustomContentExtensions, loadedCustomFilenameExtensions),
    );
    setSavedExcludeKeywords(loadedExcludeKeywords);
    setExcludeKeywordsDraft(loadedExcludeKeywords);
    setSavedSynonymGroups(loadedSynonymGroups);
    setSynonymGroupsDraft(loadedSynonymGroups);
    setSavedCustomContentExtensions(loadedCustomContentExtensions);
    setCustomContentExtensions(loadedCustomContentExtensions);
    setSavedCustomFilenameExtensions(loadedCustomFilenameExtensions);
    setCustomFilenameExtensions(loadedCustomFilenameExtensions);
    setSavedIndexExtensions(loadedSelectedIndexExtensions);
    setSelectedIndexExtensions(loadedSelectedIndexExtensions);
  }

  return {
    addExcludeKeyword,
    appendExcludeKeywordDraft,
    activeRuleKind,
    applyLoadedSettings,
    clearAllIndexExtensions,
    draggedRule,
    editingExcludeKeyword,
    editingExcludeKeywordValue,
    editingSynonymGroup,
    editingSynonymGroupValue,
    excludeKeywordSet,
    excludeRuleFilterText,
    extensionRuleFilterText,
    filteredCustomContentExtensions,
    filteredCustomFilenameExtensions,
    filteredExcludeKeywordEntries,
    filteredStandardExtensions,
    filteredSynonymGroupEntries,
    handleAddCustomExtension,
    handleDeleteRuleItem,
    handleMoveRuleItem,
    handleOpenRuleAddModal,
    handleRedoRuleChange,
    handleRemoveCustomExtension,
    handleSaveIndexExtensions,
    handleSubmitRuleAdd,
    handleUndoRuleChange,
    handleUpdateExcludeKeyword,
    handleUpdateSynonymGroup,
    hasUnsavedExcludeKeywords,
    hasUnsavedIndexExtensions,
    hasUnsavedSynonymGroups,
    isRuleAddModalOpen,
    isSavingExcludeKeywords,
    isSavingIndexExtensions,
    isSavingSynonymGroups,
    newContentExtension,
    newExcludeKeyword,
    newFilenameExtension,
    newSynonymDesc,
    newSynonymGroup,
    ruleAddKind,
    ruleContextMenu,
    savedExcludeKeywords,
    selectedIndexExtensions,
    selectedRuleItem,
    setActiveRuleKind,
    setAllIndexExtensions,
    setCustomContentExtensions,
    setCustomFilenameExtensions,
    setDraggedRule,
    setEditingExcludeKeyword,
    setEditingExcludeKeywordValue,
    setEditingSynonymGroup,
    setEditingSynonymGroupValue,
    setExcludeKeywordsDraft,
    setExcludeRuleFilterText,
    setExtensionRuleFilterText,
    setIsRuleAddModalOpen,
    setNewContentExtension,
    setNewExcludeKeyword,
    setNewFilenameExtension,
    setNewSynonymDesc,
    setNewSynonymGroup,
    setRuleContextMenu,
    setSelectedIndexExtensions,
    setSelectedRuleItem,
    setSynonymGroupsDraft,
    setSynonymRuleFilterText,
    synonymRuleFilterText,
    toggleIndexExtension,
  } as const;
}

export type UseRuleManagementResult = ReturnType<typeof useRuleManagement>;
