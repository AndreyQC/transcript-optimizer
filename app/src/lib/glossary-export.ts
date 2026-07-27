import type { ReplacementsFile, GlossaryFile, ReplacementRule, LemmaRule } from "../types/dictionaries";

interface TermEntry {
  to: string;
  label: string;
  description?: string;
  variants: string[]; // из from / from_lemmas
  source: "replacement" | "lemma";
}

export interface ExportInput {
  replacements: ReplacementsFile | null;
  glossary: GlossaryFile | null;
}

// Сгенерировать GLOSSARY.md (Markdown) из replacements + glossary.
// Термины сгруппированы по категориям (label -> title из glossary).
// Если правило ссылается на неизвестную категорию — попадает в раздел «Без категории».
export function exportGlossaryMarkdown(input: ExportInput): string {
  const { replacements, glossary } = input;
  const cats = glossary?.categories ?? {};
  const labelTitle = (id: string): string => cats[id]?.title ?? "Без категории";

  // Собрать все термины.
  const terms: TermEntry[] = [];
  if (replacements) {
    for (const rule of Object.values(replacements.replacements ?? {})) {
      const r = rule as ReplacementRule;
      terms.push({
        to: r.to,
        label: r.label,
        description: r.description,
        variants: r.from ?? [],
        source: "replacement",
      });
    }
    for (const rule of Object.values(replacements.lemma_replacements ?? {})) {
      const r = rule as LemmaRule;
      terms.push({
        to: r.to,
        label: r.label,
        description: r.description,
        variants: r.from_lemmas ?? [],
        source: "lemma",
      });
    }
  }

  // Сгруппировать по label, сохранив порядок первого появления категории.
  const groups = new Map<string, TermEntry[]>();
  const order: string[] = [];
  for (const t of terms) {
    if (!groups.has(t.label)) {
      groups.set(t.label, []);
      order.push(t.label);
    }
    groups.get(t.label)!.push(t);
  }

  // Сортировка терминов внутри группы — по алфавиту канонического термина.
  for (const arr of groups.values()) {
    arr.sort((a, b) => a.to.localeCompare(b.to, "ru"));
  }

  const lines: string[] = [];
  lines.push("# Глоссарий проекта");
  lines.push("");
  const replCount = terms.filter((t) => t.source === "replacement").length;
  const lemmaCount = terms.filter((t) => t.source === "lemma").length;
  lines.push(
    `Сгенерировано из \`replacements.yaml\` + \`glossary.yaml\`. Всего терминов: **${terms.length}** (${replCount} замен, ${lemmaCount} lemma-правил).`,
  );
  lines.push("");

  // Оглавление.
  if (order.length > 0) {
    lines.push("## Категории");
    lines.push("");
    for (const id of order) {
      const anchor = labelTitle(id).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-");
      lines.push(`- [${labelTitle(id)}](#${anchor}) (${groups.get(id)!.length})`);
    }
    lines.push("");
  }

  // Разделы по категориям.
  for (const id of order) {
    lines.push(`## ${labelTitle(id)}`);
    if (cats[id]?.description) {
      lines.push(`> ${cats[id].description}`);
      lines.push("");
    }
    for (const t of groups.get(id)!) {
      lines.push(`### ${t.to}`);
      if (t.description) {
        lines.push("");
        lines.push(t.description);
      }
      if (t.variants.length > 0) {
        lines.push("");
        lines.push(`**Варианты написания** (${t.source === "lemma" ? "по лемме" : "точное"}):`);
        lines.push("");
        for (const v of t.variants) lines.push(`- \`${v}\``);
      }
      lines.push("");
    }
  }

  if (terms.length === 0) {
    lines.push("_Нет терминов для экспорта (replacements.yaml пуст или не открыт)._");
    lines.push("");
  }

  return lines.join("\n");
}

// === Уплотнённый справочник замен ============================================
// Используется в двух потоках:
//   1. системный промпт саммари (streamChatCompletion в lib/llm.ts) — там к телу
//      спереди добавляется заголовок "🔹 СЛОВАРЬ НОРМАЛИЗАЦИИ ..." и обёртка
//      "ВАЖНО: ... / Используй исправленный текст ...";
//   2. артефакт на диске replacements.compact.txt (Toolbar) — для внешнего
//      пайплайна. Пишется как есть, без заголовка/обёртки.
//
// Поэтому функция возвращает ТОЛЬКО тело — по одной строке на правило. Один и
// тот же артефакт годится и для промпта, и для пайплайна.

interface CompactEntry {
  to: string;
  variants: string[]; // из from / from_lemmas
  label: string;
}

// Построить уплотнённый справочник нормализации. Возвращает только тело
// (по строке на правило), БЕЗ заголовка и БЕЗ обёртки промпта.
//
// Формат одной строки:
//   <вариант1>/<вариант2>/... → <to> (<label>)
// Если from/from_lemmas пустой или to пустой — правило пропускается.
// Возвращает пустую строку, если replacements == null или правил нет.
export function buildCompactReplacements(
  replacements: ReplacementsFile | null,
): string {
  if (!replacements) return "";

  const entries: CompactEntry[] = [];

  // Точные замены (from).
  for (const rule of Object.values(replacements.replacements ?? {})) {
    const r = rule as ReplacementRule;
    const variants = (r.from ?? []).filter((v) => typeof v === "string" && v.length > 0);
    const to = (r.to ?? "").trim();
    if (variants.length === 0 || to.length === 0) continue;
    entries.push({ to, variants, label: r.label });
  }

  // Замены по лемме (from_lemmas). Пометки источника не добавляем — для
  // компактности (см. план 20260727_001 §4 «Что включать в справочник»).
  for (const rule of Object.values(replacements.lemma_replacements ?? {})) {
    const r = rule as LemmaRule;
    const variants = (r.from_lemmas ?? []).filter(
      (v) => typeof v === "string" && v.length > 0,
    );
    const to = (r.to ?? "").trim();
    if (variants.length === 0 || to.length === 0) continue;
    entries.push({ to, variants, label: r.label });
  }

  if (entries.length === 0) return "";

  const lines = entries.map(
    (e) => `${e.variants.join("/")} → ${e.to} (${e.label})`,
  );
  return lines.join("\n");
}
