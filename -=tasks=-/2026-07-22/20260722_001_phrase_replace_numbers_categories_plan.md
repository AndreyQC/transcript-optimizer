# План: фикс многословных замен + числа не OOV + новые категории глоссария

**Дата:** 2026-07-22
**Проект:** transcript-optimizer (Tauri 2 + React 19 + TypeScript + Rust)
**Файл:** `-=tasks=-/2026-07-22/20260722_001_phrase_replace_numbers_categories_plan.md`
**Статус:** plan

---

## Контекст

> - `-=CHECKPOINTS=-/20260719_002_checkpoint.md`
> - `-=tasks=-/TASK_CONVENTIONS.md`
> - `LESSONS_LEARNED.md` §6 (многословные фразы — дыра в движке)
> - `app/src/engine/rules.ts`, `app/src/engine/oov-stats.ts`, `app/src/engine/tokenizer.ts`

---

## 1. Цель

Три связанные задачи одной фазы (Phase 8):

1. **Фикс движка замен** — многословные `replacements[*].from` (≥ 2 слов, напр.
   `English Club`) сейчас не применяются. Конкретный пример пользователя:
   правило `replacement_rule_087: { to: English Club community, from: [English Club] }`
   на строке `[00:29:35] Если открыть, например, English Club, наш транскрипт.`
   не срабатывает.
2. **Числа не помечать как OOV** — чистые числовые токены (`10`, `50`, `2026`)
   засоряют грид OOV. Должны автоматически исключаться.
3. **Две новые категории `replacement`** — `project_specific` (проектно-специфичный)
   и `it_slang` (IT-жаргон).

---

## 2. Зачем это нужно

- Без работающей замены фраз пользователь вынужден править текст вручную или заводить
  по одному правилу на каждое слово фразы (что ломает семантику — `English` и
  `Club` по отдельности не означают бренд).
- Числа в OOV — шум: они не требуют решения пользователя (это не опечатки и не
  термины для словаря).
- Новые категории отражают реальную структуру замен: проектные термины и IT-жаргон
  логически отделены от общих `brand_product` / `tech_term`.

---

## 3. Корневая причина бага (детально)

Точные места в коде (подтверждены чтением `rules.ts`):

- `rules.ts:69` — `buildReplaceIndex` кладёт `from` в Map под ключом
  `norm("English Club")` = `"english club"` (с пробелом).
- `rules.ts:178` — `tokenize(origText)`: регулярка `TOKEN_RE`
  (`tokenizer.ts:18` = `/[\p{L}\p{N}]+(?:[-'\u2019][\p{L}\p{N}]+)*/gu`)
  не включает пробел → фраза режется на два токена `"english"` и `"club"`.
- `rules.ts:180-183` — лукап `replaceIdx.get("english")` → `undefined` → `continue`.
  Замена молча пропускается.
- `rules.ts:223` — те же слова затем проходят OOV-проверку и помечаются `oov`
  (если их нет в whitelist).

В `LESSONS_LEARNED.md` §6 эту дыру обошли патчем агрегатора `buildOovRows`
(`oov-stats.ts:89-98`) — скрыли фантомные OOV, но движок replacements не починили.
В этой фазе чиним движок.

---

## 4. Архитектурные решения

| Вопрос | Решение | Обоснование |
|---|---|---|
| Где матчить фразы | В движке `cleanUtterance`, отдельный под-шаг 2a | Движок — источник истины для decorations и итогового текста. |
| Как избежать двойной подстановки (`to ⊃ from`, напр. `English Club` → `English Club community`) | Единый `workText.replace(re_gi, fn)` | JS не ре-сканирует вставленный replacement — идиома, уже применённая для `filler_phrases` (шаг 1). |
| Порядок применения фраз | По убыванию длины `from` | Длинная фраза применяется первой и закрывает токены через `covered`; короткая не заденет уже заменённое (в `workText` подстрока изменилась). Зеркалит `fillerPhrases` (`rules.ts:85-86`). |
| Где брать позиции для decorations | Из `origText` (через `origText.matchAll(re)`) | Original pane показывает исходный текст; позиции decorations не зависят от замен в `workText`. |
| Как исключить OOV для слов внутри фразы | Массив `covered: {start,end}[]` + хелпер `isCoveredBy` | Шаг 4 (OOV) пропускает токены, полностью лежащие в покрытом диапазоне. |
| Числовой фильтр | Regex `/^\p{N}+$/u` в `buildOovRows` | По принципу §6: фильтрация шума — в агрегаторе, движок остаётся источником истины для decorations (числа остаются подсвеченными в transcript, но пропадают из OOV-грида). |
| Числа с разделителями (`10.5`, `1,000`) | Не спец-обрабатываем | `tokenize` уже режет их на отдельные числовые токены → каждый исключается общим правилом. |
| Новые категории | Только в `sample/.../glossary.yaml` | Архитектура data-driven: `label` — строка-ссылка на id категории; UI `<select>`, валидация, экспорт подхватываются автоматически. |
| Патч `buildOovRows` из §6 | Не трогаем | После фикса движка он станет безвредным no-op для replacement-фраз (их токены не попадут в OOV-декорации), но всё ещё нужен для `filler_phrases`. |

---

## 5. План реализации

### Часть 1. Фикс движка (`app/src/engine/rules.ts`)

**1.1. Разделить индекс замен.** Заменить `buildReplaceIndex` → `buildReplaceIndices`:

```ts
interface ReplacePhrase {
  from: string;       // нормализованная фраза (lowercase, с пробелами)
  to: string;
  ruleKey: string;
  capitalize: boolean;
}
interface ReplaceIndices {
  words: Map<string, ReplaceIndex>;   // однословные from (как сейчас)
  phrases: ReplacePhrase[];           // многословные from (≥ 1 пробела)
}
```

При итерации `from`: если `norm(from).includes(" ")` → в `phrases`, иначе в `words`.
Фразы сортировать по убыванию длины (как `fillerPhrases`, `rules.ts:85-86`).

**1.2. Расширить `CleanCtx`** (`rules.ts:127-134`): `replaceIdx` → `replaceWords` +
новое поле `replacePhrases`. Обновить вызов в `applyRules` (`rules.ts:108`).

**1.3. Переписать шаг 2 `cleanUtterance`** (`rules.ts:173-196`):

- Ввести `const covered: Array<{ start: number; end: number }> = [];`
- **2a. Фразы** — цикл по `ctx.replacePhrases`, для каждой:
  - `origText.matchAll(re)` → декорации `will-replace` + `addHit` + `stats.replaced`
    + push в `covered`.
  - `workText.replace(re, fn)` одним проходом (fn определяет capitalize по
    `isAtSentenceStart(workText, offset)`).
- **2b. Слова** — текущий цикл, с добавлением `if (isCoveredBy(covered, tok.start, tok.end)) continue;`
  в начале; `replaceIdx` → `replaceWords`.

**1.4. Шаг 3** (`rules.ts:204`): `!ctx.replaceIdx.has(key)` → `!ctx.replaceWords.has(key)`.

**1.5. Шаг 4 OOV** (`rules.ts:218-232`): добавить
`if (isCoveredBy(covered, tok.start, tok.end)) continue;` после `stats.totalWords += 1`;
`replaceIdx` → `replaceWords`.

**1.6. Хелпер `isCoveredBy`** — линейный поиск по `covered`.

### Часть 2. Числовой фильтр (`app/src/engine/oov-stats.ts`)

- Константа `const NUMERIC_RE = /^\p{N}+$/u;` рядом с `OovStatsContext`.
- В `buildOovRows` после шага 1 (построение map, `oov-stats.ts:64`), до фразовой
  фильтрации — цикл удаления ключей, матчатся `NUMERIC_RE`.

### Часть 3. Новые категории (`sample/transcript_optimizer/glossary.yaml`)

Добавить в `categories:` два ключа (snake_case — иначе warning `glossary:id`):

```yaml
  project_specific:
    title: Проектно-специфичный
    description: Термины и названия, уникальные для данного проекта
  it_slang:
    title: IT-жаргон
    description: Разговорные IT-термины, жаргонизмы, кальки
```

Тестовых replacement-правил с этими label НЕ добавляем (только категории).

---

## 6. Верификация

JS-тест-раннера в проекте нет (проверка через `tsc --noEmit` + `vite build`, как
в Phase 7 — см. чекпоинт §«Test status»).

1. `cd app && pnpm exec tsc --noEmit` — типы (особенно refactor `replaceIdx` →
   `replaceWords` + новый `ReplacePhrase`).
2. `cd app && pnpm exec vite build` — сборка.
3. **Временный node-скрипт** (не коммитится): прогнать `applyRules` на мини-транскрипте
   `"[00:29:35] Если открыть English Club, наш транскрипт."` с правилом
   `English Club → English Club community`, проверить:
   - `cleanedText` содержит `English Club community` (замена применилась);
   - нет `community community` (двойная подстановка);
   - нет OOV-декораций для `english` / `club`;
   - есть декорация `will-replace` для фразы.
4. Ручной smoke (пользователь): `pnpm tauri dev` с реальным транскриптом —
   грид OOV (нет чисел), подсветка `will-replace` на фразе, итоговый текст.

Бонус-проверка: после фикса автоматически должны заработать многословные `from`
из существующего `sample/.../replacements.yaml`: `open code`, `дек бади`,
`кодекс ЧПТ`, `Лоу Кода`, `да, да, да,`.

---

## 7. Коммиты (по `TASK_CONVENTIONS`: код и документы не смешивать)

1. `docs(tasks): add 20260722_001 plan` — этот файл.
2. `feat(app): apply multi-word replacement phrases in engine` — часть 1 (rules.ts).
3. `feat(app): exclude pure numbers from OOV grid` — часть 2 (oov-stats.ts).
4. `feat(sample): add project_specific and it_slang glossary categories` — часть 3.
5. `docs(tasks): add 20260722_001 result` — результат.
6. `docs(phase_08): Phase 8 summary` — `-=PHASES=-/Phase_08.md`.
7. `docs(checkpoint): add 20260722_001` — `-=CHECKPOINTS=-/20260722_001_checkpoint.md`.

---

## 8. Что НЕ делаем (осознанно)

- Не трогаем патч `buildOovRows` из §6 — станет безвредным no-op для replacement-фраз.
- Не добавляем JS test-раннер (vitest) — отдельная задача, расширяет scope.
- Не делаем числа настраиваемыми через `settings.yaml` — хардкод regex.
- Не добавляем готовые replacement-правила с новыми `label` — только категории.
- `lemma_replacements` многословные `from_lemmas` не трогаем (движок лемм не
  применяется в MVP).

---

## 9. Риски и нюансы

- **Двойная подстановка** (`to ⊃ from`) — закрыта единым `.replace(re_gi, fn)`.
  Проверить явно в верификации #3.
- **Перекрытие фраз** (`english club` vs гипотетический `english club community`
  как `from`) — сортировка по длине desc + `covered` spans.
- **Decorations в original pane** считаются по `origText` — корректны.
- **`isAtSentenceStart(workText, offset)`** в callback — использует `workText`
  (не `origText`), т.к. соответствие смещений нарушено после замен. Логически
  корректно: контекст replacement определяется по текущему тексту.
