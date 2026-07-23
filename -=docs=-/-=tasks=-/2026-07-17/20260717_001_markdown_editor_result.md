# Режим «Markdown» — открыть/редактировать/сохранить `.md` (split-view) — итоги

**Дата:** 2026-07-17
**Проект:** transcript-optimizer (desktop: Tauri 2 + React 19 + TS + Vite 7 + Monaco)
**Ветка:** `main`
**План-документ (вход):** `-=tasks=-/2026-07-17/20260717_001_markdown_editor.md`

---

## Постановка

Не хватало функционала открывать произвольный `.md` и править его в том же
окне. Markdown уже использовался в режиме «Саммари» (результат LLM), но без
редактирования исходного файла.

Альтернативы, отвергнутые до реализации:
- **Отдельное Tauri-приложение** — дублирование скаффолда (тема, FS, Monaco,
  react-markdown, mermaid, capabilities) + нет простого IPC между окнами двух
  Tauri-приложений для «открыть .md по пути».
- **WYSIWYG «как в gramax»** — дни-недели работы: gramax = 223 K строк,
  1199 файлов markdown-части, форк Markdoc, свой сериализатор ProseMirror
  на 1173 строки.

Принято: **интегрировать** в transcript-optimizer, уровень — **split-view**
(Monaco + live-превью), **0 новых зависимостей** (переиспользован готовый
конвейер саммари).

---

## Что реализовано

### `app/src/store/markdown.ts` (новый, ~40 строк)

Zustand-стор по образцу `transcript.ts`. Поля:

- `doc: MarkdownDoc | null`, где `MarkdownDoc = { path, raw, savedRaw, dirty }`.
- `dirty` — поле внутри `doc`, не селектор-функция (инвариант LESSONS_LEARNED §3:
  селекторы компонентов остаются плоскими).

Actions: `openMarkdown(path, raw)`, `editRaw(raw)`, `markSaved()`, `setPath(path)`,
`closeMarkdown()`. Стор живёт вне компонента → состояние `.md` переживает
переключение режимов (не теряет правки при уходе в «Словари»/«Транскрипт» —
параллель с багом №2 в саммари).

### `app/src/components/MarkdownView.tsx` (новый)

Two-pane на готовых CSS-классах `.transcript-container`/`.transcript-panes`/
`.transcript-pane`/`.pane-header`:

- **Слева** — Monaco, `language="markdown"`, тема из `useTheme`,
  `path={doc.path || "untitled.md"}` (стабильная модель),
  `value={doc.raw}`, `onChange → editRaw`. `onMount` вешает
  `editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyS, ...)` — Ctrl/Cmd+S.
- **Справа** — `<ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]} components={mdComponents}>` с `useDeferredValue(doc.raw)` (превью
  ре-рендерится «отложенно», не тормозит печать на длинных файлах).
- `mdComponents` — копия `markdownComponents` из `SummaryView.tsx:270-283`
  (mermaid-перехватчик `language-mermaid → <Mermaid/>`). Дублирование ~13 строк;
  рефакторинг в общий `lib/markdown.tsx` оставлен на следующую задачу, чтобы не
  трогать проверенный `SummaryView` в этом же проходе.
- **Stale-closure в Ctrl+S обойдён заранее**: команда читает
  `useMarkdown.getState().doc` (а не `doc` из замыкания `onMount`) — иначе
  сохранялся бы устаревший текст. Тот же приём, что в `App.tsx::onCloseRequested`.
- Empty-state: `<div className="editor-empty">` если `!doc`.

### `app/src/components/Toolbar.tsx`

- `type Mode` += `"markdown"`.
- Подписки: `useMarkdown(s => s.doc)`, `openMarkdown`, `markMdSaved`, `setMdPath`,
  `closeMarkdown`. Импорт `save` из `@tauri-apps/plugin-dialog` (к `pickFile`).
- Хендлеры (внутри `Toolbar`, как `handleOpenTranscript`/`handleSave`):
  - `handleOpenMd` — `pickFile({filters:[{name:"Markdown",extensions:["md"]}]})`
    + `readFile` → `openMarkdown(path, raw)`.
  - `handleNewMd` — `openMarkdown("", "")`.
  - `handleSaveMd` — если `!mdDoc.path` → редирект на `handleSaveAsMd`; иначе
    `writeFile(path, raw)` + `markMdSaved()`.
  - `handleSaveAsMd` — `save({filters, defaultPath})` + `writeFile` +
    `setMdPath(newPath)` + `markMdSaved()`.
- Новый ранний `return` для `mode === "markdown"` (после `if (mode === "summary")`):
  кнопки Открыть .md / Новый / Сохранить (подпись «…как…» если `!mdDoc.path`,
  `disabled` если `!mdDoc || !mdDoc.dirty`) / Сохранить как… (`disabled` если
  `!mdDoc`) / Закрыть (если `mdDoc`). Dirty — бейдж `● несохранённые изменения`.

### `app/src/App.tsx`

- `type Mode` += `"markdown"` (стр. 14).
- 4-я кнопка в `nav.mode-switch` после «Саммари».
- Ветка `mode === "markdown"` в тернарнике рендера (перед `: <SummaryView/>`):
  `<div className="transcript-container"><MarkdownView/></div>`.
- `onCloseRequested` расширен: теперь проверяет и `useDictionaries.getState().entries.some(e => e.dirty)`,
  и `useMarkdown.getState().doc?.dirty` — иначе закрытие окна молча теряло бы
  несохранённый `.md`.

### Документация

- `LESSONS_LEARNED.md` — добавлен **§16 «Split-view `.md` поверх существующего
  markdown-стека»**: главный урок — «не плодить второй рендерер markdown»,
  переиспользование конвейера `SummaryView` и File I/O; повтор граблей §§2-3
  (store вне компонента, stale-closure в Ctrl+S), обойдённых заранее; заметка
  про `useDeferredValue`.
- `README.md` — пункт в раздел «Возможности»; этап 6 в «Статус реализации»;
  обновлена шапка «Статус».

---

## Что НЕ тронуто

- **Движок, типы словарей, `lib/validate.ts`, `lib/yaml-edit.ts`** — без изменений.
- **`SummaryView.tsx`** — без изменений (`markdownComponents` скопирован, не
  вынесен в общий модуль — см. «Риски §8» плана).
- **Бэкенд Rust, capabilities, `tauri.conf.json`** — без изменений. Права
  `dialog:allow-open/save`, `fs:allow-read/write-text-file`, `fs:scope "**"`
  уже покрывали любой `.md`.
- **CSS** — без правок. Все нужные классы (`.transcript-container`,
  `.transcript-pane`, `.pane-header`, `.summary-markdown`, `.editor-empty`,
  `.badge-stale`) уже были в `App.css` для транскрипта/саммари.
- **Зависимости** — 0 новых. `react-markdown`, `remark-gfm`, `rehype-raw`,
  `mermaid`, `@monaco-editor/react` уже в `package.json`.

---

## Проверки (все зелёные)

- **`pnpm exec tsc --noEmit`** — чисто (включая `noUnusedLocals`).
- **`pnpm exec vite build`** — `✓ built in 24.47s`. Предупреждение о размере
  чанка — **прежнее**, не связано с правкой (проект давал его и до этого).

---

## Что НЕ сделано (вне MVP, осознанно)

- **WYSIWYG** (TipTap/ProseMirror «как в gramax»). Архитектурно место оставлено
  — отдельный режим-обёртка поверх `MarkdownView`; код не закладывали.
- **Подсветка кода в превью** (`rehype-highlight`/`shiki`). Сейчас код-блоки
  моноширинные без подсветки токенов — как в саммари.
- **Математика (KaTeX)**: `remark-math`/`rehype-katex` не подключены.
- **File watcher / autosave**: on-demand философия проекта — сохранение по
  кнопке/Ctrl+S.
- **Sanitize raw-HTML** (`rehype-sanitize`): `rehypeRaw` оставлен — нужен для
  mermaid; XSS-поверхность ограничена WebView-sandbox desktop-приложения.
- **Рефакторинг `markdownComponents`** в общий `lib/markdown.tsx` (сейчас копия
  в `SummaryView` и `MarkdownView`) — после стабилизации.
- **Вкладки нескольких `.md` одновременно**, экспорт в PDF/HTML,
  frontmatter-парсинг — отдельные фичи.

---

## Известные нюансы

1. **Ctrl+S ловится только при фокусе в Monaco.** `editor.addCommand` не
   сработает из превью/тулбара. Подстраховка — кнопка «Сохранить» в тулбаре,
   всегда доступная. Глобальный `window`-listener не добавлен: если выяснится,
   что фокус теряется часто — отдельный мелкий фикс.
2. **`path=""` (новый документ).** `path={doc.path || "untitled.md"}` даёт
   стабильную модель Monaco. После «Сохранить как…» `setPath(newPath)` меняет
   `path` → Monaco пересоздаёт модель, контент переезжает через `value`.
   Курсор при этом может сброситься — приемлемо для редкой операции
   «первое сохранение».
3. **`rehype-raw` и произвольный .md.** Разрешает raw-HTML (нужен для mermaid и
   доверенных .md). XSS ограничен WebView-sandbox desktop-приложения (нет
   куки/сессий). Sanitize — отдельная фича (`rehype-sanitize`).

---

## Сценарий ручной проверки

(для следующего, кто будет смотреть)

1. `pnpm tauri dev` → нажать «Markdown» в `nav.mode-switch`.
2. «Открыть .md» → выбрать, например, `README.md` репозитория → обе панели:
   Monaco (редактируемый) + превью.
3. Поправить заголовок в Monaco → превью обновилось; в шапке исходника `*`.
4. **Ctrl+S** → файл перезаписан; `*` исчез; `status`: «Сохранено: …».
5. «Сохранить как…» → новый путь; дальнейшие правки идут по новому пути.
6. В `.md` есть ` ```mermaid `-блок → в превью рисуется диаграмма; GFM-таблица
   рисуется; raw-HTML виден.
7. Перейти в «Словари» → обратно в «Markdown» → текст, позиция курсора, dirty
   на месте (стор пережил размонтирование).
8. Правка без сохранения → закрыть окно → диалог подтверждения (срабатывает
   теперь и для `.md`, не только для словарей).
9. «Новый» → пустой документ; «Сохранить» на нём → открывает `save`-диалог
   (редирект на «как…»).
10. Переключить тему (☼/☾) → Monaco и превью поменяли палитру одновременно.

**Что НЕ сломано:**
- Режимы «Словари»/«Транскрипт»/«Саммари» — без изменений.
- `onCloseRequested` для словарей работает как раньше (просто расширен «или»).

---

*Реализация по итогам обсуждения с пользователем 2026-07-17. Зафиксированные
ответы: «встроить, а не отдельное приложение», «split-view сейчас, WYSIWYG
потом», «без новых зависимостей (GFM + mermaid + raw-HTML как в саммари)».*
