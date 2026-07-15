// Нечёткое сравнение строк для «похожих `from`» при добавлении в словарь.
//
// Цель — поймать опечатки и падежные/регистровые варианты вроде
// "кодекс" vs "кодексе" vs "codex" ДО создания нового правила и предложить
// дописать значение в существующее.
//
// Алгоритм — Левенштейн на code points (`Array.from` вместо `length`,
// чтобы ё/Ё, лигатуры и эмодзи не «схлопывались» по 2 байта).
// O(n*m) по длине; для слов < 64 и десятков from — дешевле любой библиотеки.
//
// Нормализация переиспользует существующий `norm` из engine/tokenizer.ts
// (lowercase) + схлопывание пробелов для фраз.
//
// Без npm-зависимостей. Чистая, юнит-тестируемая.

import { norm as tokenNorm } from "../engine/tokenizer";

/**
 * Расстояние Левенштейна между двумя строками по code points.
 * 0 = идентичны. Для очень коротких строк работает корректно на кириллице.
 *
 * Работает на codepoints (через `Array.from(s)`), поэтому ё, ĳ и т. п.
 * считаются как один символ, а не как 2 UTF-16 единиц.
 */
export function editDistance(a: string, b: string): number {
  const A = Array.from(a);
  const B = Array.from(b);
  const n = A.length;
  const m = B.length;
  if (n === 0) return m;
  if (m === 0) return n;

  // DP: prev[j] = расстояние до A[0..i-1] vs B[0..j-1]
  let prev = new Array<number>(m + 1);
  let curr = new Array<number>(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;

  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    const ai = A[i - 1];
    for (let j = 1; j <= m; j++) {
      const cost = ai === B[j - 1] ? 0 : 1;
      const del = prev[j] + 1;
      const ins = curr[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      curr[j] = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[m];
}

/**
 * Схлопываем последовательности пробелов + trim; затем lowercase через `norm`.
 * Применяется ТОЛЬКО для сравнения (`from` хранится как ввёл пользователь).
 */
function normForCompare(s: string): string {
  return tokenNorm(s.replace(/\s+/g, " ").trim());
}

/**
 * 0..1 — нормализованная похожесть двух строк.
 * 1 = идентичны, 0 = полностью разные.
 *
 * Сравнение идёт по нормализованным строкам (lowercase + пробелы).
 * `sim = 1 - editDistance / max(len)`.
 *
 * Для идентичных строк возвращает 1 без лишних расчётов.
 */
export function similarityScore(a: string, b: string): number {
  const na = normForCompare(a);
  const nb = normForCompare(b);
  if (na === nb) return 1;
  const la = na.length;
  const lb = nb.length;
  if (la === 0 || lb === 0) return 0;
  const d = editDistance(na, nb);
  const max = la > lb ? la : lb;
  return 1 - d / max;
}

/** Кандидат, прошедший порог. */
export interface SimilarHit<T> {
  candidate: T;
  /** Ключ правила в YAML (например `replacement_rule_032`) — для UI и CTA. */
  sourceKey: string;
  /** Каноническая форма `to` — для отображения в подсказке. */
  to: string;
  /** 0..1, округлено до 2 знаков для стабильного рендера. */
  score: number;
}

/** Минимальный контракт элемента пула, что ожидает `findSimilar`. */
export interface SimilarPoolItem {
  /** Нормализованное значение (lowercase) для сравнения. */
  valueNorm: string;
  /** Ключ правила в YAML (например `replacement_rule_032`). */
  ruleKey: string;
  /** Каноническая форма `to` для отображения. */
  to: string;
  /** Длина нормализованного значения для быстрого коротко-строкового фильтра. */
  length: number;
}

/**
 * Отфильтровать пул кандидатов по похожести на `target` с порогом.
 *
 * Пустой target или target длиной 1 символ → пустой массив (нечему сравнивать).
 * Возвращает попадания, отсортированные по `score` ↓, при равенстве — по `ruleKey` ↑
 * (стабильно для рендера списка).
 *
 * Производительность: O(P * maxLen²). На типичном словаре (30-100 правил × 1-3 from,
 * длина < 24) укладывается в < 1 мс — замеры не нужны, кэш useMemo достаточно.
 */
export function findSimilar<T extends SimilarPoolItem>(
  target: string,
  pool: T[],
  threshold: number,
): SimilarHit<T>[] {
  const tn = normForCompare(target);
  if (tn.length < 2) return [];

  const hits: SimilarHit<T>[] = [];
  for (const item of pool) {
    if (item.valueNorm.length < 2) continue;
    // Быстрый отсев по грубой метрике длины (|la-lb|/max > 1 - threshold).
    const la = tn.length;
    const lb = item.valueNorm.length;
    const max = la > lb ? la : lb;
    const diff = max === 0 ? 0 : Math.abs(la - lb) / max;
    if (diff > 1 - threshold) continue;
    const d = editDistance(tn, item.valueNorm);
    const score = 1 - d / max;
    const rounded = Math.round(score * 100) / 100;
    if (rounded >= threshold) {
      hits.push({
        candidate: item,
        sourceKey: item.ruleKey,
        to: item.to,
        score: rounded,
      });
    }
  }
  hits.sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.sourceKey.localeCompare(b.sourceKey),
  );
  return hits;
}
