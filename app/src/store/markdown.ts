import { create } from "zustand";

// Открытый markdown-документ для режима «Markdown» (split-view редактор .md).
// `path` пустой для нового (ещё не сохранённого) документа. `savedRaw` хранит
// текст на момент последнего сохранения/открытия — чтобы считать dirty простым
// сравнением, не выполняя его в селекторе (см. LESSONS_LEARNED §3: селекторы
// не должны возвращать новые значения).
export interface MarkdownDoc {
  path: string;
  raw: string;
  savedRaw: string;
  dirty: boolean; // raw !== savedRaw
}

interface MarkdownStore {
  doc: MarkdownDoc | null;
  openMarkdown: (path: string, raw: string) => void;
  editRaw: (raw: string) => void;
  markSaved: () => void;
  setPath: (path: string) => void;
  closeMarkdown: () => void;
}

export const useMarkdown = create<MarkdownStore>((set) => ({
  doc: null,

  openMarkdown: (path, raw) =>
    set({ doc: { path, raw, savedRaw: raw, dirty: false } }),

  editRaw: (raw) =>
    set((s) =>
      s.doc ? { doc: { ...s.doc, raw, dirty: raw !== s.doc.savedRaw } } : {},
    ),

  markSaved: () =>
    set((s) =>
      s.doc ? { doc: { ...s.doc, savedRaw: s.doc.raw, dirty: false } } : {},
    ),

  setPath: (path) => set((s) => (s.doc ? { doc: { ...s.doc, path } } : {})),

  closeMarkdown: () => set({ doc: null }),
}));
