import { useCallback, useEffect, useMemo, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { useDictionaries, getGlossaryCategories } from "../store/dictionaries";
import { validateDictionary } from "../lib/validate";

// MarkerSeverity в Monaco: Error=8, Warning=4. Числовые константы используем
// напрямую, чтобы не тащить типы из 'monaco-editor' (peer-dep без своих .d.ts).

// Конвертация ValidationIssue -> Monaco marker.
function toMarker(issue: ReturnType<typeof validateDictionary>["issues"][number]) {
  return {
    startLineNumber: issue.line,
    startColumn: issue.col,
    endLineNumber: issue.endLine,
    endColumn: issue.endCol,
    message: `${issue.message} [${issue.rule}]`,
    severity: issue.severity === "error" ? 8 : 4,
  };
}

// Monaco-редактор для активного словаря. Отображает raw YAML, прокидывает
// правки в store (dirty) и подсвечивает ошибки валидации красными/жёлтыми волнами.
export function YamlEditor() {
  const activeKind = useDictionaries((s) => s.activeKind);
  const activeEntry = useDictionaries((s) =>
    s.entries.find((e) => e.kind === activeKind),
  );
  const editRaw = useDictionaries((s) => s.editRaw);
  // Подписываемся на entries (стабильная ссылка массива), а Set категорий
  // вычисляем в useMemo — иначе селектор, возвращающий новый Set каждый раз,
  // вызывает бесконечный ре-рендер (Maximum update depth exceeded).
  const entries = useDictionaries((s) => s.entries);
  const glossaryCats = useMemo(() => getGlossaryCategories(entries), [entries]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editorRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const monacoRef = useRef<any>(null);
  const ownerRef = useRef<string>("");

  const onMount: OnMount = useCallback((ed, monaco) => {
    editorRef.current = ed;
    monacoRef.current = monaco;
  }, []);

  // Повторная валидация при изменении raw активного файла или состава категорий.
  useEffect(() => {
    const ed = editorRef.current;
    const monaco = monacoRef.current;
    if (!ed || !monaco || !activeEntry) return;
    const model = ed.getModel();
    if (!model) return;
    const owner = `transcript-optimizer:${activeEntry.kind}`;
    ownerRef.current = owner;

    const { issues } = validateDictionary(activeEntry, {
      glossaryCategories: glossaryCats,
    });
    monaco.editor.setModelMarkers(
      model,
      owner,
      issues.map(toMarker),
    );
  }, [activeEntry, glossaryCats]);

  // Очистка маркеров при смене вкладки.
  useEffect(() => {
    return () => {
      const monaco = monacoRef.current;
      const ed = editorRef.current;
      if (monaco && ed) {
        const model = ed.getModel();
        if (model && ownerRef.current) {
          monaco.editor.setModelMarkers(model, ownerRef.current, []);
        }
      }
    };
  }, [activeKind]);

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
      onMount={onMount}
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
