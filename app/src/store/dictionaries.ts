import { create } from "zustand";
import { parse } from "yaml";
import type { DictEntry, DictKind } from "../types/dictionaries";

// Undo-стек хранит историю raw по kind. Каждое AST-правка (applyEdit) кладёт
// предыдущее состояние; markSaved очищает стек (точка сохранения = корень).
// Ручные правки в Monaco (editRaw) в стек не идут — иначе он переполнится на
// каждый символ; undo предназначен для осознанных структурных правок.
interface UndoState {
  // kind -> массив предыдущих raw (последний = вершина для undo).
  stacks: Record<string, string[]>;
  // kind -> raw состояния на момент последнего сохранения (для пометки dirty
  // после undo: если после undo вернулись к saved-состоянию, dirty=false).
  savedSnapshots: Record<string, string | undefined>;
}

interface DictionariesState {
  dir: string | null; // открытая директория словарей
  entries: DictEntry[]; // распознанные файлы по контракту имён
  unknownPaths: string[]; // .yaml/.yml файлы с нераспознанной схемой
  activeKind: DictKind | null; // активная вкладка
  undoState: UndoState;

  openDir: (dir: string, entries: DictEntry[], unknownPaths: string[]) => void;
  closeDir: () => void;
  setActive: (kind: DictKind) => void;
  // Обновить raw и флаг dirty при правке в Monaco (не попадает в undo-стек).
  editRaw: (kind: DictKind, raw: string) => void;
  // Применить AST-правку (изменённый raw) + пере-парсить data + push undo.
  applyEdit: (kind: DictKind, raw: string) => void;
  // Пометить файл сохранённым (dirty=false) после записи на диск; сброс undo-корня.
  markSaved: (kind: DictKind, raw: string) => void;
  // Отменить последнюю AST-правку (вернуть предыдущий raw). true, если было что отменить.
  undo: (kind: DictKind) => boolean;
  // Можно ли отменить правку для kind.
  canUndo: (kind: DictKind) => boolean;
}

export const useDictionaries = create<DictionariesState>((set, get) => ({
  dir: null,
  entries: [],
  unknownPaths: [],
  activeKind: null,
  undoState: { stacks: {}, savedSnapshots: {} },

  openDir: (dir, entries, unknownPaths) => {
    // Снимок сохранённого состояния каждого файла — корень undo.
    const savedSnapshots: Record<string, string | undefined> = {};
    for (const e of entries) savedSnapshots[e.kind] = e.raw;
    set({
      dir,
      entries,
      unknownPaths,
      activeKind: entries[0]?.kind ?? null,
      undoState: { stacks: {}, savedSnapshots },
    });
  },

  closeDir: () =>
    set({
      dir: null,
      entries: [],
      unknownPaths: [],
      activeKind: null,
      undoState: { stacks: {}, savedSnapshots: {} },
    }),

  setActive: (kind) => set({ activeKind: kind }),

  editRaw: (kind, raw) =>
    set((state) => ({
      entries: state.entries.map((e) =>
        e.kind === kind ? { ...e, raw, dirty: true } : e,
      ),
    })),

  applyEdit: (kind, raw) =>
    set((state) => {
      const prev = state.entries.find((e) => e.kind === kind);
      if (!prev) return {};
      // Положить предыдущее состояние в undo-стек этого kind.
      const stack = [...(state.undoState.stacks[kind] ?? []), prev.raw];
      const entries = state.entries.map((e) => {
        if (e.kind !== kind) return e;
        let data: unknown = e.data;
        try {
          data = parse(raw);
        } catch {
          // невалидный результат правки — оставляем старый data
        }
        return { ...e, raw, data, dirty: true };
      });
      return {
        entries,
        undoState: {
          ...state.undoState,
          stacks: { ...state.undoState.stacks, [kind]: stack },
        },
      };
    }),

  markSaved: (kind, raw) =>
    set((state) => ({
      entries: state.entries.map((e) =>
        e.kind === kind ? { ...e, raw, dirty: false } : e,
      ),
      // Точка сохранения = новый корень undo: очищаем стек.
      undoState: {
        stacks: { ...state.undoState.stacks, [kind]: [] },
        savedSnapshots: { ...state.undoState.savedSnapshots, [kind]: raw },
      },
    })),

  undo: (kind) => {
    const state = get();
    const stack = state.undoState.stacks[kind] ?? [];
    if (stack.length === 0) return false;
    const prevRaw = stack[stack.length - 1];
    const newStack = stack.slice(0, -1);
    const saved = state.undoState.savedSnapshots[kind];
    set({
      entries: state.entries.map((e) => {
        if (e.kind !== kind) return e;
        let data: unknown = e.data;
        try {
          data = parse(prevRaw);
        } catch {
          // оставляем старый data
        }
        // Если после undo вернулись к сохранённому состоянию — dirty=false.
        const dirty = prevRaw !== saved;
        return { ...e, raw: prevRaw, data, dirty };
      }),
      undoState: {
        ...state.undoState,
        stacks: { ...state.undoState.stacks, [kind]: newStack },
      },
    });
    return true;
  },

  canUndo: (kind) => (get().undoState.stacks[kind] ?? []).length > 0,
}));

// Существует ли хотя бы один unsaved-файл (для подтверждения перед закрытием).
export function selectHasUnsaved(state: DictionariesState): boolean {
  return state.entries.some((e) => e.dirty);
}

// Производный селектор: множество id категорий из glossary.yaml.
// Используется валидатором replacements для проверки label ∈ glossary.
export function selectGlossaryCategories(state: DictionariesState): Set<string> {
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
