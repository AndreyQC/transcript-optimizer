import { useState } from "react";
import { open as pickFile, save } from "@tauri-apps/plugin-dialog";
import { useDictionaries } from "../store/dictionaries";
import { useTranscript } from "../store/transcript";
import { useMarkdown } from "../store/markdown";
import { useTheme } from "../store/theme";
import { detectDictionaries, pickDir, writeFile as writeFileFn, joinPath, readFile as readFileFn } from "../lib/fs";
import { exportGlossaryMarkdown } from "../lib/glossary-export";
import { applyRules } from "../engine/rules";
import type { ReplacementsFile, GlossaryFile, Settings, FillerFile, WhitelistFile } from "../types/dictionaries";

type Mode = "dictionaries" | "transcript" | "summary" | "markdown";

// Тулбар. В режиме «Словари»: открыть папку/сохранить/экспорт глоссария.
// В режиме «Транскрипт»: открыть транскрипт / применить правила (Очистить).
export function Toolbar({ mode }: { mode: Mode }) {
  const dir = useDictionaries((s) => s.dir);
  const openDir = useDictionaries((s) => s.openDir);
  const activeKind = useDictionaries((s) => s.activeKind);
  const activeEntry = useDictionaries((s) =>
    s.entries.find((e) => e.kind === activeKind),
  );
  const markSaved = useDictionaries((s) => s.markSaved);
  const replacements = useDictionaries((s) =>
    (s.entries.find((e) => e.kind === "replacements")?.data as ReplacementsFile | undefined) ?? null,
  );
  const glossary = useDictionaries((s) =>
    (s.entries.find((e) => e.kind === "glossary")?.data as GlossaryFile | undefined) ?? null,
  );

  // transcript-store для режима транскрипта.
  const transcript = useTranscript((s) => s.transcript);
  const openTranscript = useTranscript((s) => s.openTranscript);
  const closeTranscript = useTranscript((s) => s.closeTranscript);
  const setCleanResult = useTranscript((s) => s.setCleanResult);
  const cleanDirty = useTranscript((s) => s.cleanDirty);

  // markdown-store для режима markdown (открыть/сохранить .md).
  const mdDoc = useMarkdown((s) => s.doc);
  const openMarkdown = useMarkdown((s) => s.openMarkdown);
  const markMdSaved = useMarkdown((s) => s.markSaved);
  const setMdPath = useMarkdown((s) => s.setPath);
  const closeMarkdown = useMarkdown((s) => s.closeMarkdown);

  // Словарные данные для applyRules.
  const settings = useDictionaries((s) => (s.entries.find((e) => e.kind === "settings")?.data as Settings | null) ?? null);
  const filler = useDictionaries((s) => (s.entries.find((e) => e.kind === "filler")?.data as FillerFile | null) ?? null);
  const whitelist = useDictionaries((s) => (s.entries.find((e) => e.kind === "whitelist")?.data as WhitelistFile | null) ?? null);

  const [status, setStatus] = useState<string>("");

  // Тема — переключатель виден в обоих режимах.
  const themeMode = useTheme((s) => s.mode);
  const toggleTheme = useTheme((s) => s.toggle);

  async function handleOpen() {
    try {
      const chosen = await pickDir();
      if (!chosen) return;
      const { entries, unknownPaths } = await detectDictionaries(chosen);
      if (entries.length === 0) {
        setStatus(
          `В «${chosen}» не найдено файлов по контракту (settings/glossary/filler/replacements/lemma_irregular/detector_whitelist).`,
        );
        return;
      }
      openDir(chosen, entries, unknownPaths);
      const unkNote =
        unknownPaths.length > 0
          ? ` ; нераспознанных .yaml: ${unknownPaths.length}`
          : "";
      setStatus(
        `Открыто: ${chosen} ; словарей: ${entries.length}${unkNote}`,
      );
    } catch (e) {
      setStatus(`Ошибка открытия: ${String(e)}`);
    }
  }

  async function handleSave() {
    if (!activeEntry) return;
    try {
      await writeFileFn(activeEntry.path, activeEntry.raw);
      markSaved(activeEntry.kind, activeEntry.raw);
      setStatus(`Сохранено: ${activeEntry.path}`);
    } catch (e) {
      setStatus(`Ошибка сохранения: ${String(e)}`);
    }
  }

  async function handleExportGlossary() {
    if (!dir) return;
    try {
      const md = exportGlossaryMarkdown({ replacements, glossary });
      const path = joinPath(dir, "GLOSSARY.md");
      await writeFileFn(path, md);
      setStatus(`Глоссарий экспортирован: ${path}`);
    } catch (e) {
      setStatus(`Ошибка экспорта: ${String(e)}`);
    }
  }

  async function handleOpenTranscript() {
    try {
      const chosen = await pickFile({
        multiple: false,
        filters: [{ name: "Текст", extensions: ["txt"] }],
      });
      if (typeof chosen !== "string") return;
      const raw = await readFileFn(chosen);
      openTranscript(chosen, raw);
      setStatus(`Транскрипт открыт: ${chosen}`);
    } catch (e) {
      setStatus(`Ошибка открытия транскрипта: ${String(e)}`);
    }
  }

  function handleClean() {
    if (!transcript) return;
    try {
      const result = applyRules(transcript.parsed, { settings, filler, replacements, whitelist });
      setCleanResult(result);
      setStatus(
        `Очищено: замен ${result.stats.replaced}, удалено ${result.stats.removed}, подозрительных ${result.stats.suspect}`,
      );
    } catch (e) {
      setStatus(`Ошибка очистки: ${String(e)}`);
    }
  }

  // — Режим Markdown: открыть / создать / сохранить / закрыть .md —

  async function handleOpenMd() {
    try {
      const chosen = await pickFile({
        multiple: false,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (typeof chosen !== "string") return;
      const raw = await readFileFn(chosen);
      openMarkdown(chosen, raw);
      setStatus(`Открыт: ${chosen}`);
    } catch (e) {
      setStatus(`Ошибка открытия: ${String(e)}`);
    }
  }

  function handleNewMd() {
    openMarkdown("", "");
    setStatus("Новый документ. Сохраните через «Сохранить как…»");
  }

  // Если у документа нет path (новый) — редирект на диалог «как…».
  async function handleSaveMd() {
    if (!mdDoc) return;
    if (!mdDoc.path) return handleSaveAsMd();
    try {
      await writeFileFn(mdDoc.path, mdDoc.raw);
      markMdSaved();
      setStatus(`Сохранено: ${mdDoc.path}`);
    } catch (e) {
      setStatus(`Ошибка сохранения: ${String(e)}`);
    }
  }

  async function handleSaveAsMd() {
    if (!mdDoc) return;
    try {
      const path = await save({
        defaultPath: mdDoc.path || "untitled.md",
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!path) return; // отмена
      await writeFileFn(path, mdDoc.raw);
      setMdPath(path);
      markMdSaved();
      setStatus(`Сохранено: ${path}`);
    } catch (e) {
      setStatus(`Ошибка сохранения: ${String(e)}`);
    }
  }

  const canSave = !!activeEntry?.dirty;
  const canExport = !!dir && (!!replacements || !!glossary);
  const canClean = !!transcript;

  if (mode === "summary") {
    // Режим «Саммари» не использует словарные/транскрипт-кнопки тулбара:
    // настройки и кнопки запуска живут внутри SummaryView. Показываем только
    // переключатель темы и строку статуса.
    return (
      <header className="toolbar">
        <button
          onClick={toggleTheme}
          className="btn theme-toggle"
          title={themeMode === "dark" ? "Переключить на светлую тему" : "Переключить на тёмную тему"}
          aria-label="Переключить тему"
        >
          {themeMode === "dark" ? "☼" : "☾"}
        </button>
        <span className="status">{status}</span>
      </header>
    );
  }

  if (mode === "markdown") {
    // Режим «Markdown»: открыть/новый/сохранить/сохранить как…/закрыть .md.
    // Сами панели редактора живут в MarkdownView; тулбар — только файловые операции.
    return (
      <header className="toolbar">
        <button
          onClick={toggleTheme}
          className="btn theme-toggle"
          title={themeMode === "dark" ? "Переключить на светлую тему" : "Переключить на тёмную тему"}
          aria-label="Переключить тему"
        >
          {themeMode === "dark" ? "☼" : "☾"}
        </button>
        <button onClick={handleOpenMd} className="btn">
          Открыть .md
        </button>
        <button onClick={handleNewMd} className="btn">
          Новый
        </button>
        <button onClick={handleSaveMd} className="btn" disabled={!mdDoc || !mdDoc.dirty}>
          Сохранить{mdDoc && !mdDoc.path ? " как…" : ""}
        </button>
        <button onClick={handleSaveAsMd} className="btn" disabled={!mdDoc}>
          Сохранить как…
        </button>
        {mdDoc && (
          <button onClick={closeMarkdown} className="btn">
            Закрыть
          </button>
        )}
        {mdDoc?.dirty && <span className="badge-stale">● несохранённые изменения</span>}
        <span className="status">{status}</span>
      </header>
    );
  }

  if (mode === "transcript") {
    return (
      <header className="toolbar">
        <button
          onClick={toggleTheme}
          className="btn theme-toggle"
          title={themeMode === "dark" ? "Переключить на светлую тему" : "Переключить на тёмную тему"}
          aria-label="Переключить тему"
        >
          {themeMode === "dark" ? "☼" : "☾"}
        </button>
        <button onClick={handleOpenTranscript} className="btn">
          Открыть транскрипт
        </button>
        <button onClick={handleClean} className="btn" disabled={!canClean}>
          Очистить
        </button>
        {transcript && (
          <button onClick={closeTranscript} className="btn">
            Закрыть транскрипт
          </button>
        )}
        {cleanDirty && <span className="badge-stale">⚠ результат устарел</span>}
        <span className="status">{status}</span>
      </header>
    );
  }

  return (
    <header className="toolbar">
      <button
        onClick={toggleTheme}
        className="btn theme-toggle"
        title={themeMode === "dark" ? "Переключить на светлую тему" : "Переключить на тёмную тему"}
        aria-label="Переключить тему"
      >
        {themeMode === "dark" ? "☼" : "☾"}
      </button>
      <button onClick={handleOpen} className="btn">
        Открыть папку словарей
      </button>
      <button onClick={handleSave} className="btn" disabled={!canSave}>
        Сохранить{activeEntry ? ` (${activeEntry.kind})` : ""}
      </button>
      <button onClick={handleExportGlossary} className="btn" disabled={!canExport}>
        Экспорт GLOSSARY.md
      </button>
      <span className="status">{status}</span>
    </header>
  );
}
