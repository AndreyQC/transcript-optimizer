# План: уплотнённый справочник замен в системном промпте саммари

**Дата:** 2026-07-27
**Проект:** transcript-optimizer (Tauri 2 + React 19 + TypeScript + Rust)
**Файл:** `-=tasks=-/2026-07-27/20260727_001_compact_replacements_in_prompt_plan.md`
**Статус:** plan
**Ревизия:** v2 — добавлена запись компакт-файла на диск для внешнего пайплайна (Часть 6).

---

## Контекст

> - `-=CHECKPOINTS=-/20260722_001_checkpoint.md` (последний снапшот, конец Phase 8)
> - `-=tasks=-/TASK_CONVENTIONS.md`
> - `-=PHASES=-/Phase_08.md`
> - `sample/transcript_optimizer/replacements.yaml` — источник справочника замен
> - `app/src/lib/llm.ts` — сборка системного промпта (`streamChatCompletion`)
> - `app/src/lib/glossary-export.ts` — образец обхода replacements/lemma_replacements

---

## 1. Цель

По открытым replacements.yaml формировать **уплотнённый справочник нормализации**
(минималистичный CSV-подобный формат) и использовать его двумя способами:

1. **В промпте саммари (в-app).** Подмешивать в системный промпт при генерации
   саммари. Чекбокс в настройках LLM включает/выключает подмешивание (для
   A/B-сравнения влияния замен на выходной саммари).
2. **На диске как артефакт (для внешнего пайплайна).** Записывать компакт-файл
   `replacements.compact.txt` рядом с `replacements.yaml`, чтобы автоматический
   пайплайн мог читать готовый файл без повторной сборки. Запись — при сохранении
   `replacements.yaml` (синхронно с исходником) + по ручной кнопке экспорта.

Тело компакт-файла (только словарь, без обёртки):

```
мини Макс/минимакс/mini max → Minimax (brand_product)
опен код/open code → OpenCode (brand_product)
джем борд/джемборд → дашборд (tech_term)
Самри → Саммари (linguistic)
жире/джира → JIRA (brand_product)
слак → Slack (brand_product)
...
```

Обрамляющая инструкция — ТОЛЬКО для варианта (1), в системный промпт саммари:

```
ВАЖНО: Перед генерацией саммари примени автозамену терминов в транскрипте по правилам:
<уплотнённый справочник>

Используй исправленный текст как основу. В финальном саммари выводи ТОЛЬКО
нормализованные варианты (колонка "→").
```

В файл на диске обёртку НЕ пишем — пайплайн оборачивает сам.

---

## 2. Зачем это нужно

- Сейчас модель получает «грязный» транскрипт (опечатки, жаргон, разные написания
  бренда) и нормализует ad hoc — непредсказуемо. Явный словарь в промпте даёт
  детерминированную нормализацию ДО саммаризации.
- Уплотнённый (не Markdown-таблица) формат минимизирует токены и хорошо читается
  моделью — одна строка = одно правило.
- Чекбокс «подмешивать да/нет» позволяет сравнить саммари с заменами и без на одном
  транскрипте — чтобы оценить, улучшают ли замены выход (или, наоборот, вносят шум).
- Замены берутся из уже открытого `replacements.yaml` — единый источник правды для
  движка очистки и промпта саммари; не нужно поддерживать второй словарь.
- **Артефакт на диске (`replacements.compact.txt`)** — для внешнего автоматического
  пайплайна (CI/CD, cron-обработка транскриптов): пайплайн ссылается на готовый
  файл по фиксированному имени, ему не нужно тянуть в рантайм движок/парсер YAML.
  Запись при save гарантирует, что файл всегда синхронен с исходником.

---

## 3. Подтверждённые точки интеграции (по разведке кода)

| Concern | Path:line | Назначение |
|---|---|---|
| Сборка промпта | `app/src/lib/llm.ts:120-166` | `streamChatCompletion`: читает `.md`-промпт, формирует `messages[system,user]`. Сюда вклеивать блок автозамен. |
| `LlmSettings` (UI-формат) | `app/src/lib/llm.ts:8-26` | Интерфейс настроек модели. Добавить поле `mixReplacements`. |
| `DEFAULT_LLM_SETTINGS` | `app/src/lib/llm.ts:31-41` | Дефолты. `mixReplacements: true`. |
| `LlmModelConfig` (YAML-формат) | `app/src/types/dictionaries.ts:31-50` | snake_case-схема для settings.yaml. Добавить `mix_replacements?: boolean`. |
| `fromYaml` / `toYaml` | `app/src/store/llm.ts:50-75` | Маппинг camelCase ↔ snake_case. Добавить поле в оба. |
| `setLlmSettings` | `app/src/lib/yaml-edit.ts:221-255` | CST-запись `settings.llm.models.<name>`. Добавить поле в объект модели. |
| Образец обхода rules | `app/src/lib/glossary-export.ts:26-47` | Цикл по `replacements.replacements` + `lemma_replacements`. Взять за шаблон `buildCompactReplacements`. |
| Источник данных | `useDictionaries.getState().entries` | `entries.find(e => e.kind === "replacements").data` → `ReplacementsFile`. Реактивно обновляется при правках в Monaco. |
| UI чекбокса | `app/src/components/SummaryView.tsx:475-486` | Чекбокс «Внешняя модель» — образец для нового чекбокса. |
| Save-флоу (авто-запись) | `app/src/components/Toolbar.tsx:80-89` | `handleSave`: `writeFileFn(activeEntry.path, activeEntry.raw)` + `markSaved`. Сюда добавить запись компакт-файла после сохранения replacements. |
| Образец ручного экспорта | `app/src/components/Toolbar.tsx:91-101` | `handleExportGlossary`: `exportGlossaryMarkdown` + `writeFileFn(joinPath(dir, "GLOSSARY.md"))`. Взять за образец для `handleExportCompact`. |
| `joinPath`, `writeFile` | `app/src/lib/fs.ts:23-33` | Хелперы записи файла + склейки пути с `dir`. |
| `ReplacementsFile` тип | `app/src/types/dictionaries.ts:69-84` | `{ replacements: Record<_,ReplacementRule>, lemma_replacements: Record<_,LemmaRule> }`. |

---

## 4. Архитектурные решения

| Вопрос | Решение | Обоснование |
|---|---|---|
| Источник replacements **на момент запуска** | `useDictionaries.getState().entries` (поле `data`) | Решение пользователя. Автоматически подхватывает правки в Monaco (Zustand реактивен). Для внешних правок файла — reopen папки (тот же UX, что у остальных словарей). |
| Что включать в справочник | `replacements` + `lemma_replacements` | Решение пользователя. Модель видит все правила нормализации. Для lemma берём `from_lemmas`; пометки источника (точная/лемма) НЕ добавляем — для компактности. |
| Метка в скобках | id категории как есть (`brand_product`, `tech_term`, ...) | Решение пользователя. Без маппингов, информативно. |
| Дефолт чекбокса | `true` | Решение пользователя. Замены влияют на саммари по умолчанию. |
| Куда вклеивать | В `systemContent` (дописывать в конец) | Системный промпт — это контекст инструкции; блок автозамен логически относится к «как обрабатывать транскрипт», а не к пользовательскому сообщению. |
| Формат обрамляющей инструкции | Фиксированные строки (константы в `lib/llm.ts`) | Не выносить в YAML — это часть логики промпта, не пользовательская настройка. Если позже захочется редактировать — вынесем в отдельный `.md` (как system prompt). |
| Когда НЕ подмешивать | `settings.mixReplacements === false` ИЛИ replacements пуст/не открыт | Чекбокс выключен — пропускаем вклейку целиком (никакого блока в промпте). |
| Сортировка правил | В порядке следования в YAML (как `Object.entries`) | Сохраняет логику куратора словаря; не переупорядочивает. |
| Пропуск «пустых» правил | Пропускаем правила без `from`/`from_lemmas` и/или без `to` | Защита от мусора в YAML (битые/незаполненные). |
| **Имя компакт-файла** | `replacements.compact.txt` | Решение пользователя. `.txt` (не `.md`, не `.yaml`) — пайплайн не путает с исходником. Лежит рядом с `replacements.yaml` в `dir`. Не входит в `FILE_CONTRACT` → `detectDictionaries` игнорирует (не пытается парсить как словарь). |
| **Содержимое компакт-файла** | Только строки словаря (`from/from2 → to (label)`), без заголовка/обёртки | Решение пользователя. Пайплайн сам оборачивает блоком промпта; артефакт максимально переиспользуем. `buildCompactReplacements` возвращает ровно это тело. |
| **Триггер записи компакт-файла** | (а) при `handleSave` для replacements + (б) ручная кнопка «Экспорт compact» | Решение пользователя. Save гарантирует синхронность файла с исходником; ручная кнопка позволяет перегенерировать без полного save (напр. после правок в Monaco, которые пока не сохранены). |
| **Путь компакт-файла** | `joinPath(dir, "replacements.compact.txt")`, где `dir = useDictionaries.dir` | Зеркалит `handleExportGlossary` (пишет в `joinPath(dir, "GLOSSARY.md")`). Если `dir` не задан — тихо пропускаем запись (вне пайплайна). |
| **Обработка ошибок записи** | try/catch, ошибка не роняет основной save | Запись компакт-файла — побочный artefact; если упала (права, диск) — основной replacements.yaml уже сохранён, статус показывает предупреждение. |

---

## 5. План реализации

### Часть 1. Функция уплотнения (`app/src/lib/glossary-export.ts`)

Добавить рядом с `exportGlossaryMarkdown` новую экспортируемую функцию:

```ts
// Построить уплотнённый справочник нормализации. Возвращает ТОЛЬКО тело словаря
// (по одной строке на правило), БЕЗ заголовка и БЕЗ обёртки промпта — чтобы
// один и тот же артефакт годился и для записи в replacements.compact.txt (для
// внешнего пайплайна), и для вклейки в системный промпт саммари (где заголовок
// и обёртку добавляет вызывающий код).
//
// Формат одной строки:
//   <вариант1>/<вариант2>/... → <to> (<label>)
// Если from/from_lemmas пустой или to пустой — правило пропускается.
// Возвращает пустую строку, если replacements == null или правил нет.
export function buildCompactReplacements(replacements: ReplacementsFile | null): string
```

Реализация:
1. Собрать `entries: { to: string; variants: string[]; label: string }[]` из
   `replacements.replacements` (variants = `from`) и `replacements.lemma_replacements`
   (variants = `from_lemmas`). Пропустить с пустым `to` или `variants`.
2. Если `entries.length === 0` — вернуть `""`.
3. Для каждого entry: `variants.join("/") + " → " + to + " (" + label + ")"`.
4. `return lines.join("\n")` — **без** заголовка `🔹`, **без** обёртки промпта.

Заголовок `🔹 СЛОВАРЬ НОРМАЛИЗАЦИИ ...` и обёртку `ВАЖНО: ...` добавляет ТОЛЬКО
вызывающий код для промпта (`streamChatCompletion`, см. Часть 3) — они НЕ входят
в артефакт на диске (см. Часть 6).

Типы уже есть: `ReplacementsFile`, `ReplacementRule`, `LemmaRule` (импорт из
`../types/dictionaries`). Новых типов не требуется.

### Часть 2. Поле `mixReplacements` в LlmSettings (4 точки)

**2.1. `app/src/lib/llm.ts`:**
- Интерфейс `LlmSettings` (8-26) — добавить поле:
  ```ts
  // true: перед системным промптом вклеивается блок автозамен из replacements.yaml.
  // Чекбокс в настройках LLM; нужен для A/B-сравнения влияния замен на саммари.
  mixReplacements: boolean;
  ```
- `DEFAULT_LLM_SETTINGS` (31-41) — добавить `mixReplacements: true`.

**2.2. `app/src/types/dictionaries.ts`:**
- `LlmModelConfig` (31-50) — добавить:
  ```ts
  // true: вклеивать уплотнённый справочник замен в системный промпт саммари.
  // Если не задано — считаем true (безопасный дефолт по умолчанию).
  mix_replacements?: boolean;
  ```

**2.3. `app/src/store/llm.ts`:**
- `fromYaml` (50-61) — добавить `mixReplacements: y.mix_replacements ?? true`.
- `toYaml` (64-75) — добавить `mix_replacements: s.mixReplacements`.

**2.4. `app/src/lib/yaml-edit.ts`:**
- В `setLlmSettings` (230-247), в объект `models[name]` — добавить
  `mix_replacements: cfg.mix_replacements ?? true`.

### Часть 3. Вклейка в системный промпт (`app/src/lib/llm.ts:streamChatCompletion`)

Между чтением `.md`-промпта (`systemContent`, ~141) и сборкой `body` (~157):

```ts
// Если включено mixReplacements — дописать уплотнённый справочник замен
// в конец системного промпта. Берём replacements из dictionaries-store
// (поле data — реактивно обновляется при правках в Monaco).
let finalSystemContent = systemContent;
if (settings.mixReplacements) {
  const entries = useDictionaries.getState().entries;
  const replEntry = entries.find((e) => e.kind === "replacements");
  const repl = (replEntry?.data ?? null) as ReplacementsFile | null;
  const compactBody = buildCompactReplacements(repl); // только строки, без заголовка
  if (compactBody.length > 0) {
    finalSystemContent =
      systemContent +
      "\n\n" +
      NORMALIZATION_INTRO_PRE +
      COMPACT_HEADER + "\n" +
      compactBody +
      NORMALIZATION_INTRO_POST;
  }
}
```

Импорты в начало `lib/llm.ts`:
```ts
import { buildCompactReplacements } from "./glossary-export";
import type { ReplacementsFile } from "../types/dictionaries";
```

Константы обрамляющей инструкции (модуль-level в `lib/llm.ts`). `COMPACT_HEADER`
используется только в промпте, в файл на диске НЕ пишется:
```ts
const COMPACT_HEADER =
  "🔹 СЛОВАРЬ НОРМАЛИЗАЦИИ (исправлять ДО генерации саммари):";
const NORMALIZATION_INTRO_PRE =
  "ВАЖНО: Перед генерацией саммари примени автозамену терминов в транскрипте по правилам:\n";
const NORMALIZATION_INTRO_POST =
  "\n\nИспользуй исправленный текст как основу. В финальном саммари выводи ТОЛЬКО нормализованные варианты (колонка \"→\").";
```

Далее в `messages` использовать `finalSystemContent` вместо `systemContent`:
```ts
{ role: "system", content: finalSystemContent },
```

### Часть 4. UI чекбокс (`app/src/components/SummaryView.tsx`)

В `<details className="summary-settings">` рядом с чекбоксом «Внешняя модель»
(475-486), по образцу:

```tsx
<label className="summary-settings-full">
  <span>
    <input
      type="checkbox"
      checked={settings.mixReplacements}
      onChange={(e) =>
        setModelSettings(selectedModel, { mixReplacements: e.target.checked })
      }
    />{" "}
    Подмешивать справочник замен в промпт (уплотнённый replacements.yaml)
  </span>
</label>
```

### Часть 5. Запись компакт-файла на диск (`app/src/components/Toolbar.tsx`)

Артефакт `replacements.compact.txt` рядом с `replacements.yaml` — для внешнего
пайплайна. Записывается (а) автоматически при сохранении replacements, (б) по
ручной кнопке экспорта.

**5.1. Хелпер записи (модуль-level в `Toolbar.tsx`):**

```ts
// Записать replacements.compact.txt рядом с replacements.yaml.
// Берёт актуальный replacements из store (поле data). Если replacements пуст/нет
// или dir не задан — тихо пропускает (возвращает статус).
// НЕ роняет вызывающий флоу: ошибки записи логируются в возвращаемой строке.
async function writeCompactFile(
  dir: string | null,
  replacements: ReplacementsFile | null,
): Promise<string> {
  if (!dir) return ""; // папка не открыта — вне пайплайна
  const body = buildCompactReplacements(replacements);
  if (body.length === 0) return ""; // нечего писать
  const path = joinPath(dir, "replacements.compact.txt");
  try {
    await writeFileFn(path, body);
    return ` ; compact: ${path}`;
  } catch (e) {
    return ` ; compact FAILED: ${String(e)}`;
  }
}
```

Импорты (добавить к существующим в `Toolbar.tsx`):
```ts
import { buildCompactReplacements } from "../lib/glossary-export";
```
`replacements` уже выбран из store (Toolbar.tsx:24-26) — переиспользуем.

**5.2. Авто-запись при сохранении (расширить `handleSave`, Toolbar.tsx:80-89):**

После успешной записи `activeEntry.path` — если сохраняли replacements, дописать
компакт-файл и расширить строку статуса:

```ts
async function handleSave() {
  if (!activeEntry) return;
  try {
    await writeFileFn(activeEntry.path, activeEntry.raw);
    markSaved(activeEntry.kind, activeEntry.raw);
    let msg = `Сохранено: ${activeEntry.path}`;
    // Если сохраняли replacements — синхронно перегенерируем компакт-файл.
    if (activeEntry.kind === "replacements") {
      msg += await writeCompactFile(dir, replacements);
    }
    setStatus(msg);
  } catch (e) {
    setStatus(`Ошибка сохранения: ${String(e)}`);
  }
}
```

Важно: `replacements` здесь — то, что выбрано из store **до** `markSaved`. После
`applyEdit`/правок в Monaco `entry.data` уже обновлён (реактивно), поэтому в
момент save данные актуальны. `writeCompactFile` читает именно это поле.

**5.3. Ручная кнопка экспорта (новая, рядом с «Экспорт GLOSSARY.md»):**

```tsx
<button
  onClick={handleExportCompact}
  className="btn"
  disabled={!canExportCompact}
>
  Экспорт compact.txt
</button>
```

Обработчик по образцу `handleExportGlossary` (91-101):

```ts
async function handleExportCompact() {
  if (!dir) return;
  try {
    const msg = await writeCompactFile(dir, replacements);
    if (msg) setStatus(`Compact экспортирован${msg}`);
    else setStatus("Нет правил replacements для экспорта.");
  } catch (e) {
    setStatus(`Ошибка экспорта compact: ${String(e)}`);
  }
}
```

Флаг доступности (рядом с `canExport`, Toolbar.tsx:184):
```ts
const canExportCompact = !!dir && !!replacements;
```

### Часть 6. Верификация

JS-тест-раннера в проекте нет (проверка через `tsc --noEmit` + `vite build`, как
в Phase 7/8 — см. `20260722_001_checkpoint.md` §«Test status»).

1. `cd app && pnpm exec tsc --noEmit` — типы (особенно новое поле `mixReplacements`
   в 4 точках: llm.ts, dictionaries.ts, store/llm.ts, yaml-edit.ts).
2. `cd app && pnpm exec vite build` — сборка.
3. **Временный node-скрипт** (не коммитится): прогнать `buildCompactReplacements`
   на `sample/.../replacements.yaml` (парсинг через `yaml` + ручной монтаж
   `ReplacementsFile`), проверить:
   - присутствует строка `мини Макс/минимакс/mini max → Minimax (brand_product)`;
   - присутствует lemma-строка `слак → Slack (brand_product)`;
   - правила без `from`/с пустым `to` пропущены;
   - при пустом `replacements == null` возвращается `""`;
   - **тело БЕЗ** заголовка `🔹 ...` и БЕЗ обёртки `ВАЖНО: ...` (это только для промпта).
4. **Проверка компакт-файла на диске**: после ручного экспорта или save replacements
   в `sample/transcript_optimizer/` должен появиться `replacements.compact.txt`
   с тем же телом, что выдаёт `buildCompactReplacements`. Сравнить содержимое с
   пунктом 3 — должно совпадать посимвольно.
5. Ручной smoke (пользователь): `pnpm tauri dev`:
   - открыть папку `sample/transcript_optimizer/`, открыть транскрипт;
   - в настройках LLM убедиться, что чекбокс «Подмешивать…» виден и переключается;
   - запустить саммари дважды — с галкой и без — сравнить, что в системном сообщении
     появился/исчез блок автозамен (можно проверить через DevTools-сеть или
     временным `console.log(finalSystemContent)` в `streamChatCompletion`);
   - проверить, что правка replacements в Monaco подхватывается без reopen.

---

## 7. Коммиты (по `TASK_CONVENTIONS` §6: код и документы не смешивать)

1. `docs(tasks): add 20260727_001 plan` — этот файл.
2. `feat(app): build compact replacements glossary for summary prompt` — части 1
   (glossary-export.ts) + 3 (llm.ts вклейка) + 2 (поле `mixReplacements` в 4 точках)
   + 4 (чекбокс UI). Один логический фич-коммит — поток «в-app промпт».
3. `feat(app): write replacements.compact.txt on save + manual export` — Часть 5
   (Toolbar.tsx). Отдельный коммит — отдельная подсистема «артефакт на диске»,
   зависящая от Части 1 (`buildCompactReplacements`), но не от вклейки в промпт.
4. `docs(tasks): add 20260727_001 result` — результат (что сделано, проверки, NOT done).
5. Опционально (после ручного smoke пользователем):
   `docs(phase_09): Phase 9 summary` — `-=PHASES=-/Phase_09.md`.
6. Опционально: `docs(checkpoint): add 20260727_001`.

Порядок: 2 → 3 (Часть 5 импортирует `buildCompactReplacements` из Части 1).

---

## 8. Что НЕ делаем (осознанно)

- **Не добавляем file-watcher** для replacements.yaml. Реактивность через Zustand
  (`useDictionaries.subscribe`/`getState`) покрывает правки в Monaco; внешние
  правки требуют reopen папки — это принятый в проекте UX для всех словарей.
- **Не выносим обрамляющую инструкцию** (`NORMALIZATION_INTRO_PRE/POST`/`COMPACT_HEADER`)
  в YAML или отдельный `.md`. Это часть логики промпта. Если позже понадобится
  редактирование — вынесем в отдельный `.md` (как system prompt) отдельной задачей.
- **Не показываем preview** уплотнённого справочника в UI (текстом). Можно
  добавить позже (напр., expand-блок «что попадёт в промпт») — отдельная UX-задача.
- **Не делаем сортировку** правил по алфавиту/категории — сохраняем порядок YAML.
- **Не добавляем пометку источника** (точная/лемма) — для компактности.
- **Не маппим id категории** на короткие алиасы (`brand`/`tech`/`style`) — пишем
  id как есть.
- **Не трогаем движок очистки** (`rules.ts`) — фича чисто про промпт саммари.
- **Не добавляем JS test-раннер** (vitest) — отдельная задача (см. чекпоинт §Next).
- **Не добавляем `replacements.compact.txt` в `.gitignore`** автоматически. Это
  генерируемый артефакт, но пользователь явно хочет хранить его для пайплайна —
  оставляем решение (коммитить / игнорировать) за пользователем. По умолчанию файл
  попадёт в `git status` как untracked — пользователь сам решит.
- **Не пишем компакт-файл при каждом `applyEdit`** в Monaco (только при save +
  ручной кнопке). Частая запись на диск без явного save — лишний I/O и риск
  рассинхрона «файл обновлён, а исходник ещё нет».

---

## 9. Риски и нюансы

- **Размер промпта.** При большом replacements.yaml (десятки/сотни правил) блок
  автозамен может оказаться длинным и съесть токены. На текущем sample (~80 правил)
  это ~3-5 КБ — приемлемо. Порезка по релевантности (только правила, чьи `from`
  встречаются в транскрипте) вынесена в бэклог —
  см. `-=tasks=-/BACKLOG.md` §«Компакт-справочник: порезка по релевантности».
- **Реактивность через `getState()`.** В `streamChatCompletion` читаем
  `useDictionaries.getState().entries` синхронно перед `invoke` — актуальное
  состояние на момент запуска (включая несохранённые правки в Monaco). Это
  сознательное решение пользователя (источник = store, не диск).
- **`replEntry.data` может быть невалиден**, если YAML битый — `parse` в
  `detectDictionaries` оставит `data` как есть (объект или null). Защита: `?? null`
  + `buildCompactReplacements` проверяет структуру через типы (любая дыра даст
  undefined-поля и правило пропустится).
- **Поле `mix_replacements` в старых settings.yaml отсутствует** — `?? true` в
  `fromYaml` даёт дефолт «вклеивать», что соответствует `DEFAULT_LLM_SETTINGS`.
  После первого persist через UI поле появится в YAML явно.
- **`buildCompactReplacements` живёт в `glossary-export.ts`** рядом с
  `exportGlossaryMarkdown`. Это осознанно: обе функции — коллекторы из
  replacements/lemma. Если файл разрастётся — вынесем в `lib/compact-replacements.ts`.
- **Импорт `useDictionaries` в `lib/llm.ts`** уже есть (строка 3) — дополнительной
  циклической зависимости не возникает.
- **`replacements` в `handleSave` может быть устаревшим** на момент вызова, если
  пользователь правит replacements и сразу жмёт save на **другой** вкладке. Но
  `useDictionaries` реактивен, и `replacements` (Toolbar.tsx:24-26) — подписка,
  обновляющаяся при каждом `applyEdit`. Практически рассинхрон невозможен: к
  моменту клика «Сохранить» селектор уже отдал актуальное состояние. Если
  сохраняют replacements — `activeEntry.kind === "replacements"` гарантирует, что
  данные в `replacements` именно этой вкладки.
- **`writeCompactFile` пишет в `dir`, а не рядом с `activeEntry.path`.** Это
  совпадает для типового случая (replacements.yaml лежит в корне `dir`). Если
  replacements.yaml когда-нибудь переедет в подпапку — путь компакт-файла
  diverger'нёт. На текущей структуре проекта (все словари в корне `dir`) это
  безопасно; если структура усложнится — переключимся на `dirname(activeEntry.path)`.
- **Конфликт с внешним пайплайном.** Если пайплайн читает `replacements.compact.txt`
  в момент, когда приложение его перезаписывает, возможна гонка (пайплайн читает
  половину файла). На практике пайплайн работает по cron/по событию, а не в
  реальном времени — риск минимален. Если станет актуально — писать через
  временный файл + atomic rename (отдельная задача).
