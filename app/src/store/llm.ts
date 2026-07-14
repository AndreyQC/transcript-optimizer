import { create } from "zustand";
import { DEFAULT_LLM_SETTINGS, getApiKey, type LlmSettings } from "../lib/llm";
import { useDictionaries } from "./dictionaries";
import { setLlmSettings } from "../lib/yaml-edit";
import type {
  LlmYamlSettings,
  Settings,
  SettingsFile,
} from "../types/dictionaries";

// Настройки LLM для режима «Саммари». Источник правды — подраздел `settings.llm`
// в открытом settings.yaml (рядом с остальными словарями). НЕ localStorage:
// настройки переезжают в YAML, чтобы версионироваться и переноситься с папкой
// проекта. Если папка словарей не открыта — настройки недоступны (кнопки запуска
// disabled), показываем DEFAULT_LLM_SETTINGS как «прочерк».
//
// Внешний интерфейс store остаётся в camelCase (LlmSettings) — чтобы не трогать
// SummaryView. Конвертация в/из snake_case (конвенция YAML-файлов) — здесь.

interface LlmStore {
  // Эффективные настройки для UI. Если settings.yaml не открыт — DEFAULT.
  settings: LlmSettings;
  // Открыт ли settings.yaml (есть ли куда сохранять).
  yamlAvailable: boolean;
  setSettings: (patch: Partial<LlmSettings>) => void;
  // null = ещё не проверяли (режим Summary не открывали); true/false — есть/нет.
  apiKeyAvailable: boolean | null;
  refreshApiKey: () => Promise<void>;
}

// snake_case (YAML) → camelCase (UI).
function fromYaml(y: LlmYamlSettings): LlmSettings {
  return {
    baseUrl: y.base_url,
    model: y.model,
    temperature: y.temperature,
    maxTokens: y.max_tokens,
    systemPromptPath: y.system_prompt_path ?? "",
    userPromptTemplate: y.user_prompt_template,
  };
}

// camelCase (UI) → snake_case (YAML).
function toYaml(s: LlmSettings): LlmYamlSettings {
  return {
    base_url: s.baseUrl,
    model: s.model,
    temperature: s.temperature,
    max_tokens: s.maxTokens,
    system_prompt_path: s.systemPromptPath,
    user_prompt_template: s.userPromptTemplate,
  };
}

// Достать эффективные настройки из открытого settings.yaml. Если файл не открыт
// или подраздел `llm` отсутствует — DEFAULT_LLM_SETTINGS (с мерджем по полям,
// чтобы частично заданный llm не оставил undefined).
export function readLlmFromDictionaries(): {
  settings: LlmSettings;
  yamlAvailable: boolean;
} {
  const entries = useDictionaries.getState().entries;
  const settingsEntry = entries.find((e) => e.kind === "settings");
  if (!settingsEntry) {
    return { settings: { ...DEFAULT_LLM_SETTINGS }, yamlAvailable: false };
  }
  const data = settingsEntry.data as SettingsFile | null | undefined;
  const llm = (data?.settings as Settings | undefined)?.llm;
  if (!llm) {
    return { settings: { ...DEFAULT_LLM_SETTINGS }, yamlAvailable: true };
  }
  // Мердж с дефолтами на случай отсутствующих полей (частично заданный llm).
  return {
    settings: { ...DEFAULT_LLM_SETTINGS, ...fromYaml(llm) },
    yamlAvailable: true,
  };
}

export const useLlm = create<LlmStore>((set, get) => ({
  settings: readLlmFromDictionaries().settings,
  yamlAvailable: readLlmFromDictionaries().yamlAvailable,
  setSettings: (patch) => {
    const merged = { ...get().settings, ...patch };
    set({ settings: merged });

    // Если settings.yaml открыт — пишем подраздел `llm` через AST-правку, чтобы
    // попасть в undo-стек и пометить файл dirty. Если не открыт — правки живут
    // только в памяти (сбросятся при перезагрузке).
    const state = useDictionaries.getState();
    const settingsEntry = state.entries.find((e) => e.kind === "settings");
    if (!settingsEntry) return;

    const result = setLlmSettings(settingsEntry.raw, toYaml(merged));
    if (result.ok) {
      // applyEdit пере-парсит data и пометит dirty + положит prev в undo-стек.
      state.applyEdit("settings", result.raw);
    }
    // При ошибке правки (невалидный YAML и т.п.) — не роняем UI; в памяти уже
    // обновлено, пользователь увидит несоответствие в редакторе settings.yaml.
  },
  apiKeyAvailable: null,
  refreshApiKey: async () => {
    const key = await getApiKey();
    set({ apiKeyAvailable: key !== null });
  },
}));

// Подписка на dictionaries-store: при открытии папки / правке settings.yaml в
// YamlEditor — обновляем эффективные настройки в llm-store. Подписываемся на
// массив entries (стабильная ссылка из store, меняется только при реальной правке).
let unsubscribeDictionaries: (() => void) | null = null;
function syncFromDictionaries() {
  if (unsubscribeDictionaries) return;
  unsubscribeDictionaries = useDictionaries.subscribe(() => {
    const { settings, yamlAvailable } = readLlmFromDictionaries();
    // Не перетираем локальные правки, пока они не сохранены в YAML: обновляем
    // только если YAML-источник действительно изменился. Сравнение по значению,
    // чтобы не плодить лишних set (примитивы внутри LlmSettings сравнимаются).
    const cur = useLlm.getState().settings;
    const same =
      cur.baseUrl === settings.baseUrl &&
      cur.model === settings.model &&
      cur.temperature === settings.temperature &&
      cur.maxTokens === settings.maxTokens &&
      cur.systemPromptPath === settings.systemPromptPath &&
      cur.userPromptTemplate === settings.userPromptTemplate;
    if (!same) {
      useLlm.setState({ settings, yamlAvailable });
    } else if (useLlm.getState().yamlAvailable !== yamlAvailable) {
      useLlm.setState({ yamlAvailable });
    }
  });
}
syncFromDictionaries();

// refreshApiKey НЕ зовётся при импорте модуля — проверка делается при открытии
// режима Summary через useEffect в SummaryView (иначе падает вне Tauri).
