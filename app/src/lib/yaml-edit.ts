import { parseDocument, type Document } from "yaml";
import type { DictKind, LlmYamlSettings } from "../types/dictionaries";

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
}

// Результат операции: новый сырой текст (для предпросмотра или записи).
export interface EditResult {
  raw: string;
  ok: boolean;
  error?: string;
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
      // строка = файл не выбран). Тело промпта в YAML не хранится.
      system_prompt_path: llm.system_prompt_path ?? "",
      user_prompt_template: llm.user_prompt_template,
    });
    settingsMap.set("llm", node);
  });
}
