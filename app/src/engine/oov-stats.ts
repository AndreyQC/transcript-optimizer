// Агрегация OOV-слов для панели статистики (idea §8.4, этап «Статистика OOV»).
//
// Источник — decorations движка: берём только категории "oov" и "short-garbage"
// (слова вне effectiveWhitelist ∪ replacements ∪ filler). Группируем по
// нормализованной форме, считаем частоту, отображаем исходное написание.
// Нормализованный ключ делается через norm() из токенизатора — ровно так же,
// как матчит движок (регистронезависимо).
import type { DecorationCategory } from "./types";
import type { CleanResult } from "./types";
import { norm } from "./tokenizer";

export interface OovRow {
  display: string; // исходное написание (первое встретившееся)
  norm: string; // нормализованная форма — ключ агрегации
  count: number; // сколько раз слово встречается в тексте
  category: DecorationCategory; // "oov" | "short-garbage" (для бейджа)
}

// Построить строки грида из cleanResult. Чистая функция — мемоизируется в UI.
// Сортировка: по убыванию count, затем по алфавиту display (стабильно).
export function buildOovRows(cleanResult: CleanResult): OovRow[] {
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
  return [...map.values()].sort(
    (a, b) => b.count - a.count || a.display.localeCompare(b.display),
  );
}
