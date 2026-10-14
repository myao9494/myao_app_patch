/**
 * ファイル一覧のフィルタ選択肢
 * - TYPE_FILTERS: 種類（全 / ファイル / フォルダ）
 * - EXT_FILTERS: 拡張子グループ（id は + 区切りの拡張子リスト）
 */
export const TYPE_FILTERS = [
  { id: "all", label: "全" },
  { id: "files", label: "F" },
  { id: "folders", label: "D" },
];

export const EXT_FILTERS = [
  { id: "all", label: "全" },
  { id: "md+svg+csv+pdf+ipynb+py+bat+sh+excalidraw+excalidraw.md+excalidraw.svg+excalidraw.png+docx+xlsx+xlsm+pptx+msg+jpg+jpeg+png+gif+bmp+tiff", label: "常用" },
  { id: "md", label: "MD" },
  { id: "ipynb", label: "IPYNB" },
  { id: "pdf", label: "PDF" },
  { id: "docx+xlsx+xlsm+pptx+msg", label: "Office" },
  { id: "jpg+jpeg+png+gif+bmp+tiff", label: "画像" },
  { id: "excalidraw+excalidraw.svg+excalidraw.png", label: "Excali" },
];
