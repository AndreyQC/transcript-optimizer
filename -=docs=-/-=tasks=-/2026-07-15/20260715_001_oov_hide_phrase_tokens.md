# OOV-статистика: скрывать токены, которые встречаются только внутри многословных фраз

**Дата:** 2026-07-15
**Проект:** transcript-optimizer (desktop: Tauri 2 + React 19 + TS + Vite 7 + Monaco)
**Ветка:** продолжаем `docs/transcript-optimizer-plan`.
**Этот файл — план следующего изменения.** Реализуется по нему.

> **Контекст:** панель «Статистика OOV» во вкладках левой панели оригинала
> реализована в `20260714_001_oov_stats_panel_result.md` (коммит `7ee48b3`).
> Обнаружена неточность в датасете — см. «Проблема». Решение ниже.

---

## ✅ Состояние репозитория на момент написания

- Ветка: `docs/transcript-optimizer-plan`. Working tree чистый.
- Этапы 0-4 готовы + OOV-панель запушена (`7ee48b3`).
- Это изменение — НЕ НАЧАТО. Файл описывает, что сделать.

---

## 🎯 Цель

Сделать так, чтобы в гриде «Статистика OOV» **не показывались токены, которые в
данном прогоне встречаются только как часть многословной фразы из `filler` или
`replacements`**. Такие токены пользователь уже «обработал» (включил в правило
целиком), и шум в гриде из них не нужен.

### Критерий готовности

1. Токен, у которого **каждое появление** в `transcript` лежит внутри какой-либо
   многословной фразы из `filler_phrases` или `replacements[*].from` (с `is_phrase`
   или с количеством слов > 1), **не появляется** в `OovRow`-ах грида.
2. Токен, у которого **хотя бы одно** появление стоит вне такой фразы,
   остаётся в гриде с count, считающим **все** его вхождения (внутри и вне фраз).
   Иначе говоря — не скрываем «с головы», а даём данные движка.
3. Поведение для одиночных слов (`filler_words`, `replacements[*].from` длиной 1)
   не меняется — они уже корректно исключаются существующей проверкой в `rules.ts`
   §4 (`replaceIdx.has(key)` / `fillerWords.has(key)`).
4. Существующие критерии (whitelist, replacement-to, lemma-to) не затрагиваются.

### ВНЕ MVP

- Не менять поведение для `keep_override` (это про `filler_words`, не про фразы).
- Не считать «фразовыми» многословные правила с `from.length <= 1` — они уже
  корректно отфильтрованы одиночным `replaceIdx.has(key)`.
- Не вводить UI-переключатель правила (вкл/выкл) — в этом проходе правило
  всегда активно.

---

## ❗ Проблема (найдена при анализе `rules.ts` + `oov-stats.ts`)

Движок исключает OOV-токены, если они попали в одно из:

1. `effectiveWhitelist` (`common_words` ∪ `replacements[*].to` ∪ `lemma[*].to`)
   — `rules.ts:78`, `:224`.
2. `replaceIdx` (нормализованный `from` одиночных замен) — `rules.ts:218-232`.
3. `fillerWords` (`filler_words`, одиночные, без `keep_override`) — там же.
4. `min_word_len` — переводит в `short-garbage`.

**Что не покрыто:** **многословные фразы** в `filler_phrases` и
`replacements[*].from` с количеством слов ≥ 2.

- `filler_phrases` удаляются как подстроки по `wordBoundaryRe` (`rules.ts:159-169`).
  Для каждого совпадения кладётся декорация категории `filler-removed` (не `oov`),
  но **сами токены внутри фразы на шаге §4** проходят OOV-проверку по
  `origTokens`. Они НЕ матчатся через `fillerWords.has(key)` (там только
  одиночные слова) и НЕ матчатся через `replaceIdx.has(key)` — поэтому, если
  не в whitelist, попадают в `oov`.
- Аналогично — `replacements` с многословным `from`: на шаге §2 (`rules.ts:178-196`)
  по `origTokens` ищется точное совпадение нормализованной фразы (как целого
  токена она не существует — `tokenize` режет по словам), поэтому многословные
  `from` тут **не срабатывают вообще**. Зато на шаге §4 те же слова-внутри-фразы
  идут в OOV, если они не в whitelist/`fillerWords`.

Результат: в грид «Статистика OOV» попадают слова, которые пользователь **уже
затронул** через многословное правило — они будут вводить в заблуждение.

---

## 🧠 Решение (принятое пользователем 2026-07-15)

> **«Токен OOV встречается только в многословной фразе из filler или
> replacement — не выводить в статистике.»**

Критерий (уточнение пользователя): **токен никогда не встречается вне такой
фразы в этом прогоне**. То есть скрываем `OovRow` только если все его
вхождения в исходном тексте лежат внутри какой-либо многословной фразы
(`filler_phrases` или многословного `replacements.from`).

**Реализация — на уровне агрегации (`buildOovRows`), без правки движка.**
Движок (`rules.ts`) не трогаем — он остаётся источником истины decorations.

---

## 🔒 Зафиксированные решения (УЖЕ ПРИНЯТЫ, не пересомневаться)

| Вопрос | Решение | Обоснование |
|---|---|---|
| Где фильтровать | В `buildOovRows` (`app/src/engine/oov-stats.ts`). Движок не трогаем | Движок — источник decorations, но датасет грида формируется здесь. Фильтрация по «никогда вне фразы» — чисто статический анализ текста+правил, на движок не ложится. |
| Что считать «многословной фразой» правила | Любая запись, нормализованная форма которой содержит ≥ 2 слова (т.е. ≥ 1 внутренний пробел/перенос). Для `filler_phrases` — то же; для `replacements[*].from` — нормализованная строка целиком (каждое `from` отдельно) | Соответствует тому, что движок обрабатывает на шаге §1 (filler_phrases как подстрока) и на шаге §2 (replacements — попытки найти всю фразу не работают для многословных, но правило всё равно «существует»). Не усложняем: режем по пробелам. |
| Где взять список фраз | Принимаем в `buildOovRows` дополнительно `RuleInput` (или только нужные поля: `filler.filler_phrases` и все `replacements[*].from` нормализованные) | Чистая функция, тестируемая. Источник — zustand `useDictionaries`, прокинем через `useMemo` deps. |
| Как определить «внутри фразы» | По позициям вхождений. Для каждого `origTokens` (нужен второй проход, либо движок уже не хранит позиции в `decorations` для oov). Реализация: пройтись по исходному тексту каждой реплики, найти все вхождения каждой фразы `wordBoundaryRe`-ом, собрать `Set<{start,end}>` диапазонов; для токена проверить — в каждом ли его вхождении его `[start,end)` ⊂ диапазону фразы | Надёжнее, чем сравнивать по `value` — учитывает многократные вхождения фраз и перекрытия. |
| Подсчёт count у скрываемого токена | Скрываем полностью (не показываем строку). Если токен всё же где-то «снаружи» — он попадёт в грид со своим полным count (внутри + снаружи) | Требование пользователя: «не выводить в статистике». |
| Данные для прохода по позициям | Берём `transcript.blocks[*].utterances[*].text` (или `transcript.raw`, разбитый по строкам через парсер). Лучше — через `transcript`, чтобы не зависеть от CRLF | `transcript` уже есть в props `TranscriptView`. |
| Обновление после правки словарей | Существующий механизм (`cleanDirty` + «Очистить»). Функция чистая, пересчитается автоматически | Консистентно с существующим. |

---

## 📐 Дизайн

### Где живёт логика

```
app/src/engine/oov-stats.ts
├── buildOovRows(cleanResult, ctx)            ← расширенная сигнатура
│     ctx = { fillerPhrases, replacementPhrases }: { norm: string }[]
└── helpers (новая секция):
      • findPhraseSpans(text, phrases) → {start,end}[]   // диапазоны ВСЕХ вхождений фраз в тексте
      • tokenSpans(text)               → {start,end,value,key}[]  // позиции исходных токенов (повторный tokenize)
      • isTokenOnlyInsidePhrase(tokSpans, phraseSpans, tokIndex) → boolean
```

### Сигнатура (после изменения)

```ts
export interface OovStatsContext {
  // Многословные фразы, по которым НЕ должны идти токены в OOV.
  // Каждая фраза — нормализованная строка (≥ 2 слов).
  phraseNorms: string[];
}

export function buildOovRows(
  cleanResult: CleanResult,
  ctx: OovStatsContext,
): OovRow[];
```

`OovStatsContext` собирается в `TranscriptView.tsx` через `useMemo`:

```ts
const oovCtx = useMemo<OovStatsContext>(() => {
  const phraseNorms: string[] = [];
  for (const p of filler?.filler_phrases ?? []) {
    const n = norm(p);
    if (n.includes(" ")) phraseNorms.push(n); // ≥ 2 слов
  }
  for (const rule of Object.values(replacements?.replacements ?? {})) {
    for (const from of (rule as ReplacementRule).from ?? []) {
      const n = norm(from);
      if (n.includes(" ")) phraseNorms.push(n);
    }
  }
  return { phraseNorms };
}, [filler, replacements]);
```

Внутри `buildOovRows`:

```ts
// 1. Собрать позиции фраз по всему транскрипту.
//    (Нужен доступ к тексту реплик — добавим параметром cleanResult.transcript? нет,
//    лучше: cleanResult не хранит исходник, поэтому прокинем transcript отдельно.)
```

> **Уточнение по сигнатуре:** `CleanResult` не хранит исходный текст реплик.
> Нужно либо:
> - **Вариант A (выбран):** расширить сигнатуру `buildOovRows(cleanResult, transcript, ctx)`,
>   где `transcript: ParsedTranscript` нужен только для второго прохода позиций
>   токенов и фраз. `oov-stats.ts` остаётся чистой функцией.
> - Вариант B: положить `transcript` в `CleanResult` — ломает текущий контракт,
>   лишний вес в результате, не нужно UI.
>
> Принят **Вариант A**.

### Алгоритм

```
buildOovRows(cleanResult, transcript, ctx):
  // 1. Собрать диапазоны всех многословных фраз во всех репликах.
  //    Для каждой utterance.text — findPhraseSpans(text, ctx.phraseNorms).
  //    Возвращает Map<lineNo, [{start,end},…]>.
  phraseSpansByLine = build phrase spans per lineNo;

  // 2. Для каждой utterance — заново tokenize(text), получить
  //    [{lineNo, start, end, value, norm(value)=key}].
  //    Это нужно, потому что в Decoration есть только координаты для oov/short-garbage —
  //    но они уже НЕ нужны как первичные; мы всё равно пройдёмся по origTokens.
  //    Экономим: берём уже существующие decoration{lineNo,startCol,endCol,text} + координаты.
  // 3. Для КАЖДОЙ oov/short-garbage декорации:
  //      tokenKey = norm(decoration.text)
  //      проверить: есть ли такое же значение ХОТЯ ГДЕ-НИБУДЬ в transcript
  //                 вне диапазонов фраз → если да → не скрываем.
  //      иначе — пропустить (не добавлять в map).

  // Альтернатива (проще, шаг 3): скрываем по значению, а не по позиции.
  //   Для каждого уникального norm-ключа в oov:
  //     просмотреть ВСЕ его вхождения в transcript (по tokenSpans+norm)
  //     посчитать, сколько из них «внутри» phraseSpans (полностью ⊂) vs «снаружи»
  //     если «снаружи» count == 0 → удалить из map.
```

**Принят упрощённый вариант (по значению):** достаточно пофазно:
1. По transcript собрать `tokenOccurrences: Map<norm, {lineNo,start,end}[]>` — все вхождения каждого токена в исходнике.
2. По transcript собрать `phraseSpansByLine: Map<lineNo, {start,end}[]>` — все диапазоны многословных фраз.
3. По decorations построить начальный `map: Map<norm, OovRow>` (как сейчас).
4. Для каждого `key ∈ map.keys()`:
   - `occs = tokenOccurrences.get(key) ?? []`
   - `outsideCount = occs.filter(o => !isInsideAnyPhrase(o, phraseSpansByLine.get(o.lineNo))).length`
   - Если `outsideCount === 0` → удалить из `map`.
5. Вернуть отсортированный результат.

### Утилиты (новые в `oov-stats.ts`)

```ts
// Диапазоны вхождений всех фраз в одной строке.
function findPhraseSpansInText(text: string, phraseNorms: string[]): {start,end}[];
// tokenize c нормализацией, возвращает {value,start,end,norm}[]
function spansForText(text: string): {value, start, end, norm}[];

// isInsideSpan(token: {start,end}, phraseSpan: {start,end}): boolean
// isInsideAny(token, spans: {start,end}[]): boolean
```

Все три — pure, без побочек. Используют уже существующие `tokenize`/`norm`
из `engine/tokenizer.ts`.

### Что делать с `keep_override`

`keep_override` — это про одиночные `filler_words`, не про фразы. В многословных
фразах движок сейчас всё равно удаляет (нет `keep_override`-логики для фраз —
это особенность существующего кода). В рамках этой задачи не трогаем.

---

## 🔧 План реализации (по шагам)

### Шаг 1. Расширить `buildOovRows` и добавить утилиты в `oov-stats.ts`

**Файл:** `app/src/engine/oov-stats.ts`

- Добавить экспорт `OovStatsContext`.
- Изменить сигнатуру `buildOovRows(cleanResult, transcript, ctx): OovRow[]`.
- Реализовать приватные `findPhraseSpansInText`, `spansForText` (или
  переиспользовать существующий `tokenize`), `isInsideAny`.
- Алгоритм шагов 1-5 из «Дизайна» выше.
- Сохранить сортировку (count ↓, display ↑).

**Файл:** `app/src/engine/tokenizer.ts`
- Если `spansForText` — обёртка над `tokenize`, ничего не менять. Иначе —
  добавить экспорт, если его нет (проверить: `tokenize` уже экспортируется).

### Шаг 2. Собрать `OovStatsContext` в `TranscriptView.tsx`

- В компоненте, который сейчас вызывает `buildOovRows`, добавить `useMemo`
  для контекста (см. фрагмент в «Дизайне»).
- Зависимости: `filler`, `replacements` (zustand-селекторы по спискам — точечно,
  не на весь store).
- Передать `transcript` (он уже доступен через props/useTranscriptStore) и `ctx`
  в `buildOovRows`.

### Шаг 3. Сохранить существующие ручки взаимодействия

- `OovStatsGrid.tsx` — **не трогаем**. Контракт `OovRow` не меняется
  (только меньше строк может быть).
- `handleAddWhitelist`, `onAddReplacement` — без изменений.
- `useMemo`-зависимости `buildOovRows` дополняются `[cleanResult, transcript, oovCtx]`.

### Шаг 4. Проверка

- `pnpm exec tsc --noEmit` — чисто.
- `pnpm exec vite build` — `✓ built`.
- **Ручной тест на реальном транскрипте:**
  1. Открыть транскрипт → «Очистить» → вкладка «Статистика».
  2. Запомнить, какие слова были ДО изменения (сравнить с git).
  3. Убедиться, что **слова, которые есть только внутри многословных фраз**
     (`filler_phrases` или `replacements` с многословным `from`), **ушли**
     из грида.
  4. Убедиться, что слова, которые встречаются и внутри, и снаружи фраз,
     **остались** и их count = общее число вхождений (а не уменьшился).
  5. Кнопки whitelist/replacement по оставшимся словам работают как раньше.

### Шаг 5. Документация

- `LESSONS_LEARNED.md` — добавить §5 «Многословные правила и OOV-фильтрация»
  с описанием инварианта и почему фильтрация идёт в `buildOovRows`, а не в
  движке.
- Этот файл (`20260715_001_oov_hide_phrase_tokens_result.md`) — после
  реализации.

---

## ⚠️ Риски и нюансы

1. **Производительность:** второй проход по transcript (`tokenize` + поиск фраз)
   для каждой реплики — O(N × P) где N = кол-во токенов, P = кол-во фраз.
   Для транскриптов в десятки тысяч слов — приемлемо (memo на `cleanResult`
   кеширует). Если окажется медленно — вынести `buildOovRows` в worker
   (бэклог).
2. **`tokenize` vs `origTokens` движка.** На шаге §4 движок использует свой
   `origTokens` (`tokenize(origText)`). Чтобы декорации и наш второй проход
   считали токены одинаково — **используем тот же `tokenize` из того же
   файла**. Нормализация и границы слов совпадут.
3. **Перекрытие фраз.** Если две фразы перекрываются («в общем» и «в общем-то»),
   `findPhraseSpansInText` соберёт оба диапазона. `isInsideAny` всё равно
   корректно ответит «да, токен внутри» (хотя бы одной фразы). Ложного
   сокрытия не будет.
4. **Регистр и пробелы.** `norm()` приводит к lowercase и схлопывает пробелы;
   `findPhraseSpansInText` работает по нормализованному тексту. Нужно убедиться,
   что `wordBoundaryRe` движка и наш матчер ведут себя одинаково на
   Unicode-границах (кириллица). Возьмём то же правило, что и движок
   (`\p{L}\p{N}` — Unicode property escapes).
5. **`CleanResult.decorations` и `transcript` — два параметра.** Если кто-то
   в будущем закэширует только `cleanResult` и забудет про `transcript` —
   строки «уплывут». Помечаем в JSDoc параметра.
6. **`replacements` без `from`.** Возможно поле отсутствует — обрабатываем
   как пустой массив (без crash).

---

## 📁 Файлы, затрагиваемые изменением

| Файл | Изменение |
|---|---|
| `app/src/engine/oov-stats.ts` | расширение сигнатуры `buildOovRows`, добавление утилит `findPhraseSpansInText`, `spansForText`, `isInsideAny`; новый тип `OovStatsContext` |
| `app/src/components/TranscriptView.tsx` | `useMemo` для `OovStatsContext`, передача `transcript` и `ctx` в `buildOovRows` |
| `LESSONS_LEARNED.md` | новый раздел §5 |

Новых файлов нет. `OovStatsGrid.tsx`, `rules.ts`, `types.ts`, словари — без изменений. Бэкенд (Rust) не трогается.
