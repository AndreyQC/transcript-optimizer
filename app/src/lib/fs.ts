import { readTextFile, writeTextFile, readDir } from "@tauri-apps/plugin-fs";
import { open } from "@tauri-apps/plugin-dialog";
import { parse } from "yaml";
import { FILE_CONTRACT, type DictEntry, type DictKind } from "../types/dictionaries";

export interface OpenDirResult {
  entries: DictEntry[];
  unknownPaths: string[];
}

// Диалог выбора директории. Возвращает абсолютный путь или null (отмена).
export async function pickDir(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}

// Прочитать текстовый файл как строку.
export async function readFile(path: string): Promise<string> {
  return readTextFile(path);
}

// Записать текст в файл.
export async function writeFile(path: string, contents: string): Promise<void> {
  await writeTextFile(path, contents);
}

// Присоединить имя файла к директории с учётом разделителей платформы.
function joinPath(dir: string, name: string): string {
  // Tauri/Windows принимает и / и \; унифицируем на /.
  const sep = dir.includes("/") && !dir.includes("\\") ? "/" : "\\";
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

// Найти в директории все .yaml/.yml файлы (по контракту имён + неизвестные).
// Возвращает записи распознанных словарей и список нераспознанных путей.
export async function detectDictionaries(dir: string): Promise<OpenDirResult> {
  // readDir из plugin-fs; рекурсивно не идём — словари лежат в корне папки.
  const dirEntries = await readDir(dir);

  const entries: DictEntry[] = [];
  const unknownPaths: string[] = [];

  for (const entry of dirEntries) {
    if (entry.isDirectory || !/\.(ya?ml)$/i.test(entry.name)) continue;
    const kind: DictKind | undefined = FILE_CONTRACT[entry.name];
    const path = joinPath(dir, entry.name);
    const raw = await readTextFile(path);
    let data: unknown = null;
    try {
      data = parse(raw);
    } catch {
      // Невалидный YAML — всё равно показываем как raw; валидация подсветит ошибки.
      data = null;
    }
    if (kind) {
      entries.push({ kind, path, raw, data, dirty: false });
    } else {
      unknownPaths.push(path);
    }
  }

  return { entries, unknownPaths };
}
