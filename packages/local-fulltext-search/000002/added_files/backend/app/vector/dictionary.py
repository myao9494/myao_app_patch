"""
専門用語・類似語辞書連携モジュール (GlossaryDictionary)
仕様:
- Excel (.xlsx) / CSV から社内専門用語・類似語・解説を読み込む。
- 第1列: 用語（カンマ区切りで同義語を含む）、第2列: 意味・解説。
- SHA-256ハッシュ & mtime 差分検知キャッシュにより高速応答。
- 大文字/小文字、全角/半角、記号除去による表記揺れ正規化。
- 本文およびクエリからの最長一致用語検知。
"""

import csv
import hashlib
import os
import re
import unicodedata
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union


def normalize_term_key(text: str) -> str:
    """検索照合用に全角半角正規化、小文字化、余分な記号除去を行う"""
    if not text:
        return ""
    n = unicodedata.normalize("NFKC", text).lower().strip()
    n = re.sub(r"[\s\-_・/]+", "", n)
    return n


class GlossaryDictionary:
    """専門用語辞書管理クラス"""

    def __init__(self, file_path: Optional[str] = None):
        self.file_path = str(Path(file_path).resolve()) if file_path else None
        self.entries: List[Dict[str, Any]] = []
        self._key_to_entry: Dict[str, Dict[str, Any]] = {}
        self._raw_terms_sorted_by_len: List[Tuple[str, Dict[str, Any]]] = []
        self._last_hash: Optional[str] = None
        self._last_mtime: Optional[float] = None
        self.load()

    def _calc_file_hash(self) -> Optional[str]:
        if not self.file_path or not Path(self.file_path).exists():
            return None
        h = hashlib.sha256()
        with open(self.file_path, "rb") as f:
            while chunk := f.read(65536):
                h.update(chunk)
        return h.hexdigest()

    def load(self, force: bool = False) -> bool:
        """ファイルを読み込む。変更がなければスキップする"""
        if not self.file_path or not Path(self.file_path).exists():
            self.entries = []
            self._key_to_entry = {}
            self._raw_terms_sorted_by_len = []
            return False

        current_mtime = Path(self.file_path).stat().st_mtime
        if not force and self._last_mtime == current_mtime:
            return False

        current_hash = self._calc_file_hash()
        if not force and self._last_hash == current_hash:
            self._last_mtime = current_mtime
            return False

        new_entries: List[Dict[str, Any]] = []
        ext = Path(self.file_path).suffix.lower()

        if ext in {".txt", ".text"}:
            with open(self.file_path, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    line_str = line.strip()
                    if not line_str or line_str.startswith("#"):
                        continue
                    if ":" in line_str:
                        term_col, desc_col = line_str.split(":", 1)
                    elif "：" in line_str:
                        term_col, desc_col = line_str.split("：", 1)
                    else:
                        term_col, desc_col = line_str, ""
                    term_col = term_col.strip()
                    desc_col = desc_col.strip()
                    if term_col:
                        new_entries.append({"raw_term": term_col, "description": desc_col})
        elif ext == ".csv":
            with open(self.file_path, "r", encoding="utf-8-sig", errors="ignore") as f:
                reader = csv.reader(f)
                for row in reader:
                    if not row or len(row) < 1:
                        continue
                    term_col = row[0].strip()
                    desc_col = row[1].strip() if len(row) > 1 else ""
                    if term_col.lower() in {"term", "専門用語", "用語", "word"}:
                        continue
                    if term_col:
                        new_entries.append({"raw_term": term_col, "description": desc_col})
        elif ext in {".xlsx", ".xlsm"}:
            try:
                import openpyxl
                wb = openpyxl.load_workbook(self.file_path, read_only=True, data_only=True)
                ws = wb.active
                for row in ws.iter_rows(values_only=True):
                    if not row or not row[0]:
                        continue
                    term_col = str(row[0]).strip()
                    desc_col = str(row[1]).strip() if len(row) > 1 and row[1] else ""
                    if term_col.lower() in {"term", "専門用語", "用語", "word"}:
                        continue
                    if term_col:
                        new_entries.append({"raw_term": term_col, "description": desc_col})
                wb.close()
            except Exception:
                pass

        parsed_entries: List[Dict[str, Any]] = []
        term_map: Dict[str, Dict[str, Any]] = {}
        raw_list: List[Tuple[str, Dict[str, Any]]] = []

        for item in new_entries:
            raw = item["raw_term"]
            desc = item["description"]
            terms = [t.strip() for t in re.split(r"[,、\n]+", raw) if t.strip()]
            if not terms:
                continue

            primary_term = terms[0]
            synonyms = terms[1:]

            entry_dict = {
                "term": primary_term,
                "synonyms": synonyms,
                "description": desc,
            }
            parsed_entries.append(entry_dict)

            for t in terms:
                raw_list.append((t, entry_dict))
                key = normalize_term_key(t)
                if key:
                    term_map[key] = entry_dict

        self.entries = parsed_entries
        self._key_to_entry = term_map
        self._raw_terms_sorted_by_len = sorted(raw_list, key=lambda x: len(x[0]), reverse=True)
        self._last_hash = current_hash
        self._last_mtime = current_mtime
        return True

    def detect_terms(self, text: str) -> List[Dict[str, Any]]:
        """
        自然文テキストから登録されている専門用語・類似語を最長一致で検知する。
        """
        if not text or not self.entries:
            return []

        detected: List[Dict[str, Any]] = []
        seen_terms = set()

        # 1. 生の文字列による直接検索（最長一致）
        for raw_word, entry in self._raw_terms_sorted_by_len:
            if len(raw_word) < 2:
                continue
            pattern = re.escape(raw_word)
            if re.search(pattern, text, re.IGNORECASE):
                primary = entry["term"]
                if primary not in seen_terms:
                    seen_terms.add(primary)
                    detected.append(entry)

        # 2. 表記揺れ（ハイフン有無・全角半角）を検知するための正規化検索
        normalized_text = normalize_term_key(text)
        sorted_keys = sorted(self._key_to_entry.keys(), key=len, reverse=True)
        for k in sorted_keys:
            if len(k) >= 2 and k in normalized_text:
                entry = self._key_to_entry[k]
                primary = entry["term"]
                if primary not in seen_terms:
                    seen_terms.add(primary)
                    detected.append(entry)

        return detected

    def build_enriched_query(self, query: str) -> str:
        """クエリに検知された用語の類似語・解説を補強する"""
        if not query or not self.entries:
            return query
        detected = self.detect_terms(query)
        if not detected:
            return query
        supplements = []
        for entry in detected:
            additions = [s for s in entry.get("synonyms", []) if s.lower() not in query.lower()]
            desc = entry.get("description", "")
            if additions:
                supplements.append(" ".join(additions[:3]))
            if desc:
                supplements.append(desc[:50])
        if supplements:
            return f"{query} ({' '.join(supplements)})"
        return query

    @classmethod
    def save_to_excel(cls, file_path: str, entries: List[Dict[str, Any]]) -> None:
        """専門用語辞書エントリを2列フォーマットのExcelファイル (.xlsx) として書き込み保存する"""
        import openpyxl
        from openpyxl.styles import Font, PatternFill, Alignment, Border, Side

        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "Glossary"

        # ヘッダー
        headers = ["専門用語", "意味・解説"]
        ws.append(headers)

        header_fill = PatternFill(start_color="F1F5F9", end_color="F1F5F9", fill_type="solid")
        header_font = Font(name="Segoe UI", size=11, bold=True, color="1E293B")
        data_font = Font(name="Segoe UI", size=10, color="0F172A")
        thin_border = Border(
            left=Side(style="thin", color="E2E8F0"),
            right=Side(style="thin", color="E2E8F0"),
            top=Side(style="thin", color="E2E8F0"),
            bottom=Side(style="thin", color="E2E8F0"),
        )

        for col_num in range(1, 3):
            cell = ws.cell(row=1, column=col_num)
            cell.fill = header_fill
            cell.font = header_font
            cell.border = thin_border

        for row_idx, item in enumerate(entries, start=2):
            terms_val = item.get("terms") or item.get("term") or item.get("raw_term") or ""
            if not terms_val and item.get("synonyms"):
                all_t = [item.get("term", "")] + item.get("synonyms", [])
                terms_val = ", ".join(filter(bool, all_t))
            desc_val = item.get("description") or ""

            c1 = ws.cell(row=row_idx, column=1, value=str(terms_val).strip())
            c2 = ws.cell(row=row_idx, column=2, value=str(desc_val).strip())
            c1.font = data_font
            c1.border = thin_border
            c2.font = data_font
            c2.border = thin_border

        ws.column_dimensions["A"].width = 38
        ws.column_dimensions["B"].width = 58

        path_obj = Path(file_path).resolve()
        path_obj.parent.mkdir(parents=True, exist_ok=True)
        wb.save(str(path_obj))

