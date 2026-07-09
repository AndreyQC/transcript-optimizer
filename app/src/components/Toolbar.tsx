import { useState } from "react";
import { useDictionaries } from "../store/dictionaries";
import { detectDictionaries, pickDir, writeFile as writeFileFn } from "../lib/fs";

// Тулбар: открыть папку словарей, сохранить активный файл, статус.
export function Toolbar() {
  const openDir = useDictionaries((s) => s.openDir);
  const activeKind = useDictionaries((s) => s.activeKind);
  const activeEntry = useDictionaries((s) =>
    s.entries.find((e) => e.kind === activeKind),
  );
  const markSaved = useDictionaries((s) => s.markSaved);

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

  const canSave = !!activeEntry?.dirty;

  return (
    <header className="toolbar">
      <button onClick={handleOpen} className="btn">
        Открыть папку словарей
      </button>
      <button onClick={handleSave} className="btn" disabled={!canSave}>
        Сохранить{activeEntry ? ` (${activeEntry.kind})` : ""}
      </button>
      <span className="status">{status}</span>
    </header>
  );
}
