// TypeScript-типы схем словарей.
// Выведены из фактических файлов sample/ (см. -=tasks=-/2026-07-09/20260709_002_plan.md §5).

// settings.yaml
export interface SettingsFile {
  settings: Settings;
}
export interface Settings {
  aggressive_clean: boolean;
  similarity_threshold: number; // 0..1
  min_word_len: number;
  suggestions_header: boolean;
}

// glossary.yaml — enum категорий для label (idea.md §10.7)
export interface GlossaryFile {
  categories: Record<string, GlossaryCategory>; // ключ = id категории (snake_case)
}
export interface GlossaryCategory {
  title: string; // человекочитаемый заголовок для UI
  description?: string;
}

// filler.yaml
export interface FillerFile {
  filler_words: string[];
  filler_phrases: string[];
  keep_override: string[];
}

// replacements.yaml — замены + глоссарий проекта (idea.md §10.1)
export interface ReplacementsFile {
  replacements: Record<string, ReplacementRule>; // ключ replacement_rule_NNN
  lemma_replacements: Record<string, LemmaRule>; // ключ lemma_rule_NNN
}
export interface ReplacementRule {
  to: string;
  label: string; // ОБЯЗАТЕЛЕН: id категории из glossary.yaml
  description?: string; // опционально: определение термина
  from: string[]; // всегда список, даже из одного элемента
}
export interface LemmaRule {
  to: string;
  label: string; // ОБЯЗАТЕЛЕН и для lemma-правил
  description?: string;
  from_lemmas: string[];
}

// lemma_irregular.yaml
export interface LemmaIrregularFile {
  lemma_irregular: Record<string, string>;
}

// detector_whitelist.yaml
export interface WhitelistFile {
  common_words: string[];
}

// Дискриминированное объединение для UI
export type DictKind =
  | "settings"
  | "glossary"
  | "filler"
  | "replacements"
  | "lemma_irregular"
  | "whitelist";

export type DictFile =
  | { kind: "settings"; data: SettingsFile }
  | { kind: "glossary"; data: GlossaryFile }
  | { kind: "filler"; data: FillerFile }
  | { kind: "replacements"; data: ReplacementsFile }
  | { kind: "lemma_irregular"; data: LemmaIrregularFile }
  | { kind: "whitelist"; data: WhitelistFile };

// Контракт имён файлов (автодетект по точному имени).
export const FILE_CONTRACT: Record<string, DictKind> = {
  "settings.yaml": "settings",
  "glossary.yaml": "glossary",
  "filler.yaml": "filler",
  "replacements.yaml": "replacements",
  "lemma_irregular.yaml": "lemma_irregular",
  "detector_whitelist.yaml": "whitelist",
};

// Запись о словаре в store: путь, разобранные данные, сырой текст, флаг несохранённых правок.
export interface DictEntry {
  kind: DictKind;
  path: string;
  raw: string; // исходный текст файла (для Monaco)
  data: unknown; // разобранное содержимое (типизируется по kind при использовании)
  dirty: boolean; // есть несохранённые правки в редакторе
}

// Порядок вкладок в UI.
export const TAB_ORDER: DictKind[] = [
  "settings",
  "glossary",
  "filler",
  "replacements",
  "lemma_irregular",
  "whitelist",
];

export const KIND_LABEL: Record<DictKind, string> = {
  settings: "settings",
  glossary: "glossary",
  filler: "filler",
  replacements: "replacements",
  lemma_irregular: "lemma_irregular",
  whitelist: "detector_whitelist",
};
