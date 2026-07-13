import { create } from "zustand";

// Тема приложения. Хранится в localStorage, применяется к <html data-theme=...>,
// откуда CSS-переменные в App.css определяют палитру UI. Monaco-редактор читает
// `mode` напрямую (vs-dark / light) — см. YamlEditor.

export type ThemeMode = "dark" | "light";

interface ThemeState {
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
  toggle: () => void;
}

const STORAGE_KEY = "transcript-optimizer.theme";

function initialMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    // localStorage может быть недоступен (например, в песочницах/приватном режиме).
  }
  return "dark"; // значение по умолчанию — текущая тёмная тема.
}

function applyToDom(mode: ThemeMode) {
  document.documentElement.setAttribute("data-theme", mode);
}

export const useTheme = create<ThemeState>((set, get) => ({
  mode: initialMode(),
  setMode: (m) => {
    applyToDom(m);
    try {
      localStorage.setItem(STORAGE_KEY, m);
    } catch {
      // запись может падать в приватном режиме — игнорируем.
    }
    set({ mode: m });
  },
  toggle: () => get().setMode(get().mode === "dark" ? "light" : "dark"),
}));

// Применить тему к DOM при первом импорте store — чтобы CSS-переменные
// совпали с mode ещё до первого рендера подписанных компонентов.
// Дублирует инлайн-скрипт в index.html (на случай, если тот не успел).
applyToDom(useTheme.getState().mode);
