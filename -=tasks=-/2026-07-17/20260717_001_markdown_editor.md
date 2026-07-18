# Режим «Markdown» — открыть / редактировать / сохранить .md (split-view)

**Дата:** 2026-07-17
**Проект:** transcript-optimizer (desktop: Tauri 2 + React 19 + TS + Vite 7 + Monaco)
**Ветка:** продолжаем `main` (после merge PR #2 все фичи в `main`).
**Этот файл — план следующего изменения.** Реализуется по нему.

> **Инструкция новому диалогу:** ты продолжаешь разработку. Все архитектурные
> решения УЖЕ ПРИНЯТЫ (см. «Зафиксированные решения») — не пересомневаться.
> Паттерны zustand-селекторов (LESSONS_LEARNED §3), Monaco-монтаж и markdown-
> конвейер — критичны; смотри `app/src/components/YamlEditor.tsx`,
> `app/src/components/SummaryView.tsx`, `app/src/store/transcript.ts`.

---

## ✅ Состояние репозитория на момент написания

- **Ветка:** `main` (отслеживает `origin/main`, запушена). `docs/transcript-optimizer-plan`
  влита через PR #2 (`f644db0`).
- HEAD: `f644db0 Merge pull request #2 from AndreyQC/docs/transcript-optimizer-plan`.
- Этапы 0-5 готовы: редактор словарей, движок правил + просмотр транскрипта
  (с вкладкой OOV-статистики), контекстное меню → словарь, LLM-summary,
  помощники по словарям («Похожие from», «Дедуплицировать по to», скрытие
  OOV-токенов из многословных фраз).
- Working tree: единственный артефакт — `app/src-tauri/Cargo.toml` modified
  из-за CRLF/`autocrlf` (шум, реального diff нет — известный артефакт ещё с
  `20260710_001_next_step.md`). На работу не влияет.
- **Это изменение — НЕ НАЧАТО. Файл описывает, что сделать.**

---

## ❗ Постановка

В приложении не хватает функционала открывать произвольный `.md` и править его
в том же UI. Сейчас markdown используется только в режиме «Саммари» (результат
LLM) — рендер есть, но редактирования исходного файла нет.

**Сценарий пользователя:** открыть существующий `.md` → увидеть слева исходник,
справа — live-превью → поправить → Ctrl+S сохранить. Всё внутри того же окна
`transcript-optimizer`, без внешних редакторов.

### Почему не отдельное приложение и не gramax-уровень

- **Отдельное Tauri-приложение** = дублировать скаффолд (тема, FS, Monaco,
  react-markdown, mermaid, capabilities) + нет простого способа «открыть .md в
  другом окне другого Tauri-приложения с преданным путём» (Tauri этого не умеет
  из коробки; нужен кастомный URI-протокол/IPC — оверкилл).
- **WYSIWYG «как в gramax»** = второй gramax (223 K строк, 1199 файлов markdown,
  форк Markdoc, свой сериализатор ProseMirror на 1173 строки). Дни-недели работы.
  Архитектурно **оставляем место** под будущий WYSIWYG (режим-обёртку), но
  ProseMirror в этом проходе не закладываем.
- **Вся инфраструктура уже работает в боевых компонентах transcript-optimizer:**
  Monaco с `language="markdown"` (`DiffEditor` в `SummaryView.tsx:567-573`),
  рендер `react-markdown@10 + remark-gfm@4 + rehype-raw@7` + mermaid
  (`SummaryView.tsx:270-283, 599-607`), File I/O `.md` (`pickFile`/`readFile`/
  `save`/`writeFile`), CSS `.summary-markdown`, capabilities уже разрешают
  `dialog:allow-open/save`, `fs:allow-read/write-text-file`, `fs:scope "**"`.

→ Принято: **интегрировать**, уровень — **split-view (Monaco + live-превью)**,
**без новых зависимостей** (ровно GFM + mermaid + raw-HTML, как в саммари).

---

## 🎯 Цель

Добавить 4-й top-level режим «Markdown» с двухпанельным редактором:

- **Слева** — редактируемый исходник в Monaco (`language="markdown"`).
- **Справа** — live-превью через существующий markdown-конвейер
  (`react-markdown` + `remark-gfm` + `rehype-raw` + mermaid-перехватчик).
- Операции: **открыть .md**, **новый**, **сохранить** (кнопка + Ctrl/Cmd+S),
  **сохранить как…**, **закрыть документ**.
- Состояние переживает переключение режимов (через zustand-store, не локальный
  `useState`) — иначе правки потеряются при уходе в «Словари»/«Транскрипт»
  (баг того же класса, что баг №2 в саммари).
- Dirty-флаг (`*` в шапке), подтверждение при закрытии окна с несохранённым
  документом.

### Критерии готовности

1. В `nav.mode-switch` появился 4-й пункт «Markdown».
2. В режиме «Markdown» — две панели: Monaco (редактируемый markdown) + превью.
3. «Открыть .md» через диалог (`filters: [{name:"Markdown",extensions:["md"]}]`)
   загружает файл в обе панели.
4. Правки в Monaco → превью обновляется live; в шапке исходника появляется `*`.
5. **Ctrl/Cmd+S** (при фокусе в Monaco) и кнопка «Сохранить» — записывают
   файл на диск, `*` исчезает.
6. «Сохранить как…» — `save`-диалог, дальнейшие правки идут по новому пути.
7. «Новый» — пустой документ (`path=""`); «Сохранить» на нём открывает
   `save`-диалог.
8. Переключение режима «Markdown» → «Словари» → обратно: текст, курсор, dirty
   сохраняются (компонент не теряет состояние).
9. Закрытие окна с несохранённым `.md` спрашивает подтверждение (параллельно
   с существующей проверкой словарей).
10. ` ```mermaid `-блок в `.md` рендерится диаграммой; GFM-таблица рисуется;
    raw-HTML виден.
11. Переключение темы (☼/☾) меняет Monaco и превью одновременно.
12. `pnpm exec tsc --noEmit` — чисто.
13. `pnpm exec vite build` — `✓ built`.

### ВНЕ MVP (бэклог, НЕ делать в этом проходе)

- **WYSIWYG** (TipTap/ProseMirror — «как в gramax»). Отдельный режим-обёртка
  поверх будущего `MarkdownView`; место под него оставляем, код не пишем.
- **Подсветка кода** в превью (`rehype-highlight`/`shiki`/`highlight.js`).
  Сейчас код-блоки моноширинные без подсветки токенов — как в саммари.
- **Математика** (KaTeX/MathJax): нет `remark-math`/`rehype-katex`.
- **File watcher / autosave**: on-demand философия проекта — сохранение по
  кнопке/Ctrl+S.
- **Sanitize raw-HTML** (`rehype-sanitize`): `rehypeRaw` оставляем как есть
  (нужен для mermaid); XSS-поверхность ограничена WebView-sandbox desktop-приложения.
- **Sanitize вывода `markdownComponents`**: единый модуль `lib/markdown.tsx`
  вместо копии — после стабилизации (см. риски §8).
- **Вкладки нескольких `.md` одновременно** — сейчас один документ на приложение.
- **Экспорт в PDF/HTML**, **frontmatter-парсинг** — отдельные фичи.

---

## 🔒 Зафиксированные решения (УЖЕ ПРИНЯТЫ, не пересомневаться)

| Вопрос | Решение | Обоснование |
|---|---|---|
| Отдельное приложение vs встроить | **Встроить** | Вся инфраструктура уже работает; отдельный проект = дублирование скаффолда без простого IPC между Tauri-приложениями |
| Уровень редактора | **Split-view** (Monaco + live-превью) | Минимум работы при максимуме переиспользования; WYSIWYG — будущий режим-обёртка |
| Где живёт состояние | Новый zustand-стор `app/src/store/markdown.ts` по образцу `transcript.ts` | Переживает переключение режимов; тот же паттерн, что у 5 существующих store'ов |
| 4-й режим в App | `type Mode = "dictionaries" \| "transcript" \| "summary" \| "markdown"` | Тот же тернарный паттерн, без роутинга |
| Макет | Переиспользуем `.transcript-container`/`.transcript-panes`/`.transcript-pane`/`.pane-header`/`.pane-actions` | Двухпанельный layout уже оформлен в `App.css` (для транскрипта) |
| Редактор слева | Monaco, `language="markdown"`, `theme={mode === "dark" ? "vs-dark" : "light"}`, `path={doc.path \|\| "untitled.md"}`, `value={doc.raw}`, `onChange → editRaw` | Тот же паттерн, что `YamlEditor.tsx:122-138`; markdown-режим Monaco уже загружен (используется в `DiffEditor` саммари) |
| Превью справа | `<ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]} components={mdComponents}>{doc.raw}</ReactMarkdown>` | Тот же конвейер, что `SummaryView.tsx:600-607` |
| `mdComponents` | **Копия** `markdownComponents` из `SummaryView.tsx:270-283` (mermaid-перехватчик) | ~13 строк дубля; рефакторинг в `lib/markdown.tsx` — после стабилизации, чтобы не трогать проверенный `SummaryView` в этой же задаче |
| Открытие | `pickFile({filters:[{name:"Markdown",extensions:["md"]}]})` + `readFile` → `openMarkdown(path, raw)` | Как `Toolbar.tsx:97-103` (транскрипт) |
| Сохранить | Кнопка «Сохранить» + **Ctrl/Cmd+S** в Monaco → `writeFile(path, raw)` + `markSaved()`. На новом документе (`path === ""`) → редирект на «Сохранить как…» | On-demand (как словари); Ctrl+S через `editor.addCommand(KeyMod.CtrlCmd \| KeyCode.KeyS, ...)` в `onMount` |
| Сохранить как… | Кнопка → `save({filters:[...]})` + `writeFile` → `setPath(newPath)` (или `openMarkdown(newPath, raw)`) | Как `SummaryView.tsx:254-259` |
| Создать новый | Кнопка «Новый» → `openMarkdown("", "")` | Сценарий «набросать без внешнего файла» |
| Dirty-флаг | Поле `doc.dirty` (`raw !== savedRaw`); `*` в шапке исходника; сброс при save/open | Параллель с `DictEntry.dirty`; поле — не селектор-функция, проще |
| Закрытие окна с несохранённым | Расширить обработчик `App.tsx:36-50`: спрашивать и при `useMarkdown.getState().doc?.dirty` | Сейчас проверяется только словари — иначе потеря правок .md молча |
| Закрыть документ | Кнопка «Закрыть» → `closeMarkdown()` | Параллель с `closeTranscript` |
| Пустое состояние | Если `!doc` — заглушка `<div className="editor-empty">Откройте .md ...</div>` | Как `.editor-empty`/`.summary-empty` |
| Подсветка кода / KaTeX | НЕ добавляем | Согласовано; вне MVP |
| Stale-closure в Ctrl+S | Внутри команды читать `useMarkdown.getState().doc` (через `getState`, не замыкание) | Тот же приём, что в `App.tsx:39` для close-requested |
| Производительность превью | `useDeferredValue(raw)` для превью (debounce на уровне React) | Дёшево, без новых состояний; покрывает лаги на длинных `.md` |

---

## 📐 Дизайн

### Стор `store/markdown.ts`

```ts
import { create } from "zustand";

export interface MarkdownDoc {
  path: string;     // абсолютный путь или "" для нового документа
  raw: string;      // текущий текст в редакторе
  savedRaw: string; // текст на момент последнего сохранения/открытия
  dirty: boolean;   // raw !== savedRaw (кэшируем, чтобы селектор был плоским)
}

interface MarkdownStore {
  doc: MarkdownDoc | null;
  openMarkdown: (path: string, raw: string) => void;
  editRaw: (raw: string) => void;
  markSaved: () => void;
  setPath: (path: string) => void;
  closeMarkdown: () => void;
}

export const useMarkdown = create<MarkdownStore>((set) => ({
  doc: null,
  openMarkdown: (path, raw) =>
    set({ doc: { path, raw, savedRaw: raw, dirty: false } }),
  editRaw: (raw) =>
    set((s) =>
      s.doc ? { doc: { ...s.doc, raw, dirty: raw !== s.doc.savedRaw } } : {},
    ),
  markSaved: () =>
    set((s) =>
      s.doc ? { doc: { ...s.doc, savedRaw: s.doc.raw, dirty: false } } : {},
    ),
  setPath: (path) => set((s) => (s.doc ? { doc: { ...s.doc, path } } : {})),
  closeMarkdown: () => set({ doc: null }),
}));
```

> **Инвариант LESSONS_LEARNED §3:** селекторы в компонентах — только плоские поля
> (`doc?.raw`, `doc?.dirty`), без возврата новых объектов/массивов/Set.

### Компонент `components/MarkdownView.tsx`

```tsx
import { useDeferredValue, useMemo, useRef } from "react";
import { Editor, type OnMount } from "@monaco-editor/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import { useMarkdown } from "../store/markdown";
import { useTheme } from "../store/theme";
import { writeFile } from "../lib/fs";
import { Mermaid } from "./Mermaid";

export function MarkdownView() {
  const doc = useMarkdown((s) => s.doc);
  const editRaw = useMarkdown((s) => s.editRaw);
  const markSaved = useMarkdown((s) => s.markSaved);
  const themeMode = useTheme((s) => s.mode);

  // Превью ре-рендерится не на каждое нажатие, а когда React «доспит».
  const deferredRaw = useDeferredValue(doc?.raw ?? "");

  // mermaid-перехватчик — копия из SummaryView.tsx:270-283.
  const mdComponents = useMemo(
    () => ({
      code(props: { className?: string; children?: React.ReactNode }) {
        const { className, children } = props;
        const text = String(children ?? "");
        if (className === "language-mermaid") return <Mermaid chart={text} />;
        return <code className={className}>{children}</code>;
      },
    }),
    [],
  );

  // Ctrl/Cmd+S внутри Monaco. saveRef дёргает сохранение, читая актуальный
  // doc из store.getState() (без stale-closure — см. риски §6).
  const saveRef = useRef<() => void>(() => {});
  saveRef.current = async () => {
    const d = useMarkdown.getState().doc;
    if (!d) return;
    if (!d.path) { saveRef.currentSaveAs?.(); return; } // новый → «как…»
    try {
      await writeFile(d.path, d.raw);
      markSaved();
    } catch { /* статус показывается в тулбаре; здесь — тихо */ }
  };
  // (saveRef.currentSaveAs — опциональный проброс «как…» из тулбара; см. шаг 3)

  const onMount: OnMount = (editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void saveRef.current();
    });
  };

  if (!doc) {
    return <div className="editor-empty">Откройте .md или создайте новый документ.</div>;
  }

  return (
    <div className="transcript-container md-view">
      <div className="transcript-panes">
        <div className="transcript-pane">
          <div className="pane-header">
            <span>Исходник{doc.dirty ? " *" : ""}{doc.path ? ` — ${doc.path}` : " (новый)"}</span>
          </div>
          <Editor
            height="100%"
            language="markdown"
            theme={themeMode === "dark" ? "vs-dark" : "light"}
            path={doc.path || "untitled.md"}
            value={doc.raw}
            onMount={onMount}
            onChange={(value) => editRaw(value ?? "")}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              wordWrap: "on",
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
            }}
          />
        </div>
        <div className="transcript-pane">
          <div className="pane-header"><span>Превью</span></div>
          <div className="summary-markdown">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeRaw]}
              components={mdComponents}
            >
              {deferredRaw}
            </ReactMarkdown>
          </div>
        </div>
      </div>
    </div>
  );
}
```

### Ветка в `Toolbar.tsx`

Новый ранний `return` для `mode === "markdown"` (после `mode === "summary"`):

```tsx
if (mode === "markdown") {
  return (
    <header className="toolbar">
      {/* тема */}
      <button onClick={toggleTheme} className="btn theme-toggle" ...>
        {themeMode === "dark" ? "☼" : "☾"}
      </button>
      <button onClick={handleOpenMd} className="btn">Открыть .md</button>
      <button onClick={handleNewMd} className="btn">Новый</button>
      <button onClick={handleSaveMd} className="btn" disabled={!doc || !doc.dirty}>
        Сохранить{doc?.path ? "" : " как…"}
      </button>
      <button onClick={handleSaveAsMd} className="btn" disabled={!doc}>
        Сохранить как…
      </button>
      {doc && <button onClick={closeMarkdown} className="btn">Закрыть</button>}
      {doc?.dirty && <span className="badge-stale">● несохранённые изменения</span>}
      <span className="status">{status}</span>
    </header>
  );
}
```

Хендлеры внутри `Toolbar` (как `handleOpenTranscript`/`handleSave` уже там):

- `handleOpenMd`: `pickFile({filters})` + `readFile` → `openMarkdown(path, raw)`.
- `handleNewMd`: `openMarkdown("", "")`.
- `handleSaveMd`: если `!doc.path` → `handleSaveAsMd()`; иначе `writeFile(path, raw)` + `markSaved()`.
- `handleSaveAsMd`: `save({filters, defaultPath: doc.path || "untitled.md"})` → `writeFile(newPath, raw)` → `setPath(newPath)` + `markSaved()`.

### Интеграция в `App.tsx`

1. `type Mode` (стр. 14) += `"markdown"`.
2. `nav.mode-switch` — 4-я кнопка после «Саммари».
3. Тернарник рендера — добавить ветку `markdown` (перед summary, иначе финальный `: <SummaryView/>` её перекроет):
   ```tsx
   mode === "dictionaries" ? (...)
   : mode === "transcript" ? (...)
   : mode === "markdown" ? (<div className="transcript-container"><MarkdownView/></div>)
   : (<SummaryView/>)
   ```
4. `onCloseRequested` (стр. 36-50) — расширить условие «есть несохранённое»:
   ```ts
   const dictDirty = useDictionaries.getState().entries.some((e) => e.dirty);
   const mdDirty = !!useMarkdown.getState().doc?.dirty;
   if (!dictDirty && !mdDirty) return;
   ```

---

## 🔧 План реализации (по шагам)

### Шаг 1. `app/src/store/markdown.ts` (новый, ~35 строк)

- Скелет по образцу `transcript.ts` (см. «Дизайн» выше).
- Поля `doc: MarkdownDoc | null`, `dirty` живёт ВНУТРИ `doc` (плоский селектор).
- Actions: `openMarkdown`, `editRaw`, `markSaved`, `setPath`, `closeMarkdown`.
- Импорты: только `zustand`.

### Шаг 2. `app/src/components/MarkdownView.tsx` (новый)

- По скелету из «Дизайна».
- Подписки: `doc`, `editRaw`, `markSaved` из `useMarkdown`; `mode` из `useTheme`.
- `useDeferredValue(doc.raw)` для превью.
- `mdComponents` = копия из `SummaryView.tsx:270-283`.
- `onMount` → `editor.addCommand(CtrlCmd+S, ...)`.
- Empty-state если `!doc`.

### Шаг 3. `app/src/components/Toolbar.tsx`

- `type Mode` += `"markdown"`.
- Подписки: `useMarkdown(s => s.doc)`, `openMarkdown`, `markSaved`, `setPath`, `closeMarkdown`.
- Импорты: `open as pickFile, save` из `@tauri-apps/plugin-dialog`; `readFile, writeFile` из `../lib/fs`; `useMarkdown`.
- Хендлеры `handleOpenMd/handleNewMd/handleSaveMd/handleSaveAsMd` (скелеты выше).
- Новый ранний `return` для `mode === "markdown"` (после `if (mode === "summary")`, стр. 127).

### Шаг 4. `app/src/App.tsx`

- `type Mode` += `"markdown"` (стр. 14).
- 4-я кнопка в `nav.mode-switch` (после «Саммари», стр. 77-82).
- Ветка `mode === "markdown"` в тернарнике рендера (стр. 85-101).
- Расширить `onCloseRequested` (стр. 39) — проверять `useMarkdown.getState().doc?.dirty` вдобавок к словарям.
- Импорт `MarkdownView` и `useMarkdown`.

### Шаг 5. CSS (минимум)

- Переиспользовать `.transcript-container`/`.transcript-panes`/`.transcript-pane`/`.pane-header`/`.summary-markdown`.
- При необходимости — тонкая правка `.md-view` (ширина/скролл). Скорее всего ничего не нужно: контейнер уже flex.

### Шаг 6. Проверки

- `cd app && pnpm exec tsc --noEmit` — чисто (следить за `noUnusedLocals`).
- `cd app && pnpm exec vite build` — `✓ built`.
- Ручной тест по сценарию ниже.

### Шаг 7. Документация

- `-=tasks=-/2026-07-17/20260717_001_markdown_editor_result.md` — итоги по факту.
- `LESSONS_LEARNED.md` — §16 «Split-view .md поверх существующего markdown-стека: переиспользование SummaryView-конвейера».
- `README.md` — пункт в «Возможности» + этап 6 «Редактор Markdown» в «Статус реализации».

---

## ⚠️ Риски и нюансы

1. **Ctrl+S ловится только при фокусе в Monaco.** `editor.addCommand` не сработает,
   если фокус в превью/тулбаре. Подстраховка — кнопка «Сохранить» в тулбаре (всегда
   доступна). Глобальный `window`-listener — только если выяснится, что фокус
   теряется часто.
2. **Производительность превью на длинных .md.** `ReactMarkdown` ре-рендерит на
   каждое нажатие. Решение: `useDeferredValue(raw)` — React сам дебаунсит.
3. **`path=""` в Monaco (новый документ).** `path={doc.path || "untitled.md"}`
   даёт стабильную модель. При первом «Сохранить как…» `setPath(newPath)` может
   пересоздать модель Monaco и сбросить курсор. Если курсор сбрасывается —
   оставить `path="untitled.md"` (не пересоздавать модель), путь хранить только в store.
4. **Mermaid в Monaco и в превью.** Monaco подсвечивает ` ```mermaid ` как обычный
   код; превью рендерит диаграмму через `mdComponents`. Ожидаемо.
5. **`rehype-raw` и произвольный .md.** Разрешает raw-HTML (нужен для mermaid и
   доверенных .md). XSS-поверхность ограничена WebView-sandbox desktop-приложения
   (нет куки/сессий). Оставляем как есть; `rehype-sanitize` — отдельная фича.
6. **Stale-closure в Ctrl+S.** Внутри команды читать `useMarkdown.getState().doc`
   (не замыкание), как `App.tsx:39` для close-requested.
7. **Пустой `path` при «Сохранить».** `handleSaveMd`: `if (!doc.path) return handleSaveAsMd();`.
8. **Дублирование `markdownComponents`.** Копия ~13 строк из `SummaryView.tsx`.
   Рефакторинг в общий `lib/markdown.tsx` — после стабилизации, чтобы не трогать
   проверенный `SummaryView` в этой же задаче.

---

## 📁 Файлы, затрагиваемые изменением

| Файл | Изменение |
|---|---|
| **новый** `app/src/store/markdown.ts` | zustand-стор `useMarkdown` (`doc`, `openMarkdown/editRaw/markSaved/setPath/closeMarkdown`) |
| **новый** `app/src/components/MarkdownView.tsx` | two-pane: Monaco (markdown) + ReactMarkdown-превью; Ctrl+S в `onMount` |
| `app/src/components/Toolbar.tsx` | `type Mode` += `"markdown"`; ранний `return` с кнопками Открыть/Новый/Сохранить/Сохранить как…/Закрыть |
| `app/src/App.tsx` | `type Mode` += `"markdown"`; кнопка в `nav.mode-switch`; ветка в тернарнике; расширить `onCloseRequested` |
| `app/src/App.css` | (минимум) при необходимости `.md-view` |
| `LESSONS_LEARNED.md` | §16 «Split-view .md поверх существующего markdown-стека» |
| `README.md` | пункт в «Возможности» + этап 6 в «Статус реализации» |
| **новый** `-=tasks=-/2026-07-17/20260717_001_markdown_editor_result.md` | итоги реализации (по факту) |

Новых зависимостей **0**. Capabilities **0** правок. Бэкенд (Rust) **0** правок.
Новых файлов в `app/src/`: 2 (`store/markdown.ts`, `components/MarkdownView.tsx`).

---

## 🎬 Сценарий ручной проверки

1. `pnpm tauri dev` → режим «Markdown».
2. «Открыть .md» → выбрать `README.md` репозитория → обе панели: Monaco (редактируемый) + превью.
3. Поправить заголовок в Monaco → превью обновилось; в шапке исходника `*`.
4. **Ctrl+S** → файл на диске перезаписан; `*` исчез; `status`: «Сохранено: …».
5. «Сохранить как…» → новый путь; правки продолжаются по новому пути.
6. В `.md` есть ` ```mermaid ` блок — в превью рисуется диаграмма; GFM-таблица рисуется; raw-HTML виден.
7. Перейти в «Словари» → обратно в «Markdown» → текст, позиция курсора, dirty-флаг на месте.
8. Правка без сохранения → закрыть окно → диалог подтверждения.
9. Переключить тему (☼/☾) → Monaco и превью поменяли палитру одновременно.
10. `pnpm exec tsc --noEmit` и `pnpm exec vite build` — зелёные.

---

*План составлен по итогам обсуждения с пользователем 2026-07-17. Зафиксированные
ответы: «встроить, а не отдельное приложение», «split-view сейчас, WYSIWYG потом»,
«без новых зависимостей (GFM + mermaid + raw-HTML как в саммари)».*
