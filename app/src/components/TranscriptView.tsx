import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { save } from "@tauri-apps/plugin-dialog";
import { useTranscript } from "../store/transcript";
import { useDictionaries } from "../store/dictionaries";
import { useTheme } from "../store/theme";
import { applyRules } from "../engine/rules";
import { exportStatsMarkdown } from "../lib/stats-export";
import { writeFile } from "../lib/fs";
import { addEntry } from "../lib/yaml-edit";
import { tokenize, norm } from "../engine/tokenizer";
import { buildOovRows } from "../engine/oov-stats";
import { collapseTimemarks } from "../engine/collapse";
import { OovStatsGrid } from "./OovStatsGrid";
import type { Settings, FillerFile, ReplacementsFile, WhitelistFile } from "../types/dictionaries";
import type { Decoration, DecorationCategory } from "../engine/types";
import {
  ACTIONS_FOR_SELECTION,
  ACTION_LABEL,
  type ContextAction,
  type Selection,
} from "./contextMenuActions";
import { ContextActionDialog } from "./ContextActionDialog";

// Цвета подсветки по категории (idea §9.2: красный=OOV, жёлтый=будет-заменено).
// Alpha повышена для читаемости на тёмном фоне; добавлены рамки/зачёркивание.
const CATEGORY_CSS: Record<DecorationCategory, { bg: string }> = {
  oov: { bg: "rgba(220, 60, 60, 0.55)" }, // красный
  "will-replace": { bg: "rgba(220, 200, 60, 0.50)" }, // жёлтый
  "filler-removed": { bg: "rgba(120, 120, 120, 0.55)" }, // серый
  "short-garbage": { bg: "rgba(90, 90, 90, 0.65)" }, // тёмно-серый
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
      // Диалог сохранения: пользователь выбирает абсолютный путь.
      // Это решает Tauri FS scope (нельзя писать по относительному пути).
      const path = await save({
        defaultPath: "stats-export.md",
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!path) return; // отмена
      await writeFile(path, md);
      setStatus(`Экспортировано: ${path}`);
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
  const collapseEnabled = useTranscript((s) => s.collapseEnabled);
  const setCollapseEnabled = useTranscript((s) => s.setCollapseEnabled);

  // Данные словарей для applyRules (подписка на стабильные поля, без новых объектов).
  const settings = useDictionaries((s) => (s.entries.find((e) => e.kind === "settings")?.data as Settings | null) ?? null);
  const filler = useDictionaries((s) => (s.entries.find((e) => e.kind === "filler")?.data as FillerFile | null) ?? null);
  const replacements = useDictionaries((s) => (s.entries.find((e) => e.kind === "replacements")?.data as ReplacementsFile | null) ?? null);
  const whitelist = useDictionaries((s) => (s.entries.find((e) => e.kind === "whitelist")?.data as WhitelistFile | null) ?? null);

  // Для батч-добавления в whitelist нужны raw и applyEdit. Подписываемся через
  // селекторы (см. LESSONS_LEARNED.md §3 — нельзя getState в замыкании колбэка).
  const whitelistRaw = useDictionaries((s) => s.entries.find((e) => e.kind === "whitelist")?.raw ?? null);
  const applyEdit = useDictionaries((s) => s.applyEdit);

  // Тема обоих Monaco-редакторов (vs-dark / light).
  const themeMode = useTheme((s) => s.mode);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const origEditorRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cleanEditorRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const monacoRef = useRef<any>(null);
  const decosRef = useRef<string[]>([]);
  const [applying, setApplying] = useState(false);

  // Контекстное меню ПКМ → словарь (этап 3). Какое действие и выделение открыто.
  const [ctxAction, setCtxAction] = useState<ContextAction | null>(null);
  const [ctxSelection, setCtxSelection] = useState<Selection | null>(null);

  // Вкладка левой панели: «Оригинал» (Monaco) или «Статистика» (грид OOV).
  const [origTab, setOrigTab] = useState<"original" | "stats">("original");
  // Статус последней операции из грида (для футера).
  const [oovStatus, setOovStatus] = useState("");

  // Строки грида OOV — чистая функция от cleanResult, мемоизируется.
  const oovRows = useMemo(
    () => (cleanResult ? buildOovRows(cleanResult) : []),
    [cleanResult],
  );

  // Отображаемый очищенный текст: свёрнутая проекция по кнопке «Свернуть реплики».
  // collapseTimemarks — чистая функция, НЕ мутирует cleanResult.cleanedText.
  const cleanedShown = useMemo(
    () =>
      collapseEnabled && cleanResult
        ? collapseTimemarks(cleanResult.cleanedText)
        : cleanResult?.cleanedText ?? "",
    [cleanResult, collapseEnabled],
  );

  // Батч-добавление выделенных слов в detector_whitelist.yaml (common_words).
  // Накатываем raw одного addEntry на вход следующего → один applyEdit = один undo.
  // Дедупликация по нормализованной форме против уже существующих common_words.
  const handleAddWhitelist = useCallback(
    (words: string[]) => {
      if (words.length === 0) return;
      if (!whitelistRaw) {
        setOovStatus("Словарь whitelist не открыт.");
        return;
      }
      // Уже существующие слова (нормализованные) — чтобы не добавить дубль.
      const existing = new Set(
        (whitelist?.common_words ?? []).map(norm),
      );
      let raw = whitelistRaw;
      let added = 0;
      let skipped = 0;
      let firstErr: string | null = null;
      for (const w of words) {
        if (existing.has(norm(w))) {
          skipped += 1;
          continue;
        }
        const res = addEntry(raw, { kind: "whitelist", value: w });
        if (!res.ok) {
          firstErr ??= res.error ?? "ошибка";
          break;
        }
        raw = res.raw;
        existing.add(norm(w));
        added += 1;
      }
      if (firstErr) {
        setOovStatus(`Ошибка: ${firstErr}`);
        return;
      }
      if (added > 0) {
        applyEdit("whitelist", raw);
      }
      const parts = [`Добавлено: ${added}`];
      if (skipped > 0) parts.push(`уже было: ${skipped}`);
      setOovStatus(parts.join(", "));
    },
    [whitelistRaw, whitelist, applyEdit],
  );

  // Добавление одного слова в replacement: открывает ContextActionDialog
  // с action="replace" — тот же поток, что и ПКМ «Заменить на…».
  const handleAddReplacement = useCallback((word: string) => {
    setCtxSelection({ text: word, isPhrase: false });
    setCtxAction("replace");
  }, []);

  // Monaco в скрытой вкладке не пересчитывает layout. При возврате на «Оригинал»
  // вызываем layout(), чтобы редактор занял корректные размеры.
  useEffect(() => {
    if (origTab === "original" && origEditorRef.current) {
      // requestAnimationFrame — чтобы отработал показ контейнера (display).
      requestAnimationFrame(() => origEditorRef.current?.layout());
    }
  }, [origTab]);

  const onOrigMount: OnMount = useCallback((ed, monaco) => {
    origEditorRef.current = ed;
    monacoRef.current = monaco;
    // Инъекция CSS для классов подсветки (alpha повышена для контраста).
    const css =
      ".tco-deco-oov{background:rgba(220,60,60,0.55)!important;border-bottom:2px solid #dc3c3c}" +
      ".tco-deco-will-replace{background:rgba(220,200,60,0.50)!important;border-bottom:2px solid #dcc83c}" +
      ".tco-deco-filler-removed{background:rgba(120,120,120,0.55)!important;text-decoration:line-through}" +
      ".tco-deco-short-garbage{background:rgba(90,90,90,0.65)!important;border-bottom:1px dashed #777}";
    monaco.editor.addEditorStyles?.(css) ??
      (() => {
        const style = document.createElement("style");
        style.textContent = css;
        document.head.appendChild(style);
      })();

    // Контекстное меню ПКМ → словарь (этап 3).
    // Регистрируем одно действие-«обёртку», показывающее подменю доступных операций
    // по выделению (слово → 5 действий; фраза → 3).
    ed.addAction({
      id: "tco-context-dictionary",
      label: "📋 Словарь…",
      contextMenuGroupId: "tco-dictionary",
      contextMenuOrder: 1,
      run: (editor) => {
        // Берём выделение; если нет — слово под курсором.
        let sel = editor.getSelection();
        let model = editor.getModel();
        if (!sel || !model) return;

        let text: string;
        if (sel.isEmpty()) {
          // Нет выделения — берём слово под курсором через модель.
          const pos = editor.getPosition();
          if (!pos) return;
          const word = model.getWordAtPosition(pos);
          if (!word) return;
          text = word.word;
        } else {
          text = model.getValueInRange(sel);
        }
        text = text.trim();
        if (!text) return;

        // Классификация: одно слово или фраза (несколько токенов).
        const tokens = tokenize(text);
        const isPhrase = tokens.length > 1;

        const selection: Selection = { text, isPhrase };
        const actions = ACTIONS_FOR_SELECTION(selection);

        // Быстрый путь: единственное доступное действие — применяем сразу
        // (whitelist для одиночного слова, например). Иначе показываем меню выбора.
        if (actions.length === 1) {
          setCtxSelection(selection);
          setCtxAction(actions[0]);
          return;
        }

        // Несколько действий — показываем всплывающее меню выбора у курсора.
        // Зависит только от DOM, не от состояния React (колбэк передаётся наружу).
        showContextMenuPopup(editor, selection, actions, (a) => {
          setCtxSelection(selection);
          setCtxAction(a);
        });
      },
    });
  }, []);

  const onCleanMount: OnMount = useCallback((ed, monaco) => {
    cleanEditorRef.current = ed;
    if (!monacoRef.current) monacoRef.current = monaco;
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

  // Синхронизация по таймштампу: берём строку под курсором в активной панели,
  // находим её таймштамп, подскролливаем вторую панель к той же реплике.
  const handleSync = useCallback(() => {
    if (!transcript || !cleanResult) return;
    const origEd = origEditorRef.current;
    const cleanEd = cleanEditorRef.current;
    if (!origEd || !cleanEd) return;

    // Какая панель активна? Та, где курсор (фокус). По умолчанию — оригинал.
    const origPos = origEd.getPosition();
    const cleanPos = cleanEd.getPosition();
    const focusClean = cleanEd.hasTextFocus();
    const srcLine = (focusClean ? cleanPos : origPos)?.lineNumber;
    if (!srcLine) return;

    // Time строки-источника: в оригинале — по parsed (lineNo реплики);
    // в очищенном — парсим cleanedText на лету.
    let srcTime: string | null = null;
    if (focusClean) {
      srcTime = timeAtLine(cleanResult.cleanedText, srcLine);
    } else {
      srcTime = timeAtParsedLine(transcript.parsed, srcLine);
    }
    if (!srcTime) return;

    // Целевая панель: найти строку с тем же time.
    if (focusClean) {
      const targetLine = parsedLineForTime(transcript.parsed, srcTime);
      if (targetLine != null) origEd.revealLineInCenter(targetLine);
    } else {
      const targetLine = lineForTime(cleanResult.cleanedText, srcTime);
      if (targetLine != null) cleanEd.revealLineInCenter(targetLine);
    }
  }, [transcript, cleanResult]);

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
          <div className="pane-tabs">
            <button
              className={`pane-tab${origTab === "original" ? " active" : ""}`}
              onClick={() => setOrigTab("original")}
            >
              Оригинал
            </button>
            <button
              className={`pane-tab${origTab === "stats" ? " active" : ""}`}
              onClick={() => setOrigTab("stats")}
            >
              Статистика{oovRows.length > 0 ? ` (${oovRows.length})` : ""}
            </button>
            {origTab === "original" && (
              <span className="legend pane-tab-legend">
                <i className="dot oov" />OOV <i className="dot will-replace" />замена <i className="dot filler" />filler
              </span>
            )}
          </div>
          {/* Monaco НЕ размонтируем при переключении вкладок — иначе слетят
              decorations/курсор/скролл. Скрываем через CSS; layout() вызывается
              эффектом при возврате на вкладку. */}
          <div className={`pane-tab-body${origTab === "original" ? "" : " hidden"}`}>
            <Editor
              height="100%"
              language="plaintext"
              theme={themeMode === "dark" ? "vs-dark" : "light"}
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
          {origTab === "stats" &&
            (cleanResult ? (
              <OovStatsGrid
                rows={oovRows}
                onAddWhitelist={handleAddWhitelist}
                onAddReplacement={handleAddReplacement}
                status={oovStatus}
              />
            ) : (
              <div className="stats-empty">Нажмите «Очистить», чтобы увидеть статистику.</div>
            ))}
        </div>
        <div className="transcript-pane">
          <div className="pane-header">
            Очищенный
            <span className="pane-actions">
              <button onClick={handleClean} className="btn-mini" disabled={applying}>
                {applying ? "Очистка..." : "Очистить"}
              </button>
              <button onClick={handleSync} className="btn-mini" disabled={!cleanResult} title="Подскроллить вторую панель к той же реплике по таймштампу">
                ⇆ Синхронизировать
              </button>
              <button
                onClick={() => setCollapseEnabled(!collapseEnabled)}
                className={`btn-mini${collapseEnabled ? " active" : ""}`}
                disabled={!cleanResult}
                title="Свернуть избыточные временные метки в блоках одного спикера"
              >
                ⤵ Свернуть реплики
              </button>
            </span>
          </div>
          <Editor
            height="100%"
            language="plaintext"
            theme={themeMode === "dark" ? "vs-dark" : "light"}
            path={transcript.path + "#clean"}
            value={cleanedShown}
            onMount={onCleanMount}
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
      <ContextActionDialog
        action={ctxAction}
        selection={ctxSelection}
        onClose={() => {
          setCtxAction(null);
          setCtxSelection(null);
        }}
      />
    </div>
  );
}

// --- helpers для синхронизации по таймштампу --------------------------------

const RE_TIME_LINE = /^\[(\d{2}:\d{2}:\d{2})\]/;

// Найти таймштамп реплики, которой принадлежит строка lineNo (1-based),
// в распарсенном оригинале. Идём по utterances, берём ближайший <= lineNo.
function timeAtParsedLine(parsed: { blocks: { utterances: { lineNo: number; time: string }[] }[] }, lineNo: number): string | null {
  let best: string | null = null;
  for (const b of parsed.blocks) {
    for (const u of b.utterances) {
      if (u.lineNo <= lineNo) best = u.time;
      else break;
    }
  }
  return best;
}

// Таймштамп строки в произвольном плоском тексте (для cleanedText).
function timeAtLine(text: string, lineNo: number): string | null {
  const lines = text.split("\n");
  let best: string | null = null;
  for (let i = 0; i < Math.min(lineNo, lines.length); i++) {
    const m = lines[i].match(RE_TIME_LINE);
    if (m) best = m[1];
  }
  return best;
}

// Номер строки (1-based) первой реплики с данным таймштампом в parsed.
function parsedLineForTime(parsed: { blocks: { utterances: { lineNo: number; time: string }[] }[] }, time: string): number | null {
  for (const b of parsed.blocks) {
    for (const u of b.utterances) {
      if (u.time === time) return u.lineNo;
    }
  }
  return null;
}

// Номер строки (1-based) первой реплики с данным таймштампом в плоском тексте.
function lineForTime(text: string, time: string): number | null {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(RE_TIME_LINE);
    if (m && m[1] === time) return i + 1;
  }
  return null;
}

// --- контекстное меню ПКМ → словарь -----------------------------------------

// Всплывающее меню выбора действия у позиции курсора (этап 3.2).
// Простой DOM-попап: закрытие по клику вне меню или Esc, по выбору — колбэк.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function showContextMenuPopup(
  editor: any,
  selection: Selection,
  actions: ContextAction[],
  onPick: (a: ContextAction) => void,
) {
  // Удаляем возможно-существующий попап (на всякий случай).
  document.querySelectorAll(".ctx-popup").forEach((el) => el.remove());

  const popup = document.createElement("div");
  popup.className = "ctx-popup";

  const title = document.createElement("div");
  title.className = "ctx-popup-title";
  title.textContent = `«${selection.text}»`;
  popup.appendChild(title);

  for (const a of actions) {
    const item = document.createElement("div");
    item.className = "ctx-popup-item";
    item.textContent = ACTION_LABEL[a];
    item.addEventListener("click", () => {
      popup.remove();
      document.removeEventListener("mousedown", onOutside, true);
      onPick(a);
    });
    popup.appendChild(item);
  }

  // Позиция: там, где был клик (contextmenu-событие). Monaco экранирует coords,
  // поэтому используем screen-координаты из последнего contextmenu-события.
  // Запасной вариант — позиция курсора редактора, спроецированная в screen.
  const pos = editor.getPosition();
  const coords =
    pos && typeof editor.getScrolledVisiblePosition === "function"
      ? editor.getScrolledVisiblePosition(pos)
      : null;
  // DOM-координаты Monaco-контейнера.
  const domNode = editor.getDomNode();
  let left = 100;
  let top = 100;
  if (domNode) {
    const rect = domNode.getBoundingClientRect();
    if (coords) {
      left = rect.left + window.scrollX + coords.left;
      top = rect.top + window.scrollY + coords.top;
    } else {
      left = rect.left + window.scrollX + 40;
      top = rect.top + window.scrollY + 40;
    }
  }
  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;

  document.body.appendChild(popup);

  function onOutside(e: MouseEvent) {
    if (!popup.contains(e.target as Node)) {
      popup.remove();
      document.removeEventListener("mousedown", onOutside, true);
    }
  }
  document.addEventListener("mousedown", onOutside, true);

  function onEsc(e: KeyboardEvent) {
    if (e.key === "Escape") {
      popup.remove();
      document.removeEventListener("mousedown", onOutside, true);
      document.removeEventListener("keydown", onEsc, true);
    }
  }
  document.addEventListener("keydown", onEsc, true);
}
