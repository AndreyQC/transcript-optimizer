import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { blocksToTranscript, type PipelineBlock } from "../lib/transcriptFormat";
import { useTranscript } from "./transcript";
import { useUi } from "./ui";

// Состояние панели «Транскрибация»: форма + ход пайплайна. События приходят
// из Rust (`transcribe-event`) — проброс JSON-lines sidecar'а.

export type TranscribeEngine = "parakeet" | "gigaam";

interface StageEvent {
  event: "stage";
  stage: string;
  i: number;
  n: number;
  secs: number;
}

interface DoneEvent {
  event: "done";
  result: {
    blocks: PipelineBlock[];
    text: string;
    audio_secs: number;
    model: string;
    turns: unknown[];
    segments: unknown[];
    timings: Record<string, number>;
  };
}

interface ErrorEvent {
  event: "error";
  message: string;
}

type PipelineEvent = StageEvent | DoneEvent | ErrorEvent;

interface TranscribeStore {
  // форма
  inputPath: string;
  modelDir: string;
  engine: TranscribeEngine;
  limitSecs: number | null;
  maxSpeakers: number | null;
  // ход выполнения
  running: boolean;
  stage: string | null;
  stageProgress: { i: number; n: number } | null;
  error: string | null;
  summary: string | null;

  setInputPath: (v: string) => void;
  setModelDir: (v: string) => void;
  setEngine: (v: TranscribeEngine) => void;
  setLimitSecs: (v: number | null) => void;
  setMaxSpeakers: (v: number | null) => void;

  detectAivoModels: () => Promise<void>;
  start: () => Promise<void>;
  cancel: () => Promise<void>;
}

const STAGE_LABELS: Record<string, string> = {
  decode: "Декодирование аудио",
  asr: "Распознавание речи",
  diar: "Диаризация спикеров",
  merge: "Сшивка",
};

export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}

export const useTranscribe = create<TranscribeStore>((set, get) => ({
  inputPath: "",
  modelDir: "",
  engine: "parakeet",
  limitSecs: null,
  maxSpeakers: null,
  running: false,
  stage: null,
  stageProgress: null,
  error: null,
  summary: null,

  setInputPath: (v) => set({ inputPath: v }),
  setModelDir: (v) => set({ modelDir: v }),
  setEngine: (v) => set({ engine: v }),
  setLimitSecs: (v) => set({ limitSecs: v !== null && v > 0 ? v : null }),
  setMaxSpeakers: (v) => set({ maxSpeakers: v !== null && v > 0 ? v : null }),

  detectAivoModels: async () => {
    try {
      const dir = await invoke<string | null>("detect_aivo_model_dir");
      if (!dir) return;
      const sub =
        get().engine === "gigaam" ? "giga-am-v3-int8" : "parakeet-tdt-0.6b-v3-int8";
      set({ modelDir: `${dir}\\${sub}` });
    } catch (e) {
      console.warn("detect_aivo_model_dir failed:", e);
    }
  },

  start: async () => {
    const s = get();
    if (s.running) return;
    if (!s.inputPath || !s.modelDir) {
      set({ error: "Укажите видеофайл и каталог моделей" });
      return;
    }
    set({ running: true, stage: null, stageProgress: null, error: null, summary: null });

    let unlisten: UnlistenFn | undefined;
    try {
      unlisten = await listen<PipelineEvent>("transcribe-event", (ev) => {
        const payload = ev.payload;
        if (payload.event === "stage") {
          set({ stage: payload.stage, stageProgress: { i: payload.i, n: payload.n } });
        } else if (payload.event === "error") {
          set({ running: false, stage: null, stageProgress: null, error: payload.message });
          unlisten?.();
        } else if (payload.event === "done") {
          const r = payload.result;
          const raw = blocksToTranscript(
            r.blocks,
            `# Транскрипция: ${s.inputPath} (модель: ${r.model})`,
          );
          useTranscript.getState().openTranscript(`${s.inputPath}.transcript.txt`, raw);
          const t = r.timings ?? {};
          const total = Object.values(t).reduce((a, b) => a + b, 0);
          set({
            running: false,
            stage: null,
            stageProgress: null,
            summary:
              `Готово: ${r.blocks.length} блоков, ${r.audio_secs.toFixed(0)} с аудио, ` +
              `${total.toFixed(0)} с обработки. Транскрипт открыт во вкладке «Транскрипт».`,
          });
          useUi.getState().setMode("transcript");
          unlisten?.();
        }
      });

      await invoke("run_transcription", {
        input: s.inputPath,
        modelDir: s.modelDir,
        engine: s.engine,
        chunkSecs: null,
        limitSecs: s.limitSecs,
        maxSpeakers: s.maxSpeakers,
        clusterer: null,
      });
    } catch (e) {
      set({ running: false, stage: null, stageProgress: null, error: String(e) });
      unlisten?.();
    }
  },

  cancel: async () => {
    try {
      await invoke("transcribe_cancel");
    } catch (e) {
      set({ error: String(e) });
    }
  },
}));
