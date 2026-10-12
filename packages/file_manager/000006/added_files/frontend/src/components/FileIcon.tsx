/**
 * ファイル・フォルダに応じたCatppuccinアイコン画像を表示するコンポーネント
 */
import React, { memo } from "react";
import { getIconPath } from "../utils/iconMapping";

export interface FileIconProps {
    name: string;
    type: "file" | "directory";
    isOpen?: boolean; // For folders
    size?: number;
    className?: string;
}

export const FileIcon: React.FC<FileIconProps> = memo(({
    name,
    type,
    isOpen = false,
    size = 16,
    className = "",
}) => {
    const iconPath = getIconPath(name, type, isOpen);

    return (
        <img
            src={iconPath}
            alt={name}
            width={size}
            height={size}
            className={className}
            style={{ display: "inline-block", verticalAlign: "middle" }}
            onError={(e) => {
                // Fallback to generic icon if specific one fails (e.g. valid extension but missing svg)
                const target = e.target as HTMLImageElement;
                if (type === "directory") {
                    // Prevent infinite loop if fallback also fails
                    if (!target.src.endsWith("folder.svg")) {
                        target.src = isOpen ? "/icons/catppuccin/folder__open.svg" : "/icons/catppuccin/folder.svg";
                    }
                } else {
                    if (!target.src.endsWith("file.svg")) {
                        target.src = "/icons/catppuccin/file.svg";
                    }
                }
            }}
        />
    );
});
