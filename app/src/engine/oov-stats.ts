// Агрегация OOV-слов для панели статистики (idea §8.4, этап «Статистика OOV»).
//
// Источник — decorations движка: берём только категории "oov" и "short-garbage"
// (слова вне effectiveWhitelist ∪ replacements ∪ filler). Группируем по
// нормализованной форме, считаем частоту, отображаем исходное написание.
// Нормализованный ключ делается через norm() из токенизатора — ровно так же,
// как матчит движок (регистронезависимо).
//
// Дополнительно (см. -=tasks=-/2026-07-15/20260715_001_oov_hide_phrase_tokens.md):
// токен скрывается из грида, если ВСЕ его вхождения в исходном транскрипте лежат
// внутри какой-либо многословной фразы из filler_phrases или replacements[*].from
// (≥ 2 слов после нормализации). Это убирает шум: пользователь уже «обработал»
// слово через правило-фразу целиком. Токен, который встречается «снаружи» хотя
// бы один раз, остаётся и его count считает все вхождения (внутри и снаружи).
import type { DecorationCategory } from "./types";
import type { CleanResult } from "./types";
import type { ParsedTranscript } from "./types";
import { tokenize, norm } from "./tokenizer";

export interface OovRow {
  display: string; // исходное написание (первое встретившееся)
  norm: string; // нормализованная форма — ключ агрегации
  count: number; // сколько раз слово встречается в тексте
  category: DecorationCategory; // "oov" | "short-garbage" (для бейджа)
}

// Контекст фильтрации по многословным фразам. Каждая фраза — нормализованная
// строка (toLowerCase) с ≥ 2 слов (≥ 1 пробел). Собирается в UI из словарей
// (filler.filler_phrases + replacements[*].from) и мемоизируется.
export interface OovStatsContext {
  phraseNorms: string[];
}

// Чистые числа (10, 50, 2026) не показываем как OOV — это шум, не требующий
// решения пользователя. Одна или более Unicode-цифр; для чисел norm(display)
// идентичен display. Составные числа с разделителями (10.5, 1,000) tokenize
// уже режет на отдельные числовые токены — каждый исключается этим правилом.
const NUMERIC_RE = /^\p{N}+$/u;

// Диапазон вхождения фразы в тексте одной реплики (без префикса [HH:MM:SS]).
interface PhraseSpan {
  start: number; // 0-based, относительно utt.text
  end: number;   // эксклюзивно
}

// Построить строки грида из cleanResult с учётом многословных фраз.
// Чистая функция — мемоизируется в UI. Сортировка: по убыванию count, затем
// по алфавиту display (стабильно).
//
// Если ctx не передан или phraseNorms пуст — поведение идентично прежней версии
// (ничего не скрываем), что важно для обратной совместимости unit-style вызовов.
export function buildOovRows(
  cleanResult: CleanResult,
  transcript?: ParsedTranscript | null,
  ctx?: OovStatsContext,
): OovRow[] {
  // 1. Базовый map из decorations (как раньше).
  const map = new Map<string, OovRow>();
  for (const d of cleanResult.decorations) {
    if (d.category !== "oov" && d.category !== "short-garbage") continue;
    const display = d.text;
    if (!display) continue; // декорация без текста — пропускаем (не должна быть)
    const key = norm(display);
    const existing = map.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      map.set(key, { display, norm: key, count: 1, category: d.category });
    }
  }
  if (map.size === 0) return [];

  // 2. Скрыть чистые числа (10, 50, 2026) — не требуют действия пользователя.
  //    По принципу §6: фильтрация шума — в агрегаторе, движок остаётся
  //    источником истины для decorations (числа остаются подсвеченными в
  //    transcript, но пропадают из OOV-грида).
  for (const key of map.keys()) {
    if (NUMERIC_RE.test(key)) map.delete(key);
  }
  if (map.size === 0) return [];

  // 3. Если контекста нет / фраз нет — отдаём как есть.
  if (!ctx || !ctx.phraseNorms || ctx.phraseNorms.length === 0) {
    return [...map.values()].sort(
      (a, b) => b.count - a.count || a.display.localeCompare(b.display),
    );
  }
  // Без транскрипта фразовую фильтрацию делать нельзя — отдаём базовое.
  if (!transcript) {
    return [...map.values()].sort(
      (a, b) => b.count - a.count || a.display.localeCompare(b.display),
    );
  }

  // 4. Собрать по utterance.text:
  //    - phraseSpansByLine: нормализованная фраза → Set диапазонов по каждой строке;
  //    - tokenOccurrences: norm → список координат (lineNo,start,end) каждого вхождения.
  const phraseSpansByLine = collectPhraseSpans(transcript, ctx.phraseNorms);
  const tokenOccurrences = collectTokenOccurrences(transcript);

  // 5. Для каждого norm в map: если ВСЕ его вхождения лежат внутри фраз —
  //    удалить из map. Для каждого occ — есть ли хотя бы один диапазон на его
  //    lineNo, в который occ[start..end) ⊂ span.
  for (const [key] of map) {
    const occs = tokenOccurrences.get(key);
    if (!occs || occs.length === 0) continue;
    const allInside = occs.every((occ) => {
      const spans = phraseSpansByLine.get(occ.lineNo);
      if (!spans || spans.length === 0) return false;
      return spans.some((sp) => occ.start >= sp.start && occ.end <= sp.end);
    });
    if (allInside) map.delete(key);
  }

  return [...map.values()].sort(
    (a, b) => b.count - a.count || a.display.localeCompare(b.display),
  );
}

// --- helpers ---------------------------------------------------------------

// Экранирование спецсимволов regex в phrase. Локальная копия — в rules.ts
// лежит приватный escapeRe, экспортировать его ради одного вызова не нужно.
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Regex с Unicode-границами слов (\p{L}, \p{N}). Логика повторяет движок
// (rules.ts:wordBoundaryRe), чтобы границы слов на кириллице совпадали.
function wordBoundaryRe(phrase: string, flags: "i" | "gi"): RegExp {
  const inner = escapeRe(phrase);
  return new RegExp(`(?<![\\p{L}\\p{N}])${inner}(?![\\p{L}\\p{N}])`, flags + "u");
}

// Пройти по всем репликам транскрипта, найти все вхождения каждой фразы и
// вернуть Map<lineNo, PhraseSpan[]>. lineNo — utterance.lineNo (1-based).
// Работаем по `utt.text` (без префикса [HH:MM:SS]), как и движок.
function collectPhraseSpans(
  transcript: ParsedTranscript,
  phraseNorms: string[],
): Map<number, PhraseSpan[]> {
  const result = new Map<number, PhraseSpan[]>();
  if (phraseNorms.length === 0) return result;
  for (const block of transcript.blocks) {
    for (const utt of block.utterances) {
      const text = utt.text;
      if (!text) continue;
      const spans: PhraseSpan[] = [];
      for (const phrase of phraseNorms) {
        if (phrase.length === 0) continue;
        const re = wordBoundaryRe(phrase, "gi");
        for (const m of text.matchAll(re)) {
          const start = m.index ?? 0;
          spans.push({ start, end: start + m[0].length });
        }
      }
      if (spans.length > 0) result.set(utt.lineNo, spans);
    }
  }
  return result;
}

// Все вхождения токенов в каждой реплике: Map<norm, {lineNo, start, end}[]>.
// Здесь используем `tokenize` из engine/tokenizer.ts — это ТОТ ЖЕ токенизатор,
// что и движок (нормализация/границы слов идентичны).
function collectTokenOccurrences(
  transcript: ParsedTranscript,
): Map<string, { lineNo: number; start: number; end: number }[]> {
  const result = new Map<string, { lineNo: number; start: number; end: number }[]>();
  for (const block of transcript.blocks) {
    for (const utt of block.utterances) {
      const text = utt.text;
      if (!text) continue;
      for (const tok of tokenize(text)) {
        const key = norm(tok.value);
        if (!key) continue;
        let arr = result.get(key);
        if (!arr) {
          arr = [];
          result.set(key, arr);
        }
        arr.push({ lineNo: utt.lineNo, start: tok.start, end: tok.end });
      }
    }
  }
  return result;
}
