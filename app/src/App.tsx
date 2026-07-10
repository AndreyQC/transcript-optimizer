import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { Toolbar } from "./components/Toolbar";
import { DictionaryTabs } from "./components/DictionaryTabs";
import { YamlEditor } from "./components/YamlEditor";
import { EditPanel } from "./components/EditPanel";
import { useDictionaries } from "./store/dictionaries";
import { useTranscript } from "./store/transcript";
import "./App.css";

function App() {
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
            // Читаем актуальный флаг из store в момент закрытия (не из замыкания).
            if (!useDictionaries.getState().entries.some((e) => e.dirty)) return;
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
      <Toolbar />
      <DictionaryTabs />
      <div className="main-pane">
        <div className="editor-pane">
          <YamlEditor />
        </div>
        <EditPanel />
      </div>
    </div>
  );
}

export default App;
