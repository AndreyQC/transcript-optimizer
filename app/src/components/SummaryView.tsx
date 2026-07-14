import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import { DiffEditor } from "@monaco-editor/react";
import { open as pickFile, save } from "@tauri-apps/plugin-dialog";
import { useLlm } from "../store/llm";
import { useTranscript } from "../store/transcript";
import { useTheme } from "../store/theme";
import { useSummary, type Source } from "../store/summary";
import { streamChatCompletion, type LlmSettings } from "../lib/llm";
import { stripReasoning } from "../lib/reasoning";
import { writeFile } from "../lib/fs";
import { collapseTimemarks } from "../engine/collapse";
import { Mermaid } from "./Mermaid";

// Режим «Саммари»: настройки LLM, статус ключа, две кнопки запуска (raw/cleaned),
// live-рендер Markdown (GFM + Mermaid) и Monaco Diff при наличии обоих результатов.
//
// Вкладки результата — двухуровневые:
//   верхний уровень: Raw | Cleaned | Diff (что показываем)
//   под-вкладки (только для Raw/Cleaned): Поток (сырой текст) | Результат (рендер)
// Поток — моноширинный <pre>, видно как стрим заполняется. Результат — отрендеренный
// Markdown + кнопка «Сохранить .md».
//
// ВАЖНО: результаты саммари (summaryRaw/Cleaned, streaming, вкладки) живут в
// store/summary.ts, а не в локальном useState. Иначе уход в другой режим
// (Словари/Транскрипт) размонтирует этот компонент и потеряет результаты —
// это был баг №2.

export function SummaryView() {
  // store-подписки: settings (плоский объект — безопасный селектор, см. §3 LL),
  // apiKeyAvailable, refreshApiKey.
  const settings = useLlm((s) => s.settings);
  const setSettings = useLlm((s) => s.setSettings);
  const apiKeyAvailable = useLlm((s) => s.apiKeyAvailable);
  const refreshApiKey = useLlm((s) => s.refreshApiKey);
  const yamlAvailable = useLlm((s) => s.yamlAvailable);

  const transcript = useTranscript((s) => s.transcript);
  const cleanResult = useTranscript((s) => s.cleanResult);

  const themeMode = useTheme((s) => s.mode);

  // Результаты саммари — из store, чтобы переживать размонтирование компонента
  // при переключении режима (баг №2). Локально — только error/saveStatus (UI-only).
  const summaryRaw = useSummary((s) => s.summaryRaw);
  const summaryCleaned = useSummary((s) => s.summaryCleaned);
  const summaryCollapsed = useSummary((s) => s.summaryCollapsed);
  const streaming = useSummary((s) => s.streaming);
  const sourceTab = useSummary((s) => s.sourceTab);
  const viewMode = useSummary((s) => s.viewMode);
  const setSummaryRaw = useSummary((s) => s.setSummaryRaw);
  const setSummaryCleaned = useSummary((s) => s.setSummaryCleaned);
  const setSummaryCollapsed = useSummary((s) => s.setSummaryCollapsed);
  const setStreaming = useSummary((s) => s.setStreaming);
  const setSourceTab = useSummary((s) => s.setSourceTab);
  const setViewMode = useSummary((s) => s.setViewMode);

  const [error, setError] = useState<string>("");
  const [saveStatus, setSaveStatus] = useState<string>("");
  // Выбор пары для Diff — UI-выбор, переживает размонтирование не обязан.
  // По умолчанию raw↔cleaned (как было до добавления collapsed).
  const [diffPair, setDiffPair] = useState<[Source, Source]>(["raw", "cleaned"]);

  // Флаг «diff уже предложен». Автопереключение на diff срабатывает ОДИН раз —
  // ровно когда оба результата впервые готовы и стрим остановлен. После этого
  // пользователь может свободно переключаться на Raw/Cleaned (чтобы посмотреть
  // результат и сохранить), и эффект не должен перетягивать его обратно на diff.
  // Сбрасывается при старте нового стрима в runSummary.
  const diffOfferedRef = useRef(false);

  // При монтировании — проверить наличие ключа (не делаем этого на импорте store,
  // чтобы не падать вне Tauri). Зависимости пустые — только на mount.
  useEffect(() => {
    refreshApiKey();
  }, [refreshApiKey]);

  // Тексты результатов по 3 источникам (map — чтобы избавиться от булевых
  // тернарников «raw vs cleaned» при добавлении collapsed).
  const summaries: Record<Source, string> = {
    raw: summaryRaw,
    cleaned: summaryCleaned,
    collapsed: summaryCollapsed,
  };
  const setters: Record<Source, (u: string | ((p: string) => string)) => void> = {
    raw: setSummaryRaw,
    cleaned: setSummaryCleaned,
    collapsed: setSummaryCollapsed,
  };
  const has: Record<Source, boolean> = {
    raw: summaryRaw.length > 0,
    cleaned: summaryCleaned.length > 0,
    collapsed: summaryCollapsed.length > 0,
  };
  // Готовых (непустых) результатов ≥ 2 — diff доступен.
  const readyCount = (has.raw ? 1 : 0) + (has.cleaned ? 1 : 0) + (has.collapsed ? 1 : 0);
  const canDiff = readyCount >= 2;

  // Автопереключение на diff — ОДИН раз, когда ≥2 результата впервые готовы и
  // стрим остановлен. Раньше эффект перетягивал на diff при каждом изменении
  // sourceTab, не давая удержать вкладку источника (баг: «Сохранить .md»
  // исчезал). Флаг diffOffered гасит повторы; сбрасывается в runSummary.
  useEffect(() => {
    if (canDiff && streaming === null && !diffOfferedRef.current) {
      diffOfferedRef.current = true;
      setSourceTab("diff");
      return;
    }
    // Если на diff, а готовых < 2 или стрим идёт — уходим на первый готовый.
    if (sourceTab === "diff" && (!canDiff || streaming !== null)) {
      const fallback: Source = has.raw ? "raw" : has.cleaned ? "cleaned" : "collapsed";
      setSourceTab(fallback);
    }
  }, [canDiff, streaming, sourceTab, has.raw, has.cleaned, has.collapsed, setSourceTab]);

  const keyMissing = apiKeyAvailable === false;
  const hasPrompt = settings.systemPromptPath.trim().length > 0;
  const canRunRaw =
    !!transcript && yamlAvailable && hasPrompt && !keyMissing && streaming === null;
  // cleaned и collapsed — оба производны от cleanResult, условия те же.
  const canRunCleaned =
    !!transcript && !!cleanResult && yamlAvailable && hasPrompt && !keyMissing && streaming === null;
  const canRunCollapsed = canRunCleaned;

  // Выбор .md-файла системного промпта через нативный диалог. Путь (абсолютный,
  // от Tauri) пишется в settings.yaml через store. Содержимое файла НЕ кешируется —
  // читается перед каждым запуском в streamChatCompletion.
  async function handlePickPromptFile() {
    try {
      const chosen = await pickFile({
        multiple: false,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (typeof chosen !== "string") return;
      setSettings({ systemPromptPath: chosen });
    } catch (e) {
      setError(`Ошибка выбора файла промпта: ${String(e)}`);
    }
  }

  // Имя файла (basename) для показа в UI; полный путь — в tooltip.
  const promptFileName = useMemo(() => {
    const p = settings.systemPromptPath;
    if (!p) return "";
    // Берём последний сегмент пути (работает и для / и для \).
    const segs = p.split(/[\\/]/).filter(Boolean);
    return segs.length > 0 ? segs[segs.length - 1] : p;
  }, [settings.systemPromptPath]);

  async function runSummary(target: Source) {
    if (!transcript) return;
    if (target !== "raw" && !cleanResult) return;
    // collapsed — свёрнутая проекция cleanedText; НЕ зависит от флага просмотра.
    const text =
      target === "raw"
        ? transcript.raw
        : target === "cleaned"
          ? (cleanResult?.cleanedText ?? "")
          : collapseTimemarks(cleanResult?.cleanedText ?? "");
    if (text.length === 0) {
      setError(
        target === "raw"
          ? "Пустой исходный транскрипт."
          : "Нет очищенного текста — сначала «Очистить» в режиме Транскрипт.",
      );
      return;
    }

    setError("");
    setStreaming(target);
    setters[target]("");

    // Новый стрим — сбросить флаг «diff предложен», чтобы по завершении
    // автопереключение на diff сработало снова (если ≥2 результата будут готовы).
    diffOfferedRef.current = false;

    // Автопереключение на вкладку «Поток» активного источника — чтобы
    // пользователь сразу видел, как стрим заполняется.
    setSourceTab(target);
    setViewMode("stream");

    const apiKey = await (async () => {
      // refreshApiKey уже звался на mount; ключ также пере-читаем на случай,
      // если env изменили без перезапуска (best-effort).
      const { getApiKey } = await import("../lib/llm");
      return getApiKey();
    })();

    if (!apiKey) {
      setStreaming(null);
      setError(
        "OPENAI_API_KEY не задан в окружении. Установите его (setx на Windows) и перезапустите приложение.",
      );
      return;
    }

    const result = await streamChatCompletion({
      settings: settings as LlmSettings,
      transcriptText: text,
      apiKey,
      onDelta: (chunk) => {
        setters[target]((prev) => prev + chunk);
      },
    });

    setStreaming(null);
    if (!result.ok) {
      setError(result.error ?? "Неизвестная ошибка стриминга.");
    } else {
      // Успех — показываем финальный отрендеренный результат (а не сырой поток).
      setSourceTab(target);
      setViewMode("result");
    }
  }

  // Активный источник (когда не diff) — sourceTab, суженный до Source.
  // Используется для Потока/Результата/сохранения.
  const activeSource: Source =
    sourceTab === "cleaned" || sourceTab === "collapsed" ? sourceTab : "raw";

  // Текст активного источника как есть (с <think>-рассуждениями) — для «Потока».
  const activeSourceText = summaries[activeSource];
  const activeSourceHas = has[activeSource];

  // Очищенные от рассуждений версии (без <think>/<reasoning>/<reflection>).
  // useMemo — чтобы не гонять stripReasoning на каждом рендере. Применяются в
  // «Результат», Diff и при сохранении .md. «Поток» показывает исходный текст.
  const cleanedRaw = useMemo(() => stripReasoning(summaryRaw), [summaryRaw]);
  const cleanedCleaned = useMemo(
    () => stripReasoning(summaryCleaned),
    [summaryCleaned],
  );
  const cleanedCollapsed = useMemo(
    () => stripReasoning(summaryCollapsed),
    [summaryCollapsed],
  );
  // Map очищенных версий по 3 источникам — для Результата/Diff/сохранения.
  const cleanedSources: Record<Source, string> = {
    raw: cleanedRaw,
    cleaned: cleanedCleaned,
    collapsed: cleanedCollapsed,
  };
  // Очищенный текст активного источника — для Результата/сохранения.
  const activeSourceCleaned = cleanedSources[activeSource];

  // Сохранить финальный Markdown-результат через save-диалог. Доступно только
  // на вкладке «Результат» (sourceTab !== "diff", viewMode === "result").
  // Сохраняется ОЧИЩЕННЫЙ Markdown (без рассуждений) — его можно дальше открыть в редакторе.
  async function handleSaveMarkdown() {
    const text = activeSourceCleaned;
    if (!text) return;
    try {
      const path = await save({
        defaultPath: `summary-${sourceTab}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!path) return; // отмена
      await writeFile(path, text);
      setError("");
      setSaveStatus(`Сохранено: ${path}`);
    } catch (e) {
      setSaveStatus("");
      setError(`Ошибка сохранения: ${String(e)}`);
    }
  }

  // Рендер Markdown-результата: GFM-таблицы + raw HTML (для mermaid-svg и т.п.).
  // Блоки ```mermaid → компонент <Mermaid>.
  const markdownComponents = useMemo(
    () => ({
      code(props: { className?: string; children?: React.ReactNode }) {
        const { className, children } = props;
        const text = String(children ?? "");
        // Блочный fenced code с language-mermaid → рендерим диаграмму.
        if (className === "language-mermaid") {
          return <Mermaid chart={text} />;
        }
        return <code className={className}>{children}</code>;
      },
    }),
    [],
  );

  return (
    <div className="summary-view">
      {/* Статус ключа */}
      {apiKeyAvailable === false && (
        <div className="key-status key-status-missing">
          <strong>Ключ API не найден.</strong> Установите переменную окружения{" "}
          <code>OPENAI_API_KEY</code> (на Windows:{" "}
          <code>setx OPENAI_API_KEY &quot;sk-…&quot;</code>) и{" "}
          <strong>перезапустите приложение</strong>, чтобы процесс подхватил
          новый env-блок.
        </div>
      )}
      {apiKeyAvailable === true && (
        <div className="key-status key-status-ok">
          Ключ <code>OPENAI_API_KEY</code> обнаружен в окружении.
        </div>
      )}
      {apiKeyAvailable === null && (
        <div className="key-status">Проверка наличия ключа…</div>
      )}

      {/* Подсказка: настройки LLM живут в settings.yaml */}
      {!yamlAvailable && (
        <div className="key-status key-status-missing">
          <strong>Не открыта папка словарей.</strong> Настройки LLM хранятся в{" "}
          <code>settings.yaml</code> (раздел <code>settings.llm</code>).
          Откройте папку словарей в режиме «Словари», чтобы редактировать
          настройки и запускать саммари.
        </div>
      )}

      {/* Настройки LLM (скрыты по умолчанию) */}
      <details className="summary-settings">
        <summary>Настройки LLM</summary>
        <div className="summary-settings-grid">
          <label>
            <span>Base URL</span>
            <input
              type="text"
              value={settings.baseUrl}
              placeholder="https://api.openai.com/v1"
              onChange={(e) => setSettings({ baseUrl: e.target.value })}
            />
          </label>
          <label>
            <span>Model</span>
            <input
              type="text"
              value={settings.model}
              placeholder="gpt-4o-mini"
              onChange={(e) => setSettings({ model: e.target.value })}
            />
          </label>
          <label>
            <span>Temperature</span>
            <input
              type="number"
              step="0.1"
              min="0"
              max="2"
              value={settings.temperature}
              onChange={(e) =>
                setSettings({ temperature: Number(e.target.value) })
              }
            />
          </label>
          <label>
            <span>Max tokens</span>
            <input
              type="number"
              step="1"
              min="1"
              value={settings.maxTokens}
              onChange={(e) =>
                setSettings({ maxTokens: Number(e.target.value) })
              }
            />
          </label>
          {/* Файл системного промпта (.md). Тело промпта НЕ редактируется в UI —
              только через выбор файла. Содержимое читается перед каждым запуском. */}
          <div className="summary-settings-full summary-prompt-row">
            <span className="summary-prompt-label">
              Файл промпта (.md){" "}
              <em>— отправляется целиком (с frontmatter)</em>
            </span>
            <div className="summary-prompt-controls">
              <button
                type="button"
                className="btn"
                onClick={handlePickPromptFile}
                disabled={!yamlAvailable}
                title={
                  !yamlAvailable
                    ? "Откройте папку словарей (settings.yaml)"
                    : "Выбрать .md-файл промпта"
                }
              >
                Открыть .md…
              </button>
              {hasPrompt ? (
                <>
                  <span
                    className="summary-prompt-name"
                    title={settings.systemPromptPath}
                  >
                    {promptFileName}
                  </span>
                  <button
                    type="button"
                    className="btn-mini"
                    onClick={() => setSettings({ systemPromptPath: "" })}
                    title="Очистить путь к файлу промпта"
                  >
                    ✕
                  </button>
                </>
              ) : (
                <span className="summary-prompt-empty">не выбран</span>
              )}
            </div>
          </div>
          <label className="summary-settings-full">
            <span>
              User prompt template{" "}
              <em>(плейсхолдер {"{transcript}"} заменяется текстом)</em>
            </span>
            <textarea
              rows={4}
              value={settings.userPromptTemplate}
              placeholder="Сделай саммари: {transcript}"
              onChange={(e) =>
                setSettings({ userPromptTemplate: e.target.value })
              }
            />
          </label>
        </div>
      </details>

      {/* Кнопки запуска */}
      <div className="summary-actions">
        <button
          className="btn"
          onClick={() => runSummary("raw")}
          disabled={!canRunRaw}
          title={
            !transcript
              ? "Сначала откройте транскрипт"
              : !yamlAvailable
                ? "Откройте папку словарей (settings.yaml)"
                : !hasPrompt
                  ? "Сначала выберите файл промпта (.md)"
                  : keyMissing
                    ? "Нет API-ключа"
                    : streaming
                      ? "Идёт стриминг…"
                      : "Саммари исходного транскрипта"
          }
        >
          {streaming === "raw" ? "Стримится…" : "Саммари (raw)"}
        </button>
        <button
          className="btn"
          onClick={() => runSummary("cleaned")}
          disabled={!canRunCleaned}
          title={
            !transcript
              ? "Сначала откройте транскрипт"
              : !cleanResult
                ? "Сначала «Очистить»"
                : !yamlAvailable
                  ? "Откройте папку словарей (settings.yaml)"
                  : !hasPrompt
                    ? "Сначала выберите файл промпта (.md)"
                    : keyMissing
                      ? "Нет API-ключа"
                      : streaming
                        ? "Идёт стриминг…"
                        : "Саммари очищенного транскрипта"
          }
        >
          {streaming === "cleaned" ? "Стримится…" : "Саммари (cleaned)"}
        </button>
        <button
          className="btn"
          onClick={() => runSummary("collapsed")}
          disabled={!canRunCollapsed}
          title={
            !transcript
              ? "Сначала откройте транскрипт"
              : !cleanResult
                ? "Сначала «Очистить»"
                : !yamlAvailable
                  ? "Откройте папку словарей (settings.yaml)"
                  : !hasPrompt
                    ? "Сначала выберите файл промпта (.md)"
                    : keyMissing
                      ? "Нет API-ключа"
                      : streaming
                        ? "Идёт стриминг…"
                        : "Саммари свёрнутого транскрипта (без избыточных таймштампов)"
          }
        >
          {streaming === "collapsed" ? "Стримится…" : "Саммари (collapsed)"}
        </button>
        {!transcript && (
          <span className="summary-hint">Откройте транскрипт в режиме «Транскрипт».</span>
        )}
        {transcript && !hasPrompt && (
          <span className="summary-hint">
            Выберите файл системного промпта (.md) в настройках LLM.
          </span>
        )}
      </div>

      {error && <div className="summary-error">{error}</div>}

      {/* Результат */}
      {(has.raw || has.cleaned || has.collapsed || streaming !== null) && (
        <div className="summary-result">
          {/* Верхний ряд: Raw | Cleaned | Collapsed | Diff */}
          <div className="summary-tabs">
            <button
              className={sourceTab === "raw" ? "tab active" : "tab"}
              onClick={() => setSourceTab("raw")}
              disabled={!has.raw && streaming !== "raw"}
            >
              Raw{streaming === "raw" ? " ⏳" : ""}
            </button>
            <button
              className={sourceTab === "cleaned" ? "tab active" : "tab"}
              onClick={() => setSourceTab("cleaned")}
              disabled={!has.cleaned && streaming !== "cleaned"}
            >
              Cleaned{streaming === "cleaned" ? " ⏳" : ""}
            </button>
            <button
              className={sourceTab === "collapsed" ? "tab active" : "tab"}
              onClick={() => setSourceTab("collapsed")}
              disabled={!has.collapsed && streaming !== "collapsed"}
            >
              Collapsed{streaming === "collapsed" ? " ⏳" : ""}
            </button>
            <button
              className={sourceTab === "diff" ? "tab active" : "tab"}
              onClick={() => setSourceTab("diff")}
              disabled={!canDiff}
              title={!canDiff ? "Нужно ≥2 готовых результата" : ""}
            >
              Diff
            </button>
          </div>

          {/* Под-вкладки: Поток | Результат — только для источников (не diff) */}
          {sourceTab !== "diff" && (
            <div className="summary-subtabs">
              <button
                className={viewMode === "stream" ? "tab active" : "tab"}
                onClick={() => setViewMode("stream")}
              >
                Поток
              </button>
              <button
                className={viewMode === "result" ? "tab active" : "tab"}
                onClick={() => setViewMode("result")}
                disabled={!activeSourceHas}
                title={!activeSourceHas ? "Результат ещё не готов" : ""}
              >
                Результат
              </button>
            </div>
          )}

          {sourceTab === "diff" ? (
            <div className="summary-diff">
              {/* Переключатель пары Diff: 3 варианта (raw↔cleaned, raw↔collapsed,
                  cleaned↔collapsed). Кнопка disabled, если один из результатов
                  пары пуст. Текущая пара подсвечена. */}
              <DiffPairSelector
                has={has}
                pair={diffPair}
                onChange={setDiffPair}
              />
              <DiffEditor
                original={cleanedSources[diffPair[0]]}
                modified={cleanedSources[diffPair[1]]}
                theme={themeMode === "dark" ? "vs-dark" : "light"}
                language="markdown"
                options={{ readOnly: true, renderSideBySide: true }}
              />
            </div>
          ) : viewMode === "stream" ? (
            // Поток — сырой текст из LLM в моноширинном <pre>, без рендера.
            // Видно, как стрим заполняется по мере прихода чанков.
            <pre className="summary-stream">
              {activeSourceText || (streaming === activeSource ? "" : "(пусто)")}
              {streaming === activeSource && <span className="summary-stream-cursor" />}
            </pre>
          ) : (
            // Результат — отрендеренный Markdown (GFM + Mermaid) + кнопка сохранения.
            <div className="summary-result-pane">
              <div className="summary-result-header">
                <span className="summary-result-title">
                  Саммари ({activeSource})
                </span>
                <button
                  className="btn"
                  onClick={handleSaveMarkdown}
                  disabled={!activeSourceHas}
                  title={activeSourceHas ? "Сохранить .md через диалог" : "Нечего сохранять"}
                >
                  Сохранить .md
                </button>
                {saveStatus && <span className="summary-save-status">{saveStatus}</span>}
              </div>
              <div className="summary-markdown">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeRaw]}
                  components={markdownComponents}
                >
                  {activeSourceCleaned}
                </ReactMarkdown>
              </div>
            </div>
          )}
        </div>
      )}

      {!has.raw && !has.cleaned && !has.collapsed && streaming === null && (
        <div className="summary-empty">
          Нажмите «Саммари (raw)», «Саммари (cleaned)» или «Саммари (collapsed)»,
          чтобы сгенерировать саммари. Результат появится здесь и будет рендериться live.
        </div>
      )}
    </div>
  );
}

// Переключатель пары для Diff-вкладки. Три варианта пар источников; кнопка пары
// disabled, если один из результатов пары пуст. Текущая пара подсвечена (active).
const DIFF_PAIRS: [Source, Source][] = [
  ["raw", "cleaned"],
  ["raw", "collapsed"],
  ["cleaned", "collapsed"],
];

function DiffPairSelector({
  has,
  pair,
  onChange,
}: {
  has: Record<Source, boolean>;
  pair: [Source, Source];
  onChange: (p: [Source, Source]) => void;
}) {
  return (
    <div className="diff-pair-selector">
      {DIFF_PAIRS.map((p) => {
        const available = has[p[0]] && has[p[1]];
        const isActive = p[0] === pair[0] && p[1] === pair[1];
        return (
          <button
            key={`${p[0]}-${p[1]}`}
            className={`btn-mini${isActive ? " active" : ""}`}
            disabled={!available}
            title={!available ? "Один из результатов пары ещё не готов" : ""}
            onClick={() => onChange(p)}
          >
            {p[0]} ↔ {p[1]}
          </button>
        );
      })}
    </div>
  );
}
