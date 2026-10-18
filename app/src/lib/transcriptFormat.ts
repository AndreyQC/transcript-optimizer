// Конвертация блоков sidecar-пайплайна в родной формат транскриптов
// приложения («Имя спикера:» + строки «[HH:MM:SS] текст»). Парсер/engine
// не меняются — см. план Phase 10 §10.5.

export interface PipelineBlock {
  speaker: number;
  start: number;
  end: number;
  text: string;
}

export function fmtHms(secs: number): string {
  const total = Math.max(0, Math.floor(secs));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(s)}`;
}

export function blocksToTranscript(
  blocks: PipelineBlock[],
  header: string,
): string {
  const parts: string[] = [];
  if (header.trim()) parts.push(header.trim());
  for (const b of blocks) {
    parts.push("");
    parts.push(`Спикер ${b.speaker}:`);
    parts.push(`[${fmtHms(b.start)}] ${b.text.trim()}`);
  }
  return parts.join("\n") + "\n";
}
