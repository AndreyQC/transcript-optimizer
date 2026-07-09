import Editor from "@monaco-editor/react";
import { useDictionaries } from "../store/dictionaries";

// Monaco-редактор для активного словаря. Отображает raw YAML и прокидывает
// правки в store (с пометкой dirty).
export function YamlEditor() {
  const activeKind = useDictionaries((s) => s.activeKind);
  const activeEntry = useDictionaries((s) =>
    s.entries.find((e) => e.kind === activeKind),
  );
  const editRaw = useDictionaries((s) => s.editRaw);

  if (!activeEntry) {
    return (
      <div className="editor-empty">
        Словарь не выбран. Откройте папку словарей.
      </div>
    );
  }

  return (
    <Editor
      height="100%"
      language="yaml"
      theme="vs-dark"
      path={activeEntry.path}
      value={activeEntry.raw}
      onChange={(value) => editRaw(activeEntry.kind, value ?? "")}
      options={{
        minimap: { enabled: false },
        fontSize: 13,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
      }}
    />
  );
}
