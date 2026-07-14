import type { CleanResult, ReplacementHit } from "../engine/types";

// Экспорт таблицы статистики в Markdown (idea §4.5).
export function exportStatsMarkdown(result: CleanResult): string {
  const s = result.stats;
  const lines: string[] = [];
  lines.push("# Статистика очистки");
  lines.push("");
  lines.push(
    `Всего слов: **${s.totalWords}** · заменено: **${s.replaced}** · удалено (filler): **${s.removed}** · подозрительных: **${s.suspect}**`,
  );
  lines.push("");

  const replaces = result.replacementsApplied.filter((h) => h.type === "replace");
  const fillers = result.replacementsApplied.filter((h) => h.type === "filler");

  if (replaces.length > 0) {
    lines.push("## Замены");
    lines.push("");
    lines.push("| Исходное | Замена | Правило | Кол-во |");
    lines.push("|---|---|---|---|");
    for (const h of replaces) {
      lines.push(`| ${h.original} | ${h.replacement} | ${h.rule} | ${h.count} |`);
    }
    lines.push("");
  }

  if (fillers.length > 0) {
    lines.push("## Удалённые filler-слова/фразы");
    lines.push("");
    lines.push("| Слово/фраза | Тип | Кол-во |");
    lines.push("|---|---|---|");
    for (const h of fillers) {
      lines.push(`| ${h.original} | ${h.rule} | ${h.count} |`);
    }
    lines.push("");
  }

  if (replaces.length === 0 && fillers.length === 0) {
    lines.push("_Нет применённых правил._");
    lines.push("");
  }

  return lines.join("\n");
}

// Сортировка хитов по частоте (для UI-таблицы).
export function sortByCount(hits: ReplacementHit[]): ReplacementHit[] {
  return [...hits].sort((a, b) => b.count - a.count);
}
