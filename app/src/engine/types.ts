// Типы движка очистки транскрипта (idea.md §8, plan §5).
// Парсер → ParsedTranscript; правила → CleanResult; UI читает оба.

// --- Результат парсинга плоского .txt транскрипта --------------------------

export interface ParsedTranscript {
  headerLine: string | null; // строка-шапка (до первого спикера), может отсутствовать
  blocks: SpeakerBlock[]; // спикер → реплики
}

export interface SpeakerBlock {
  speaker: string; // имя без тега «(голос N)» — для группировки
  voiceTag: number | null; // номер голоса, если был; null если тега не было
  utterances: Utterance[];
}

export interface Utterance {
  time: string; // "HH:MM:SS"
  text: string; // исходный текст реплики (без префикса [time])
  lineNo: number; // 1-based номер строки в исходном файле — якорь для stage 3
  speakerLineNo: number; // 1-based номер строки заголовка спикера этого блока
}

// --- Результат применения правил -------------------------------------------

export interface CleanResult {
  cleanedText: string; // пересобранный плоский текст (speaker + time + cleaned)
  decorations: Decoration[]; // подсветка в ОРИГИНАЛЕ (левая панель)
  stats: CleanStats;
  replacementsApplied: ReplacementHit[]; // для таблицы статистики
}

export type DecorationCategory =
  | "oov" // вне whitelist — красный
  | "will-replace" // совпало с from правила замены — жёлтый
  | "filler-removed" // filler-слово/фраза, будет удалено — серый
  | "short-garbage"; // короче min_word_len — тёмно-серый

export interface Decoration {
  lineNo: number; // 1-based строка в исходном файле
  startCol: number; // 1-based колонка начала
  endCol: number; // 1-based колонка конца (эксклюзивно)
  category: DecorationCategory;
  note?: string; // например, id сработавшего правила
}

export interface ReplacementHit {
  original: string;
  replacement: string; // для filler-удаления — "(удалено)"
  type: "replace" | "filler";
  rule: string; // id правила или "filler_word"/"filler_phrase"
  count: number;
}

export interface CleanStats {
  totalWords: number;
  replaced: number; // применено замен
  removed: number; // удалено filler
  suspect: number; // OOV + short-garbage
}
