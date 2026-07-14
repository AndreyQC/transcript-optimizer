import { create } from "zustand";

// Результаты саммари-сессии. Хранятся ВНЕ компонента SummaryView, чтобы переживать
// его размонтирование при переключении режима (Словари/Транскрипт/Саммари).
// Если бы state жил в useState внутри SummaryView, уход в другой режим терял бы
// уже полученные от LLM результаты — это был баг №2.
//
// Стриминг (streaming) тоже здесь: если пользователь ушёл и вернулся во время
// стрима — onDelta продолжит накапливать текст в store, и при возврате он будет
// виден. Останавливать стрим при размонтировании НЕ нужно (onDelta пишет в store,
// а не в локальный state).

export type StreamTarget = "raw" | "cleaned" | "collapsed" | null;
export type SourceTab = "raw" | "cleaned" | "collapsed" | "diff";
// Источник саммари (без diff). Удобен для map-логики по 3 источникам.
export type Source = "raw" | "cleaned" | "collapsed";
export type ViewMode = "stream" | "result";

interface SummaryState {
  // Тексты результатов (накапливаются по onDelta во время стриминга).
  summaryRaw: string;
  summaryCleaned: string;
  summaryCollapsed: string;
  // Какой источник сейчас стримится (null = ничего).
  streaming: StreamTarget;
  // Активная вкладка результата (верхний уровень + под-вкладка).
  sourceTab: SourceTab;
  viewMode: ViewMode;

  // Мутаторы — SummaryView зовёт их вместо локальных setState.
  setSummaryRaw: (updater: string | ((prev: string) => string)) => void;
  setSummaryCleaned: (updater: string | ((prev: string) => string)) => void;
  setSummaryCollapsed: (updater: string | ((prev: string) => string)) => void;
  setStreaming: (target: StreamTarget) => void;
  setSourceTab: (tab: SourceTab) => void;
  setViewMode: (mode: ViewMode) => void;

  // Стереть результаты (пока не используется UI, но пригодится для «очистить всё»).
  resetResults: () => void;
}

export const useSummary = create<SummaryState>((set) => ({
  summaryRaw: "",
  summaryCleaned: "",
  summaryCollapsed: "",
  streaming: null,
  sourceTab: "raw",
  viewMode: "stream",

  setSummaryRaw: (updater) =>
    set((s) => ({
      summaryRaw:
        typeof updater === "function" ? updater(s.summaryRaw) : updater,
    })),
  setSummaryCleaned: (updater) =>
    set((s) => ({
      summaryCleaned:
        typeof updater === "function" ? updater(s.summaryCleaned) : updater,
    })),
  setSummaryCollapsed: (updater) =>
    set((s) => ({
      summaryCollapsed:
        typeof updater === "function" ? updater(s.summaryCollapsed) : updater,
    })),
  setStreaming: (target) => set({ streaming: target }),
  setSourceTab: (tab) => set({ sourceTab: tab }),
  setViewMode: (mode) => set({ viewMode: mode }),

  resetResults: () =>
    set({
      summaryRaw: "",
      summaryCleaned: "",
      summaryCollapsed: "",
      streaming: null,
    }),
}));
