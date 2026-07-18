import { useDeferredValue, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import { useMarkdown } from "../store/markdown";
import { useTheme } from "../store/theme";
import { writeFile } from "../lib/fs";
import { Mermaid } from "./Mermaid";

// Режим «Markdown»: двухпанельный редактор произвольного .md.
// Слева — Monaco (language="markdown", редактируемый), справа — live-превью
// через тот же конвейер, что в SummaryView (GFM + raw HTML + mermaid).
//
// Сохранение по Ctrl/Cmd+S (в фокусе Monaco) или из тулбара. Превью
// ре-рендерится через useDeferredValue, чтобы не тормозить на длинных файлах.

// mermaid-перехватчик — копия SummaryView.tsx::markdownComponents.
// Рефакторинг в общий lib/markdown.tsx оставлен на следующую задачу (см. риски §8).
const mdComponents = {
  code(props: { className?: string; children?: React.ReactNode }) {
    const { className, children } = props;
    const text = String(children ?? "");
    // Блочный fenced code с language-mermaid → рендерим диаграмму.
    if (className === "language-mermaid") {
      return <Mermaid chart={text} />;
    }
    return <code className={className}>{children}</code>;
  },
};

export function MarkdownView() {
  const doc = useMarkdown((s) => s.doc);
  const editRaw = useMarkdown((s) => s.editRaw);
  const markSaved = useMarkdown((s) => s.markSaved);
  const mode = useTheme((s) => s.mode);

  // Превью отстаёт от ввода — React сам выбирает момент, не блокируя клавиши.
  const deferredRaw = useDeferredValue(doc?.raw ?? "");

  // Ctrl/Cmd+S внутри Monaco. Читаем актуальный doc из store.getState(),
  // а не из замыкания onMount — иначе сохранится устаревший текст
  // (stale-closure; тот же приём, что в App.tsx::onCloseRequested).
  const saveRef = useRef<() => Promise<void>>(async () => {});
  saveRef.current = async () => {
    const d = useMarkdown.getState().doc;
    if (!d) return;
    if (!d.path) return; // новый документ — сохранение идёт через тулбар «как…»
    try {
      await writeFile(d.path, d.raw);
      markSaved();
    } catch {
      // Ошибка сохранения показывается статусом тулбара при кнопочном сохранении;
      // Ctrl+S тихо молчит — не блокируем печать.
    }
  };

  const onMount: OnMount = (editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void saveRef.current();
    });
  };

  if (!doc) {
    return (
      <div className="editor-empty">
        Откройте .md или создайте новый документ.
      </div>
    );
  }

  return (
    <div className="transcript-container md-view">
      <div className="transcript-panes">
        <div className="transcript-pane">
          <div className="pane-header">
            <span>
              Исходник{doc.dirty ? " *" : ""}
              {doc.path ? ` — ${doc.path}` : " — новый"}
            </span>
          </div>
          <Editor
            height="100%"
            language="markdown"
            theme={mode === "dark" ? "vs-dark" : "light"}
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
          <div className="pane-header">
            <span>Превью</span>
          </div>
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
