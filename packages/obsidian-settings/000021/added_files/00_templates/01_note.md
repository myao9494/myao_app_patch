---
created: <% tp.date.now("YYYY-MM-DD HH:mm:ss") %>
tags:
---
<%*
const CONFIG = {
  BASE_FOLDER: "01_data",
  DATE_FORMAT: "YYYY/MM/DD",
  TITLE: ""  // ここに任意のタイトルを設定。空欄("")の場合はデフォルトのファイル名を使用
}

const createFolderIfNotExists = async (path) => {
  try {
    await app.vault.createFolder(path)
  } catch {
    // フォルダが既に存在
  }
}

// 今日のフォルダに直接作ったノートは、自分自身を重複と数えない
const getUniqueName = async (folder, base, currentPath) => {
  const isTaken = (path) => path !== currentPath && app.vault.getAbstractFileByPath(path)
  let name = base
  let i = 1
  while (isTaken(`${folder}/${name}.md`)) {
    name = `${base} ${i++}`
  }
  return name
}

const moveFileToFolder = async (fileTitle, folder) => {
  await createFolderIfNotExists(folder)
  const currentPath = tp.file.path(true)
  const uniqueName = await getUniqueName(folder, fileTitle, currentPath)
  const destination = `${folder}/${uniqueName}`
  if (`${destination}.md` !== currentPath) await tp.file.move(destination)
  return uniqueName
}

const notifyIfRenamed = (original, newName) => {
  if (original !== newName) {
    new Notice(`ファイル名が重複していたため "${newName}" に変更されました`)
  }
}

const generateFileName = (title) => {
  if (title && title.trim() !== "") {
    const dateStr = tp.date.now("YYYY-MM-DD")
    return `${title.trim()}_${dateStr}`
  } else {
    return tp.file.title
  }
}

try {
  const folderPath = `${CONFIG.BASE_FOLDER}/${tp.date.now(CONFIG.DATE_FORMAT)}`
  const originalName = tp.file.title
  const newFileName = generateFileName(CONFIG.TITLE)
  const finalName = await moveFileToFolder(newFileName, folderPath)
  notifyIfRenamed(newFileName, finalName)
} catch (error) {
  new Notice(`エラー: ${error.message}`)
}
%>