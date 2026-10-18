import { create } from "zustand";

// Активный режим приложения. Вынесен в store (а не useState в App), чтобы
// другие stores могли переключать режим — например, transcribe открывает
// готовый транскрипт после «done».
export type Mode =
  | "dictionaries"
  | "transcript"
  | "summary"
  | "markdown"
  | "transcribe";

interface UiStore {
  mode: Mode;
  setMode: (mode: Mode) => void;
}

export const useUi = create<UiStore>((set) => ({
  mode: "dictionaries",
  setMode: (mode) => set({ mode }),
}));
