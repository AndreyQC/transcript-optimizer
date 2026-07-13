import type {
  ParsedTranscript,
  Utterance,
  CleanResult,
  Decoration,
  DecorationCategory,
  ReplacementHit,
  CleanStats,
} from "./types";
import type {
  Settings,
  FillerFile,
  ReplacementsFile,
  ReplacementRule,
  LemmaRule,
  WhitelistFile,
} from "../types/dictionaries";
import { tokenize, norm } from "./tokenizer";

// Вход для применения правил.
export interface RuleInput {
  settings: Settings | null;
  filler: FillerFile | null;
  replacements: ReplacementsFile | null;
  whitelist: WhitelistFile | null;
}

// «Эффективный whitelist» = common_words ∪ {все to из replacements/lemma}.
// Вычисляется в рантайме, НЕ пишется в detector_whitelist.yaml (idea §8.3.4).
// Все значения — в нижнем регистре (регистронезависимое сравнение).
export function effectiveWhitelist(
  whitelist: WhitelistFile | null,
  replacements: ReplacementsFile | null,
): Set<string> {
  const set = new Set<string>();
  for (const w of whitelist?.common_words ?? []) set.add(norm(w));
  if (replacements) {
    for (const rule of Object.values(replacements.replacements ?? {})) {
      set.add(norm((rule as ReplacementRule).to));
    }
    // lemma_replacements не применяем в MVP (нет лемматизатора), но их to
    // тоже считаем «известными», чтобы не плодить ложных OOV на каноничном термине.
    for (const rule of Object.values(replacements.lemma_replacements ?? {})) {
      set.add(norm((rule as unknown as LemmaRule).to));
    }
  }
  return set;
}

// Индекс замен: normalized from → { to, ruleKey, isName (для capitalize) }.
interface ReplaceIndex {
  to: string;
  ruleKey: string;
  // Требует ли capitalize в начале предложения (эвристика: to содержит заглавную).
  capitalize: boolean;
}
function buildReplaceIndex(replacements: ReplacementsFile | null): Map<string, ReplaceIndex> {
  const idx = new Map<string, ReplaceIndex>();
  if (!replacements) return idx;
  for (const [ruleKey, rule] of Object.entries(replacements.replacements ?? {})) {
    const r = rule as ReplacementRule;
    const capitalize = /[А-ЯA-Z]/.test(r.to.charAt(0));
    for (const from of r.from ?? []) {
      idx.set(norm(from), { to: r.to, ruleKey, capitalize });
    }
  }
  return idx;
}

// Главная функция: применить правила к распарсенному транскрипту.
export function applyRules(transcript: ParsedTranscript, input: RuleInput): CleanResult {
  const minWordLen = input.settings?.min_word_len ?? 3;
  const wl = effectiveWhitelist(input.whitelist, input.replacements);
  const replaceIdx = buildReplaceIndex(input.replacements);

  // Filler — в нижнем регистре, множества для быстрого лукапа.
  const fillerWords = new Set((input.filler?.filler_words ?? []).map(norm));
  const fillerPhrases = (input.filler?.filler_phrases ?? [])
    .map(norm)
    // длинные первыми — чтобы «в общем-то» матчило раньше «общем»
    .sort((a, b) => b.length - a.length);
  const keepOverride = new Set((input.filler?.keep_override ?? []).map(norm));

  const decorations: Decoration[] = [];
  const stats: CleanStats = { totalWords: 0, replaced: 0, removed: 0, suspect: 0 };
  const hitMap = new Map<string, ReplacementHit>(); // key -> hit (для агрегации count)

  const cleanedLines: string[] = [];
  if (transcript.headerLine) {
    cleanedLines.push(transcript.headerLine, "");
  }

  for (const block of transcript.blocks) {
    // Заголовок спикера (без голос-тега? нет — сохраняем как в оригинале через пересборку).
    const speakerHeader = block.voiceTag !== null
      ? `${block.speaker} (голос ${block.voiceTag}):`
      : `${block.speaker}:`;
    cleanedLines.push(speakerHeader);

    for (const utt of block.utterances) {
      const cleaned = cleanUtterance(
        utt,
        { replaceIdx, fillerWords, fillerPhrases, keepOverride, wl, minWordLen },
        decorations,
        stats,
        hitMap,
      );
      cleanedLines.push(`[${utt.time}] ${cleaned}`);
    }
    cleanedLines.push(""); // пустая между блоками
  }

  // Убрать последний лишний пустой перенос (если был добавлен).
  const cleanedText = cleanedLines.join("\n").replace(/\n+$/, "\n");

  const replacementsApplied = [...hitMap.values()].sort((a, b) => b.count - a.count);

  return { cleanedText, decorations, stats, replacementsApplied };
}

// Контекст очистки одной реплики (чтобы не тащить длинный список аргументов).
interface CleanCtx {
  replaceIdx: Map<string, ReplaceIndex>;
  fillerWords: Set<string>;
  fillerPhrases: string[];
  keepOverride: Set<string>;
  wl: Set<string>;
  minWordLen: number;
}

// Очистить текст одной реплики. Порядок (idea §8.4):
//   1. filler_phrases (точное совпадение подстроки) → удалить
//   2. replacements (слово/фраза → to)
//   3. filler_words (токен совпал → удалить, кроме keep_override)
//   4. пометить OOV (вне whitelist) и short-garbage decorations в ИСХОДНОМ тексте.
// Decorations всегда считаются по оригинальной строке (left pane = original).
function cleanUtterance(
  utt: Utterance,
  ctx: CleanCtx,
  decorations: Decoration[],
  stats: CleanStats,
  hitMap: Map<string, ReplacementHit>,
): string {
  // Работаем с копией текста; decorations по исходному.
  const origText = utt.text;
  let text = origText;

  // Сдвиг колонок для Monaco: в оригинальной строке перед текстом реплики
  // идёт префикс «[HH:MM:SS] » (длина 11). Токены/offset-ы считаем от text
  // (без префикса), а Monaco показывает строку с префиксом → сдвигаем.
  const colShift = `[${utt.time}] `.length; // = 11

  // 1. Filler-фразы — по подстроке (с границами слов, регистронезависимо).
  for (const phrase of ctx.fillerPhrases) {
    const re = wordBoundaryRe(phrase, "gi");
    text = text.replace(re, (match, offset) => {
      // keep_override исключает удаление.
      if (ctx.keepOverride.has(norm(match))) return match;
      addDecoration(decorations, utt.lineNo, offset + colShift + 1, offset + colShift + 1 + match.length, "filler-removed", "filler_phrase");
      addHit(hitMap, match, "(удалено)", "filler", "filler_phrase");
      stats.removed += 1;
      return ""; // удаляем
    });
  }
  // Зачистка двойных пробелов после удаления фраз.
  text = text.replace(/[ \t]{2,}/g, " ").replace(/\s+\./g, ".").trim();

  // 2. Replacements — по токенам (слово целиком), регистронезависимо.
  // Делаем по исходному тексту, чтобы позиции decorations были корректны.
  // Заменяем в `text`, но ищем позиции в `origText` (для упрощения MVP считаем
  // позиции по текущему text — replacements применяются после filler, поэтому
  // смещения могут отличаться; для decorations используем поиск по origText).
  const origTokens = tokenize(origText);
  let workText = text;
  for (const tok of origTokens) {
    const key = norm(tok.value);
    const rep = ctx.replaceIdx.get(key);
    if (!rep) continue;
    if (ctx.keepOverride.has(key)) continue;
    // Позиция в origText + сдвиг префикса (1-based col).
    addDecoration(decorations, utt.lineNo, tok.start + colShift + 1, tok.end + colShift + 1, "will-replace", rep.ruleKey);
    addHit(hitMap, tok.value, rep.to, "replace", rep.ruleKey);
    stats.replaced += 1;
    // Замена в workText: ищем токен по значению (word-boundary, регистронезависимо).
    const reTok = wordBoundaryRe(tok.value, "i");
    // capitalize, если токен в начале строки и to ожидает заглавную.
    const isSentenceStart = isAtSentenceStart(origText, tok.start);
    const replacement = rep.capitalize && isSentenceStart ? capitalize(rep.to) : rep.to;
    workText = workText.replace(reTok, replacement);
  }
  text = workText;

  // 3. Filler-слова — по токенам текущего text.
  // decorations/keep-логику считаем по исходным словам (origTokens), чтобы
  // не ложноположить на уже-заменённые. Для удаления используем текущий text.
  const toRemove: { value: string; start: number }[] = [];
  for (const tok of tokenize(text)) {
    const key = norm(tok.value);
    if (ctx.fillerWords.has(key) && !ctx.keepOverride.has(key) && !ctx.replaceIdx.has(key)) {
      toRemove.push({ value: tok.value, start: tok.start });
    }
  }
  // Удаляем с конца к началу, чтобы не сбить индексы.
  for (let i = toRemove.length - 1; i >= 0; i--) {
    const { value, start } = toRemove[i];
    text = text.slice(0, start) + text.slice(start + value.length);
      addDecoration(decorations, utt.lineNo, start + colShift + 1, start + colShift + 1 + value.length, "filler-removed", "filler_word");
    addHit(hitMap, value, "(удалено)", "filler", "filler_word");
    stats.removed += 1;
  }
  text = text.replace(/[ \t]{2,}/g, " ").replace(/\s+([.,;!?])/g, "$1").trim();

  // 4. OOV и short-garbage decorations — по исходным токенам (в original pane).
  for (const tok of origTokens) {
    const key = norm(tok.value);
    stats.totalWords += 1;
    // уже учтено как replacement/filler — пропускаем suspect-проверку
    if (ctx.replaceIdx.has(key) || (ctx.fillerWords.has(key) && !ctx.keepOverride.has(key))) continue;
    if (ctx.wl.has(key)) continue;
    if (tok.value.length < ctx.minWordLen) {
      addDecoration(decorations, utt.lineNo, tok.start + colShift + 1, tok.end + colShift + 1, "short-garbage");
      stats.suspect += 1;
    } else {
      addDecoration(decorations, utt.lineNo, tok.start + colShift + 1, tok.end + colShift + 1, "oov");
      stats.suspect += 1;
    }
  }

  return text;
}

// --- helpers ---------------------------------------------------------------

function addDecoration(
  out: Decoration[],
  lineNo: number,
  startCol: number,
  endCol: number,
  category: DecorationCategory,
  note?: string,
): void {
  out.push({ lineNo, startCol, endCol, category, note });
}

function addHit(
  hitMap: Map<string, ReplacementHit>,
  original: string,
  replacement: string,
  type: "replace" | "filler",
  rule: string,
): void {
  const key = `${original}\u0000${rule}`;
  const existing = hitMap.get(key);
  if (existing) {
    existing.count += 1;
  } else {
    hitMap.set(key, { original, replacement, type, rule, count: 1 });
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Regex для точного совпадения слова/фразы с границами. JS-овый `\b` определён
// через `[A-Za-z0-9_]` и НЕ работает с кириллицей/Unicode — поэтому используем
// lookaround с Unicode property escapes (`\p{L}` = любая буква, `\p{N}` = цифра)
// и флаг `u`. Слово считается отдельным, если слева/справа нет буквы или цифры.
// Дефис/апостроф внутри фразы (напр. «код-ревью») допускаются — они не являются
// границей (соответствует логике токенизатора).
function wordBoundaryRe(phrase: string, flags: "i" | "gi"): RegExp {
  const inner = escapeRe(phrase);
  return new RegExp(`(?<![\\p{L}\\p{N}])${inner}(?![\\p{L}\\p{N}])`, flags + "u");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Находится ли позиция в начале предложения (начало строки или после [.!?] + пробел).
function isAtSentenceStart(text: string, pos: number): boolean {
  const before = text.slice(0, pos).trimEnd();
  if (before.length === 0) return true;
  return /[.!?]\s*$/.test(before);
}
