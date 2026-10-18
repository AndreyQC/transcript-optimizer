// Агент предложений по словарю (Phase 10 §10.8): пакетный проход по OOV
// текущего транскрипта. Переиспользует движковые buildOovRows + similarity —
// один источник правды для norm/tokenize (урок LESSONS §6).
//
// Агент НЕ пишет в словарь сам: UI показывает чеклист, применения идут через
// yaml-edit в существующий pending/Превью/Применить (урок LESSONS §8).

import { buildOovRows } from "../engine/oov-stats";
import type { CleanResult, ParsedTranscript } from "../engine/types";
import { similarityScore } from "./similarity";

export interface Proposal {
  from: string; // исходное написание (display) — кандидат в replacements.from
  count: number; // вхождений в транскрипте
  similar: string[]; // похожие существующие from (Левенштейн, сверху вниз)
}

// Пороги совпадают с SimilarFromPanel (одна функция порогов на проект).
const SINGLE_THRESHOLD = 0.78;

export function buildProposals(
  cleanResult: CleanResult,
  transcript: ParsedTranscript | null,
  phraseNorms: string[],
  existingFrom: string[], // нормализованные from текущего replacements.yaml
  limit = 30,
): Proposal[] {
  const rows = buildOovRows(cleanResult, transcript, { phraseNorms });
  const existing = new Set(existingFrom);
  const out: Proposal[] = [];
  for (const row of rows) {
    if (existing.has(row.norm)) continue;
    const similar: string[] = [];
    for (const cand of existing) {
      if (similarityScore(row.norm, cand) >= SINGLE_THRESHOLD) {
        similar.push(cand);
        if (similar.length >= 3) break;
      }
    }
    out.push({ from: row.display, count: row.count, similar });
    if (out.length >= limit) break;
  }
  // Сначала кандидаты с fuzzy-матчем (вероятная опечатка существующего),
  // затем по частоте.
  out.sort((a, b) => {
    const sa = a.similar.length > 0 ? 1 : 0;
    const sb = b.similar.length > 0 ? 1 : 0;
    if (sa !== sb) return sb - sa;
    return b.count - a.count;
  });
  return out;
}
