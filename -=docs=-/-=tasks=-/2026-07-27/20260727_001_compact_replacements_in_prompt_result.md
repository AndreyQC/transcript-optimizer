# Результат: уплотнённый справочник замен в промпте саммари + артефакт на диске

**Дата:** 2026-07-27
**Проект:** transcript-optimizer (Tauri 2 + React 19 + TypeScript + Rust)
**Файл:** `-=tasks=-/2026-07-27/20260727_001_compact_replacements_in_prompt_result.md`
**Статус:** result
**План:** `-=tasks=-/2026-07-27/20260727_001_compact_replacements_in_prompt_plan.md`

---

## Контекст

> - `-=tasks=-/2026-07-27/20260727_001_compact_replacements_in_prompt_plan.md`
> - `-=CHECKPOINTS=-/20260722_001_checkpoint.md`
> - `-=tasks=-/BACKLOG.md` (создан в этой же сессии — отложенная порезка по релевантности)

---

## 1. Что сделано

Реализованы оба потока из плана v2: (1) подмешивание уплотнённого справочника
в системный промпт саммари, (2) запись компакт-файла на диск для внешнего
пайплайна.

### Frontend / движок

| Файл | Что изменилось |
|---|---|
| `app/src/lib/glossary-export.ts` | +`buildCompactReplacements(replacements)`: обходит `replacements.replacements` (variants=`from`) и `lemma_replacements` (variants=`from_lemmas`), возвращает плотное тело по строке на правило (`from/from2 → to (label)`). Возвращает **только тело** — без заголовка и обёртки (их добавляет вызывающий). Пропускает правила с пустым `to`/`variants`; `null` → `""`. |
| `app/src/lib/llm.ts` | +импорты `buildCompactReplacements`, `ReplacementsFile`. +константы `COMPACT_HEADER`, `NORMALIZATION_INTRO_PRE/POST` (только для промпта, в файл не пишутся). В `streamChatCompletion` при `settings.mixReplacements` — вклейка тела+заголовка+обёртки в конец `systemContent` → `finalSystemContent`, который и уходит в `messages[0]`. Источник данных — `useDictionaries.getState().entries` (реактивно, в т.ч. несохранённые правки в Monaco). |
| `app/src/types/dictionaries.ts` | +`mix_replacements?: boolean` в `LlmModelConfig` (snake_case для YAML). |
| `app/src/store/llm.ts` | +`mixReplacements` в `fromYaml` (`?? true`) и `toYaml`. |
| `app/src/lib/yaml-edit.ts` | +`mix_replacements: cfg.mix_replacements ?? true` в объект модели внутри `setLlmSettings`. |
| `app/src/components/SummaryView.tsx` | +чекбокс «Подмешивать справочник замен в промпт» рядом с «Внешняя модель». |
| `app/src/components/Toolbar.tsx` | +импорт `buildCompactReplacements`. +`writeCompactFile()` хелпер (пишет `replacements.compact.txt` в `dir`, try/catch, не роняет save). +`handleExportCompact()` + кнопка «Экспорт compact.txt». `handleSave` расширен: после сохранения replacements — авто-перезапись компакт-файла. +`canExportCompact` флаг. |

### Документы

| Файл | Что |
|---|---|
| `-=tasks=-/2026-07-27/20260727_001_..._plan.md` | План v2 (с Частью 5). |
| `-=tasks=-/BACKLOG.md` | Новый файл — единый бэклог отложенных задач. Первая запись: порезка компакт-справочника по релевантности транскрипта. |

---

## 2. Ключевые архитектурные решения (фактические)

- **Разделение тела и обёртки.** `buildCompactReplacements` возвращает только
  строки правил. Заголовок `🔹 СЛОВАРЬ НОРМАЛИЗАЦИИ ...` и обёртка `ВАЖНО: ...`
  добавляются только в `streamChatCompletion` (для промпта). Файл на диске
  содержит только тело — пайплайн оборачивает сам. Один артефакт — два потребителя.
- **Источник данных — store, не диск.** В `streamChatCompletion` читаем
  `useDictionaries.getState().entries` синхронно перед `invoke`. Актуально на
  момент запуска, включая несохранённые правки в Monaco. Решение пользователя.
- **`mixReplacements` дефолт = true.** Замены влияют на саммари по умолчанию;
  для A/B пользователь выключает чекбокс. В YAML — `mix_replacements`, в старых
  файлах отсутствует → `?? true` даёт тот же дефолт; после первого persist поле
  пишется явно.
- **Запись компакт-файла не роняет save.** `writeCompactFile` ловит ошибки
  записи и возвращает их в строку статуса (`compact FAILED: ...`), но не
  бросает — основной replacements.yaml уже сохранён.
- **Артефакт не в `.gitignore`.** Пользователь явно хочет хранить его для
  пайплайна. Файл попадёт в `git status` как untracked — решение коммитить/
  игнорировать за пользователем.

---

## 3. Проверки

```bash
cd app && pnpm exec tsc --noEmit    # OK (exit 0)
cd app && pnpm exec vite build      # OK (exit 0, built in 14s)
```

### Функциональный тест `buildCompactReplacements` (временный node-скрипт, не коммитился)

На реальном `sample/.../replacements.yaml` (72 валидных правила: 70 replacements
+ 2 lemma). **11/11 assertions ok:**

- ✓ строка `мини Макс/минимакс/mini max → Minimax (brand_product)` присутствует;
- ✓ lemma-строка `слак → Slack (brand_product)` присутствует;
- ✓ lemma-строка `вег → команда вега (team)` присутствует;
- ✓ правило `English Club → English Club community` (кейс `to ⊃ from`) — в теле;
- ✓ заголовок `🔹 СЛОВАРЬ НОРМАЛИЗАЦИИ` **ОТСУТСТВУЕТ** в теле (только в промпте);
- ✓ обёртка `ВАЖНО:` **ОТСУТСТВУЕТ** в теле;
- ✓ все строки содержат разделитель ` → `;
- ✓ число строк = 72 (совпадает с ручным подсчётом валидных правил);
- ✓ `null` → `""`;
- ✓ `{replacements:{}, lemma_replacements:{}}` → `""`;
- ✓ правило с пустым `to` пропущено;
- ✓ правило с пустым `from` пропущено.

Размер тела: 2834 байт, 72 строки.

### Roundtrip-тест записи на диск (временный, не коммитился)

Имитация `writeCompactFile` + `readFileSync`. **5/5 ok:**

- ✓ файл записан и читается;
- ✓ содержимое совпадает с `body` посимвольно;
- ✓ нет BOM;
- ✓ нет trailing newline (пишем как есть);
- ✓ первая строка — `мини Макс/...`.

Тестовый файл удалён — в репо не попал.

### Ручной smoke — НЕ проводился

Оставлен пользователю. Что проверить в `pnpm tauri dev`:
- чекбокс «Подмешивать…» в настройках LLM виден и переключается;
- запуск саммари с галкой и без — блок автозамен появляется/исчезает в системном
  сообщении (через DevTools-сеть или временный `console.log(finalSystemContent)`);
- правка replacements в Monaco подхватывается без reopen;
- «Экспорт compact.txt» создаёт `sample/transcript_optimizer/replacements.compact.txt`;
- «Сохранить» replacements обновляет компакт-файл синхронно (статус `... ; compact: ...`).

---

## 4. Коммиты

| Хэш | Сообщение | Содержание |
|---|---|---|
| `1d6b979` | `feat(app): mix compact replacements glossary into summary system prompt` | Части 1–4: `buildCompactReplacements`, поле `mixReplacements` (4 точки), вклейка в промпт, чекбокс UI. |
| `2095eff` | `feat(app): write replacements.compact.txt on save + manual export` | Часть 5: `writeCompactFile`, авто-запись при save, ручная кнопка экспорта. |

Документы (план/result/бэклог) — отдельный коммит `docs(tasks): ...` по конвенции.

---

## 5. Известные ограничения / NOT done

- **Ручной smoke не проводился** — оставлен пользователю (как и в Phase 8).
- **Нет file-watcher** для replacements.yaml — внешние правки требуют reopen папки
  (принятый UX). См. план §8.
- **Обрамляющая инструкция не вынесена** в `.md`/YAML — это часть логики промпта.
  Если понадобится редактирование — отдельная задача.
- **Нет preview** уплотнённого справочника в UI — отдельная UX-задача.
- **Порезка по релевантности** (при большом словаре) — в `BACKLOG.md`, отдельная
  задача с проработкой подводных камней.
- **`replacements.compact.txt` и гонка с внешним пайплайном** — риск минимален
  (пайплайн по cron); atomic rename оставлен отдельной задачей.
- **JS test-раннера (vitest) по-прежнему нет** — проверка через `tsc` + `vite build`
  + временные node-скрипты (как в Phase 7/8).

---

## 6. Где читать дальше

- План: `-=tasks=-/2026-07-27/20260727_001_compact_replacements_in_prompt_plan.md`
- Бэклог (отложенное): `-=tasks=-/BACKLOG.md`
- Предыдущий снапшот: `-=CHECKPOINTS=-/20260722_001_checkpoint.md`
- Образец обхода rules (использован как шаблон): `app/src/lib/glossary-export.ts:exportGlossaryMarkdown`
