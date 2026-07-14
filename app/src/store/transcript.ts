import { create } from "zustand";
import { parseTranscript } from "../engine/parser";
import type { ParsedTranscript, CleanResult } from "../engine/types";

// Открытый транскрипт: путь, исходный текст, распарсенная структура.
export interface TranscriptState {
  path: string;
  raw: string;
  parsed: ParsedTranscript;
}

interface TranscriptStore {
  transcript: TranscriptState | null; // открытый транскрипт (или null)
  cleanResult: CleanResult | null; // результат applyRules (или null)
  cleanDirty: boolean; // true = результат устарел после правки словарей
  // Свёрнуто ли отображение очищенного транскрипта (кнопка «Свернуть реплики»).
  // Сбрасывается при открытии/закрытии транскрипта; НЕ сбрасывается при повторном
  // «Очистить» — пользовательский выбор предпочтения в рамках сессии файла.
  collapseEnabled: boolean;

  openTranscript: (path: string, raw: string) => void;
  closeTranscript: () => void;
  setCleanResult: (result: CleanResult | null) => void;
  markCleanDirty: () => void;
  setCollapseEnabled: (v: boolean) => void;
}

export const useTranscript = create<TranscriptStore>((set) => ({
  transcript: null,
  cleanResult: null,
  cleanDirty: false,
  collapseEnabled: false,

  openTranscript: (path, raw) =>
    set({
      transcript: { path, raw, parsed: parseTranscript(raw) },
      // Открытие нового транскрипта обнуляет старый результат и флаги.
      cleanResult: null,
      cleanDirty: false,
      collapseEnabled: false,
    }),

  closeTranscript: () =>
    set({ transcript: null, cleanResult: null, cleanDirty: false, collapseEnabled: false }),

  setCleanResult: (result) =>
    set({ cleanResult: result, cleanDirty: false }),

  // Правка словарей делает существующий результат устаревшим. Вызывается
  // эффектом в App при изменении entries в dictionaries-store.
  markCleanDirty: () => {
    // Лишь если уже есть результат — иначе помечать нечего.
    set((s) => (s.cleanResult ? { cleanDirty: true } : {}));
  },

  setCollapseEnabled: (v) => set({ collapseEnabled: v }),
}));
