---
excalidraw-plugin: parsed
tags:
  - excalidraw
---
<%*
const CONFIG = {
  BASE_FOLDER: "01_data",
  DATE_FORMAT: "YYYY/MM/DD",
  TITLE: ""
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
# Excalidraw Data

## Text Elements
%%
## Drawing
```compressed-json
N4KAkARALgngDgUwgLgAQQQDwMYEMA2AlgCYBOuA7hADTgQBuCpAzoQPYB2KqATLZMzYBXUtiRoIACyhQ4zZAHoFAc0JRJQgEYA6bGwC2CgF7N6hbEcK4OCtptbErHALRY8RMpWdx8Q1TdIEfARcZgRmBShcZQUebQBGAHZtHho6IIR9BA4oZm4AbQBdfghcODgAZSiocVRQMEh1TNqIImVpNIaGQgQKACFcbABrZVJhDmIAYTZ8NlJuCABiADNV

tc7IbBFAnIBJGv0qsaGEadn5iUX4hGvrjYgt0h2ofcyB4dHxqZm5hahyDjMOC4Z73R7PV76ABihHw+CqMGCC0EHjB22yLwORzYJwA6iR1Nw+OBNui9lj/jiEAikRIUSQ0U8MZCAErCdoccJ5NDxfikpnkzIAeWB2DUMG48QADFK+Q8yZjMlDOFAobh9LCJWgAKxy8HMg7KnIVQhGWo8WUk+UCxX6AAqWCgAEE2lwJMFllBGRCKSDnU82BRJCFiNw

OEI4XqFZCAKITJ0BoMhhYgsZUKM2yEJtN2+AtMZCCbeg1K8hZNm01DhyNW5jYMZwgAa3AAbIkAMzabVSgCc7Z7PYALPFB1KWzxdbX6zN8ABNVvS7Qy9tJdsADh4a/iE7lRjYBm49S69AIQlq8RJAF8Mz7MmzC8ROcxuegC0W5aMSCazUTLV1P8QVQIHA3CTv+pAkAAsmwxAIHGuCaMEoZoMsBBhB+EHfOch4kpAfQzMhr7KJouAABQ8Ek1C8JR1G

JFRUpdgAlBskAsggygRiCCykMRZE8O2sq8AJVH8YJDHasxV43hi2InCKUDsICYYRvgcrLGWCBsRMTCEBwyg4Q0kDZAhSHcP8Z58psRAgWg5kIJZEAcOqtR2Q5whQEQnJmaQFm4RA+ggicpAAHLOd5vmGf5gVMPBiEIIRdlSVadgAFYINguQVE5cDQbBsWmShaH2VagwKYwdr7vgBldLAiDIhkGWKSx8rMFABi5nVaDVqpfmzMM8XcKh+DoX56kGB

UDUKZwg1FQ5+ChM6jXlZVylwklXSOMwJmnCqjqQdkQgzcNCDgNedDLLC4SHpeICXkAA=
```
%%