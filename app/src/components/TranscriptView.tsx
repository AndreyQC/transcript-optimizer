import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { useTranscript } from "../store/transcript";
import { useDictionaries } from "../store/dictionaries";
import { applyRules } from "../engine/rules";
import { exportStatsMarkdown } from "../lib/stats-export";
import { writeFile } from "../lib/fs";
import type { Settings, FillerFile, ReplacementsFile, WhitelistFile } from "../types/dictionaries";
import type { Decoration, DecorationCategory } from "../engine/types";

// Цвета подсветки по категории (idea §9.2: красный=OOV, жёлтый=будет-заменено).
const CATEGORY_CSS: Record<DecorationCategory, { bg: string }> = {
  oov: { bg: "rgba(220, 60, 60, 0.35)" }, // красный
  "will-replace": { bg: "rgba(220, 200, 60, 0.35)" }, // жёлтый
  "filler-removed": { bg: "rgba(140, 140, 140, 0.30)" }, // серый
  "short-garbage": { bg: "rgba(100, 100, 100, 0.45)" }, // тёмно-серый
};

// Преобразовать decorations движка в Monaco decorations (через CSS-классы).
function decorationsToMonaco(decos: Decoration[]): unknown[] {
  return decos.map((d, i) => {
    const cat = d.category;
    const { bg } = CATEGORY_CSS[cat];
    return {
      range: {
        startLineNumber: d.lineNo,
        startColumn: d.startCol,
        endLineNumber: d.lineNo,
        endColumn: d.endCol,
      },
      options: {
        inlineClassName: `tco-deco tco-deco-${cat}`,
        overviewRuler: { color: bg, position: 4 }, // OverviewRulerLane.Right
        // CSS-инъекция ниже задаёт фоны для классов.
        hoverMessage: { value: d.note ? `**${d.category}** (${d.note})` : `**${d.category}**` },
      },
      id: i,
    };
  });
}

function StatsPanel() {
  const cleanResult = useTranscript((s) => s.cleanResult);
  const cleanDirty = useTranscript((s) => s.cleanDirty);
  const [status, setStatus] = useState("");

  if (!cleanResult) {
    return <div className="stats-empty">Нажмите «Очистить», чтобы применить словари.</div>;
  }

  const s = cleanResult.stats;
  const replaces = cleanResult.replacementsApplied.filter((h) => h.type === "replace");
  const fillers = cleanResult.replacementsApplied.filter((h) => h.type === "filler").slice(0, 20);

  async function handleExport() {
    try {
      const md = exportStatsMarkdown(cleanResult!);
      await writeFile("stats-export.md", md);
      setStatus("Экспортировано: stats-export.md");
    } catch (e) {
      setStatus(`Ошибка экспорта: ${String(e)}`);
    }
  }

  return (
    <div className="stats-panel">
      <div className="stats-summary">
        <span className={cleanDirty ? "stats-stale" : ""}>
          Всего: <b>{s.totalWords}</b>
        </span>
        <span>Замены: <b>{s.replaced}</b></span>
        <span>Удалено: <b>{s.removed}</b></span>
        <span>Подозрительных: <b>{s.suspect}</b></span>
        {cleanDirty && <span className="stats-stale-badge">⚠ результат устарел</span>}
        <button onClick={handleExport} className="btn-mini">Экспорт .md</button>
        {status && <span className="stats-status">{status}</span>}
      </div>

      {replaces.length > 0 && (
        <table className="stats-table">
          <thead>
            <tr><th>Исходное</th><th>Замена</th><th>Правило</th><th>Кол-во</th></tr>
          </thead>
          <tbody>
            {replaces.map((h, i) => (
              <tr key={`r${i}`}><td>{h.original}</td><td>{h.replacement}</td><td className="mono">{h.rule}</td><td>{h.count}</td></tr>
            ))}
          </tbody>
        </table>
      )}

      {fillers.length > 0 && (
        <details>
          <summary>Удалённые filler ({cleanResult.replacementsApplied.filter(h=>h.type==="filler").length})</summary>
          <table className="stats-table">
            <thead><tr><th>Слово/фраза</th><th>Тип</th><th>Кол-во</th></tr></thead>
            <tbody>
              {fillers.map((h, i) => (
                <tr key={`f${i}`}><td>{h.original}</td><td className="mono">{h.rule}</td><td>{h.count}</td></tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

export function TranscriptView() {
  const transcript = useTranscript((s) => s.transcript);
  const cleanResult = useTranscript((s) => s.cleanResult);
  const setCleanResult = useTranscript((s) => s.setCleanResult);

  // Данные словарей для applyRules (подписка на стабильные поля, без новых объектов).
  const settings = useDictionaries((s) => (s.entries.find((e) => e.kind === "settings")?.data as Settings | null) ?? null);
  const filler = useDictionaries((s) => (s.entries.find((e) => e.kind === "filler")?.data as FillerFile | null) ?? null);
  const replacements = useDictionaries((s) => (s.entries.find((e) => e.kind === "replacements")?.data as ReplacementsFile | null) ?? null);
  const whitelist = useDictionaries((s) => (s.entries.find((e) => e.kind === "whitelist")?.data as WhitelistFile | null) ?? null);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const origEditorRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const monacoRef = useRef<any>(null);
  const decosRef = useRef<string[]>([]);
  const [applying, setApplying] = useState(false);

  const onOrigMount: OnMount = useCallback((ed, monaco) => {
    origEditorRef.current = ed;
    monacoRef.current = monaco;
    // Инъекция CSS для классов подсветки.
    const css =
      ".tco-deco-oov{background:rgba(220,60,60,0.35)!important;border-bottom:1px solid #dc3c3c}" +
      ".tco-deco-will-replace{background:rgba(220,200,60,0.35)!important;border-bottom:1px solid #dcc83c}" +
      ".tco-deco-filler-removed{background:rgba(140,140,140,0.30)!important;text-decoration:line-through}" +
      ".tco-deco-short-garbage{background:rgba(100,100,100,0.45)!important}";
    monaco.editor.addEditorStyles?.(css) ??
      (() => {
        const style = document.createElement("style");
        style.textContent = css;
        document.head.appendChild(style);
      })();
  }, []);

  // Применить decorations при изменении cleanResult.
  useEffect(() => {
    const ed = origEditorRef.current;
    if (!ed || !cleanResult) return;
    decosRef.current = ed.deltaDecorations(decosRef.current, decorationsToMonaco(cleanResult.decorations));
  }, [cleanResult]);

  // Запуск applyRules.
  const handleClean = useCallback(() => {
    if (!transcript) return;
    setApplying(true);
    try {
      const result = applyRules(transcript.parsed, { settings, filler, replacements, whitelist });
      setCleanResult(result);
    } finally {
      setApplying(false);
    }
  }, [transcript, settings, filler, replacements, whitelist, setCleanResult]);

  // Команда «Очистить» доступна через window-событие от Toolbar (упрощённо:
  // Toolbar вызывает applyRules напрямую через свой обработчик). Здесь кнопка
  // дублирует для удобства.
  if (!transcript) {
    return (
      <div className="editor-empty">
        Транскрипт не открыт. Нажмите «Открыть транскрипт».
      </div>
    );
  }

  return (
    <div className="transcript-view">
      <div className="transcript-panes">
        <div className="transcript-pane">
          <div className="pane-header">Оригинал <span className="legend"><i className="dot oov"/>OOV <i className="dot will-replace"/>замена <i className="dot filler"/>filler</span></div>
          <Editor
            height="100%"
            language="plaintext"
            theme="vs-dark"
            path={transcript.path + "#orig"}
            value={transcript.raw}
            onMount={onOrigMount}
            options={{
              readOnly: true,
              minimap: { enabled: false },
              fontSize: 12,
              scrollBeyondLastLine: false,
              automaticLayout: true,
              wordWrap: "on",
            }}
          />
        </div>
        <div className="transcript-pane">
          <div className="pane-header">
            Очищенный
            <button onClick={handleClean} className="btn-mini" disabled={applying}>
              {applying ? "Очистка..." : "Очистить"}
            </button>
          </div>
          <Editor
            height="100%"
            language="plaintext"
            theme="vs-dark"
            path={transcript.path + "#clean"}
            value={cleanResult?.cleanedText ?? ""}
            options={{
              readOnly: true,
              minimap: { enabled: false },
              fontSize: 12,
              scrollBeyondLastLine: false,
              automaticLayout: true,
              wordWrap: "on",
            }}
          />
        </div>
      </div>
      <StatsPanel />
    </div>
  );
}
