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
import {
  streamChatCompletion,
  getEffectiveApiKey,
  isCryptoToken,
  parseCryptoToken,
  encryptText,
} from "../lib/llm";
import { stripReasoning } from "../lib/reasoning";
import { writeFile } from "../lib/fs";
import { collapseTimemarks } from "../engine/collapse";
import { Mermaid } from "./Mermaid";

// Режим «Саммари»: выбор модели, настройки LLM, статус ключа, две кнопки запуска
// (raw/cleaned/collapsed), live-рендер Markdown и Monaco Diff.
//
// Вкладки результата — двухуровневые:
//   верхний уровень: Raw | Cleaned | Diff (что показываем)
//   под-вкладки (только для Raw/Cleaned): Поток (сырой текст) | Результат (рендер)
//
// ВАЖНО: результаты саммари живут в store/summary.ts, а не в локальном useState.

export function SummaryView() {
  // store-подписки: выбираем только плоские поля (LESSONS_LEARNED.md §3).
  const models = useLlm((s) => s.models);
  const selectedModel = useLlm((s) => s.selectedModel);
  const setSelectedModel = useLlm((s) => s.setSelectedModel);
  const setModelSettings = useLlm((s) => s.setModelSettings);
  const addModel = useLlm((s) => s.addModel);
  const removeModel = useLlm((s) => s.removeModel);
  const renameModel = useLlm((s) => s.renameModel);
  const yamlAvailable = useLlm((s) => s.yamlAvailable);
  const apiKeyAvailable = useLlm((s) => s.apiKeyAvailable);
  const refreshApiKey = useLlm((s) => s.refreshApiKey);

  const settings = models[selectedModel] ?? null;

  const transcript = useTranscript((s) => s.transcript);
  const cleanResult = useTranscript((s) => s.cleanResult);

  const themeMode = useTheme((s) => s.mode);

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
  const [diffPair, setDiffPair] = useState<[Source, Source]>(["raw", "cleaned"]);

  const diffOfferedRef = useRef(false);

  useEffect(() => {
    refreshApiKey();
  }, [refreshApiKey, selectedModel]);

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
  const readyCount = (has.raw ? 1 : 0) + (has.cleaned ? 1 : 0) + (has.collapsed ? 1 : 0);
  const canDiff = readyCount >= 2;

  useEffect(() => {
    if (canDiff && streaming === null && !diffOfferedRef.current) {
      diffOfferedRef.current = true;
      setSourceTab("diff");
      return;
    }
    if (sourceTab === "diff" && (!canDiff || streaming !== null)) {
      const fallback: Source = has.raw ? "raw" : has.cleaned ? "cleaned" : "collapsed";
      setSourceTab(fallback);
    }
  }, [canDiff, streaming, sourceTab, has.raw, has.cleaned, has.collapsed, setSourceTab]);

  const keyMissing = apiKeyAvailable === false;
  const hasPrompt = settings?.systemPromptPath.trim().length ?? 0 > 0;
  const canRunRaw =
    !!transcript && yamlAvailable && hasPrompt && !keyMissing && streaming === null;
  const canRunCleaned =
    !!transcript && !!cleanResult && yamlAvailable && hasPrompt && !keyMissing && streaming === null;
  const canRunCollapsed = canRunCleaned;

  const isExternal = settings?.external ?? true;
  const baseUrlCrypto = useMemo(
    () => parseCryptoToken(settings?.baseUrl ?? ""),
    [settings?.baseUrl],
  );
  const apiKeyCrypto = useMemo(
    () => parseCryptoToken(settings?.apiKey ?? ""),
    [settings?.apiKey],
  );

  async function handlePickPromptFile() {
    try {
      const chosen = await pickFile({
        multiple: false,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (typeof chosen !== "string" || !settings) return;
      setModelSettings(selectedModel, { systemPromptPath: chosen });
    } catch (e) {
      setError(`Ошибка выбора файла промпта: ${String(e)}`);
    }
  }

  const promptFileName = useMemo(() => {
    const p = settings?.systemPromptPath ?? "";
    if (!p) return "";
    const segs = p.split(/[\\/]/).filter(Boolean);
    return segs.length > 0 ? segs[segs.length - 1] : p;
  }, [settings?.systemPromptPath]);

  async function handleEncryptField(field: "baseUrl" | "apiKey", current: string) {
    if (!settings) return;
    const envVar = window.prompt(
      "Переменная окружения с Fernet-ключом:",
      "TRANSCRIPT_OPTIMIZER_KEY",
    );
    if (!envVar) return;
    const plaintext = window.prompt("Значение для шифрования:", current);
    if (plaintext === null) return;
    const encrypted = await encryptText(plaintext, envVar);
    if (encrypted) {
      setModelSettings(selectedModel, { [field]: encrypted });
      setError("");
    } else {
      setError(
        "Не удалось зашифровать. Проверьте, что env-переменная содержит валидный Fernet-ключ.",
      );
    }
  }

  async function runSummary(target: Source) {
    if (!transcript || !settings) return;
    if (target !== "raw" && !cleanResult) return;

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
    diffOfferedRef.current = false;
    setSourceTab(target);
    setViewMode("stream");

    const apiKey = await getEffectiveApiKey(settings);
    if (!apiKey) {
      setStreaming(null);
      setError(
        "API-ключ не задан: у модели нет api_key, а OPENAI_API_KEY не задан в окружении.",
      );
      return;
    }

    const result = await streamChatCompletion({
      settings,
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
      setSourceTab(target);
      setViewMode("result");
    }
  }

  const activeSource: Source =
    sourceTab === "cleaned" || sourceTab === "collapsed" ? sourceTab : "raw";
  const activeSourceText = summaries[activeSource];
  const activeSourceHas = has[activeSource];

  const cleanedRaw = useMemo(() => stripReasoning(summaryRaw), [summaryRaw]);
  const cleanedCleaned = useMemo(() => stripReasoning(summaryCleaned), [summaryCleaned]);
  const cleanedCollapsed = useMemo(() => stripReasoning(summaryCollapsed), [summaryCollapsed]);
  const cleanedSources: Record<Source, string> = {
    raw: cleanedRaw,
    cleaned: cleanedCleaned,
    collapsed: cleanedCollapsed,
  };
  const activeSourceCleaned = cleanedSources[activeSource];

  async function handleSaveMarkdown() {
    const text = activeSourceCleaned;
    if (!text) return;
    try {
      const path = await save({
        defaultPath: `summary-${sourceTab}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!path) return;
      await writeFile(path, text);
      setError("");
      setSaveStatus(`Сохранено: ${path}`);
    } catch (e) {
      setSaveStatus("");
      setError(`Ошибка сохранения: ${String(e)}`);
    }
  }

  const markdownComponents = useMemo(
    () => ({
      code(props: { className?: string; children?: React.ReactNode }) {
        const { className, children } = props;
        const text = String(children ?? "");
        if (className === "language-mermaid") {
          return <Mermaid chart={text} />;
        }
        return <code className={className}>{children}</code>;
      },
    }),
    [],
  );

  if (!settings) {
    return (
      <div className="summary-view">
        <div className="key-status key-status-missing">
          Не выбрана модель. Добавьте модель в настройках LLM.
        </div>
      </div>
    );
  }

  return (
    <div className="summary-view">
      {/* Статус ключа */}
      {apiKeyAvailable === false && (
        <div className="key-status key-status-missing">
          <strong>Ключ API не найден.</strong> Укажите <code>api_key</code> у модели «
          {selectedModel}» или установите переменную окружения{" "}
          <code>OPENAI_API_KEY</code>.
        </div>
      )}
      {apiKeyAvailable === true && (
        <div className="key-status key-status-ok">
          Ключ API для модели «{selectedModel}» обнаружен.
        </div>
      )}
      {apiKeyAvailable === null && (
        <div className="key-status">Проверка наличия ключа…</div>
      )}

      {!yamlAvailable && (
        <div className="key-status key-status-missing">
          <strong>Не открыта папка словарей.</strong> Настройки LLM хранятся в{" "}
          <code>settings.yaml</code>. Откройте папку словарей в режиме «Словари», чтобы
          редактировать настройки и запускать саммари.
        </div>
      )}

      {/* Предупреждение о внешней модели */}
      {isExternal && (
        <div className="security-warning">
          <strong>⚠️ Внешняя модель «{selectedModel}».</strong> Текст транскрипта будет
          отправлен на сторонний сервер. Перед запуском проверьте транскрипт на наличие
          персональных данных, паролей, токенов и коммерческой тайны.
        </div>
      )}

      {/* Селектор модели */}
      <div className="model-selector">
        <label>
          <span>Модель</span>
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            disabled={!yamlAvailable}
          >
            {Object.keys(models).map((name) => {
              const m = models[name];
              const hasCrypto = isCryptoToken(m.baseUrl) || isCryptoToken(m.apiKey);
              return (
                <option key={name} value={name}>
                  {name}
                  {m.external ? " • external" : " • internal"}
                  {hasCrypto ? " • 🔒" : ""}
                </option>
              );
            })}
          </select>
        </label>
        <div className="model-actions">
          <button
            type="button"
            className="btn-mini"
            disabled={!yamlAvailable}
            onClick={() => {
              const name = window.prompt("Имя новой модели:");
              if (name) addModel(name);
            }}
            title="Добавить модель"
          >
            + Добавить
          </button>
          <button
            type="button"
            className="btn-mini"
            disabled={!yamlAvailable || Object.keys(models).length <= 1}
            onClick={() => removeModel(selectedModel)}
            title="Удалить выбранную модель"
          >
            Удалить
          </button>
          <button
            type="button"
            className="btn-mini"
            disabled={!yamlAvailable}
            onClick={() => {
              const newName = window.prompt("Новое имя модели:", selectedModel);
              if (newName && newName !== selectedModel) {
                renameModel(selectedModel, newName);
              }
            }}
            title="Переименовать модель"
          >
            Переименовать
          </button>
        </div>
      </div>

      {/* Настройки LLM (скрыты по умолчанию) */}
      <details className="summary-settings">
        <summary>Настройки LLM ({selectedModel})</summary>
        <div className="summary-settings-grid">
          <div className="summary-settings-full">
            <label>
              <span>Base URL</span>
              <div className="crypto-input-row">
                <input
                  type="text"
                  value={
                    baseUrlCrypto
                      ? `🔒 зашифровано (env: ${baseUrlCrypto.env})`
                      : settings.baseUrl
                  }
                  placeholder="https://api.openai.com/v1"
                  readOnly={!!baseUrlCrypto}
                  onChange={(e) =>
                    !baseUrlCrypto && setModelSettings(selectedModel, { baseUrl: e.target.value })
                  }
                />
                <button
                  type="button"
                  className="btn-mini"
                  onClick={() =>
                    handleEncryptField(
                      "baseUrl",
                      baseUrlCrypto ? "" : settings.baseUrl,
                    )
                  }
                  title={baseUrlCrypto ? "Изменить зашифрованный base_url" : "Зашифровать base_url"}
                >
                  {baseUrlCrypto ? "Изменить 🔒" : "Зашифровать 🔒"}
                </button>
              </div>
            </label>
          </div>
          <label>
            <span>Model</span>
            <input
              type="text"
              value={settings.model}
              placeholder="gpt-4o-mini"
              onChange={(e) => setModelSettings(selectedModel, { model: e.target.value })}
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
                setModelSettings(selectedModel, { temperature: Number(e.target.value) })
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
                setModelSettings(selectedModel, { maxTokens: Number(e.target.value) })
              }
            />
          </label>
          <div className="summary-settings-full">
            <label>
              <span>API key</span>
              <div className="crypto-input-row">
                <input
                  type="text"
                  value={
                    apiKeyCrypto
                      ? `🔒 зашифровано (env: ${apiKeyCrypto.env})`
                      : settings.apiKey
                  }
                  placeholder="sk-... или crypto__ENV__..."
                  readOnly={!!apiKeyCrypto}
                  onChange={(e) =>
                    !apiKeyCrypto && setModelSettings(selectedModel, { apiKey: e.target.value })
                  }
                />
                <button
                  type="button"
                  className="btn-mini"
                  onClick={() =>
                    handleEncryptField("apiKey", apiKeyCrypto ? "" : settings.apiKey)
                  }
                  title={apiKeyCrypto ? "Изменить зашифрованный api_key" : "Зашифровать api_key"}
                >
                  {apiKeyCrypto ? "Изменить 🔒" : "Зашифровать 🔒"}
                </button>
              </div>
              <em>
                Если пусто — используется <code>OPENAI_API_KEY</code> из окружения.
              </em>
            </label>
          </div>
          <label className="summary-settings-full">
            <span>
              <input
                type="checkbox"
                checked={settings.external}
                onChange={(e) =>
                  setModelSettings(selectedModel, { external: e.target.checked })
                }
              />{" "}
              Внешняя модель (данные уходят за пределы локальной машины)
            </span>
          </label>
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
                  <span className="summary-prompt-name" title={settings.systemPromptPath}>
                    {promptFileName}
                  </span>
                  <button
                    type="button"
                    className="btn-mini"
                    onClick={() => setModelSettings(selectedModel, { systemPromptPath: "" })}
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
                setModelSettings(selectedModel, { userPromptTemplate: e.target.value })
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
                      : `Саммари исходного транскрипта (${selectedModel})`
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
                        : `Саммари очищенного транскрипта (${selectedModel})`
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
                        : `Саммари свёрнутого транскрипта (${selectedModel})`
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
              <DiffPairSelector has={has} pair={diffPair} onChange={setDiffPair} />
              <DiffEditor
                original={cleanedSources[diffPair[0]]}
                modified={cleanedSources[diffPair[1]]}
                theme={themeMode === "dark" ? "vs-dark" : "light"}
                language="markdown"
                options={{ readOnly: true, renderSideBySide: true }}
              />
            </div>
          ) : viewMode === "stream" ? (
            <pre className="summary-stream">
              {activeSourceText || (streaming === activeSource ? "" : "(пусто)")}
              {streaming === activeSource && <span className="summary-stream-cursor" />}
            </pre>
          ) : (
            <div className="summary-result-pane">
              <div className="summary-result-header">
                <span className="summary-result-title">
                  Саммари ({activeSource}, {selectedModel})
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
          Нажмите «Саммари (raw)», «Саммари (cleaned)» или «Саммари (collapsed)», чтобы
          сгенерировать саммари. Результат появится здесь и будет рендериться live.
        </div>
      )}
    </div>
  );
}

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
