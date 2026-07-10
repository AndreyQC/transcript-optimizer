import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { Toolbar } from "./components/Toolbar";
import { DictionaryTabs } from "./components/DictionaryTabs";
import { YamlEditor } from "./components/YamlEditor";
import { EditPanel } from "./components/EditPanel";
import { useDictionaries } from "./store/dictionaries";
import "./App.css";

function App() {
  // Перехват закрытия окна: если есть несохранённые правки — спросить пользователя.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const win = getCurrentWindow();
        unlisten = await win.onCloseRequested(async (event) => {
          // Читаем актуальный флаг из store в момент закрытия (не из замыкания).
          if (!useDictionaries.getState().entries.some((e) => e.dirty)) return;
          const confirmed = await ask(
            "Есть несохранённые изменения. Закрыть окно без сохранения?",
            { title: "Несохранённые изменения", kind: "warning" },
          );
          if (!confirmed) {
            event.preventDefault();
          }
        });
      } catch {
        // Не в Tauri-окружении (например, vite dev в браузере) — игнорируем.
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
