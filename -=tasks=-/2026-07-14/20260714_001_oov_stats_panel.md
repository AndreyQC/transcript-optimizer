# Панель «Статистика OOV» во вкладках левой панели оригинала

**Дата:** 2026-07-14
**Проект:** transcript-optimizer (desktop: Tauri 2 + React 19 + TS + Vite 7 + Monaco)
**Этот файл — план следующего изменения.** Реализуется по нему.

> **Инструкция новому диалогу:** ты продолжаешь разработку. Все архитектурные
> решения УЖЕ ПРИНЯТЫ (см. «Зафиксированные решения») — не пересомневаться.
> Паттерны zustand-селекторов и движок правил — критичны; если сомневаешься,
> смотри `app/src/components/TranscriptView.tsx`, `app/src/engine/rules.ts`,
> `app/src/lib/yaml-edit.ts` и `LESSONS_LEARNED.md` (§3 про zustand).

---

## ✅ Состояние репозитория на момент написания

- **Ветка:** `docs/transcript-optimizer-plan`.
- Этапы 0-4 готовы и запушены: редактор словарей, движок правил + просмотр
  транскрипта (`TranscriptView.tsx`), контекстное меню ПКМ → словарь
  (`contextMenuActions.ts` + `ContextActionDialog.tsx`), LLM-summary.
- Working tree чистый.
- **Это изменение — НЕ НАЧАТО. Файл описывает, что сделать.**

---

## 🎯 Цель

При открытом оригинальном транскрипте превратить **левую панель** (сейчас там
один Monaco с оригиналом) в **панель с вкладками**:

1. **Вкладка «Оригинал»** — текущий Monaco с текстом оригинального транскрипта
   (со всеми подсветками decorations, контекстным меню, синхронизацией). Поведение
   и внешний вид — без изменений.
2. **Вкладка «Статистика»** — таблица (грид) со словами, которые **не найдены ни
   в одном словаре и не входят в replacement** (то есть OOV + short-garbage), с
   возможностью множественного селекта и кнопками «Добавить в whitelist» и
   «Добавить в replacement».

### Критерий готовности
1. Слева над Monaco появилась полоска вкладок «Оригинал | Статистика».
2. Вкладка «Оригинал» показывает то же, что раньше занимало всю левую панель.
3. Вкладка «Статистика» показывает грид OOV-слов с колонками:
   - **Слово** (как в тексте; нормализованная форма используется только для
     агрегации счётчика);
   - **Количество** — сколько раз слово встречается в тексте.
4. Грид поддерживает **множественный селект** (чекбоксы / Ctrl/Shift-клик).
5. Под/над гридом две кнопки:
   - **«Добавить в whitelist»** — добавляет **все выделенные** слова разом в
     `detector_whitelist.yaml` (раздел `common_words`);
   - **«Добавить в replacement»** — доступна только при **ровно одном**
     выделенном слове; открывает тот же диалог/поток, что и ПКМ «Заменить на…»
     (`ContextActionDialog` с `action: "replace"`).
6. После применения правки словаря статистика обновляется (через существующий
   флаг `cleanDirty` / пересчёт `applyRules`).

### ВНЕ MVP (бэклог, НЕ делать в этом проходе)
- Сортировка/фильтрация/поиск по гриду (только сортировка по убыванию count по
  умолчанию — этого достаточно).
- Группировка по спикеру/таймлайну.
- Пагинация/виртуализация (транскрипты пока небольшие; если тормозит — позже).
- Редактирование прямо в гриде.
- Добавление в `filler`/`lemma`/`keep` из этой панели (оставлено для ПКМ-меню).
- «Очистить выделение», «инвертировать выделение» и прочие масс-операции.

---

## 🔒 Зафиксированные решения (УЖЕ ПРИНЯТЫ, не пересомневаться)

| Вопрос | Решение | Обоснование |
|---|---|---|
| **Какой датасет в гриде** | Слова категории `oov` **и** `short-garbage` из `cleanResult.decorations`, с дедупликацией и подсчётом частоты | Требование ТЗ: «слово, которое не было найдено ни в одном словаре и в replacement». По движку (`rules.ts` §4) это ровно токены, не попавшие в `effectiveWhitelist` ∪ replacements ∪ filler — они и помечаются `oov`/`short-garbage`. |
| **Что считать «словом» (ключ агрегации)** | **Нормализованная форма** (`norm()` из `engine/tokenizer`) — ключ, **исходное написание** (первое встретившееся) — отображаемое значение | Регистронезависимая агрегация: «Привет» и «привет» — одно слово с одним счётчиком. Так же работает движок. |
| **Откуда брать данные** | **Из `cleanResult.decorations`**, НЕ отдельным проходом по тексту | Decorations уже вычислены при «Очистить»; отдельный токенизатор = двойная работа и риск рассинхрона с подсветкой. |
| **Куда класть вкладки** | **Внутри `TranscriptView.tsx`**: обернуть левый `.transcript-pane` в компонент `OriginalPane` с локальным `useState<TabId>` | Изменение локальное для одной панели; отдельный файл-компонент + переиспользование существующего `Editor`/`onOrigMount`. Без новых zustand-слоёв. |
| **Добавление в whitelist (множественное)** | **Цикл `addEntry` по выделенным словам**, накатывая raw одного на вход следующего (reduce), затем **один `applyEdit('whitelist', raw)` + один push в undo** | `yaml-edit.addEntry` правит CST и сохраняет комментарии/стиль. Несколько `applyEdit` подряд дали бы N undo-шагов — неудобно. Один батч = один undo. |
| **Добавление в replacement** | **Переиспользовать `ContextActionDialog`** с `action: "replace"`, `selection: { text: word, isPhrase: false }` | ТЗ: «добавлять аналогично тому, как добавляется в текущей реализации». Диалог уже умеет форму `to`+`label`, превью diff, apply. Дублировать логику нельзя. |
| **Доступность кнопки «В replacement»** | **Disabled, если `selected.size !== 1`** | ТЗ явно требует: «проверять, что выбрано только одно». Для `replace` нужен один `from`. |
| **Когда статистика доступна** | Только после «Очистить» (есть `cleanResult`). До этого — заглушка как у текущего `StatsPanel` | Decorations считаются в `applyRules`. Без него грида нет. |
| **Обновление после правки словарей** | Существующий механизм: правка словаря → `markCleanDirty()` → пользователь жмёт «Очистить» заново. **Автопересчёт НЕ делаем** (как и в текущей панели) | Консистентно с нынешним UX; MVP не усложняет. |
| **Стиль вкладок** | CSS, без UI-библиотеки. Чекбоксы — нативные `<input type="checkbox">`. Таблица — как `.stats-table` | Проект не использует UI-кит; все панели самописные на CSS. |

---

## 📐 Дизайн

### Расположение вкладок

```
┌─────────────────────────────────────┐  ← левая панель (.transcript-pane)
│ [ Оригинал ] [ Статистика (N) ]     │  ← полоса вкладок (.tabs)
├─────────────────────────────────────┤
│                                     │
│   Monaco с оригиналом               │  ← вкладка "Оригинал"
│   (или грид OOV — вкладка "Статистика")
│                                     │
└─────────────────────────────────────┘
```

- Высота вкладок ~28px, под существующий `.pane-header` по стилю.
- В заголовке вкладки «Статистика» — `(N)` = число уникальных OOV-слов.
- Monaco **не размонтировать** при переключении вкладок (иначе слетают
  decorations/курсор/скролл): рендерить через `display: none` / CSS-класс скрытия.
  **Грид рендерить только когда вкладка активна** (ему нечего сохранять).

### Датасет грида

Производный тип (в `engine/types.ts` или локально в компоненте):

```ts
interface OovRow {
  display: string;   // исходное написание (первое встретившееся)
  norm: string;      // нормализованная форма — ключ агрегации
  count: number;     // сколько раз в тексте
  category: DecorationCategory; // "oov" | "short-garbage" (для бейджа/цвета)
}
```

Вычисление (мемоизировать через `useMemo` по `cleanResult`):

1. Отфильтровать `cleanResult.decorations` по `category ∈ { "oov", "short-garbage" }`.
2. Для каждой декорации восстановить слово из исходного текста по
   `lineNo`/`startCol`/`endCol` (парс `transcript.raw` по строкам) → получить
   `display` и `norm` через `tokenize`/`norm`.
   - **Альтернатива (проще):** расширить `Decoration` опциональным полем
     `text?: string` и заполнять его в `rules.ts` прямо при создании декорации
     (там уже есть `tok.value`). Это убирает хрупкий обратный поиск по сырым
     строкам. **ПРЕДПОЧТИТЕЛЬНО** — см. «Шаг 1».
3. Сгруппировать по `norm`, `count++`, `display = первое встретившееся`,
   `category` — взять любую (обычно стабильно для одного слова).
4. Отсортировать по `count` убыванию, затем по `display` по алфавиту.

### Грид

```
┌──────────────────────────────────────────────────────┐
│ [✓] Слово           Кол-во    Тип                     │
│ ──────────────────────────────────────────────────── │
│ [✓] распознвание      7       OOV                     │
│ [ ] чё               12       short                   │
│ [✓] таймштамп         3       OOV                     │
│ ...                                                  │
├──────────────────────────────────────────────────────┤
│ Выбрано: 2   [ Добавить в whitelist ] [ В replacement ]│
└──────────────────────────────────────────────────────┘
```

- Шапка с чекбоксом «выбрать все».
- Строка: чекбокс + слово (моноширинно) + count + цветной бейдж категории.
- Сортировка по count ↓ (заголовок кликабелен опционально — бэклог).
- Footer: «Выбрано: N» + две кнопки. Кнопка «В replacement» `disabled` при
  `N !== 1`.

### Поведение кнопок

- **«Добавить в whitelist»** (требует `selected.size >= 1`):
  1. Взять raw текущего `whitelist`-entries из `useDictionaries`.
  2. `reduce` по выделенным словам: `addEntry(raw, { kind: "whitelist", value: word.display })`
     → если `!ok`, показать ошибку и прервать.
  3. Один вызов `applyEdit('whitelist', finalRaw)` → один undo-шаг.
  4. Очистить выделение, показать краткий статус «Добавлено N слов».
  - Дедупликация: если слово уже в `common_words`, пропустить с подсчётом
    «уже было: M». Простой `.includes` по `norm()` от существующих значений.

- **«Добавить в replacement»** (требует `selected.size === 1`):
  1. Установить `ctxAction = "replace"`, `ctxSelection = { text: row.display, isPhrase: false }`.
  2. Тот же `ContextActionDialog` отрисовывается (он уже смонтирован в
     `TranscriptView`). Пользователь вводит `to` + `label`, жмёт «Превью» →
     «Применить».
  3. После закрытия диалога — очистить выделение в гриде.

---

## 🔧 План реализации (по шагам)

### Шаг 1. Расширить `Decoration` текстом слова (опционально, но рекомендуется)

**Файл:** `app/src/engine/types.ts`
- Добавить `text?: string` в `Decoration` (исходное написание токена).

**Файл:** `app/src/engine/rules.ts`
- В блоке OOV/short-garbage (строки ~219-232) при создании декорации передавать
  `tok.value` как `text`:
  ```ts
  addDecoration(decorations, utt.lineNo, …, "short-garbage" | "oov", undefined, tok.value);
  ```
- Поправить сигнатуру `addDecoration` (добавить параметр `text?`) и класть его в
  объект. **Не сломать** остальные вызовы (`filler-removed`, `will-replace`) —
  там `text` можно не передавать (останется `undefined`, гриду это не нужно).

**Почему:** убирает хрупкий обратный поиск слова по `lineNo`/`cols` в `raw` и
риск рассинхрона (например, при CRLF). Дёшево: данные уже есть в `tok.value`.

> **Альтернатива Б** (без правки движка): в компоненте восстановить текст из
> `transcript.raw` по `lineNo`/`startCol`/`endCol`. Допустимо, если не хочется
> трогать движок — но менее надёжно. Принять решение по ходу; по умолчанию — Шаг 1.

### Шаг 2. Компонент `OovStatsGrid`

**Новый файл:** `app/src/components/OovStatsGrid.tsx`
- Пропсы: `rows: OovRow[]`, колбэки `onAddWhitelist(words: string[])`,
  `onAddReplacement(word: string)`.
- Локальный стейт: `selected: Set<string>` (ключ — `norm`).
- Рендер: таблица + footer с кнопками по дизайн-макету выше.
- Мемоизация выделения; чекбокс «все» в шапке.

**Тип `OovRow`** — локально в файле (или в `engine/types.ts`, если переиспользуется).

### Шаг 3. Селектор OOV-строк

В `TranscriptView.tsx` (или отдельная утилита `engine/oov-stats.ts`):
```ts
function buildOovRows(cleanResult: CleanResult): OovRow[] {
  const map = new Map<string, OovRow>();
  for (const d of cleanResult.decorations) {
    if (d.category !== "oov" && d.category !== "short-garbage") continue;
    const display = d.text ?? "<unknown>";
    const key = norm(display);
    const existing = map.get(key);
    if (existing) existing.count += 1;
    else map.set(key, { display, norm: key, count: 1, category: d.category });
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.display.localeCompare(b.display));
}
```
Обернуть в `useMemo(() => buildOovRows(cleanResult), [cleanResult])`.

### Шаг 4. Вкладки в левой панели

**Файл:** `app/src/components/TranscriptView.tsx`
- Вынести левую `.transcript-pane` в новый внутренний компонент `OriginalPane`
  (или оставить инлайн — на усмотрение, но отдельный компонент чище).
- `const [tab, setTab] = useState<"original" | "stats">("original")`.
- Рендер:
  ```tsx
  <div className="transcript-pane">
    <div className="tabs">
      <button className={tab==="original"?"active":""} onClick={()=>setTab("original")}>Оригинал</button>
      <button className={tab==="stats"?"active":""} onClick={()=>setTab("stats")}>
        Статистика{oovRows.length>0 && ` (${oovRows.length})`}
      </button>
    </div>
    <div className={tab==="original"?"":"hidden"}>
      {/* существующий Editor + onOrigMount + options — без изменений */}
    </div>
    {tab === "stats" && (
      <OovStatsGrid
        rows={oovRows}
        onAddWhitelist={handleAddWhitelist}
        onAddReplacement={(w) => { setCtxSelection({text:w,isPhrase:false}); setCtxAction("replace"); }}
      />
    )}
    {!cleanResult && tab === "stats" && <div className="stats-empty">Нажмите «Очистить»…</div>}
  </div>
  ```
- Monaco НЕ размонтировать (`hidden` через CSS, не условный рендер) — иначе
  потеряются decorations/курсор/скролл и придётся их восстанавливать.

### Шаг 5. Обработчик «Добавить в whitelist» (батч)

В `TranscriptView.tsx`:
```ts
const handleAddWhitelist = useCallback(async (words: string[]) => {
  const wlEntry = useDictionaries.getState().entries.find(e => e.kind === "whitelist");
  if (!wlEntry) { /* показать ошибку */ return; }
  const existing = new Set((wlEntry.data as WhitelistFile)?.common_words?.map(norm) ?? []);
  let raw = wlEntry.raw;
  let added = 0, skipped = 0;
  for (const w of words) {
    if (existing.has(norm(w))) { skipped++; continue; }
    const res = addEntry(raw, { kind: "whitelist", value: w });
    if (!res.ok) { /* показать res.error, прервать */ return; }
    raw = res.raw; existing.add(norm(w)); added++;
  }
  applyEdit("whitelist", raw); // один undo-шаг
  setStatus(added ? `Добавлено: ${added}${skipped?`, уже было: ${skipped}`:""}` : "Все слова уже в whitelist");
}, []);
```
> Внимание: читать `entries`/`applyEdit` через хук `useDictionaries` в компоненте,
> НЕ через `getState` в колбэке (иначе реактивность потеряется). `getState` выше —
> только набросок; в реализации — через хуки + `useCallback` с правильными deps.
> Свериться с `LESSONS_LEARNED.md` §3 (zustand-селекторы).

### Шаг 6. «Добавить в replacement» — переиспользование диалога

Уже работает в шаге 4: установка `ctxAction="replace"` + `ctxSelection` открывает
существующий `ContextActionDialog`. Никакой новой логики. Проверить, что после
`onClose` диалога выделение в гриде сбрасывается (опционально — см. «Критерий 6»).

### Шаг 7. CSS

**Файл:** `app/src/App.css`
- `.tabs`, `.tabs button`, `.tabs button.active` — стиль вкладок (бордер-бокс,
  нижняя граница активной вкладки белая/фон панели, чтобы «сливаться»).
- `.transcript-pane .hidden { display: none; }`.
- `.oov-grid` — таблица; переиспользовать визуал `.stats-table` (моноширинные
  слова, бейджи категорий цветом как в легенде: красный OOV, серый short).
- Чекбоксы — дефолтные, выровненные по центру ячейки.
- Footer грида: flex, кнопки как `.btn-mini`.

### Шаг 8. Проверка

- `pnpm exec tsc --noEmit` — типы.
- `pnpm exec vite build` — сборка.
- Ручной тест: открыть транскрипт, «Очистить», переключиться на «Статистику»,
  выделить несколько слов → «Добавить в whitelist» → проверить, что в
  `detector_whitelist.yaml` появились все, одним undo-шагом; выделить одно →
  «Добавить в replacement» → открывается диалог, работает превью/применить;
  вернуться на «Оригинал» — Monaco, decorations и позиция курсора на месте.

---

## ⚠️ Риски и нюансы

1. **Monaco и `display:none`.** Если при скрытии вкладки Monaco ломает layout
   (`automaticLayout` может не пересчитаться при показе) — вызвать
   `origEditorRef.current.layout()` при активации вкладки «Оригинал»
   (в `useEffect` на `tab`). Это известный глюк Monaco в скрытых контейнерах.
2. **CRLF/табы в `raw`.** Если выбран Шаг 1 (расширить `Decoration.text`),
   риск исчезает. Если Альтернатива Б — учитывать `\r` при резке строк.
3. **Несколько `applyEdit` vs один undo.** Батч в один raw-накат (Шаг 5) критичен
   для удобства undo. Не вызывать `applyEdit` в цикле.
4. **Реактивность zustand.** Данные словарей в `handleAddWhitelist` — через хук
   с селектором, не `getState` в замыкании (иначе устареет). См. `LESSONS_LEARNED.md` §3.
5. **«Статистика» без «Очистить».** Показать заглушку, как нынешний `StatsPanel`.
6. **Размер транскрипта.** Если OOV-слов тысячи — таблица может тормозить.
   В MVP не виртуализируем (бэклог); если упрётся — добавить позже.

---

## 📁 Файлы, затрагиваемые изменением

| Файл | Изменение |
|---|---|
| `app/src/engine/types.ts` | `+text?: string` в `Decoration` (Шаг 1) |
| `app/src/engine/rules.ts` | заполнить `text` для oov/short-garbage декораций (Шаг 1) |
| `app/src/components/OovStatsGrid.tsx` | **новый** — грид + кнопки (Шаг 2) |
| `app/src/components/TranscriptView.tsx` | вкладки, `OriginalPane`, обработчики (Шаги 3-6) |
| `app/src/App.css` | стили вкладок, грида, hidden (Шаг 7) |

Новых зависимостей нет. Бэкенд (Rust) не трогается.
