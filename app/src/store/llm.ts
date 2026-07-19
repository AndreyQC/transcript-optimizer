import { create } from "zustand";
import {
  DEFAULT_LLM_SETTINGS,
  getEffectiveApiKey,
  type LlmSettings,
} from "../lib/llm";
import { useDictionaries } from "./dictionaries";
import { setLlmSettings } from "../lib/yaml-edit";
import type {
  LlmModelConfig,
  LlmYamlSettings,
  Settings,
  SettingsFile,
} from "../types/dictionaries";

// Настройки LLM для режима «Саммари». Источник правды — подраздел `settings.llm`
// в открытом settings.yaml (рядом с остальными словарями). НЕ localStorage:
// настройки переезжают в YAML, чтобы версионироваться и переноситься с папкой
// проекта.
//
// Внешний интерфейс store остаётся в camelCase (LlmSettings) — чтобы не трогать
// SummaryView. Конвертация в/из snake_case (конвенция YAML-файлов) — здесь.
// Поддерживается несколько моделей: settings.llm.models — карта, ключ = имя модели.

interface LlmStore {
  // Карта моделей. Если settings.yaml не открыт — содержит одну default-модель.
  models: Record<string, LlmSettings>;
  // Имя активной модели (выбранной в UI). Синхронизируется с default_model в YAML.
  selectedModel: string;
  // Открыт ли settings.yaml (есть ли куда сохранять).
  yamlAvailable: boolean;
  // null = ещё не проверяли (режим Summary не открывали); true/false — есть/нет.
  // Зависит от выбранной модели: apiKey модели или fallback OPENAI_API_KEY.
  apiKeyAvailable: boolean | null;

  setSelectedModel: (name: string) => void;
  addModel: (name: string, template?: LlmSettings) => void;
  removeModel: (name: string) => void;
  renameModel: (oldName: string, newName: string) => void;
  setModelSettings: (name: string, patch: Partial<LlmSettings>) => void;
  setDefaultModel: (name: string) => void;
  refreshApiKey: () => Promise<void>;

  // Внутренний хелпер: записать текущее состояние в settings.yaml.
  // Не вызывается напрямую из UI.
  persist: (models: Record<string, LlmSettings>, defaultModel: string) => void;
}

// snake_case (YAML) → camelCase (UI).
function fromYaml(y: LlmModelConfig): LlmSettings {
  return {
    baseUrl: y.base_url,
    model: y.model,
    temperature: y.temperature,
    maxTokens: y.max_tokens,
    apiKey: y.api_key ?? "",
    external: y.external ?? true,
    systemPromptPath: y.system_prompt_path ?? "",
    userPromptTemplate: y.user_prompt_template,
  };
}

// camelCase (UI) → snake_case (YAML).
function toYaml(s: LlmSettings): LlmModelConfig {
  return {
    base_url: s.baseUrl,
    model: s.model,
    temperature: s.temperature,
    max_tokens: s.maxTokens,
    api_key: s.apiKey,
    external: s.external,
    system_prompt_path: s.systemPromptPath,
    user_prompt_template: s.userPromptTemplate,
  };
}

function buildLlmYamlSettings(
  models: Record<string, LlmSettings>,
  defaultModel: string,
): LlmYamlSettings {
  const modelsYaml: Record<string, LlmModelConfig> = {};
  for (const [name, settings] of Object.entries(models)) {
    modelsYaml[name] = toYaml(settings);
  }
  return { default_model: defaultModel, models: modelsYaml };
}

function isOldLlmFormat(llm: unknown): llm is LlmModelConfig {
  return (
    typeof llm === "object" &&
    llm !== null &&
    !("models" in llm) &&
    "base_url" in llm &&
    "model" in llm
  );
}

// Достать эффективные настройки из открытого settings.yaml. Если файл не открыт
// или подраздел `llm` отсутствует — DEFAULT_LLM_SETTINGS как модель `default`.
// Поддерживает старый плоский формат settings.llm (до введения models).
export function readLlmFromDictionaries(): {
  models: Record<string, LlmSettings>;
  selectedModel: string;
  yamlAvailable: boolean;
} {
  const entries = useDictionaries.getState().entries;
  const settingsEntry = entries.find((e) => e.kind === "settings");
  if (!settingsEntry) {
    return {
      models: { default: { ...DEFAULT_LLM_SETTINGS } },
      selectedModel: "default",
      yamlAvailable: false,
    };
  }

  const data = settingsEntry.data as SettingsFile | null | undefined;
  const llm = (data?.settings as Settings | undefined)?.llm;

  // Старый плоский формат → миграция в models.default.
  if (llm && isOldLlmFormat(llm)) {
    return {
      models: { default: { ...DEFAULT_LLM_SETTINGS, ...fromYaml(llm) } },
      selectedModel: "default",
      yamlAvailable: true,
    };
  }

  // Новый формат.
  const modelsYaml = (llm as LlmYamlSettings | undefined)?.models;
  if (!modelsYaml || Object.keys(modelsYaml).length === 0) {
    return {
      models: { default: { ...DEFAULT_LLM_SETTINGS } },
      selectedModel: "default",
      yamlAvailable: true,
    };
  }

  const models: Record<string, LlmSettings> = {};
  for (const [name, cfg] of Object.entries(modelsYaml)) {
    models[name] = { ...DEFAULT_LLM_SETTINGS, ...fromYaml(cfg) };
  }

  const selectedModel =
    (llm as LlmYamlSettings).default_model || Object.keys(models)[0];

  return { models, selectedModel, yamlAvailable: true };
}

export const useLlm = create<LlmStore>((set, get) => ({
  models: readLlmFromDictionaries().models,
  selectedModel: readLlmFromDictionaries().selectedModel,
  yamlAvailable: readLlmFromDictionaries().yamlAvailable,
  apiKeyAvailable: null,

  setSelectedModel: (name) => {
    if (!(name in get().models)) return;
    set({ selectedModel: name });
    get().persist(get().models, name);
  },

  addModel: (name, template) => {
    if (!name.trim() || name in get().models) return;
    const models = { ...get().models };
    models[name] = { ...DEFAULT_LLM_SETTINGS, ...(template ?? {}) };
    set({ models, selectedModel: name });
    get().persist(models, name);
  },

  removeModel: (name) => {
    if (!(name in get().models)) return;
    const models = { ...get().models };
    delete models[name];

    let selectedModel = get().selectedModel;
    if (selectedModel === name || !(selectedModel in models)) {
      selectedModel = Object.keys(models)[0] ?? "default";
    }
    if (!models[selectedModel]) {
      models[selectedModel] = { ...DEFAULT_LLM_SETTINGS };
    }

    set({ models, selectedModel });
    get().persist(models, selectedModel);
  },

  renameModel: (oldName, newName) => {
    if (!(oldName in get().models) || !newName.trim() || newName in get().models) return;
    const models = { ...get().models };
    models[newName] = models[oldName];
    delete models[oldName];

    let selectedModel = get().selectedModel;
    if (selectedModel === oldName) selectedModel = newName;

    set({ models, selectedModel });
    get().persist(models, selectedModel);
  },

  setModelSettings: (name, patch) => {
    if (!(name in get().models)) return;
    const models = { ...get().models };
    models[name] = { ...models[name], ...patch };
    set({ models });
    get().persist(models, get().selectedModel);
  },

  setDefaultModel: (name) => {
    get().setSelectedModel(name);
  },

  refreshApiKey: async () => {
    const settings = get().models[get().selectedModel];
    if (!settings) {
      set({ apiKeyAvailable: false });
      return;
    }
    const key = await getEffectiveApiKey(settings);
    set({ apiKeyAvailable: key !== null });
  },

  persist: (models, defaultModel) => {
    const state = useDictionaries.getState();
    const settingsEntry = state.entries.find((e) => e.kind === "settings");
    if (!settingsEntry) return;

    const result = setLlmSettings(
      settingsEntry.raw,
      buildLlmYamlSettings(models, defaultModel),
    );
    if (result.ok) {
      state.applyEdit("settings", result.raw);
    }
  },
}));

// Вспомогательная функция для глубокого сравнения объектов (для подписки).
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Подписка на dictionaries-store: при открытии папки / правке settings.yaml в
// YamlEditor — обновляем эффективные настройки в llm-store. Подписываемся на
// массив entries (стабильная ссылка из store, меняется только при реальной правке).
let unsubscribeDictionaries: (() => void) | null = null;
function syncFromDictionaries() {
  if (unsubscribeDictionaries) return;
  unsubscribeDictionaries = useDictionaries.subscribe(() => {
    const { models, selectedModel, yamlAvailable } = readLlmFromDictionaries();
    const cur = useLlm.getState();

    const sameModels = deepEqual(cur.models, models);
    const sameSelected = cur.selectedModel === selectedModel;

    if (!sameModels || !sameSelected) {
      useLlm.setState({ models, selectedModel, yamlAvailable });
    } else if (cur.yamlAvailable !== yamlAvailable) {
      useLlm.setState({ yamlAvailable });
    }
  });
}
syncFromDictionaries();

// refreshApiKey НЕ зовётся при импорте модуля — проверка делается при открытии
// режима Summary через useEffect в SummaryView (иначе падает вне Tauri).
