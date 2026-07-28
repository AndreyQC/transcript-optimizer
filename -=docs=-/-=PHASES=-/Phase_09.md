# Phase 9: Уплотнённый справочник замен в промпте саммари + артефакт на диске

**Дата:** 2026-07-27
**Статус:** завершён
**План:** `-=tasks=-/2026-07-27/20260727_001_compact_replacements_in_prompt_plan.md`
**Результат:** `-=tasks=-/2026-07-27/20260727_001_compact_replacements_in_prompt_result.md`

---

## Цель фазы

Два связанных потока на одном уплотнённом справочнике замен:

1. **В-app промпт.** Подмешивать уплотнённый справочник нормализации
   (построенный из `replacements.yaml`) в системный промпт при генерации
   саммари. Чекбокс включает/выключает подмешивание (для A/B-сравнения
   влияния замен на выходной саммари).
2. **Артефакт на диске.** Записывать компакт-файл `replacements.compact.txt`
   рядом с `replacements.yaml` — для внешнего автоматического пайплайна
   (пользователь явно использует подготовленные файлы в автоматике).

---

## Что сделано

### Frontend / движок

| Файл | Что изменилось |
|---|---|
| `app/src/lib/glossary-export.ts` | +`buildCompactReplacements(replacements)`: обходит `replacements.replacements` (variants=`from`) и `lemma_replacements` (variants=`from_lemmas`), возвращает плотное тело по строке на правило (`from/from2 → to (label)`). Возвращает **только тело** — без заголовка/обёртки. Пропускает правила с пустым `to`/`variants`; `null` → `""`. |
| `app/src/lib/llm.ts` | +импорты `buildCompactReplacements`, `ReplacementsFile`. +константы `COMPACT_HEADER`, `NORMALIZATION_INTRO_PRE/POST`. В `streamChatCompletion` при `settings.mixReplacements` — вклейка тела+заголовка+обёртки в конец `systemContent` → `finalSystemContent` → `messages[0]`. Источник — `useDictionaries.getState().entries` (реактивно, в т.ч. несохранённые правки Monaco). |
| `app/src/types/dictionaries.ts` | +`mix_replacements?: boolean` в `LlmModelConfig`. |
| `app/src/store/llm.ts` | +`mixReplacements` в `fromYaml` (`?? true`) и `toYaml`. |
| `app/src/lib/yaml-edit.ts` | +`mix_replacements: cfg.mix_replacements ?? true` в `setLlmSettings`. |
| `app/src/components/SummaryView.tsx` | +чекбокс «Подмешивать справочник замен в промпт» рядом с «Внешняя модель». |
| `app/src/components/Toolbar.tsx` | +`writeCompactFile()` (пишет `replacements.compact.txt`, try/catch, не роняет save). +`handleExportCompact()` + кнопка «Экспорт compact.txt». `handleSave` расширен: авто-перезапись компакт-файла при сохранении replacements. +`canExportCompact`. |

### Документы

| Файл | Что |
|---|---|
| `-=tasks=-/2026-07-27/20260727_001_..._plan.md` | План v2 (с Частью 5 — артефакт на диске). |
| `-=tasks=-/2026-07-27/20260727_001_..._result.md` | Результат: что сделано, проверки, NOT done. |
| `-=tasks=-/BACKLOG.md` | **Новый файл** — единый бэклог отложенных задач. Первая запись: порезка компакт-справочника по релевантности транскрипта. |

---

## Ключевые архитектурные решения

- **Разделение тела и обёртки.** `buildCompactReplacements` возвращает только
  строки правил. Заголовок `🔹 СЛОВАРЬ НОРМАЛИЗАЦИИ ...` и обёртка `ВАЖНО: ...`
  добавляются только в `streamChatCompletion` (для промпта); в файл на диске НЕ
  пишутся — пайплайн оборачивает сам. Один артефакт — два потребителя, без
  дублирования логики.
- **Источник данных — store, не диск.** В `streamChatCompletion` читаем
  `useDictionaries.getState().entries` синхронно перед `invoke`. Актуально на
  момент запуска, включая несохранённые правки в Monaco. Решение пользователя.
- **`mixReplacements` дефолт = true.** Замены влияют на саммари по умолчанию;
  для A/B пользователь выключает чекбокс. В YAML — `mix_replacements`; в старых
  файлах отсутствует → `?? true` даёт тот же дефолт; после первого persist поле
  пишется явно.
- **Запись компакт-файла не роняет save.** `writeCompactFile` ловит ошибки записи
  и возвращает их в строку статуса (`compact FAILED: ...`), но не бросает —
  основной replacements.yaml уже сохранён.
- **Артефакт не в `.gitignore`.** Пользователь явно хочет хранить его для пайплайна.
  Файл попадает в `git status` как untracked — решение коммитить/игнорировать за
  пользователем.
- **Бэклог как отдельная сущность.** `-=tasks=-/BACKLOG.md` заведён как единое
  место для отложенных задач (вместо разброса по планам). Порезка справочника по
  релевантности — первая запись, с проработкой 5 подводных камней; из плана §9
  сделана явная перекрёстная ссылка.

---

## Проверки

```bash
cd app && pnpm exec tsc --noEmit    # OK (exit 0)
cd app && pnpm exec vite build      # OK (exit 0, built in 14s)
```

Функциональные тесты (временные node-скрипты, не коммитились):
- `buildCompactReplacements` на реальном `sample/.../replacements.yaml`: **11/11
  ok** — 72 валидных правила (70 replacements + 2 lemma), 2834 байт; тело без
  заголовка/обёртки; пустые/битые правила пропущены; кейс `to ⊃ from`
  (`English Club → English Club community`) корректен.
- Roundtrip записи на диск: **5/5 ok** — содержимое совпадает посимвольно, нет
  BOM, нет trailing newline.

**Ручной smoke через `pnpm tauri dev` — проведён пользователем, OK.**

---

## Известные ограничения / NOT done

- **Нет file-watcher** для replacements.yaml — внешние правки требуют reopen
  папки (принятый в проекте UX для всех словарей). Реактивность в-app через
  Zustand (`useDictionaries`) покрывает правки в Monaco.
- **Обрамляющая инструкция промпта** (`NORMALIZATION_INTRO_*`, `COMPACT_HEADER`)
  не вынесена в `.md`/YAML — это часть логики промпта. Редактирование — отдельная
  задача.
- **Нет preview** уплотнённого справочника в UI (expand-блок «что попадёт в
  промпт») — отдельная UX-задача.
- **Порезка по релевантности** при большом словаре — в `-=tasks=-/BACKLOG.md`,
  отдельная задача.
- **Гонка чтения/записи** компакт-файла с внешним пайплайном — риск минимален
  (пайплайн по cron); atomic rename оставлен отдельной задачей.
- **JS test-раннера (vitest) по-прежнему нет** — проверка через `tsc` + `vite
  build` + временные node-скрипты (как в Phase 7/8).

---

## Коммиты

| Хэш | Сообщение |
|---|---|
| `1d6b979` | `feat(app): mix compact replacements glossary into summary system prompt` |
| `2095eff` | `feat(app): write replacements.compact.txt on save + manual export` |
| `9607455` | `docs(tasks): add 20260727_001 plan+result and BACKLOG.md` |

---

## Где читать дальше

- План: `-=tasks=-/2026-07-27/20260727_001_compact_replacements_in_prompt_plan.md`
- Результат: `-=tasks=-/2026-07-27/20260727_001_compact_replacements_in_prompt_result.md`
- Бэклог (отложенное): `-=tasks=-/BACKLOG.md`
- Предыдущая фаза: `-=PHASES=-/Phase_08.md`
- Предыдущий снапшот: `-=CHECKPOINTS=-/20260722_001_checkpoint.md`
