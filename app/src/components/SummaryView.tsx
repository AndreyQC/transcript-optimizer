import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import { DiffEditor } from "@monaco-editor/react";
import { open as pickFile, save } from "@tauri-apps/plugin-dialog";
import { useLlm } from "../store/llm";
import { useTranscript } from "../store/transcript";
import { useTheme } from "../store/theme";
import { useSummary } from "../store/summary";
import { streamChatCompletion, type LlmSettings } from "../lib/llm";
import { stripReasoning } from "../lib/reasoning";
import { writeFile } from "../lib/fs";
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
  const streaming = useSummary((s) => s.streaming);
  const sourceTab = useSummary((s) => s.sourceTab);
  const viewMode = useSummary((s) => s.viewMode);
  const setSummaryRaw = useSummary((s) => s.setSummaryRaw);
  const setSummaryCleaned = useSummary((s) => s.setSummaryCleaned);
  const setStreaming = useSummary((s) => s.setStreaming);
  const setSourceTab = useSummary((s) => s.setSourceTab);
  const setViewMode = useSummary((s) => s.setViewMode);

  const [error, setError] = useState<string>("");
  const [saveStatus, setSaveStatus] = useState<string>("");

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

  const hasRaw = summaryRaw.length > 0;
  const hasCleaned = summaryCleaned.length > 0;
  // Diff доступен только когда оба результата непустые.
  const canDiff = hasRaw && hasCleaned;

  // Автопереключение на diff — ОДИН раз, когда оба результата впервые готовы и
  // стрим остановлен. Раньше эффект перетягивал на diff при каждом изменении
  // sourceTab, не давая пользователю удержать Raw/Cleaned (баг: перескакивало
  // на diff, кнопка «Сохранить .md» исчезала). Теперь флаг diffOffered гасит
  // повторные автопереключения; сбрасывается только в runSummary при новом стриме.
  useEffect(() => {
    if (canDiff && streaming === null && !diffOfferedRef.current) {
      diffOfferedRef.current = true;
      setSourceTab("diff");
      return;
    }
    // Если результат стёрли или стрим идёт — с diff уходим на активный источник.
    if (sourceTab === "diff" && (!canDiff || streaming !== null)) {
      setSourceTab(hasRaw ? "raw" : hasCleaned ? "cleaned" : "raw");
    }
  }, [canDiff, streaming, sourceTab, hasRaw, hasCleaned, setSourceTab]);

  const keyMissing = apiKeyAvailable === false;
  const hasPrompt = settings.systemPromptPath.trim().length > 0;
  const canRunRaw =
    !!transcript && yamlAvailable && hasPrompt && !keyMissing && streaming === null;
  const canRunCleaned =
    !!transcript && !!cleanResult && yamlAvailable && hasPrompt && !keyMissing && streaming === null;

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

  async function runSummary(target: "raw" | "cleaned") {
    if (!transcript) return;
    if (target === "cleaned" && !cleanResult) return;
    const text =
      target === "raw" ? transcript.raw : (cleanResult?.cleanedText ?? "");
    if (text.length === 0) {
      setError(
        target === "cleaned"
          ? "Нет очищенного текста — сначала «Очистить» в режиме Транскрипт."
          : "Пустой исходный транскрипт.",
      );
      return;
    }

    setError("");
    setStreaming(target);
    if (target === "raw") setSummaryRaw("");
    else setSummaryCleaned("");

    // Новый стрим — сбросить флаг «diff предложен», чтобы по завершении
    // автопереключение на diff сработало снова (если оба результата будут готовы).
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
        if (target === "raw") setSummaryRaw((prev) => prev + chunk);
        else setSummaryCleaned((prev) => prev + chunk);
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

  // Текст активного источника (raw или cleaned) — как есть, с <think>-рассуждениями.
  // Используется ТОЛЬКО во вкладке «Поток» (пользователь видит ход мыслей модели).
  const activeSourceText = sourceTab === "raw" ? summaryRaw : summaryCleaned;
  const activeSourceHas = sourceTab === "raw" ? hasRaw : hasCleaned;

  // Очищенные от рассуждений версии (без <think>/<reasoning>/<reflection>).
  // useMemo — чтобы не гонять stripReasoning на каждом рендере. Применяются в
  // «Результат», Diff и при сохранении .md. «Поток» показывает исходный текст.
  const cleanedRaw = useMemo(() => stripReasoning(summaryRaw), [summaryRaw]);
  const cleanedCleaned = useMemo(
    () => stripReasoning(summaryCleaned),
    [summaryCleaned],
  );
  // Очищенный текст активного источника — для Результата/сохранения.
  const activeSourceCleaned =
    sourceTab === "raw" ? cleanedRaw : cleanedCleaned;

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
      {(hasRaw || hasCleaned || streaming !== null) && (
        <div className="summary-result">
          {/* Верхний ряд: Raw | Cleaned | Diff */}
          <div className="summary-tabs">
            <button
              className={sourceTab === "raw" ? "tab active" : "tab"}
              onClick={() => setSourceTab("raw")}
              disabled={!hasRaw && streaming !== "raw"}
            >
              Raw{streaming === "raw" ? " ⏳" : ""}
            </button>
            <button
              className={sourceTab === "cleaned" ? "tab active" : "tab"}
              onClick={() => setSourceTab("cleaned")}
              disabled={!hasCleaned && streaming !== "cleaned"}
            >
              Cleaned{streaming === "cleaned" ? " ⏳" : ""}
            </button>
            <button
              className={sourceTab === "diff" ? "tab active" : "tab"}
              onClick={() => setSourceTab("diff")}
              disabled={!canDiff}
              title={!canDiff ? "Нужны оба результата" : ""}
            >
              Diff
            </button>
          </div>

          {/* Под-вкладки: Поток | Результат — только для raw/cleaned (не diff) */}
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
              <DiffEditor
                original={cleanedRaw}
                modified={cleanedCleaned}
                theme={themeMode === "dark" ? "vs-dark" : "light"}
                language="markdown"
                options={{ readOnly: true, renderSideBySide: true }}
              />
            </div>
          ) : viewMode === "stream" ? (
            // Поток — сырой текст из LLM в моноширинном <pre>, без рендера.
            // Видно, как стрим заполняется по мере прихода чанков.
            <pre className="summary-stream">
              {activeSourceText || (streaming === sourceTab ? "" : "(пусто)")}
              {streaming === sourceTab && <span className="summary-stream-cursor" />}
            </pre>
          ) : (
            // Результат — отрендеренный Markdown (GFM + Mermaid) + кнопка сохранения.
            <div className="summary-result-pane">
              <div className="summary-result-header">
                <span className="summary-result-title">
                  {sourceTab === "raw" ? "Саммари (raw)" : "Саммари (cleaned)"}
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

      {!hasRaw && !hasCleaned && streaming === null && (
        <div className="summary-empty">
          Нажмите «Саммари (raw)» или «Саммари (cleaned)», чтобы сгенерировать
          саммари. Результат появится здесь и будет рендериться live.
        </div>
      )}
    </div>
  );
}
