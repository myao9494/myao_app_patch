/**
 * AIインプットのプレビュー画面で使う、リンク先ノートのツリー表示。
 * リンクを辿って展開されたノート（ExpandedNode）を、親子関係のツリーに組み立てて表示する。
 * ノートごとに、出力へ含めるかどうかの切り替えと、子ノードの折りたたみができる。
 */
import type { ExpandedNode } from "../../types";

/**
 * 展開された子ノードの木構造型 (spoon_feeder2 風)
 **/
export interface TreeChildNode {
  node: ExpandedNode;
  children: TreeChildNode[];
}

/**
 * フラットなExpandedNode配列から親パスに基づく階層ツリーを構築する
 **/
export function buildChildTree(nodes: ExpandedNode[], rootPath: string): TreeChildNode[] {
  const relevant = nodes.filter(
    (n) => (n.root_path === rootPath) && n.depth_level > 0
  );
  if (relevant.length === 0) return [];

  const byParent = new Map<string, ExpandedNode[]>();
  relevant.forEach((n) => {
    const p = n.parent_path || rootPath;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p)!.push(n);
  });

  const visited = new Set<string>();

  function buildSubtree(parentPath: string, expectedDepth: number): TreeChildNode[] {
    let direct = byParent.get(parentPath) || [];
    if (direct.length === 0 && expectedDepth === 1) {
      direct = relevant.filter((n) => n.depth_level === 1 && !visited.has(n.full_path));
    }

    const result: TreeChildNode[] = [];
    for (const item of direct) {
      if (visited.has(item.full_path)) continue;
      visited.add(item.full_path);
      result.push({
        node: item,
        children: buildSubtree(item.full_path, item.depth_level + 1),
      });
    }
    return result;
  }

  const tree = buildSubtree(rootPath, 1);

  // 孤立したノードがあればルート直下に安全に追加
  for (const item of relevant) {
    if (!visited.has(item.full_path)) {
      visited.add(item.full_path);
      tree.push({
        node: item,
        children: buildSubtree(item.full_path, item.depth_level + 1),
      });
    }
  }

  return tree;
}

/**
 * spoon_feeder2風の折りたたみ・展開可能な子ノードツリーアイテムコンポーネント
 **/
export function AiChildTreeNode({
  treeNode,
  excludedChildPaths,
  collapsedNodes,
  onToggleChildNode,
  onToggleCollapse,
  openFileViaHub,
  depth = 1,
}: {
  treeNode: TreeChildNode;
  excludedChildPaths: Set<string>;
  collapsedNodes: Set<string>;
  onToggleChildNode: (path: string) => void;
  onToggleCollapse: (path: string) => void;
  openFileViaHub: (path: string) => void;
  depth?: number;
}) {
  const child = treeNode.node;
  const isChildExcluded = excludedChildPaths.has(child.full_path);
  const hasSubChildren = treeNode.children.length > 0;
  const isCollapsed = collapsedNodes.has(child.full_path);

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div
        className="ai-child-node-item"
        onClick={() => openFileViaHub(child.full_path)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          fontSize: "11.5px",
          color: isChildExcluded ? "#64748b" : "#cbd5e1",
          padding: "3px 8px",
          backgroundColor: isChildExcluded
            ? "rgba(100, 116, 139, 0.08)"
            : "rgba(99, 102, 241, 0.08)",
          borderRadius: "4px",
          border: isChildExcluded
            ? "1px solid rgba(100, 116, 139, 0.15)"
            : "1px solid rgba(99, 102, 241, 0.15)",
          cursor: "pointer",
          textDecoration: isChildExcluded ? "line-through" : "none",
          opacity: isChildExcluded ? 0.6 : 1,
        }}
        title={`クリックして 8001 Open Hub で開く\n階層 ${child.depth_level} (リンク元: ${child.parent_name || "親ノート"})\nパス: ${child.full_path}`}
      >
        {/* 開閉トグルボタンまたはスペーサー */}
        {hasSubChildren ? (
          <button
            type="button"
            className="ai-tree-toggle-btn"
            onClick={(e) => {
              e.stopPropagation();
              onToggleCollapse(child.full_path);
            }}
            title={isCollapsed ? "展開する" : "折りたたむ"}
          >
            {isCollapsed ? "▶" : "▼"}
          </button>
        ) : (
          <span className="ai-tree-spacer" style={{ color: "rgba(99, 102, 241, 0.5)", fontSize: "11px", fontWeight: "bold" }}>
            ↳
          </span>
        )}

        {/* 除外チェックボックス */}
        <input
          type="checkbox"
          checked={!isChildExcluded}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            e.stopPropagation();
            onToggleChildNode(child.full_path);
          }}
          style={{
            cursor: "pointer",
            width: "14px",
            height: "14px",
            accentColor: "#6366f1",
            flexShrink: 0,
          }}
          title={isChildExcluded ? "コンテキストに含める" : "コンテキストから除外する"}
        />

        {/* 階層バッジ */}
        <span
          className="badge"
          style={{
            fontSize: "9.5px",
            padding: "1px 5px",
            backgroundColor: isChildExcluded
              ? "rgba(100, 116, 139, 0.2)"
              : "rgba(99, 102, 241, 0.25)",
            color: isChildExcluded ? "#94a3b8" : "#a5b4fc",
            borderRadius: "3px",
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          階層 {child.depth_level}
        </span>

        {/* ファイル名 */}
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
        >
          {child.file_name}
        </span>

        {/* 8001 アイコン */}
        <span style={{ fontSize: "10px", opacity: 0.6, color: "#38bdf8", flexShrink: 0 }} title="8001ハブで開く">
          ↗
        </span>

        {/* リンク元名 */}
        {child.parent_name && (
          <span style={{ fontSize: "10px", color: "#64748b", flexShrink: 0 }}>
            (リンク元: {child.parent_name})
          </span>
        )}
      </div>

      {/* サブツリー（子ノードが展開されている場合） */}
      {hasSubChildren && !isCollapsed && (
        <div className="ai-child-tree-subgroup">
          {treeNode.children.map((subChild, sIdx) => (
            <AiChildTreeNode
              key={`${subChild.node.full_path}-${sIdx}`}
              treeNode={subChild}
              excludedChildPaths={excludedChildPaths}
              collapsedNodes={collapsedNodes}
              onToggleChildNode={onToggleChildNode}
              onToggleCollapse={onToggleCollapse}
              openFileViaHub={openFileViaHub}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}
