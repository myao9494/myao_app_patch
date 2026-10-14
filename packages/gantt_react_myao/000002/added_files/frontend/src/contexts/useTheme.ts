import { createContext, useContext } from 'react';

export interface ThemeContextType {
  darkMode: boolean;
  toggleDarkMode: () => void;
  setDarkMode: (value: boolean) => void;
}

export const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

/** 現在のテーマと切り替え関数を取得する（ThemeProvider の内側で使うこと） */
export function useTheme(): ThemeContextType {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
