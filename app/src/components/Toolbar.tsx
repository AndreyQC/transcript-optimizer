import { useState } from "react";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import { useDictionaries } from "../store/dictionaries";
import { useTranscript } from "../store/transcript";
import { detectDictionaries, pickDir, writeFile as writeFileFn, joinPath, readFile as readFileFn } from "../lib/fs";
import { exportGlossaryMarkdown } from "../lib/glossary-export";
import { applyRules } from "../engine/rules";
import type { ReplacementsFile, GlossaryFile, Settings, FillerFile, WhitelistFile } from "../types/dictionaries";

type Mode = "dictionaries" | "transcript";

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

  // Словарные данные для applyRules.
  const settings = useDictionaries((s) => (s.entries.find((e) => e.kind === "settings")?.data as Settings | null) ?? null);
  const filler = useDictionaries((s) => (s.entries.find((e) => e.kind === "filler")?.data as FillerFile | null) ?? null);
  const whitelist = useDictionaries((s) => (s.entries.find((e) => e.kind === "whitelist")?.data as WhitelistFile | null) ?? null);

  const [status, setStatus] = useState<string>("");

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

  const canSave = !!activeEntry?.dirty;
  const canExport = !!dir && (!!replacements || !!glossary);
  const canClean = !!transcript;

  if (mode === "transcript") {
    return (
      <header className="toolbar">
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
