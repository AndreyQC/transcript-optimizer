import { parseDocument, type Document } from "yaml";
import type { DictKind, LlmYamlSettings } from "../types/dictionaries";
import { norm as tokenNorm } from "../engine/tokenizer";

// Опции сериализации, при которых пакет `yaml` сохраняет стиль исходника:
// indentSeq:false — тире блочного списка на уровне родителя (как в образцах),
// lineWidth:0 — не переносить длинные строки.
const SERIALIZATION_OPTS = { indentSeq: false, lineWidth: 0 };

// Параметры добавления записи. Вид зависит от kind.
// Универсальный — чтобы UI-форма передавала простые строки.
export interface AddEntryInput {
  kind: DictKind;
  // Для replacements/lemma: to/label/description/from-array.
  // Для glossary: id/title/description.
  // Для filler/whitelist: section + value.
  // Для lemma_irregular: key + value.
  // Для settings: key + value.
  to?: string;
  label?: string;
  description?: string;
  from?: string[]; // replacements -> from; lemma -> from_lemmas
  id?: string; // glossary
  title?: string; // glossary
  section?: string; // filler: filler_words|filler_phrases|keep_override
  value?: string; // filler/whitelist/settings
  key?: string; // lemma_irregular/settings
  isLemma?: boolean; // replacements.yaml: добавить в lemma_replacements (from_lemmas)
  // replacements.yaml: вместо создания нового правила — дописать `from` (или
  // `from_lemmas`) в существующее правило `appendFromToRule`. Используется
  // кнопкой «Добавить в это правило» в панели «Похожие from» (см. similarity.ts).
  appendFromToRule?: string;
  appendFromSection?: "from" | "from_lemmas";
}

// Результат операции: новый сырой текст (для предпросмотра или записи).
// `noop` — операция не внесла изменений (используется для дедупликации
// и append при совпадении значения).
export interface EditResult {
  raw: string;
  ok: boolean;
  error?: string;
  noop?: boolean;
}

// Применить правку и вернуть новый текст. Не мутирует исходный raw.
function applyEdit(
  raw: string,
  fn: (doc: Document.Parsed) => void,
): EditResult {
  try {
    const doc = parseDocument(raw);
    if (doc.errors.length > 0) {
      return { raw, ok: false, error: "Файл содержит ошибки парсинга; правка невозможна" };
    }
    fn(doc);
    return { raw: doc.toString(SERIALIZATION_OPTS), ok: true };
  } catch (e) {
    return { raw, ok: false, error: String(e) };
  }
}

// Сгенерировать следующий ключ замены: replacement_rule_{max+1:03d} (или lemma_rule_*).
function nextRuleKey(doc: Document.Parsed, section: string, prefix: string): string {
  const block = doc.get(section, true) as
    | { items: { key: { value: string } }[] }
    | undefined;
  const nums: number[] = [];
  if (block && "items" in block) {
    for (const pair of block.items) {
      const m = String(pair.key?.value ?? "").match(/(\d+)$/);
      if (m) nums.push(parseInt(m[1], 10));
    }
  }
  const max = nums.length > 0 ? Math.max(...nums) : 0;
  return `${prefix}_${String(max + 1).padStart(3, "0")}`;
}

// Добавить запись в словарь. Возвращает новый raw (для превью/записи).
export function addEntry(raw: string, input: AddEntryInput): EditResult {
  return applyEdit(raw, (doc) => {
    switch (input.kind) {
      case "replacements": {
        // replacements.yaml — replacements (from) или lemma_replacements (from_lemmas).
        const isLemma = !!input.isLemma;
        const section = isLemma ? "lemma_replacements" : "replacements";
        const fromField = isLemma ? "from_lemmas" : "from";
        const prefix = isLemma ? "lemma_rule" : "replacement_rule";
        // Если передали appendFromToRule — дописываем в существующее правило
        // (кнопка «Добавить в это правило» из панели похожих from). Префикс секции
        // и fromField берём из этого аргумента, чтобы не зависеть от isLemma.
        if (input.appendFromToRule && input.appendFromSection) {
          const appended = appendFromToRuleInDoc(
            doc,
            input.appendFromToRule,
            (input.from ?? [])[0] ?? "",
            input.appendFromSection,
          );
          if (!appended.ok) {
            throw new Error(appended.error);
          }
          break;
        }
        const key = nextRuleKey(doc, section, prefix);
        const node = doc.createNode({
          to: input.to ?? "",
          label: input.label ?? "",
          ...(input.description ? { description: input.description } : {}),
          [fromField]: input.from ?? [],
        });
        (doc.get(section, true) as { set: (k: string, v: unknown) => void }).set(key, node);
        break;
      }
      case "glossary": {
        const cats = doc.get("categories", true) as
          | { set: (k: string, v: unknown) => void }
          | undefined;
        const node = doc.createNode({
          title: input.title ?? "",
          ...(input.description ? { description: input.description } : {}),
        });
        cats?.set(input.id ?? "", node);
        break;
      }
      case "filler": {
        const sec = input.section ?? "filler_words";
        const list = doc.get(sec, true) as { add: (v: string) => void } | undefined;
        list?.add(input.value ?? "");
        break;
      }
      case "whitelist": {
        const list = doc.get("common_words", true) as { add: (v: string) => void } | undefined;
        list?.add(input.value ?? "");
        break;
      }
      case "lemma_irregular": {
        // карта flexia -> lemma (этот kind не имеет replacements-структуры)
        const map = doc.get("lemma_irregular", true) as
          | { set: (k: string, v: string) => void }
          | undefined;
        map?.set(input.key ?? "", input.value ?? "");
        break;
      }
      case "settings": {
        const map = doc.get("settings", true) as
          | { set: (k: string, v: unknown) => void }
          | undefined;
        map?.set(input.key ?? "", input.value ?? "");
        break;
      }
    }
  });
}

// Удалить запись. Идентификатор зависит от kind:
// replacements/lemma — ключ правила; glossary — id категории;
// filler/whitelist — значение; lemma_irregular — flexia-ключ; settings — поле.
export interface DeleteEntryInput {
  kind: DictKind;
  key?: string; // replacements rule key / glossary id / lemma flexia / settings field
  section?: string; // filler section
  value?: string; // filler/whitelist value
  isLemma?: boolean; // replacements.yaml: удалять из lemma_replacements
}

export function deleteEntry(raw: string, input: DeleteEntryInput): EditResult {
  return applyEdit(raw, (doc) => {
    switch (input.kind) {
      case "replacements": {
        const section = input.isLemma ? "lemma_replacements" : "replacements";
        (doc.get(section, true) as { delete: (k: string) => unknown } | undefined)?.delete(input.key ?? "");
        break;
      }
      case "glossary": {
        (doc.get("categories", true) as { delete: (k: string) => unknown } | undefined)?.delete(input.key ?? "");
        break;
      }
      case "filler": {
        const sec = input.section ?? "filler_words";
        const list = doc.get(sec, true) as { items: { value: string }[] } | undefined;
        if (list && "items" in list) {
          const idx = list.items.findIndex((it) => it.value === input.value);
          if (idx >= 0) doc.deleteIn([sec, idx]);
        }
        break;
      }
      case "whitelist": {
        const list = doc.get("common_words", true) as { items: { value: string }[] } | undefined;
        if (list && "items" in list) {
          const idx = list.items.findIndex((it) => it.value === input.value);
          if (idx >= 0) doc.deleteIn(["common_words", idx]);
        }
        break;
      }
      case "lemma_irregular": {
        (doc.get("lemma_irregular", true) as { delete: (k: string) => unknown } | undefined)?.delete(input.key ?? "");
        break;
      }
      case "settings": {
        (doc.get("settings", true) as { delete: (k: string) => unknown } | undefined)?.delete(input.key ?? "");
        break;
      }
    }
  });
}

// Превью правки: новый raw без модификации исходного.
// Используется для мини-diff перед записью.
export function previewAdd(raw: string, input: AddEntryInput): EditResult {
  return addEntry(raw, input);
}
export function previewDelete(raw: string, input: DeleteEntryInput): EditResult {
  return deleteEntry(raw, input);
}

// Перезаписать подраздел `settings.llm` в settings.yaml новыми значениями.
// Сохраняет все остальные поля settings.yaml. Создаёт подраздел, если его не было.
// snake_case — по конвенции YAML-файлов проекта (не camelCase, как в lib/llm.ts).
export function setLlmSettings(raw: string, llm: LlmYamlSettings): EditResult {
  return applyEdit(raw, (doc) => {
    const settingsMap = doc.get("settings", true) as
      | { set: (k: string, v: unknown) => void }
      | undefined;
    if (!settingsMap) {
      // throw внутри applyEdit-колбэка ловится try/catch и возвращается как
      // EditResult с ошибкой. (Прежний `return … as unknown as void` НЕ работал —
      // колбэк типизирован как `void`, applyEdit игнорирует возвращаемое значение.)
      throw new Error("settings.yaml: нет корневого раздела `settings`");
    }
    const node = doc.createNode({
      base_url: llm.base_url,
      model: llm.model,
      temperature: llm.temperature,
      max_tokens: llm.max_tokens,
      // system_prompt_path — путь к .md-файлу промпта (опциональный; пустая
      // строка = файл не выбран). Тело промпта в YAML не дублируется.
      system_prompt_path: llm.system_prompt_path ?? "",
      user_prompt_template: llm.user_prompt_template,
    });
    settingsMap.set("llm", node);
  });
}

// === «Похожие from» (similarity.ts) =========================================
// Используется кнопкой «Добавить в это правило» в панели похожих from.

/** Результат `appendFromToRule`. `noop` означает «уже есть — не меняли». */
export interface AppendFromResult extends EditResult {
  noop?: boolean;
}

/**
 * Дописать `value` в список `from` (или `from_lemmas`) существующего правила
 * `ruleKey` в секции `replacements` / `lemma_replacements`. Через CST —
 * сохраняет комментарии и стиль.
 *
 * - Если `value` уже в списке — `noop: true`, raw не меняется.
 * - Если правило не найдено — возвращает `ok: false` с ошибкой.
 * - Если поля `from`/`from_lemmas` нет или оно не список — инициализирует списком.
 */
export function appendFromToRule(
  raw: string,
  ruleKey: string,
  value: string,
  section: "from" | "from_lemmas",
): AppendFromResult {
  const trimmed = value.trim();
  if (!trimmed) {
    return { raw, ok: false, error: "Пустое значение from" };
  }
  let noop = false;
  const result = applyEdit(raw, (doc) => {
    const res = appendFromToRuleInDoc(doc, ruleKey, trimmed, section);
    if (!res.ok) {
      throw new Error(res.error);
    }
    noop = !!res.noop;
  });
  if (!result.ok) {
    return { ...result, noop };
  }
  return { raw: result.raw, ok: true, noop };
}

/**
 * Хелпер для `appendFromToRule` и для `addEntry` (ветка `append`). Не делает
 * parse/raw — работает с уже распарсенным `doc`. Сообщает об ошибке через
 * возврат `{ ok: false, error }` (НЕ throw), чтобы вызывающий код мог решить,
 * как обработать.
 */
function appendFromToRuleInDoc(
  doc: Document.Parsed,
  ruleKey: string,
  value: string,
  section: "from" | "from_lemmas",
): { ok: boolean; noop?: boolean; error?: string } {
  // Корень содержит обе секции как map'ы. Ищем ключ в обеих — если есть только
  // в одной, это всё равно однозначно (rule_key уникален между секциями).
  let block:
    | { items: Array<{ key: { value: string }; value: unknown }> }
    | undefined;
  let blockPath: "replacements" | "lemma_replacements" | undefined;
  for (const p of ["replacements", "lemma_replacements"] as const) {
    const b = doc.get(p, true) as
      | { items: Array<{ key: { value: string }; value: unknown }> }
      | undefined;
    if (b && "items" in b && b.items.some((it) => it.key?.value === ruleKey)) {
      block = b;
      blockPath = p;
      break;
    }
  }
  if (!block || !blockPath) {
    return { ok: false, error: `Правило ${ruleKey} не найдено` };
  }
  const pair = block.items.find((it) => it.key?.value === ruleKey);
  if (!pair) return { ok: false, error: `Правило ${ruleKey} не найдено` };
  // pair.value — Pair<ValueNode> (или Scalar в простых случаях).
  const ruleNode = pair.value as
    | { get: (k: string, keepScalar?: boolean) => unknown; set: (k: string, v: unknown) => void }
    | undefined;
  if (!ruleNode || typeof ruleNode.get !== "function") {
    return { ok: false, error: `Неверный формат правила ${ruleKey}` };
  }
  const fromNode = ruleNode.get(section, true) as
    | { items: Array<{ value: string }>; add: (v: unknown) => void }
    | { value: string }
    | undefined;
  if (!fromNode) {
    // Поле отсутствует — создаём список из одного элемента.
    ruleNode.set(section, [value]);
    return { ok: true };
  }
  // Поле уже есть — если это Scalar (одно значение), превращаем в список.
  if ("value" in fromNode && typeof fromNode.value === "string") {
    if (fromNode.value === value) return { ok: true, noop: true };
    ruleNode.set(section, [fromNode.value, value]);
    return { ok: true };
  }
  // Иначе — список.
  const items = (fromNode as { items: Array<{ value: string }> }).items;
  if (items.some((it) => it.value === value)) {
    return { ok: true, noop: true };
  }
  (fromNode as { add: (v: unknown) => void }).add(value);
  return { ok: true };
}

/**
 * Найти 1-based номер строки ключа `ruleKey` в `raw` (для Monaco
 * `revealLineInCenter`). Ищет в обеих секциях `replacements` и
 * `lemma_replacements`. Возвращает null при ошибке парсинга или если ключ не
 * найден (например, файл уже отредактирован после `findRuleLine`).
 */
export function findRuleLine(raw: string, ruleKey: string): number | null {
  try {
    const doc = parseDocument(raw);
    if (doc.errors.length > 0) return null;
    for (const section of ["replacements", "lemma_replacements"] as const) {
      const pair = doc.getIn([section, ruleKey], true) as { line?: number } | undefined;
      if (pair && typeof pair.line === "number") {
        // eemeli/yaml: line — 0-based номер строки ключа map-пары.
        return pair.line + 1;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Дедуплицировать секцию `replacements` по нормализованному `to`
 * (lowercase + trim пробелов; см. решение 2026-07-15: «сравнивай канонические
 * формы в нижнем регистре»).
 *
 * Алгоритм:
 *   1. parseDocument → проверка parse-errors.
 *   2. Обойти пары секции `replacements` в исходном порядке.
 *   3. Для каждого правила: взять `to`, нормализовать (`norm(to).trim()`).
 *      Пустой `to` (битое правило) — пропускаем, оно не группа.
 *   4. Сгруппировать правила по нормализованному `to`.
 *   5. Для каждой группы с размером > 1:
 *        - берём первое правило (по порядку ключей в YAML-файле);
 *        - собираем уникальные `from` из всех правил группы (Set по
 *          нормализованному значению; первое встреченное написание сохраняем);
 *        - заменяем `first.from` на этот список;
 *        - удаляем остальные правила группы из CST.
 *   6. Вернуть новый raw. Если ни одна группа не имела дублей — `noop: true`,
 *      raw совпадает с исходным (мы НЕ делаем никаких CST-операций в этом случае).
 *
 * `label` берётся от первого правила (старейшего по ключу); `description`
 * других правил группы тихо отбрасывается (видны в diff как `- строки`).
 * `label` не «мерджится» — это минимально инвазивно и обратимо через undo.
 */
export function dedupByTo(raw: string): EditResult {
  let changed = false;
  const res = applyEdit(raw, (doc) => {
    const block = doc.get("replacements", true) as
      | {
          items: Array<{
            key: { value: string };
            value: { get: (k: string, keepScalar?: boolean) => unknown } | unknown;
          }>;
        }
      | undefined;
    if (!block || !("items" in block) || !Array.isArray(block.items)) {
      // секции нет или она не map — нечего дедуплицировать.
      return;
    }

    // Группировка пар по нормализованному `to`. `pairs: [перваяPair, ...остальные]`
    // (первая в YAML — старейшая).
    interface Group {
      firstKey: string;
      firstNode: { get: (k: string, keepScalar?: boolean) => unknown; set?: (k: string, v: unknown) => void };
      pairs: Array<{ key: { value: string }; value: unknown }>;
    }
    const groups = new Map<string, Group>();
    for (const pair of block.items) {
      const key = String(pair.key?.value ?? "");
      if (!key) continue;
      const ruleNode = pair.value as { get?: (k: string, keepScalar?: boolean) => unknown } | undefined;
      if (!ruleNode || typeof ruleNode.get !== "function") continue;
      const toScalar = ruleNode.get("to", true) as { value?: unknown } | undefined;
      const toRaw =
        toScalar && typeof toScalar === "object" && "value" in toScalar
          ? String((toScalar as { value?: unknown }).value ?? "")
          : "";
      const normTo = tokenNorm(toRaw).trim();
      if (!normTo) {
        // Пустой `to` — битое правило, не участвует в группах.
        continue;
      }
      const existing = groups.get(normTo);
      if (!existing) {
        groups.set(normTo, {
          firstKey: key,
          firstNode: ruleNode as Group["firstNode"],
          pairs: [pair],
        });
      } else {
        existing.pairs.push(pair);
      }
    }

    // Нормализация для сравнения `from`: lowercase + схлопнуть пробелы.
    const normFrom = (s: string) => tokenNorm(s).replace(/\s+/g, " ").trim();

    // Группы, где помимо первого правила есть хотя бы одна дубль-пара.
    const dupGroups = Array.from(groups.values()).filter((g) => g.pairs.length >= 2);
    if (dupGroups.length === 0) return; // без изменений — changed не поднимается.

    for (const g of dupGroups) {
      // Собираем уникальные `from` из всех пар группы (включая первую).
      const seen = new Set<string>();
      const mergedFrom: string[] = [];
      for (const pair of g.pairs) {
        const node = pair.value as { get?: (k: string, keepScalar?: boolean) => unknown } | undefined;
        if (!node || typeof node.get !== "function") continue;
        const fromList = node.get("from", true) as
          | { items?: Array<{ value?: unknown }> }
          | { value?: unknown }
          | undefined;
        const values: unknown[] = [];
        if (fromList && typeof fromList === "object") {
          if ("items" in fromList && Array.isArray((fromList as { items?: unknown[] }).items)) {
            for (const it of (fromList as { items: Array<{ value?: unknown }> }).items) {
              values.push(it.value);
            }
          } else if ("value" in fromList) {
            values.push((fromList as { value?: unknown }).value);
          }
        }
        for (const v of values) {
          if (typeof v !== "string") continue;
          const k = normFrom(v);
          if (!k || seen.has(k)) continue;
          seen.add(k);
          // Сохраняем написание первого встреченного — стабильно для diff.
          mergedFrom.push(v);
        }
      }
      // Перезаписываем `from` первого правила объединённым списком.
      // `set` на ноде правила сохраняет ключ и стиль блока, но список
      // `from` будет пересоздан — комментарии внутри списка теряются.
      // Это приемлемо: дедуп — крупная операция, diff покажет изменения.
      if (typeof g.firstNode.set === "function") {
        g.firstNode.set("from", mergedFrom);
      }
      // Удаляем остальные пары группы из CST.
      // `firstPair` — pairs[0], остальные — pairs[1..], они нам не нужны.
      const otherPairs = g.pairs.slice(1);
      for (const pair of otherPairs) {
        const k = String(pair.key?.value ?? "");
        if (k) doc.deleteIn(["replacements", k]);
      }
    }
    changed = true;
  });
  if (!res.ok) return res;
  return { ...res, noop: !changed };
}
