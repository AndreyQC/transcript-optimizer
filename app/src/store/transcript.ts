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

  openTranscript: (path: string, raw: string) => void;
  closeTranscript: () => void;
  setCleanResult: (result: CleanResult | null) => void;
  markCleanDirty: () => void;
}

export const useTranscript = create<TranscriptStore>((set) => ({
  transcript: null,
  cleanResult: null,
  cleanDirty: false,

  openTranscript: (path, raw) =>
    set({
      transcript: { path, raw, parsed: parseTranscript(raw) },
      // Открытие нового транскрипта обнуляет старый результат и флаг dirty.
      cleanResult: null,
      cleanDirty: false,
    }),

  closeTranscript: () =>
    set({ transcript: null, cleanResult: null, cleanDirty: false }),

  setCleanResult: (result) =>
    set({ cleanResult: result, cleanDirty: false }),

  // Правка словарей делает существующий результат устаревшим. Вызывается
  // эффектом в App при изменении entries в dictionaries-store.
  markCleanDirty: () => {
    // Лишь если уже есть результат — иначе помечать нечего.
    set((s) => (s.cleanResult ? { cleanDirty: true } : {}));
  },
}));
