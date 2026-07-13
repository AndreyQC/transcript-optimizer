import { invoke, Channel } from "@tauri-apps/api/core";
import { readFile, joinPath } from "./fs";
import { useDictionaries } from "../store/dictionaries";

// Настройки LLM для режима «Саммари». Хранятся в settings.yaml (раздел
// settings.llm) через store/llm.ts. `baseUrl` — полный base с /v1;
// `/chat/completions` доклеивает Rust-команда stream_chat.
export interface LlmSettings {
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  // Путь к .md-файлу системного промпта. Тело промпта НЕ хранится в settings.yaml —
  // только путь. Файл читается перед каждым запуском (правки во внешнем редакторе
  // подхватываются). Пустая строка = файл не выбран.
  systemPromptPath: string;
  // Шаблон пользовательского сообщения. Плейсхолдер `{transcript}` заменяется
  // на текст саммаризируемого транскрипта.
  userPromptTemplate: string;
}

// Дефолты по OpenAI-совместимому API. Провайдер может быть любым (LM Studio,
// Ollama, OpenRouter) — пользователь правит baseUrl/model в настройках.
// systemPromptPath пустой по умолчанию — пользователь должен явно выбрать .md.
export const DEFAULT_LLM_SETTINGS: LlmSettings = {
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  temperature: 0.3,
  maxTokens: 4096,
  systemPromptPath: "",
  userPromptTemplate:
    "Сделай саммари следующего транскрипта:\n\n{transcript}",
};

// Прочитать OpenAI-ключ из окружения процесса (через Rust-команду). Возвращает
// null вне Tauri или если ключ не задан. Без try/catch invoke падает в браузере.
export async function getApiKey(): Promise<string | null> {
  try {
    const key = await invoke<string | null>("get_openai_api_key");
    return key && key.length > 0 ? key : null;
  } catch {
    // Не Tauri-окружение (vite dev в браузере) или команда не зарегистрирована.
    return null;
  }
}

// Форма чанка, который присылает Rust-сторона stream_chat. `data` — Vec<u8>,
// который Tauri сериализует в number[].
interface StreamChunkMsg {
  data: number[];
}

// Опции запуска стриминга саммари.
export interface StreamChatOptions {
  settings: LlmSettings;
  transcriptText: string;
  apiKey: string;
  // Вызывается по каждому инкременту дельты текста (choices[0].delta.content).
  onDelta: (chunk: string) => void;
}

// Запустить стриминг чат-комплишена и прокинуть дельты через onDelta.
// Возвращает {ok:true} при успехе или {ok:false, error} при ошибке (включая
// HTTP-статусы провайдера — message приходит из Rust).
export async function streamChatCompletion(
  opts: StreamChatOptions,
): Promise<{ ok: boolean; error?: string }> {
  const { settings, transcriptText, apiKey, onDelta } = opts;

  // Прочитать .md-файл системного промпта перед каждым запуском (правки во
  // внешнем редакторе подхватываются без reopen). Файл читается целиком —
  // включая YAML frontmatter (name/description).
  const promptPath = settings.systemPromptPath.trim();
  if (!promptPath) {
    return {
      ok: false,
      error: "Не выбран файл системного промпта (.md). Откройте его в настройках LLM.",
    };
  }
  // Нормализация пути: readTextFile требует абсолютный путь. Если путь
  // относительный — склеиваем с открытой папкой словарей. Это покрывает и эталон
  // в репозитории (где путь относительный), и ручную правку settings.yaml.
  const resolvedPath = resolvePromptPath(promptPath);
  let systemContent: string;
  try {
    systemContent = await readFile(resolvedPath);
  } catch (e) {
    return {
      ok: false,
      error: `Не удалось прочитать файл промпта (${resolvedPath}): ${String(e)}`,
    };
  }
  if (systemContent.trim().length === 0) {
    return { ok: false, error: `Файл промпта пуст: ${resolvedPath}` };
  }

  const userContent = settings.userPromptTemplate.replace(
    "{transcript}",
    transcriptText,
  );

  const body = {
    model: settings.model,
    temperature: settings.temperature,
    max_tokens: settings.maxTokens,
    stream: true,
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: userContent },
    ],
  };

  // Модульно-local буфер SSE: чанк из Rust не обязан совпадать с границей
  // `data:`-строки, поэтому накапливаем и режем по `\n`.
  let buffer = "";
  let done = false;

  const channel = new Channel<StreamChunkMsg>();
  channel.onmessage = (msg: StreamChunkMsg) => {
    const text = new TextDecoder().decode(new Uint8Array(msg.data));
    buffer += text;
    // Обрабатываем только целые строки; хвост без \n оставляем в буфере.
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (done) break;
      processSseLine(line, onDelta, () => {
        done = true;
      });
    }
  };

  try {
    await invoke("stream_chat", {
      baseUrl: settings.baseUrl,
      apiKey,
      body,
      onEvent: channel,
    });
    // После завершения стрима мог остаться хвост без \n — обрабатываем.
    if (!done && buffer.length > 0) {
      processSseLine(buffer, onDelta, () => {
        done = true;
      });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Нормализовать путь к файлу промпта. Tauri readTextFile требует абсолютный путь;
// если путь относительный — склеиваем с открытой папкой словарей. Абсолютный путь
// (начинается с буквы диска на Windows или `/` на Unix) возвращаем как есть.
// Это покрывает: (1) путь от Tauri-диалога (абсолютный), (2) эталонный
// относительный путь в репозитории (напр. "./drill_ai_skill_summary.md"),
// (3) ручную правку settings.yaml пользователем.
function resolvePromptPath(promptPath: string): string {
  // Абсолютный путь? Windows: `C:\…`, `C:/…`; Unix: `/…`. Также Tauri возвращает
  // пути с обратными слешами на Windows — учитываем оба разделителя.
  const isAbsolute =
    /^[A-Za-z]:[\\/]/.test(promptPath) || // Windows drive
    promptPath.startsWith("/");
  if (isAbsolute) return promptPath;

  // Относительный — склеиваем с открытой папкой словарей. joinPath сам выбирает
  // разделитель по платформе. Если папка не открыта — возвращаем как есть:
  // readTextFile упадёт с понятной ошибкой (её покажет UI).
  const dir = useDictionaries.getState().dir;
  if (!dir) return promptPath;

  // Убираем ведущий `./` если есть — joinPath ожидает имя, а не относительный путь.
  const trimmedRelative = promptPath.replace(/^\.\//, "");
  return joinPath(dir, trimmedRelative);
}

// Толерантный парсер одной SSE-строки. Берём только `data: {json}` с полем
// choices[0].delta.content; `data: [DONE]` — конец стрима (flagDone). Остальное
// (комментарии `:`, ping, event/id-строки) игнорируем.
function processSseLine(
  line: string,
  onDelta: (chunk: string) => void,
  flagDone: () => void,
): void {
  const trimmed = line.trimEnd();
  if (trimmed.length === 0) return;
  // SSE-комментарий / heartbeat.
  if (trimmed.startsWith(":")) return;
  if (!trimmed.startsWith("data:")) return;

  const payload = trimmed.slice("data:".length).trim();
  if (payload === "[DONE]") {
    flagDone();
    return;
  }
  if (payload.length === 0) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    // Неполный/нестандартный JSON — игнорируем, не роняем стрим.
    return;
  }

  const content = extractDeltaContent(parsed);
  if (content) onDelta(content);
}

// Достать choices[0].delta.content из произвольного JSON. Любая несогласованность
// структуры → null (без исключений).
function extractDeltaContent(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (typeof first !== "object" || first === null) return null;
  const delta = (first as { delta?: unknown }).delta;
  if (typeof delta !== "object" || delta === null) return null;
  const content = (delta as { content?: unknown }).content;
  return typeof content === "string" ? content : null;
}
