import { create } from "zustand";
import { parse } from "yaml";
import type { DictEntry, DictKind } from "../types/dictionaries";

interface DictionariesState {
  dir: string | null; // открытая директория словарей
  entries: DictEntry[]; // распознанные файлы по контракту имён
  unknownPaths: string[]; // .yaml/.yml файлы с нераспознанной схемой
  activeKind: DictKind | null; // активная вкладка

  openDir: (dir: string, entries: DictEntry[], unknownPaths: string[]) => void;
  closeDir: () => void;
  setActive: (kind: DictKind) => void;
  // Обновить raw и флаг dirty при правке в Monaco.
  editRaw: (kind: DictKind, raw: string) => void;
  // Применить AST-правку (изменённый raw) + пере-парсить data.
  applyEdit: (kind: DictKind, raw: string) => void;
  // Пометить файл сохранённым (dirty=false) после записи на диск.
  markSaved: (kind: DictKind, raw: string) => void;
}

export const useDictionaries = create<DictionariesState>((set) => ({
  dir: null,
  entries: [],
  unknownPaths: [],
  activeKind: null,

  openDir: (dir, entries, unknownPaths) =>
    set({
      dir,
      entries,
      unknownPaths,
      activeKind: entries[0]?.kind ?? null,
    }),

  closeDir: () =>
    set({ dir: null, entries: [], unknownPaths: [], activeKind: null }),

  setActive: (kind) => set({ activeKind: kind }),

  editRaw: (kind, raw) =>
    set((state) => ({
      entries: state.entries.map((e) =>
        e.kind === kind ? { ...e, raw, dirty: true } : e,
      ),
    })),

  markSaved: (kind, raw) =>
    set((state) => ({
      entries: state.entries.map((e) =>
        e.kind === kind ? { ...e, raw, dirty: false } : e,
      ),
    })),
  // Применить AST-правку: заменить raw + пере-парсить data, поставить dirty.
  applyEdit: (kind, raw) =>
    set((state) => ({
      entries: state.entries.map((e) => {
        if (e.kind !== kind) return e;
        let data: unknown = e.data;
        try {
          data = parse(raw);
        } catch {
          // невалидный результат правки — оставляем старый data
        }
        return { ...e, raw, data, dirty: true };
      }),
    })),
}));

// Производный селектор: множество id категорий из glossary.yaml.
// Используется валидатором replacements для проверки label ∈ glossary.
export function selectGlossaryCategories(
  state: DictionariesState,
): Set<string> {
  const cats = new Set<string>();
  const glossary = state.entries.find((e) => e.kind === "glossary");
  if (glossary && glossary.data && typeof glossary.data === "object") {
    const categories = (glossary.data as { categories?: Record<string, unknown> }).categories;
    if (categories && typeof categories === "object") {
      for (const id of Object.keys(categories)) cats.add(id);
    }
  }
  return cats;
}
