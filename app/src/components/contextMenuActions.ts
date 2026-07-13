// Контекстное меню ПКМ → словарь (этап 3).
// Маппинг выделения (слово/фраза) → действие над словарём.
// Идея: idea.md §4.3, §8.3.2.

// Идентификатор действия. Определяет целевой словарь и секцию.
export type ContextAction =
  | "whitelist" // detector_whitelist.yaml → common_words (слово корректное)
  | "filler_word" // filler.yaml → filler_words (одно слово)
  | "filler_phrase" // filler.yaml → filler_phrases (несколько слов)
  | "replace" // replacements.yaml → replacements (with label)
  | "lemma" // lemma_irregular.yaml → flexia -> lemma
  | "keep"; // filler.yaml → keep_override (не трогать)

// Выделение: одно слово или несколько (фраза). Определяет доступные действия.
export interface Selection {
  text: string; // как в тексте (без нормализации)
  isPhrase: boolean; // true если несколько токенов
}

// Какие действия доступны для данного выделения (idea §4.3, §8.3.2).
// Слово → все 5; фраза → filler_phrase/replacements/keep.
export const ACTIONS_FOR_SELECTION: (sel: Selection) => ContextAction[] = (sel) =>
  sel.isPhrase
    ? ["filler_phrase", "replace", "keep"]
    : ["whitelist", "filler_word", "replace", "lemma", "keep"];

// Человекочитаемые подписи действий для контекстного меню и формы.
export const ACTION_LABEL: Record<ContextAction, string> = {
  whitelist: "Добавить в whitelist",
  filler_word: "Удалить всегда (filler)",
  filler_phrase: "Удалить всегда (filler фраза)",
  replace: "Заменить на…",
  lemma: "Указать лемму",
  keep: "Не трогать (keep)",
};

// Короткое пояснение для формы действия.
export const ACTION_HINT: Record<ContextAction, string> = {
  whitelist: "Слово считается корректным — не подсвечивается как OOV.",
  filler_word: "Слово удаляется при очистке как заполнитель.",
  filler_phrase: "Фраза удаляется при очистке как заполнитель.",
  replace: "Слово/фраза заменяется на канонический термин (с категорией глоссария).",
  lemma: "Слово приводится к лемме при лемматизации.",
  keep: "Слово/фраза защищена от любых правил (keep_override).",
};
