// Свёртка избыточных временных меток в очищенном транскрипте (план 20260714_003).
//
// Если один спикер говорит несколько фраз подряд, метки [time] остаются только на
// первой и последней реплике блока — в виде маркеров-«обрамлений»:
//   [t1]>
//   <текст первой реплики>
//   <текст второй реплики>
//   ...
//   <[tN]
// Применяется к cleanedText (плоский, результат applyRules) как чистая функция —
// НЕ мутирует CleanResult. Используется в просмотре (правая панель) и как третий
// источник саммари ("collapsed").
//
// Переиспользует RE_SPEAKER/RE_UTTERANCE из parser.ts (единый контракт формата).
import { RE_SPEAKER, RE_UTTERANCE } from "./parser";

// Построчный FSM: шапка → заголовок спикера → группа реплик.
// При встрече нового заголовка или конце файла — закрываем текущий блок.
export function collapseTimemarks(text: string): string {
  if (!text) return "";
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");

  const out: string[] = [];
  // Аккумуляторы текущего блока реплик одного спикера.
  let blockTimes: string[] = [];
  let blockTexts: string[] = [];

  // Сбросить текущий блок в выходные строки в свёрнутом виде.
  const flushBlock = () => {
    if (blockTexts.length === 0) return;
    const first = blockTimes[0];
    const last = blockTimes[blockTimes.length - 1];
    out.push(`[${first}]>`);
    out.push(...blockTexts);
    out.push(`<[${last}]`);
    blockTimes = [];
    blockTexts = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") {
      flushBlock();
      out.push(line);
      continue;
    }

    // Заголовок спикера (не путать с utterance, содержащим двоеточие в тексте).
    // Условие как в parser.ts: это speaker, если матчит RE_SPEAKER и НЕ RE_UTTERANCE.
    const speakerMatch = trimmed.match(RE_SPEAKER);
    const utteranceMatch = line.match(RE_UTTERANCE);

    if (speakerMatch && !utteranceMatch) {
      flushBlock();
      out.push(line);
      continue;
    }

    if (utteranceMatch) {
      // Реплика: накапливаем time/text, не выводим сразу.
      blockTimes.push(utteranceMatch[1]);
      blockTexts.push(utteranceMatch[2]);
      continue;
    }

    // Прочее (шапка, мусор): закрываем блок, если он был, и пробрасываем строку.
    flushBlock();
    out.push(line);
  }
  flushBlock();

  let result = out.join("\n");

  // Пост-обработка артефактов склейки (план §«Дизайн функции», порядок важен):
  // 1. Повторы запятой (в т.ч. через пробелы: артефакты склейки фраз) → одна.
  //    `,\s*,` покрывает цепочки из 3+ запятых (заменит итеративно: движок JS
  //    regex без sticky/g с квантором обрабатывает непересекающиеся матчи, поэтому
  //    прогоняем в цикле, пока стабильно).
  // 2. Множественные пробелы/табы → один пробел. Переводы строк не трогаем.
  let prev: string;
  do {
    prev = result;
    result = result.replace(/,\s*,/g, ",");
  } while (result !== prev);
  result = result.replace(/[ \t]{2,}/g, " ");

  return result;
}
