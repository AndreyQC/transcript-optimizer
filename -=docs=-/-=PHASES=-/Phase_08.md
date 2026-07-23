# Phase 8: Фикс многословных замен + числа не OOV + новые категории глоссария

**Дата:** 2026-07-22
**Статус:** завершён
**План:** `-=tasks=-/2026-07-22/20260722_001_phrase_replace_numbers_categories_plan.md`
**Результат:** `-=tasks=-/2026-07-22/20260722_001_phrase_replace_numbers_categories_result.md`

---

## Цель фазы

Три связанные задачи:
1. **Фикс движка замен** — многословные `replacements[*].from` (≥ 2 слов, напр.
   `English Club`) не применялись. Конкретный кейс пользователя:
   `English Club → English Club community` на строке
   `[00:29:35] Если открыть, например, English Club, наш транскрипт.` не срабатывал.
2. **Числа не помечать как OOV** — чистые числовые токены (`10`, `50`, `2026`)
   засоряли грид OOV; должны автоматически исключаться.
3. **Две новые категории `replacement`** — `project_specific` и `it_slang`.

---

## Что сделано

### Frontend / движок

| Файл | Что изменилось |
|---|---|
| `app/src/engine/rules.ts` | `buildReplaceIndex` → `buildReplaceIndices` (словá в `Map`, фразы в `ReplacePhrase[]`, сортировка по убыванию длины). Шаг 2 `cleanUtterance` разбит на 2a (фразы — единым `.replace(re, fn)`) и 2b (слова). Массив `covered` + хелпер `isCoveredBy`: шаги 2b и 4 (OOV) пропускают токены внутри заменённой фразы. `CleanCtx.replaceIdx` → `replaceWords` + `replacePhrases`. |
| `app/src/engine/oov-stats.ts` | Константа `NUMERIC_RE = /^\p{N}+$/u`. Шаг 2 в `buildOovRows` удаляет чистые числа из map до фразовой фильтрации. Числа остаются в decorations движка (видны в transcript), но пропадают из OOV-грида. |
| `app/src/components/TranscriptView.tsx` | Уточнён комментарий `oovCtx`: после фикса движка replacement-фразы обрабатываются в движке, патч §6 в `buildOovRows` теперь нужен только для `filler_phrases`. |

### Sample-данные

| Файл | Что изменилось |
|---|---|
| `sample/transcript_optimizer/glossary.yaml` | Добавлены 2 категории: `project_specific` (Проектно-специфичный) и `it_slang` (IT-жаргон). UI `<select>`, валидация `label-unknown`, экспорт глоссария — подхватываются автоматически (data-driven архитектура). |

---

## Ключевые архитектурные решения

- **Корневая дыра из `LESSONS_LEARNED.md` §6 закрыта в движке**, а не обойдена
  патчем агрегатора. Раньше `replaceIdx` хранил ключ с пробелом (`"english club"`),
  а применение шло по однословным токенам — лукап всегда промахивался. Теперь
  фразы матчатся подстрокой через `wordBoundaryRe` (как `filler_phrases`).
- **Единый `.replace(re_gi, fn)`** для фраз — JS не ре-сканирует вставленный
  replacement, что гарантирует отсутствие двойной подстановки при `to ⊃ from`
  (`English Club` → `English Club community`). Проверено явно.
- **Сортировка фраз по длине desc + `covered` spans** — корректно обрабатывает
  перекрытия (`english club community` матчится раньше `english club`).
- **Числовой фильтр — в агрегаторе, не в движке.** Следует принципу §6: движок
  остаётся источником истины для decorations (числа подсвечены в transcript),
  фильтрация шума — в `buildOovRows`.
- **§6-патч `buildOovRows` сохранён** — стал безвредным no-op для replacement-фраз,
  но всё ещё нужен для `filler_phrases`.
- **Новые категории — только данные**, без правок кода: архитектура `label` как
  строки-ссылки на id категории из `glossary.yaml` делает UI/валидацию/экспорт
  data-driven.

---

## Проверки

```bash
cd app && pnpm exec tsc --noEmit    # OK
cd app && pnpm exec vite build      # OK
```

Функциональный тест (временный node-скрипт через Vite-сборку, не коммитился):
- На примере пользователя `English Club → English Club community`: **8/8 ok**
  (замена применилась, нет двойной подстановки, 1 decoration `will-replace`,
  `english`/`club` не OOV, числа исключены из грида).
- На существующих многословных `from` из `sample/.../replacements.yaml`
  (`опен код`, `open code` → `OpenCode`; `дек бади` → `DeckBody`): **4/4 ok**.
  Фикс автоматически починил ранее молча не работавшие правила.

Ручной smoke через `pnpm tauri dev` — оставлен пользователю.

---

## Известные ограничения / NOT done

- JS test-раннера по-прежнему нет (проверка через `tsc` + `vite build` + временный
  скрипт). Добавление vitest — отдельная задача.
- Числа — хардкод `/^\p{N}+$/u`, не настраиваются через `settings.yaml`.
- `lemma_replacements` многословные `from_lemmas` не трогались (движок лемм в MVP).
- `isAtSentenceStart` в callback замены фраз использует `workText` (не `origText`)
  из-за разошедшихся смещений — логически корректно, но отличается от однословной
  ветки (там `origText`).

---

## Где читать дальше

- План фазы: `-=tasks=-/2026-07-22/20260722_001_phrase_replace_numbers_categories_plan.md`
- Результат: `-=tasks=-/2026-07-22/20260722_001_phrase_replace_numbers_categories_result.md`
- Предыдущий контекст дыры: `LESSONS_LEARNED.md` §6
- Предыдущая фаза: `-=PHASES=-/Phase_07.md`
