import type { ParsedTranscript, SpeakerBlock, Utterance } from "./types";

// Строчный конечный автомат: header → speaker → utterance.
// Формат (idea.md §8.1, разведка образца):
//   HEADER_LINE
//   <пустые>
//   (SPEAKER_HEADER (TIMESTAMP_LINE)+ <пустая>)*
//   SPEAKER_HEADER (TIMESTAMP_LINE)+   ← последний блок, без trailing newline
//
// Якорь — lineNo (1-based), таймштамп НЕ ключ (дубли встречаются, вкл. cross-speaker).
// Speaker «(голос N)» отделяется от имени.

// Экспортируем — переиспользуются в engine/collapse.ts (единый источник формата).
export const RE_SPEAKER = /^(.+?)(?:\s*\(голос\s+(\d+)\))?\s*:\s*$/;
export const RE_UTTERANCE = /^\[(\d{2}:\d{2}:\d{2})\]\s+(.*)$/;

type State = "header" | "speaker" | "utterance";

// Распарсить плоский текст транскрипта. Нормализует \r\n → \n.
export function parseTranscript(raw: string): ParsedTranscript {
  const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text.split("\n");

  const blocks: SpeakerBlock[] = [];
  let headerLine: string | null = null;

  let state: State = "header";
  let currentBlock: SpeakerBlock | null = null;
  let currentSpeakerLineNo = 0;

  // header: накапливаем всё до первого спикера в одну строку (обычно 1 строка).
  const headerParts: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1; // 1-based
    const trimmed = line.trim();

    if (trimmed === "") {
      // Пустые строки разделяют блоки/секции; состояние не меняем,
      // но завершаем текущий utterance-блок неявно (следующий speaker/blank).
      continue;
    }

    const speakerMatch = trimmed.match(RE_SPEAKER);
    const utteranceMatch = line.match(RE_UTTERANCE);

    if (state === "header") {
      // В header-состоянии: ждём первого спикера. Всё до него — шапка.
      if (speakerMatch) {
        // Переход: первый спикер найден.
        headerLine = headerParts.length > 0 ? headerParts.join("\n").trim() : null;
        state = "speaker";
        // fall-through к обработке speaker ниже (не теряем строку)
      } else {
        headerParts.push(line);
        continue;
      }
    }

    if (speakerMatch && !utteranceMatch) {
      // Строка-спикер (не путать с utterance, содержащим двоеточие в тексте).
      const name = speakerMatch[1].trim();
      const voiceTag = speakerMatch[2] ? parseInt(speakerMatch[2], 10) : null;
      currentBlock = { speaker: name, voiceTag, utterances: [] };
      currentSpeakerLineNo = lineNo;
      blocks.push(currentBlock);
      state = "utterance";
      continue;
    }

    if (utteranceMatch) {
      // Реплика. Если currentBlock ещё null (спикера не было) — это мусор/шапка,
      // пропускаем (защита от битого ввода).
      if (!currentBlock) continue;
      const utt: Utterance = {
        time: utteranceMatch[1],
        text: utteranceMatch[2],
        lineNo,
        speakerLineNo: currentSpeakerLineNo,
      };
      currentBlock.utterances.push(utt);
      // остаёмся в utterance (несколько реплик подряд одного спикера)
      continue;
    }

    // Нестроковая строка внутри utterance-блока (нет timestamp, не спикер):
    // defensively считаем продолжением — игнорируем, чтобы не ломать парсинг.
    // (В образце таких нет, но защита от вариантов других файлов дешёвая.)
  }

  // Финализация: если header-состояние до конца (нет ни одного спикера) —
  // весь файл считается шапкой, blocks пустой.
  if (state === "header" && headerLine === null) {
    headerLine = headerParts.length > 0 ? headerParts.join("\n").trim() : null;
  }

  return { headerLine, blocks };
}
