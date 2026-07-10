import { useState } from "react";
import { useDictionaries } from "../store/dictionaries";
import { detectDictionaries, pickDir, writeFile as writeFileFn, joinPath } from "../lib/fs";
import { exportGlossaryMarkdown } from "../lib/glossary-export";
import type { ReplacementsFile, GlossaryFile } from "../types/dictionaries";

// Тулбар: открыть папку словарей, сохранить активный файл, статус.
export function Toolbar() {
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

  const canSave = !!activeEntry?.dirty;
  const canExport = !!dir && (!!replacements || !!glossary);

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
