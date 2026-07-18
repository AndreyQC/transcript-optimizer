import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { Toolbar } from "./components/Toolbar";
import { DictionaryTabs } from "./components/DictionaryTabs";
import { YamlEditor } from "./components/YamlEditor";
import { EditPanel } from "./components/EditPanel";
import { TranscriptView } from "./components/TranscriptView";
import { SummaryView } from "./components/SummaryView";
import { MarkdownView } from "./components/MarkdownView";
import { useDictionaries } from "./store/dictionaries";
import { useTranscript } from "./store/transcript";
import { useMarkdown } from "./store/markdown";
import "./App.css";

type Mode = "dictionaries" | "transcript" | "summary" | "markdown";

function App() {
  const [mode, setMode] = useState<Mode>("dictionaries");

  // Связка stores: при изменении содержимого словарей (entries) помечать
  // существующий результат очистки устаревшим. Подписываемся на массив raw
  // значений (строка), а не на сами entries, чтобы избежать ложных срабатываний
  // по ссылке и не плодить ре-рендеры.
  const rawsKey = useDictionaries((s) => s.entries.map((e) => e.raw).join("\u0000"));
  const markCleanDirty = useTranscript((s) => s.markCleanDirty);
  useEffect(() => {
    markCleanDirty();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawsKey]);
  // Перехват закрытия окна: если есть несохранённые правки — спросить пользователя.
  // Любая ошибка внутри НЕ должна блокировать закрытие (окно обязано закрываться).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const win = getCurrentWindow();
        unlisten = await win.onCloseRequested(async (event) => {
          try {
            // Читаем актуальные флаги из store в момент закрытия (не из замыкания).
            // Несохранённое может быть в словарях ИЛИ в редакторе .md.
            const dictDirty = useDictionaries.getState().entries.some((e) => e.dirty);
            const mdDirty = !!useMarkdown.getState().doc?.dirty;
            if (!dictDirty && !mdDirty) return;
            const confirmed = await ask(
              "Есть несохранённые изменения. Закрыть окно без сохранения?",
              { title: "Несохранённые изменения", kind: "warning" },
            );
            if (!confirmed) {
              event.preventDefault();
            }
          } catch (e) {
            // Диалог/проверка упали — не держим пользователя заложником: закрываем.
            console.error("close-requested handler failed, allowing close:", e);
          }
        });
      } catch (e) {
        // Не в Tauri-окружении (например, vite dev в браузере) — игнорируем.
        console.warn("onCloseRequested unavailable:", e);
      }
    })();
    return () => {
      unlisten?.();
    };
  }, []);

  return (
    <div className="app-root">
      <nav className="mode-switch">
        <button
          className={mode === "dictionaries" ? "mode-btn active" : "mode-btn"}
          onClick={() => setMode("dictionaries")}
        >
          Словари
        </button>
        <button
          className={mode === "transcript" ? "mode-btn active" : "mode-btn"}
          onClick={() => setMode("transcript")}
        >
          Транскрипт
        </button>
        <button
          className={mode === "summary" ? "mode-btn active" : "mode-btn"}
          onClick={() => setMode("summary")}
        >
          Саммари
        </button>
        <button
          className={mode === "markdown" ? "mode-btn active" : "mode-btn"}
          onClick={() => setMode("markdown")}
        >
          Markdown
        </button>
      </nav>
      <Toolbar mode={mode} />
      {mode === "dictionaries" ? (
        <>
          <DictionaryTabs />
          <div className="main-pane">
            <div className="editor-pane">
              <YamlEditor />
            </div>
            <EditPanel />
          </div>
        </>
      ) : mode === "transcript" ? (
        <div className="transcript-container">
          <TranscriptView />
        </div>
      ) : mode === "markdown" ? (
        <div className="transcript-container">
          <MarkdownView />
        </div>
      ) : (
        <SummaryView />
      )}
    </div>
  );
}

export default App;
