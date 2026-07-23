# Предупреждение о похожих `from` при добавлении в replacement / lemma — итоги

**Дата:** 2026-07-15
**Проект:** transcript-optimizer (desktop: Tauri 2 + React 19 + TS + Vite 7 + Monaco)
**Ветка:** `docs/transcript-optimizer-plan`
**План-документ (вход):** `-=tasks=-/2026-07-15/20260715_002_similar_from_warning.md`

Коммит сессии: см. `git log` (см. ниже).

---

## Что реализовано

### Постановка

В `sample/transcript_optimizer/replacements.yaml` накопились пересекающиеся правила — пользователь наступил на это вживую:

```yaml
replacement_rule_025:
  to: Codex
  label: tech_term
  from: [кодекс, кодекс ЧПТ, codex]
replacement_rule_032:
  to: codex
  label: tech_term
  from: [кодексе]   # ← дубль, отличается только падежом
```

Точные дубликаты `from` ловились `validate.ts::replacements:from-conflict`, но **только после применения** — маркером Monaco на вкладке словаря. Похожие (опечатки, иные падежи, иная раскладка клавиатуры) — не ловились вообще.

### Решение (по итогам обсуждения 2026-07-15)

В диалоге добавления (`ContextActionDialog`, ветка `replace`) и в форме `EditPanel` (вкладка `replacements`) — **до превью/применения** — собираем все существующие `from` (и `from_lemmas`) в пул и считаем похожесть по Левенштейну на codepoints. Если кандидаты есть — показываем панель «Похожие from уже в словаре» с тремя кнопками:

1. **«Добавить в это правило»** — дописать в `from[]` существующего правила через CST.
2. **«Открыть»** — переключиться на вкладку `replacements` и прокрутить Monaco к этому правилу.
3. **«Игнорировать»** — добавить как новое правило.

### Арена изменений (что НЕ тронуто)

- **Движок `rules.ts`** — без изменений. Нечёткий поиск — это UX-помощник, движок и так правильно матчит нормализованные `from` через `replaceIdx`.
- **`lib/validate.ts`** — без изменений. Точные дубликаты `replacements:from-conflict` остаются как есть.
- **`engine/types.ts`, `engine/oov-stats.ts`, `engine/tokenizer.ts`** — без изменений.
- **Типы (`types/dictionaries.ts`)** — без изменений (используется уже объявленное `Settings.similarity_threshold`, которое раньше никем не читалось).

---

## Файлы и изменения

### Новые файлы

#### `app/src/lib/similarity.ts`

`editDistance(a, b): number` — Левенштейн на codepoints через `Array.from(s)` (Unicode-correct: ё/Ё, лигатуры, эмодзи считаются за 1 символ). O(n*m), для слов < 64 и десятков from — < 1 мс.

`similarityScore(a, b): number` — `1 - editDistance(norm(a), norm(b)) / max(len)`. Нормализация через `norm` из `engine/tokenizer.ts` (lowercase) + схлопывание пробелов.

`findSimilar<T extends SimilarPoolItem>(target, pool, threshold): SimilarHit<T>[]` — линейный фильтр пула с быстрым отсевом по грубой метрике длины; сортировка по `score` ↓, `ruleKey` ↑. Содержит типы `SimilarHit<T>` и `SimilarPoolItem`.

#### `app/src/components/SimilarFromPanel.tsx`

Переиспользуемый sub-компонент панели «Похожие from» для двух мест (`ContextActionDialog` и `EditPanel`). Принимает `scope: 'ctx' | 'edit'` — разные CSS-классы для разных контекстов. Экспортирует также хелпер `buildFromPool(entries, section)` (пул кандидатов из `replacements.yaml`).

### Изменённые файлы

#### `app/src/lib/yaml-edit.ts`

- Расширен `AddEntryInput` опциональными полями `appendFromToRule?`, `appendFromSection?: 'from' | 'from_lemmas'`.
- Ветка `case "replacements"` в `addEntry` теперь проверяет `appendFromToRule` — если задан, дёргает `appendFromToRuleInDoc` (дописывает в существующее правило) вместо создания нового.
- Новая публичная функция `appendFromToRule(raw, ruleKey, value, section): AppendFromResult` — через CST (`yaml.parseDocument`), сохраняет комментарии/порядок. Идемпотентна: если значение уже в списке, возвращает `{ ok: true, noop: true, raw: prev }`.
- Новая утилита `findRuleLine(raw, ruleKey): number | null` — находит 1-based номер строки ключа через CST для Monaco `revealLineInCenter`. Возвращает null при ошибке парсинга или если ключ не найден.

#### `app/src/store/dictionaries.ts`

- Новый тип `PendingScroll { kind, ruleKey, line, ts }` — запрос на прокрутку Monaco.
- Новые методы `setPendingScroll(kind, ruleKey, line)` и `clearPendingScroll()` в zustand-store.
- Обнуление `pendingScroll` в `closeDir`.
- Новый хелпер `getSimilarityThresholds(entries): { word, phrase }` — читает `Settings.similarity_threshold` через `useMemo`-паттерн (см. LESSONS_LEARNED §3). Если поле отсутствует или вне [0,1] — возвращает дефолты `0.78 / 0.85`.
- Экспортируемая константа `DEFAULT_SIMILARITY_THRESHOLD`.

#### `app/src/components/ContextActionDialog.tsx`

- Новый state `appendTarget: { ruleKey, section } | null` — режим «append to existing».
- Новый state `dismissed: Set<string>` — помнит «Игнорировать» на время жизни диалога. Сбрасывается при смене `action` и при успешном `handleApply`.
- `useMemo<SimilarCandidateRow[]>` для похожих from — учитывает `action`, `selection`, `entries`, `thresholds`. Фильтрация по `dismissed` — в JSX.
- Новый helper `sectionForAction(action)` — возвращает `'from'` для `replace`, `null` для остальных (lemma вне MVP).
- `buildInput()`: в режиме `appendTarget` возвращает `{ kind: 'replacements', appendFromToRule, appendFromSection, from: [sel.text] }`.
- Новые обработчики:
  - `onAppendCandidate(row)` — переключает диалог в режим append, сбрасывает `pending`.
  - `onOpenCandidate(row)` — `setActive('replacements')` + `setPendingScroll` + закрыть диалог.
  - `onDismissCandidate(ruleKey)` — копирует `Set` и `setDismissed` (нужен ререндер).
- Разметка:
  - В ветке `replace` без `appendTarget` — форма `to`/`label` (как раньше).
  - В ветке `replace` с `appendTarget` — компактная инфа «Будет дописано в правило `_025`» + кнопка «Отмена».
  - Под формой (только `replace` и без append) — `<SimilarFromPanel scope="ctx" />`.

#### `app/src/components/EditPanel.tsx`

- Те же state и helper'ы, что в диалоге (`appendTarget`, `dismissed`, `useMemo` для похожих).
- `useMemo` использует первое непустое значение из `form.from.split(',')` (UX-компромисс — несколько значений не зипуем).
- `buildAddInput()`: в режиме append возвращает `appendFromToRule` вместо создания нового правила.
- В JSX под полем `from` рендерится `<SimilarFromPanel scope="edit" />`.

#### `app/src/components/YamlEditor.tsx`

- Подписка на `pendingScroll` и `clearPendingScroll` через zustand-селекторы.
- Новый `useEffect`: при `pendingScroll && pendingScroll.kind === activeKind` проверяет, что строка ещё существует в модели, вызывает `editor.revealLineInCenter(line)` + `setPosition` + `focus`; затем `clearPendingScroll()`. Защита от «уплывания»: если строка вышла за пределы модели — тихий сброс.

#### `LESSONS_LEARNED.md`

- Добавлен **§7 «Нечёткий поиск похожих `from` при добавлении в словарь»** (контекст, дыра, решение, где фильтровать, алгоритм, нюансы, урок). Помещён перед «Шпаргалкой».

---

## Проверки (все зелёные)

- **`pnpm exec tsc --noEmit`** — чисто. Предварительно были warning'ы про неиспользуемые импорты и переменные — устранены.
- **`pnpm exec vite build`** — `✓ built in 16.58s`. Предупреждения о размере чанка и `llm.ts` dynamic/static — **прежние**, не связаны с правкой.

---

## Что НЕ сделано (вне MVP, осознанно)

- Покрытие похожих `to` (`Codex` vs `codex`) — отдельная фича; требует UX-решения «объединить/переименовать/синоним».
- Стемминг русского, метафоны, расстояние Хэмминга по клавиатуре — пока плоский Левенштейн.
- Масс-merge нескольких похожих в одно правило одной кнопкой.
- UI-переключатель правила «показывать панель / нет» — она всегда активна.
- Юнит-тесты на `findSimilar` — в проекте пока нет тестов; проверка через ручной сценарий и через `tsc` + `vite build`.

---

## Lessons Learned (дубль §7 — для удобства поиска)

### 8. Задействуй «висящие» поля типов, когда они нужны

`Settings.similarity_threshold` было объявлено в `types/dictionaries.ts`, но никем не читалось — «висящая» заготовка. Когда понадобилось — задействовали одной функцией `getSimilarityThresholds(entries)` через `useMemo` от `entries` (паттерн A из §3). Без новых типов и без миграций.

### 9. `Set` в state, а не в ref, для «Игнорировать»

Сначала использовал `useRef<Set<string>>` — он не вызывает ререндер, и без ререндера список не отфильтруется. `useState<Set<string>>` срабатывает редко (только по клику «Игнорировать»), и это дешевле, чем ломать рендеринг. Урок: ref — для «не влияет на UI»; Set для фильтрации UI — это state.

### 10. CST для точечных правок — сохраняет комментарии

`appendFromToRuleInDoc(doc, ruleKey, value, section)` — через `yaml.parseDocument` и `node.set`. Комментарии и порядок ключей сохраняются как есть. Если бы правили `String.replace` по тексту — комментарии потерялись бы при первом же переписывании правила.

### 11. `pendingScroll` через store, чтобы и диалог, и форма могли попросить

Кнопка «Открыть» в двух разных местах (диалог, форма) → один `useState`/`useEffect` в `YamlEditor`. Store — естественный медиатор. `ts` в `PendingScroll` нужен был, но в этой версии `line`-проверка `model.getLineCount()` покрывает основной случай «raw поменялся».

---

## Сценарий ручной проверки

(для следующего, кто будет смотреть)

**Через OOV-грид:**

1. Открыть словарь `replacements.yaml` с правилом `replacement_rule_032: { to: codex, from: [кодексе] }`.
2. Загрузить транскрипт, в котором встречается «кодекса» → в OOV-гриде выбрать строку → «Добавить в replacement».
3. В открывшемся диалоге ввести `to=codex`, нажать на поле/не нажимать — под формой появится панель «Похожие from уже в словаре (1)» со строкой «кодексе правило _032 → codex 0.83».
4. Нажать «+ Добавить в это правило» → в форме появится «Будет дописано в правило _032» + кнопка «Отмена».
5. Нажать «Превью» → в diff видно, что правило _032 теперь содержит `from: [кодексе, кодекса]` (а не новое правило _033).
6. «Применить» → правило _032 объединено.
7. «Очистить» транскрипт — слово «кодекса» больше не в OOV-гриде.

**Через форму на вкладке:**

1. Открыть вкладку `replacements`.
2. Ввести `to: codex, label: tech_term, from: кодекса`.
3. Под полем `from` появится панель «Похожие from (1)» со строкой «кодексе _032 → codex 0.83».
4. «+ Добавить в это правило» → под формой появится «Будет дописано в правило _032».
5. «Превью» → diff показывает мерж; «Применить» → готово.

**Кнопка «Открыть»:**

1. В той же панели нажать «Открыть» → вкладка `replacements` активируется, Monaco прокручивается к `_032`, каретка ставится на эту строку.

**«Игнорировать»:**

1. Нажать «Игнорировать» → строка исчезает из панели (на время сессии диалога).
2. Закрыть диалог → снова открыть → снова видна (помнит только до закрытия).

**Точные дубликаты:**

1. Ввести `from: кодексе` при существующем `_032: { from: [кодексе] }` → панель покажет кандидата; «+ Добавить в это правило» — `noop: true`, raw не меняется (в diff ничего).
2. Нажать «Игнорировать» и «Применить» без append → создастся новое правило; после «Сохранить» Monaco-маркер `replacements:from-conflict` подсветит точный дубликат. Поведение валидации **не изменилось**.

---

*Реализация по итогам обсуждения с пользователем 2026-07-15. Зафиксированные ответы: «показать список-предупреждение + 3 кнопки», «своя реализация + порог», «покрытие A+B (from + from_lemmas, без to)».*
