# Результат: фикс многословных замен + числа не OOV + новые категории

**Дата:** 2026-07-22
**Проект:** transcript-optimizer (Tauri 2 + React 19 + TypeScript + Rust)
**Файл:** `-=tasks=-/2026-07-22/20260722_001_phrase_replace_numbers_categories_result.md`
**Статус:** реализовано

> Контекст:
> - `-=tasks=-/2026-07-22/20260722_001_phrase_replace_numbers_categories_plan.md`
> - `-=CHECKPOINTS=-/20260719_002_checkpoint.md`
> - `LESSONS_LEARNED.md` §6

---

## 1. Что сделано

- [x] **Часть 1. Фикс движка многословных замен** (`app/src/engine/rules.ts`):
  `buildReplaceIndex` → `buildReplaceIndices`, разделяющий `from` на однословные
  (`Map<norm, ReplaceIndex>`) и многословные (`ReplacePhrase[]`, отсортированы по
  убыванию длины). В `cleanUtterance` шаг 2 разбит на 2a (фразы — единым
  `.replace(re, fn)`) и 2b (слова — прежний цикл). Введён массив `covered` и
  хелпер `isCoveredBy`: шаги 2b и 4 (OOV) пропускают токены внутри заменённой
  фразы. `CleanCtx.replaceIdx` → `replaceWords` + `replacePhrases`.
- [x] **Часть 2. Числовой фильтр OOV** (`app/src/engine/oov-stats.ts`):
  константа `NUMERIC_RE = /^\p{N}+$/u`, шаг 2 в `buildOovRows` удаляет из map
  ключи, матчатся regex. Числа остаются в decorations движка (видны в
  transcript), но пропадают из OOV-грида.
- [x] **Часть 3. Две новые категории** (`sample/transcript_optimizer/glossary.yaml`):
  `project_specific` (Проектно-специфичный) и `it_slang` (IT-жаргон). UI
  `<select>`, валидация, экспорт подхватываются автоматически (data-driven).
- [x] Сопутствующее: уточнён комментарий в `app/src/components/TranscriptView.tsx`
  (описывал устаревшую ситуацию «токен проскакивает мимо replaceIdx»).

---

## 2. Проверки

```
cd app && pnpm exec tsc --noEmit    # OK (exit 0)
cd app && pnpm exec vite build      # OK (exit 0)
```

**Функциональный тест** (временный node-скрипт через Vite-сборку, не коммитился).
Транскрипт:
```
Спикер:
[00:29:35] Если открыть, например, English Club, наш транскрипт.
[00:29:40] Там было 10 и 50 участников, а в 2026 будет 100.
```
Правило: `English Club → English Club community` (to ⊃ from — риск двойной подстановки).

Результат: **8/8 assertions ok**:
- `cleanedText` содержит `English Club community`;
- нет `community community` (двойная подстановка);
- ровно 1 decoration `will-replace` (span L2 [36-48]);
- `english` / `club` не помечены OOV;
- `10`, `50`, `2026`, `100` исключены из OOV-грида, но остались в decorations движка.

**Бонус-тест** на существующих многословных `from` из `sample/.../replacements.yaml`
(`опен код`, `open code` → `OpenCode`; `дек бади` → `DeckBody`): **4/4 ok**,
замены применились, слова внутри фраз не попали в OOV. Значит,фикс автоматически
починил ранее молча не работавшие правила в sample-словаре.

Ручной smoke через `pnpm tauri dev` — оставлен пользователю (требует Tauri-окружения).

---

## 3. Известные ограничения / нюансы

- **§6-патч `buildOovRows` сохранён.** После фикса движка он стал безвредным no-op
  для replacement-фраз (их токены больше не попадают в OOV-декорации), но всё ещё
  нужен для `filler_phrases` (движок только удаляет их, не «заменяет»).
- **JS test-раннера по-прежнему нет.** Проверка через `tsc --noEmit` + `vite build`
  + временный node-скрипт. Добавление vitest — отдельная задача.
- **`isAtSentenceStart(workText, offset)`** в callback замены фраз использует
  `workText` (не `origText`), т.к. смещения разошлись после шага 1 (filler).
  Логически корректно: контекст replacement определяется по текущему тексту.
- **Числа настраиваемыми не сделаны** — хардкод `/^\p{N}+$/u`. Если потребуются
  исключения (напр. помечать 4-значные как годы), можно вынести в `settings.yaml`.
- **`lemma_replacements` многословные `from_lemmas` не трогались** — движок лемм
  в MVP не применяется.

---

## 4. Коммиты

| # | Хеш | Сообщение |
|---|-----|-----------|
| 1 | `133cdf1` | `docs(tasks): add 20260722_001 plan - phrase replace + numbers OOV + categories` |
| 2 | `11e23a6` | `feat(app): apply multi-word replacement phrases in engine` |
| 3 | `833c6fb` | `feat(app): exclude pure numbers from OOV grid` |
| 4 | `88443ad` | `feat(sample): add project_specific and it_slang glossary categories` |
| 5 | (этот коммит) | `docs(tasks): add 20260722_001 result` |

---

## 5. Архитектурный итог

Корневая дыра из `LESSONS_LEARNED.md` §6 **закрыта в движке**, а не обойдена
патчем агрегатора. Теперь:
- движок реально применяет многословные replacement-фразы (decoration
  `will-replace` + замена в `cleanedText`);
- единый `.replace(re_gi, fn)` гарантирует отсутствие двойной подстановки при
  `to ⊃ from`;
- сортировка фраз по длине + `covered` spans корректно обрабатывают перекрытия;
- токены внутри фразы исключаются из OOV на уровне движка (а не скрываются в UI).

Принцип §6 («движок — источник истины для decorations») расширен, но не нарушен:
числовой фильтр по-прежнему живёт в агрегаторе `buildOovRows`, т.к. это шумовая
фильтрация, не относящаяся к логике правил.
