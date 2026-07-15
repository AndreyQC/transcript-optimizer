# Предупреждение о похожих `from` при добавлении в replacement / lemma

**Дата:** 2026-07-15
**Проект:** transcript-optimizer (desktop: Tauri 2 + React 19 + TS + Vite 7 + Monaco)
**Ветка:** продолжаем `docs/transcript-optimizer-plan`.
**Этот файл — план следующего изменения.** Реализуется по нему.

---

## ❗ Проблема

В `sample/transcript_optimizer/replacements.yaml` уже накопились пересекающиеся правила — пользователь наступил на это вживую:

```yaml
replacement_rule_025:
  to: Codex
  label: tech_term
  description: LLM от OpenAI для написания кода
  from:
  - кодекс
  - кодекс ЧПТ
  - codex
replacement_rule_032:
  to: codex
  label: tech_term
  from:
  - кодексе       # ← дубль, различающийся только падежом
replacement_rule_031:
  to: немного
  label: linguistic
  from:
  - немножечко
```

Что плохо:

- `replacement_rule_032.from: [кодексе]` — дубль семантики правила _025 (тот же «Codex»), различающийся только падежной формой/регистром.
- Правила `.to: Codex` и `.to: codex` — тоже, по сути, одно и то же (lowercase-нормализация уравнивает).
- Опечатки и близкие формы (`кодексе`/`кодекс`, `немножечко`/`немного`) пользователь сейчас не видит заранее — диалог добавления в `replacements` не сверяется с уже существующими похожими `from`.

**Текущее поведение:**

- Точные дубликаты `from` ловятся `lib/validate.ts` через `replacements:from-conflict`, **но только после применения**, маркером Monaco на вкладке словаря.
- Похожие (но не идентичные) `from` — не ловятся вообще. Каждое такое правило создаёт фантомы в OOV-гриде и шум в словаре.

---

## 🎯 Цель

При добавлении нового `from` (через диалог `ContextActionDialog` или форму `EditPanel` на вкладке `replacements`) — **до превью/применения** — показывать пользователю список уже существующих похожих `from` с тремя действиями на каждого кандидата:

1. **«Добавить в это правило»** — дописать в `from[]` существующего правила вместо создания нового.
2. **«Открыть»** — переключиться на вкладку словаря и прокрутить Monaco к этому правилу.
3. **«Игнорировать»** — добавить как обычно (новое правило). Запоминается до закрытия диалога, чтобы не вылезало заново.

### Критерии готовности

1. Точные дубликаты `from` — то же текущее поведение (Monaco-маркер после применения). **Ничего не сломано.**
2. Похожие `from` (опечатки, иные падежи/формы, иная раскладка) — диалог/форма показывает блок «Похожие from уже в словаре» с 3 кнопками на каждого кандидата.
3. Кнопка «Добавить в это правило» дописывает в `from[]` существующего правила через CST с сохранением комментариев/порядка.
4. Кнопка «Открыть» переключает активную вкладку на `replacements` и прокручивает Monaco к нужному правилу.
5. Кнопка «Игнорировать» отключает показ этого кандидата до конца сессии диалога; при смене `action` сбрасывается.
6. Алгоритм корректно работает на кириллице: учитывает ё/Ё, регистр (через `norm`), схлопывает пробелы в фразах.
7. Покрытие — `replacements.*.from` (ветка `replace`) и `lemma_replacements.*.from_lemmas` (ветка `lemma`). `to` — НЕ в этом проходе.
8. `pnpm exec tsc --noEmit` — чисто.
9. `pnpm exec vite build` — `✓ built`.

### Вне MVP (явно)

- Покрытие похожих `to` (Codex vs codex) — отдельная фича, требует UX «объединить/переименовать/синоним». Не делаем.
- Стемминг русского, метафоны, расстояние Хэмминга по клавиатуре — пока плоский Левенштейн. Если обнаружатся систематические ошибки — добавим.
- Масс-merge нескольких похожих одной кнопкой — follow-up.
- Юнит-тесты — в проекте пока нет; проверка ручным сценарием + `tsc` + `vite build`.

---

## 🧠 Решение

### 1. Алгоритм нечёткого сравнения

**Новый файл `app/src/lib/similarity.ts`** (pure, без новых зависимостей):

```ts
// Левенштейн на codepoints (Unicode-correct: кириллица, ё/Ё, эмодзи не ломают).
// O(n*m), для коротких слов (< 64) и десятков from — дешевле любой библиотеки.
export function editDistance(a: string, b: string): number;

// 0..1, 1 = идентичны. Схлопываем пробелы + lowercase через norm().
export function similarityScore(a: string, b: string): number;

export interface SimilarHit<T> {
  candidate: T;
  sourceKey: string;   // ключ правила в YAML, "replacement_rule_032"
  to: string;          // каноническая форма для отображения
  score: number;       // 0..1
}
export function findSimilar<T>(
  target: string,
  pool: T[],
  threshold: number,
): SimilarHit<T>[];
```

Реализация `editDistance` — стандартный DP по `Array.from(a)` / `Array.from(b)` (codepoints, чтобы лигатуры/композитные символы не ломали сравнение).

**Нормализация** переиспользует существующий `norm` из `engine/tokenizer.ts` (lowercase) + `replace(/\s+/g, ' ').trim()` для фраз. Поскольку `from` в диалоге заполняется как `selection.text` (одно слово или фраза), пробелы уже будут — нужно лишь схлопнуть.

**Скоринг:**
- `score = 1 - distance / max(len(a), len(b))`
- Очень короткие `from` (длина ≤ 2) — отсекаются на этапе `collectFromCandidates` (Левенштейн для «в» vs «на» даёт 0.0, но шум в UI не нужен).

**Пороги** (`Settings.similarity_threshold`, ныне висящий в `types/dictionaries.ts` без потребителей):
- одиночное слово — `0.78`,
- фраза (≥ 1 пробела после нормы) — `0.85` (консервативнее — иначе ложные срабатывания на длинных фразах).
- Если в `settings.yaml` поля нет — дефолт по типу входа.

### 2. Источник кандидатов

В обеих точках входа (диалог и форма на вкладке) уже доступен `entries` из zustand-store. Достаём:

```ts
interface FromCandidate {
  value: string;        // нормализованное значение from / from_lemmas
  ruleKey: string;      // "replacement_rule_025" / "lemma_rule_010"
  to: string;           // канон. форма для отображения
  section: "from" | "from_lemmas";
}

// Для ветки replace: обходим replacements.*.from
// Для ветки lemma:   обходим lemma_replacements.*.from_lemmas
function collectFromCandidates(entries, section: "from" | "from_lemmas"): FromCandidate[] { … }
```

### 3. UX в диалоге `ContextActionDialog`

Под полями `to`/`label` (для веток `replace` и `lemma`), между формой и кнопкой «Превью»:

```
⚠ Похожие from уже в словаре

┌─────────────────────────────────────────────────────────────┐
│ кодексе    · правило _032   · to: codex      · 0.83        │
│ [+ Добавить в это правило]   [Открыть]   [Игнорировать]   │
└─────────────────────────────────────────────────────────────┘
```

Три действия на каждую строку (см. «Цель» §1-3).

### 4. Состояние режима формы

В диалоге появляется второе поведение: «append to existing rule». State:

```ts
const [appendTarget, setAppendTarget] = useState<{ruleKey, section, value} | null>(null);
const dismissedRef = useRef<Set<string>>(new Set()); // помнит "Игнорировать" до закрытия диалога
```

Когда `appendTarget !== null`:
- поле `from` заблокировано (показывается «будет дописано: \"<новое>\" → <существ. to>»),
- `buildInput` возвращает `{ kind, to: existingRule.to, label: existingRule.label, appendFrom: newFrom, ruleKey: targetKey }`,
- `addEntry` дописывает в существующее правило вместо `nextRuleKey`.

Сброс `dismissedRef` — при смене `action` (через существующий `useEffect`) и при `setDone(true)`.

### 5. Расширение `app/src/lib/yaml-edit.ts`

**Новая функция `appendFromToRule`:**

```ts
// section: "from" | "from_lemmas"
// поведение:
//   - найти правило по ruleKey через CST (yaml.parse(raw))
//   - добавить value в from[] / from_lemmas[]
//   - если уже есть — no-op
//   - сохранить комментарии и порядок ключей (через set поверх существующей ноды)
```

**Расширение `AddEntryInput`** — два новых опциональных поля:

```ts
appendFromToRule?: string;        // ключ целевого правила
appendFromSection?: "from" | "from_lemmas";   // куда писать
```

Внутри `addEntry`, ветка `kind === "replacements"`:
- если `appendFromToRule` задан → `appendFromToRule` вместо `nextRuleKey`;
- иначе — как раньше.

**Новая утилита `findRuleLine(raw, ruleKey)`:**

```ts
// находит 1-based номер строки ключа через CST
// используется для Monaco-команды editor.revealLineInCenter
export function findRuleLine(raw: string, ruleKey: string): number | null;
```

Все правки — через CST (`yaml.parse(raw)` → `set`), чтобы сохранить комментарии и стиль.

### 6. `EditPanel.tsx` (форма на вкладке replacements)

В этой форме `from` вводится как comma-separated:

```ts
const fromList = form.from.split(",").map(s => s.trim()).filter(Boolean);
const similar = useMemo(
  () => findSimilar(norm(input), candidates, threshold),
  [input, candidates, threshold],
);
```

Панель кандидатов показывается так же, как в диалоге. По умолчанию режим «create» (как сейчас); переключатель на «append» по кнопке «Добавить в это правило».

### 7. Прокрутка Monaco к правилу (кнопка «Открыть»)

В `app/src/store/dictionaries.ts`:

```ts
setPendingScroll: (kind: DictKind, ruleKey: string) => void;
// pendingScrollKey: { kind, ruleKey, line, ts } | null
```

В `app/src/components/YamlEditor.tsx`:

```tsx
useEffect(() => {
  if (pendingScrollKey?.kind === activeKind && pendingScrollKey.line && editor) {
    editor.revealLineInCenter(pendingScrollKey.line);
    setPendingScrollHandled(); // сбрасывает pendingScrollKey
  }
}, [pendingScrollKey]);
```

### 8. Settings.similarity_threshold

Поле `Settings.similarity_threshold: number` уже объявлено в `types/dictionaries.ts`, но **никем не читается** — наконец-то задействуем:

- новый селектор `selectSimilarityThreshold(state)` с дефолтами,
- в диалоге/форме берётся по типу входа (слово vs фраза),
- в UI подсказке: «порог 0.78 — опечатки вроде `кодексе`/`кодекс` уже на 0.83».

---

## 🔧 План реализации (по шагам)

### Шаг 1. `app/src/lib/similarity.ts` (новый файл)

- Реализовать `editDistance(a, b): number` через DP по codepoints (использовать `Array.from(s)`).
- Реализовать `similarityScore(a, b): number` с нормализацией через `import { norm } from "../engine/tokenizer"`.
- Реализовать `findSimilar(target, pool, threshold)` — линейный фильтр пула, сортировка по `score` ↓.
- Тип `SimilarHit<T>`.
- JSDoc с инвариантами и производительностью (O(N×P×L²), где L = длина слова, N = входов, P = правил; < 1 мс на типичном словаре).

### Шаг 2. `app/src/lib/yaml-edit.ts`

- Добавить `findRuleLine(raw, ruleKey): number | null` — парсит `yaml.parse(raw)`, ищет ключ в `replacements` / `lemma_replacements`, возвращает `pair?.[0].line + 1` (1-based).
- Добавить `appendFromToRule(raw, ruleKey, value, section): Result<string, string>` (success/failure-обёртка как у `addEntry`):
  - парсит doc,
  - если уже есть в списке — возвращает существующий raw без изменений (`{ ok: true, raw: prev, noop: true }`),
  - иначе `set(ruleKey, ...append в from[] через mapItems)`,
  - возвращает новый raw + флаг изменения.
- Расширить `AddEntryInput` полями `appendFromToRule?`, `appendFromSection?`.
- В `addEntry` для `kind === "replacements"`:
  - если `appendFromToRule` задан — вызвать `appendFromToRule(prevRaw, key, value, section)`,
  - иначе — старая логика с `nextRuleKey`.

### Шаг 3. `app/src/store/dictionaries.ts`

- Добавить `pendingScrollKey: { kind: DictKind; ruleKey: string; line: number; ts: number } | null` в state.
- Действие `setPendingScroll(kind, ruleKey, line)` — кладёт в state.
- Действие `clearPendingScroll()` — сбрасывает.
- Селектор `selectSimilarityThreshold(state): { word: number; phrase: number }` (с дефолтом `0.78 / 0.85`).

### Шаг 4. `app/src/components/ContextActionDialog.tsx`

- Импорт расширить: `findSimilar`, `type SimilarHit` из `../lib/similarity`; `selectSimilarityThreshold`, `setPendingScroll` из `../store/dictionaries`.
- Локальный state:
  - `appendTarget: { ruleKey, section, value } | null`,
  - `dismissedRef: useRef<Set<string>>(new Set())`.
- Хелперы:
  - `collectFromCandidates(entries, section)`,
  - `findSimilarForCurrent(mode, form)` — `useMemo`,
  - `similar = ...filter(c => !dismissedRef.current.has(c.ruleKey))`.
- Новый sub-компонент `SimilarFromPanel` (inline):
  ```tsx
  function SimilarFromPanel({ candidates, onAppend, onOpen, onDismiss }) { … }
  ```
  — рендерится между блоком `to`/`label` и кнопками превью/применить.
- Кнопка «Открыть» вызывает `setPendingScroll("replacements", c.ruleKey, findRuleLine(currentRaw, c.ruleKey))` + переключение активной вкладки.
- При смене `action` (`useEffect([action])`) — `setAppendTarget(null)`, `dismissedRef.current.clear()`.
- В `buildInput` ветка `replace` / `lemma`:
  ```ts
  if (appendTarget && (action === "replace" || action === "lemma")) {
    return {
      kind: "replacements",
      to: ..., label: ...,
      appendFromToRule: appendTarget.ruleKey,
      appendFromSection: appendTarget.section,
      from: [appendTarget.value],
    };
  }
  ```
- После `handleApply` сбрасывать `appendTarget`.

### Шаг 5. `app/src/components/EditPanel.tsx`

- Расширить форму:
  - `useMemo` → `fromList = form.from.split(",").map(s => s.trim()).filter(Boolean)`,
  - `useMemo` → `similar = findSimilar(norm(input), candidates, threshold)`,
  - панель кандидатов под полем `from` (рендерим из общего `SimilarFromPanel` или копируем разметку).
- В функции `submit`:
  - если `appendTarget` есть → подменяем `nextRuleKey` на `appendTarget.ruleKey`,
  - иначе — как сейчас.

### Шаг 6. `app/src/components/YamlEditor.tsx`

- Подписаться на `pendingScrollKey` через селектор.
- В `useEffect`:
  ```tsx
  useEffect(() => {
    if (pendingScrollKey && pendingScrollKey.kind === activeKind && editor) {
      editor.revealLineInCenter(pendingScrollKey.line);
      clearPendingScroll();
    }
  }, [pendingScrollKey, activeKind, editor]);
  ```

### Шаг 7. Документация и проверки

- `pnpm exec tsc --noEmit` — должно быть чисто.
- `pnpm exec vite build` — `✓ built`.
- Ручной сценарий (см. «Критерии готовности» §10).
- `LESSONS_LEARNED.md` — §7 «Нечёткий поиск похожих from при добавлении в словарь».

### Шаг 8. Документ итогов

- Создать `-=tasks=-/2026-07-15/20260715_002_similar_from_warning_result.md` по факту реализации.

---

## ⚠️ Риски и нюансы

1. **Производительность.** `findSimilar` пробегает по всем `from`/`from_lemmas`. Типичный словарь: 30-100 правил × 1-3 `from` = ≤ 300 кандидатов. Левенштейн O(L²) при L ≤ ~24 → < 1 мс даже в худшем случае. `useMemo` кеширует пересчёт.
2. **Кириллица и регистр.** `Array.from(s)` корректно обрабатывает codepoints (включая ё/Ё, лигатуры, эмодзи). `norm()` делает lowercase. Двойная нормализация (наша + движка) совпадает.
3. **Фразы.** Для длинных фраз (`кодекс чата гпт от опенэйай`) Левенштейн склонен к ложным срабатываниям на «почти совпадающих началах». Решение — повышенный порог 0.85 для фраз (см. §1).
4. **`tokenize` и `norm`.** Используем только `norm` из `engine/tokenizer.ts` — не надо трогать `tokenize`. Границы слов для сравнения `from` нам не нужны (сравниваем строки целиком).
5. **`findRuleLine` и редактируемый файл.** Между моментом `findRuleLine(raw)` и моментом, когда Monaco реально прокручивает, пользователь мог уже изменить файл — тогда `line` уплывёт. Защита: `ts` в `pendingScrollKey` + проверка `rawMatchesKey(rawAtTs, ruleKey)` при применении; если не совпало — отменяем прокрутку. Альтернатива: после применения setPendingScroll сразу показывать Monaco, не давая шанс редактировать (диалог держит фокус — этого достаточно, но оставляем защиту как страховку).
6. **`replacements` без `from`** — обрабатываем как пустой массив.
7. **Dismiss permanence.** `dismissedRef` помнит «Игнорировать» только до закрытия диалога. Если пользователь в ОДНОЙ сессии открыл диалог, нажал «Игнорировать», потом изменил `to`, потом снова открыл — кандидат всплывёт заново. Это осознанный выбор: «Игнорировать» = решение «добавить как новый раз сейчас», а не глобальный запрет.
8. **Несколько похожих правил.** Если похожих > 1 (например, и `кодексе`, и `кодекса` уже в разных правилах) — пользователь видит обе строки и сам решает, в какое дописывать. Масс-merge в одной кнопке — вне MVP.
9. **CST-правка через `yaml`.** Если файл уже с невалидным YAML (пользователь редактирует в Monaco и не сохранил) — `findRuleLine` вернёт null. На этот случай — fallback: открыть вкладку без прокрутки, кнопка «Открыть» всё равно отработает частично.

---

## 📁 Файлы, затрагиваемые изменением

| Файл | Изменение |
|---|---|
| **новый** `app/src/lib/similarity.ts` | `editDistance`, `similarityScore`, `findSimilar`, тип `SimilarHit<T>` |
| `app/src/lib/yaml-edit.ts` | `appendFromToRule`, `findRuleLine`, расширение `AddEntryInput` полями `appendFromToRule?`, `appendFromSection?` |
| `app/src/store/dictionaries.ts` | `pendingScrollKey`, `setPendingScroll` / `clearPendingScroll`, селектор `selectSimilarityThreshold` |
| `app/src/components/ContextActionDialog.tsx` | sub-компонент `SimilarFromPanel`, state `appendTarget` + `dismissedRef`, учёт в `buildInput`/`handleApply` |
| `app/src/components/EditPanel.tsx` | та же логика для формы на вкладке replacements (панель кандидатов + переключатель режима) |
| `app/src/components/YamlEditor.tsx` | эффект `revealLineInCenter` по `pendingScrollKey` |
| `LESSONS_LEARNED.md` | новый §7 «Нечёткий поиск похожих `from` при добавлении в словарь» |
| **новый** `-=tasks=-/2026-07-15/20260715_002_similar_from_warning_result.md` | итоги реализации (по факту) |

Новых файлов в `app/src/`: 1 (`similarity.ts`). Движок `rules.ts`, типы, `engine/*` — без изменений. `lib/validate.ts` — без изменений (точные дубликаты остаются ловиться как раньше).

---

## 🔒 Зафиксированные решения

| Вопрос | Решение | Обоснование |
|---|---|---|
| Алгоритм сравнения | Левенштейн на codepoints, своя реализация в `lib/similarity.ts` | Unicode-correct, 0 npm-зависимостей, < 1 мс на типичном словаре, использует существующий `norm` |
| Пороги | 0.78 для одиночных, 0.85 для фраз | Покрывает `кодекс`↔`кодексе` (0.83), `немножечко`↔`немного` (0.82); не ловит случайные совпадения длинных фраз |
| Где показывать UI | В двух точках: `ContextActionDialog` (ветки replace/lemma) + `EditPanel` (форма вкладки) | Оба пути ведут к одному и тому же эффекту — должны быть консистентны |
| Действие при похожем | Список-предупреждение + 3 кнопки на кандидата | Пользователь явно выбирает; не блокируем, не молчим |
| Где дописывать в правило | Расширение `AddEntryInput` + новая `appendFromToRule` через CST | Сохраняем комментарии/порядок; переиспользуем существующий applyEdit/undo |
| Где взять пороги | Из `Settings.similarity_threshold` (наконец-то задействуем висящее поле) + дефолты по типу входа | Не плодим новых настроек |
| Покрытие | A+B: только `from` в `replacements` и `from_lemmas` в `lemma_replacements`. `to` — НЕ в этом проходе | `to` требует другого UX-решения (объединить/переименовать/синоним) |
| Открытие правила | `revealLineInCenter` через Monaco (используем уже подключённый редактор) | Уже подключён; `findRuleLine` через CST — дёшево |
| Память «Игнорировать» | `useRef<Set>` на время жизни диалога, не state, не localStorage | Меньше ререндеров; не «забывается» при других сессиях — пользователь видит предупреждение снова |

---

*План составлен по итогам обсуждения с пользователем 2026-07-15. Зафиксированные ответы: «показать список-предупреждение + 3 кнопки», «своя реализация + порог», «покрытие A+B (from + from_lemmas, без to)».*
