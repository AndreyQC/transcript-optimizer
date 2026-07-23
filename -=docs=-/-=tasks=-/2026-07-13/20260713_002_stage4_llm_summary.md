# Этап 4: LLM-summary — самодостаточный план для следующей сессии

**Дата:** 2026-07-13
**Проект:** transcript-optimizer (desktop: Tauri 2 + React 19 + TS + Vite 7 + Monaco)
**Этот файл — точка входа для реализации этапа 4.** Прочти его первым.

> **Инструкция новому диалогу:** ты продолжаешь разработку. Все архитектурные
> решения УЖЕ ПРИНЯТЫ (см. «Зафиксированные решения») — не пересомневаться.
> Контекст проекта (стек, архитектура движка, паттерны zustand) — в
> `-=tasks=-/2026-07-10/20260710_001_next_step.md`; сверься при необходимости.
> Уроки отладки — в `LESSONS_LEARNED.md` (§3 про zustand-селекторы — критично).

---

## ✅ Состояние репозитория на момент написания

- **Ветка:** `docs/transcript-optimizer-plan` (отслеживает origin, **запушена**).
- HEAD: `93dfd86 feat(transcript): context menu → dictionary (stage 3)`.
- Этапы 0-2 + тёмная/светлая тема + **этап 3 (контекстное меню ПКМ → словарь)** — готовы и запушены.
- Working tree чистый (возможен CRLF-шум в `app/src-tauri/Cargo.toml` — известный артефакт, игнорировать).
- **Этап 4 (LLM-summary) — НЕ НАЧАТ. Этот файл описывает, как его реализовать.**

---

## 🎯 Цель этапа 4 (MVP)

Пользователь открывает транскрипт, опционально «Очистить», переключается в режим
«Саммари», видит настройки LLM, жмёт одну из двух кнопок — «Саммари (raw)» или
«Саммари (cleaned)» — и получает Markdown-результат с поддержкой GFM-таблиц и
Mermaid-диаграмм, рендерящийся live по мере стриминга. Если сгенерированы оба
результата — Monaco diff между ними.

### Критерий готовности
1. В UI появился третий режим «Саммари».
2. Настройки LLM (`base_url`, `model`, `temperature`, `max_tokens`, `system_prompt`,
   `user_prompt_template`) редактируются и сохраняются между перезапусками.
3. Если OS env `OPENAI_API_KEY` задан — статус ключа зелёный; если нет —
   понятное сообщение и кнопки запуска задизейблены.
4. Жмёшь «Саммари (raw)» → стрим идёт, Markdown рендерится live, Mermaid-блоки
   рисуются.
5. Жмёшь «Саммари (cleaned)» (после «Очистить») → второй результат, переключение
   в Diff-режим Monaco показывает разницу raw vs cleaned.

### ВНЕ MVP (бэклог, НЕ делать в этом проходе)
- История запусков (prompt-хэш, модель, токены, дата) — idea §4.6.
- OS keychain для `api_key` — оставлено на потом (ключ из env).
- Открытие внешнего prompt-файла через диалог — промпт сейчас в settings store.
- Чанкинг длинных транскриптов.
- Streaming abort при переключении режима (задизейблить кнопки пока стримит — MVP).

---

## 🔒 Зафиксированные решения (УЖЕ ПРИНЯТЫ, не пересомневаться)

| Вопрос | Решение | Обоснование |
|---|---|---|
| **Где HTTP-вызов к LLM** | **Rust-команда** через `reqwest` + `tauri::ipc::Channel` | `@tauri-apps/plugin-http`'s `fetch` имеет баг стриминга (plugins-workspace #2415) — буферизует весь ответ. Rust-сторона даёт настоящий инкрементальный SSE. |
| **API-ключ** | **OS env `OPENAI_API_KEY`**, читается `std::env::var` в Rust, отдаётся фронтенду через `#[tauri::command]` | Пользователь явно выбрал системные переменные. Не в localStorage, не в config-файле, не keychain. |
| **Настройки LLM** | **localStorage** через zustand-стор (как `theme.ts`) | MVP; keychain избыточен для не-секретных полей. |
| **Вход саммари** | **Две кнопки**: «Саммари (raw)» + «Саммари (cleaned)» | Пользователь хочет сравнить саммари сырого и очищенного. |
| **Просмотр результата** | `react-markdown` + `remark-gfm` + `rehype-raw` + `mermaid`; **Monaco DiffEditor** если есть оба результата | idea §3.3 фиксирует стек рендера. |
| **CSP** | **Без изменений** (`csp: null` в `tauri.conf.json`) | Monaco использует Web Workers + blob — строгое CSP сломает редактор. |
| **Scope** | MVP без истории запусков | Согласовано с пользователем. |
| **Prompt** | `system_prompt` + `user_prompt_template` в zustand-настройках (не внешний файл) | MVP упрощение; внешний prompt-файл — бэклог. |

---

## 🏗️ Технические находки (исследовано для этого плана)

### 1. Чтение OS env в Tauri 2 → frontend
- `std::env::var("OPENAI_API_KEY")` в Rust → `#[tauri::command] fn get_openai_api_key() -> Option<String>`.
- Регистрация: `.invoke_handler(tauri::generate_handler![...])` в `lib.rs`.
- Фронтенд: `invoke<string|null>("get_openai_api_key")` из `@tauri-apps/api/core`.
- **Свои `#[tauri::command]` НЕ требуют entries в `capabilities/default.json`** — capabilities гейтят только plugin/core команды.
- **Windows-нюанс:** при запуске `.exe` двойным кликом процесс наследует env-блок логина. Если пользователь сделал `setx OPENAI_API_KEY ...`, потребуется перелогин/перезапуск оболочки. Сообщить в UI.
- Документация: https://v2.tauri.app/develop/calling-rust/

### 2. SSE-стриминг из Rust во frontend
- Используем `reqwest` (реэкспортируется из `tauri-plugin-http`: `tauri_plugin_http::reqwest`).
- `futures-util` нужен для `StreamExt` на `bytes_stream()`.
- Чанки отправляются во фронтенд через `tauri::ipc::Channel<StreamChunk>`.
- На JS: `new Channel<T>()` (из `@tauri-apps/api/core`), `onmessage = (msg) => ...`. `Vec<u8>` приходит как `number[]` → `new Uint8Array(msg.data)`.
- Документация: https://v2.tauri.app/develop/calling-frontend/
- SSE-формат парсим на JS (толерантно): строки `data: {json}` → `choices[0].delta.content`; `data: [DONE]` → конец; остальное игнорим.

### 3. HTTP-запрос идёт из Rust → CORS не применяется
- `reqwest` в Rust не подчиняется webview-CORS.
- **`capabilities/default.json` НЕ МЕНЯЕМ** — ни `http:default`, ни scope. HTTP-провайдер (Rust) обходит систему permissions плагинов.

### 4. Существующие зависимости (что уже стоит)
- `package.json`: `@monaco-editor/react ^4.7.0`, `@tauri-apps/api ^2`, `zustand ^5.0.14`, `yaml ^2.9.0`, React 19. **Нет** react-markdown/mermaid/openai-sdk.
- `Cargo.toml`: `tauri 2`, `tauri-plugin-{opener,fs,dialog}`, `serde`, `serde_json`. **Нет** `tauri-plugin-http`, `futures-util`. **Нет ни одного `#[tauri::command]`** (`lib.rs` — только плагины).

### 5. Паттерны кода (сверяться!)
- **Zustand-стор:** `create<T>((set, get) => ...)`, БЕЗ middleware persist. localStorage — ручной в setter'е, обёрнутый в try/catch. Namespace ключа: `transcript-optimizer.<feature>`. Образец: `app/src/store/theme.ts`.
- **lib-модуль:** экспортированные async-функции, без классов/default-exports, с русским JSDoc. Образец: `app/src/lib/fs.ts`.
- **Mode type:** дублирован в `App.tsx` и `Toolbar.tsx` — `type Mode = "dictionaries" | "transcript"`. **Не вынесен в shared-типы** — добавляя `"summary"`, править оба файла (соответствие существующему паттерну).
- **Режим-переключение:** `App.tsx` `<nav className="mode-switch">` + тернарный рендер; `Toolbar.tsx` — ранний `if (mode === "...") return ...`.
- **Transcript-данные:** `useTranscript((s) => s.transcript)` даёт `.raw` и `.parsed`; `useTranscript((s) => s.cleanResult)` даёт `.cleanedText` (`null` если не очищено).

---

## 📐 Архитектура изменений

```
app/
├─ src-tauri/
│  ├─ Cargo.toml                  +tauri-plugin-http, +futures-util
│  ├─ src/lib.rs                  +invoke_handler, +2 команды (get_openai_api_key, stream_chat)
│  └─ capabilities/default.json   БЕЗ ИЗМЕНЕНИЙ
└─ src/
   ├─ App.tsx                     +третья кнопка режима, +рендер SummaryView
   ├─ components/
   │  ├─ Toolbar.tsx              +"summary" ветка mode
   │  ├─ SummaryView.tsx          НОВЫЙ: настройки + 2 кнопки + рендер/diff
   │  └─ Mermaid.tsx              НОВЫЙ: обёртка mermaid.render() для react-markdown
   ├─ store/
   │  └─ llm.ts                   НОВЫЙ: settings + persist + apiKeyAvailable
   ├─ lib/
   │  └─ llm.ts                   НОВЫЙ: payload, invoke, SSE-парсинг
   └─ App.css                     +стили .summary-*, .mermaid-block
```

---

## 🔧 Подзадачи (порядок реализации)

### 4.1 Rust-бэкенд: env-команда + stream_chat
- `Cargo.toml`: добавить `tauri-plugin-http = "2"` (реэкспорт `reqwest`), `futures-util = { version = "0.3", features = ["std"] }`.
- `src/lib.rs`:
  - `#[tauri::command] fn get_openai_api_key() -> Option<String>` — `std::env::var("OPENAI_API_KEY").ok().filter(|s| !s.is_empty())`.
  - `#[derive(serde::Serialize)] struct StreamChunk { data: Vec<u8> }`.
  - `#[tauri::command] async fn stream_chat(base_url: String, api_key: String, body: serde_json::Value, on_event: Channel<StreamChunk>) -> Result<(), String>`:
    - Нормализовать `base_url` (убрать trailing `/`), склеить `+ "/chat/completions"` (**НЕ** добавлять `/v1` — пользователь пишет полный base, напр. `https://api.openai.com/v1`).
    - `Client::new().post(url).bearer_auth(&api_key).json(&body).send().await` → map_err в `String`.
    - `resp.bytes_stream()` + `while let Some(chunk) = stream.next().await { on_event.send(StreamChunk { data: bytes.to_vec() }).map_err(|e| e.to_string())?; }`.
    - Ошибки → `Err(String)`.
  - `.invoke_handler(tauri::generate_handler![get_openai_api_key, stream_chat])`.
- Проверка: `cd app/src-tauri && cargo check`.

### 4.2 `lib/llm.ts` — payload + invoke + SSE-парсинг
- `export interface LlmSettings { baseUrl; model; temperature; maxTokens; systemPrompt; userPromptTemplate: string }` + `DEFAULT_LLM_SETTINGS` (`gpt-4o-mini`, `0.3`, `4096`, `https://api.openai.com/v1`, системный промпт про саммари, шаблон с плейсхолдером `{transcript}`).
- `export async function getApiKey(): Promise<string | null>` — `invoke<string|null>("get_openai_api_key")`, try/catch (вне Tauri вернёт `null`).
- `export async function streamChatCompletion(params: { settings; transcriptText; apiKey; onDelta: (chunk: string) => void }): Promise<{ ok: boolean; error?: string }>`:
  - Собрать `body = { model, temperature, max_tokens, stream: true, messages: [{role:"system", content: systemPrompt}, {role:"user", content: template.replace("{transcript}", transcriptText)}] }`.
  - `const channel = new Channel<{data: number[]}>(); channel.onmessage = (msg) => { const text = new TextDecoder().decode(new Uint8Array(msg.data)); parseSse(text) }`.
  - SSE-парсер: накапливать буфер (модульно-local), делить по `\n`, для каждой `data: ...` строки парсить JSON, достать `choices[0].delta.content`, дернуть `onDelta`. `data: [DONE]` → флаг конца.
  - `await invoke("stream_chat", { baseUrl: settings.baseUrl, apiKey, body, onEvent: channel })`.
- Smoke-тест через tsx (с мок-Channel, см. «Как проверять» ниже).

### 4.3 `store/llm.ts` — настройки + persist + статус ключа
- `interface LlmStore { settings: LlmSettings; setSettings: (patch: Partial<LlmSettings>) => void; apiKeyAvailable: boolean | null; refreshApiKey: () => Promise<void>; }`.
- localStorage ключ `transcript-optimizer.llm`. `initialSettings()` — чтение + `JSON.parse` + try/catch, fallback на `DEFAULT_LLM_SETTINGS`.
- `setSettings(patch)` — merge + `localStorage.setItem(KEY, JSON.stringify(merged))` (try/catch) + `set(...)`.
- `apiKeyAvailable: null` (не проверяли) | `true` | `false`. `refreshApiKey` — `apiKeyAvailable = !!(await getApiKey())`. **НЕ дёргать при импорте модуля** — только когда откроют режим Summary (иначе падает вне Tauri).
- Образец стиля: `app/src/store/theme.ts`.

### 4.4 npm-зависимости
- `cd app && pnpm add react-markdown remark-gfm rehype-raw mermaid`.
- Проверить версии в `package.json` (последние стабильные).

### 4.5 `Mermaid.tsx` + `SummaryView.tsx`
- **`Mermaid.tsx`** (маленький):
  - Принимает `chart: string` (содержимое ```` ```mermaid ```` блока).
  - `useEffect`: `const { svg } = await mermaid.render(id, chart)` → `setSvg(svg)`. Обработка ошибок рендера (показать текст диаграммы + ошибку).
  - `id` — уникальный (`useId` или счётчик), чтобы mermaid не конфликтовал.
- **`SummaryView.tsx`**:
  - Читает `useLlm`, `useTranscript` (`transcript`, `cleanResult`).
  - Локальный state: `summaryRaw: string`, `summaryCleaned: string`, `streaming: "raw" | "cleaned" | null`, `error: string`, `activeTab: "raw" | "cleaned" | "diff"`.
  - `useEffect` на mount: `refreshApiKey()`.
  - UI-блоки:
    1. **Статус ключа**: если `apiKeyAvailable === false` — красный бейдж «Установите env `OPENAI_API_KEY` (и перезапустите приложение)».
    2. **Настройки** (`<details>`): 6 полей — inputs для `baseUrl`/`model`/`temperature`/`maxTokens`, textareas для `systemPrompt`/`userPromptTemplate`. `onChange` → `setSettings({...})`. Placeholder подсказывает про `{transcript}`.
    3. **Кнопки запуска**: «Саммари (raw)» (disabled если нет transcript ИЛИ ключа ИЛИ `streaming !== null`), «Саммари (cleaned)» (доп. disabled если `cleanResult === null`; tooltip «Сначала Очистить»).
    4. **Результат**:
       - Переключатель «Raw | Cleaned | Diff». Diff доступен только если оба результата непустые.
       - Single-view: `<ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]} components={{ code: ({className, children}) => className === "language-mermaid" ? <Mermaid chart={String(children)} /> : <code>{children}</code> }}>`.
       - Diff: `<DiffEditor original={summaryRaw} modified={summaryCleaned} theme={themeMode === "dark" ? "vs-dark" : "light"} language="markdown" readOnly />` из `@monaco-editor/react`.
  - Стриминг: при запуске `streaming = "raw"`, `summaryRaw = ""`, дёргаем `streamChatCompletion({ onDelta: (c) => setSummaryRaw(prev => prev + c) })`, по завершении `streaming = null`. Аналогично для cleaned. Если оба результата есть → автопереключение на `activeTab = "diff"`.

### 4.6 Интеграция в `App.tsx` + `Toolbar.tsx`
- **`App.tsx`**:
  - `type Mode = "dictionaries" | "transcript" | "summary"`.
  - Третья кнопка в `<nav className="mode-switch">`: `<button className={mode === "summary" ? "mode-btn active" : "mode-btn"} onClick={() => setMode("summary")}>Саммари</button>`.
  - Рендер: расширить тернар до switch/вложенных — `mode === "summary" ? <SummaryView /> : mode === "transcript" ? (<div className="transcript-container"><TranscriptView /></div>) : (…словари…)`.
- **`Toolbar.tsx`**:
  - `type Mode` расширить до `"summary"`.
  - Добавить ранний `if (mode === "summary") { return <header className="toolbar">… theme-toggle + status …</header>; }` — саммари-режим не использует словарные/транскрипт-кнопки тулбара.

### 4.7 CSS
- В `app/src/App.css` добавить: `.summary-view`, `.summary-settings`, `.summary-settings label/input/textarea`, `.summary-actions`, `.summary-result`, `.summary-tabs`, `.mermaid-block`, `.key-status-{ok,missing}`. Использовать существующие семантические CSS-переменные (`--bg-surface`, `--text-primary` и т.д.) — тема-aware без доп. усилий.

### 4.8 Проверки
- `cd app && ./node_modules/.bin/tsc --noEmit` — типы.
- `cd app && ./node_modules/.bin/vite build` — сборка фронта.
- `cd app/src-tauri && cargo check` — бэкенд.
- Smoke через tsx: мок `invoke`+`Channel`, проверить что `streamChatCompletion` корректно парсит фейковый SSE (см. ниже).

---

## 🧪 Как проверять (шпаргалка)

```bash
cd app
./node_modules/.bin/tsc --noEmit                    # типы фронта
./node_modules/.bin/vite build                      # сборка фронта
cd src-tauri && cargo check                         # бэкенд
cd .. && pnpm tauri dev                             # запуск GUI (делает пользователь)
```

### Smoke для `lib/llm.ts` (SSE-парсер)
Создать временный `.mjs` в `app/` (рядом с `src/`, чтобы относительные импорты работали):
```js
import { streamChatCompletion } from "./src/lib/llm.ts";
// Мок @tauri-apps/api/core: заменить invoke+Channel на фейк, который
// "стримит" заранее заготовленный SSE-блок:
//   data: {choices:[{delta:{content:'Hello'}}]}\n
//   data: {choices:[{delta:{content:' world'}}]}\n
//   data: [DONE]\n
// В Node нет window.fetch — мокаем через vi.mock или подмену модуля.
const deltas = [];
await streamChatCompletion({
  settings: { baseUrl: "https://x/v1", model: "m", temperature: 0, maxTokens: 8,
              systemPrompt: "s", userPromptTemplate: "{transcript}" },
  transcriptText: "T", apiKey: "k",
  onDelta: (c) => deltas.push(c),
});
console.log("deltas joined:", JSON.stringify(deltas.join("")));
// ожидание: "Hello world" (без [DONE]).
```
После прогона — удалить `.mjs`.

### Ручная проверка вживую (критерий готовности)
1. `setx OPENAI_API_KEY "sk-..."` (Windows) → перезапустить приложение (важно для env-блока).
2. Открыть транскрипт → «Очистить».
3. Режим «Саммари» → проверить статус ключа (зелёный).
4. «Саммари (raw)» → стрим пошёл, Markdown рендерится.
5. «Саммари (cleaned)» → второй результат → Diff-вкладка показывает разницу.

### Тестовые данные
- Транскрипт: `sample/transcript_optimizer/2026-06-30 14_03 (MSK) Drill_AI_Skill.2026 [0FSklp].txt` (732 строки, 49 мин).
- Словари: `sample/transcript_optimizer/*.yaml` (6 файлов).

---

## ⚠️ Риски и заметки

1. **Windows env-блок**: `setx` требует ре-логина для GUI-запуска. Сообщение в UI: «Если ключ задан `setx` — перезапустите приложение/оболочку».
2. **Mermaid + CSP**: НЕ закручивать CSP (Monaco сломается). Оставить `csp: null`.
3. **SSE-толерантность**: разные провайдеры могут отличаться. Парсер берёт только `choices[0].delta.content`; остальное игнорим. `data: [DONE]` — конец стрима.
4. **base_url нормализация**: пользователь пишет полный base с `/v1` (напр. `https://api.openai.com/v1`). Обрезать trailing `/`, склеить с `/chat/completions`. **НЕ** добавлять `/v1` автоматически.
5. **Длинные транскрипты**: MVP без чанкинга. Если упрётся в `max_tokens` — пользователь корректирует в настройках.
6. **Streaming abort**: MVP — задизейблить кнопки пока `streaming !== null`. AbortSignal — бэклог.
7. **Первые `#[tauri::command]` в проекте**: до этого `lib.rs` содержал только плагины. Регистрация через `invoke_handler(generate_handler![...])` — новый паттерн для кодовой базы.
8. **Zustand-селекторы**: НЕ возвращать новые объекты из селекторов (`LESSONS_LEARNED.md` §3). В `llm.ts` `settings` — плоский объект, `useLlm((s) => s.settings)` ок; производные коллекции — через `useMemo`.

---

## 📚 Документация (читать при необходимости)

- **`-=tasks=-/2026-07-09/20260709_001_idea.md`** — концепция; §3.3 (Markdown+Mermaid), §3.4 (LLM-интеграция), §4.6 (Запуск summary), §9.1 (стек-вердикты), §10.6 (config-файл). **Внимание:** идея говорит «прямой fetch из фронтенда» — это решение ИЗМЕНЕНО на Rust-команду из-за бага стриминга (см. «Зафиксированные решения»).
- **`-=tasks=-/2026-07-09/20260709_002_plan.md`** — техплан; §3 (стек-таблица), §4 (зарезервированный `views/SummaryView.tsx` — мы кладём в `components/` по сложившейся конвенции проекта).
- **`-=tasks=-/2026-07-10/20260710_001_next_step.md`** — точка входа для общего контекста проекта (стек, архитектура движка, паттерны, тестовые данные).
- **`LESSONS_LEARNED.md`** — §3 (zustand-селекторы) критичен.
- Tauri 2 docs: https://v2.tauri.app/develop/calling-rust/ , https://v2.tauri.app/develop/calling-frontend/ , https://v2.tauri.app/plugin/http-client/ .

---

## 💬 Шаблон начала следующего диалога

> «Прочитай `-=tasks=-/2026-07-13/20260713_002_stage4_llm_summary.md` и реализуй этап 4 по подзадачам 4.1-4.8.»

Этого достаточно — документ самодостаточен: контекст, решения, архитектура, декомпозиция, проверки, риски.
