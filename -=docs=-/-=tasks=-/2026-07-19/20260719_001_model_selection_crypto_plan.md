# План: выбор конфигурации модели + шифрование токенов и base_url

**Дата:** 2026-07-19  
**Проект:** transcript-optimizer (Tauri 2 + React 19 + TypeScript + Rust)  
**Файл:** `-=tasks=-/2026-07-19/20260719_001_model_selection_crypto_plan.md`  
**Статус:** реализовано

---

## Результат реализации

- [x] Rust: чисто-Rust реализация Fernet (`app/src-tauri/src/crypto.rs`), совместимая с Python `cryptography.fernet`.
- [x] Rust: `stream_chat` расшифровывает `base_url` и `api_key` в формате `crypto__<ENV>__<ct>`.
- [x] Rust: команды `generate_fernet_key`, `encrypt_text`, `resolve_crypto_token`.
- [x] Frontend: типы `LlmModelConfig`, `LlmYamlSettings` (несколько моделей + `default_model`).
- [x] Frontend: store `llm.ts` поддерживает карту моделей, выбор, add/remove/rename, миграцию старого формата.
- [x] Frontend: `SummaryView` — селектор модели, баннер `external`, индикаторы зашифрованных полей, кнопки шифрования.
- [x] Frontend: `yaml-edit.ts` пишет новую схему `settings.llm` через AST.
- [x] Обновлён `sample/transcript_optimizer/settings.yaml`.

Проверки:
- `cargo check` — OK
- `cargo test crypto::tests --lib` — 5 passed
- `pnpm exec tsc --noEmit` — OK
- `pnpm exec vite build` — OK

---

## 1. Цель

Добавить в приложение возможность:
1. Хранить в `settings.yaml` **несколько конфигураций OpenAI-совместимых моделей**.
2. **Выбирать конкретную модель** в UI перед формированием саммари.
3. Хранить **токен API и `base_url` в зашифрованном виде** с тем же форматом, что и в `db-project-manager` (`crypto__<ENV>__<ciphertext>`).
4. Добавить флаг `external` у модели и показывать **предупреждение о конфиденциальности**, когда саммари отправляется на внешний сервер.

---

## 2. Зачем это нужно

- Сравнивать саммари, полученные от разных моделей (raw/cleaned/collapsed + разные модели).
- Не хранить чувствительные данные (API-ключи, приватные endpoint'ы) в открытом виде в YAML-файле, который может попасть в git.
- Предупреждать пользователя, что текст транскрипта уйдёт наружу, чтобы он мог проверить его на ПДн/пароли/токены/коммерческую тайну.

---

## 3. Архитектурные решения

| Вопрос | Решение | Обоснование |
|---|---|---|
| Алгоритм шифрования | **Fernet** (крейт `fernet` в Rust) | Совместим с Python `cryptography.fernet` — проверенный механизм из `db-project-manager`. |
| Что шифруем | `api_key` и `base_url` | Оба поля могут быть чувствительными. |
| Формат зашифрованного значения | `crypto__<ENV>__<ciphertext>` | Как в Python-образце: ключ Fernet берётся из переменной окружения `<ENV>`. |
| Где расшифровываем | **Rust** (`stream_chat`) | Секретный Fernet-ключ не попадает во фронтенд. |
| Где живут настройки | `settings.yaml` (рядом с другими словарями) | Сохраняем существующую конвенцию: YAML-конфиг версионируется и переносится с папкой проекта. |
| Схема хранения | `settings.llm.models: Record<string, ModelConfig>` + `settings.llm.default_model` | Удобно для селектора моделей и расширяемости. |
| Флаг внешности | `external: true/false` | `true` — данные уходят за пределы локальной машины. Если не задано — считаем `true` (безопасный дефолт). |
| Fallback ключа | `OPENAI_API_KEY` из env | Если у модели не задан `api_key`, используем старый механизм. |
| Обратная совместимость | Старый плоский `settings.llm` → `models.default` | Пользователь не потеряет текущие настройки. |

---

## 4. Целевая схема `settings.yaml`

```yaml
settings:
  aggressive_clean: false
  similarity_threshold: 0.65
  min_word_len: 3
  suggestions_header: true
  llm:
    default_model: minimax
    models:
      minimax:
        base_url: https://api.minimax.io/v1
        model: MiniMax-M3
        temperature: 0.3
        max_tokens: 4096
        api_key: crypto__TRANSCRIPT_OPTIMIZER_KEY__gAAAAAB...
        external: true
        system_prompt_path: drill_ai_skill_summary.md
        user_prompt_template: |-
          Сделай саммари следующего транскрипта:

          {transcript}
      openai:
        base_url: https://api.openai.com/v1
        model: gpt-4o-mini
        temperature: 0.3
        max_tokens: 4096
        api_key: crypto__TRANSCRIPT_OPTIMIZER_KEY__gAAAAAB...
        external: true
        system_prompt_path: drill_ai_skill_summary.md
        user_prompt_template: |-
          Сделай саммари следующего транскрипта:

          {transcript}
      local_qwen:
        base_url: http://localhost:11434/v1
        model: qwen2.5
        temperature: 0.3
        max_tokens: 4096
        api_key: ignored
        external: false
        system_prompt_path: drill_ai_skill_summary.md
        user_prompt_template: |-
          Сделай саммари:

          {transcript}
```

---

## 5. Backend (Rust)

### 5.1. Зависимости

В `app/src-tauri/Cargo.toml` добавить:

```toml
fernet = "0.2"
```

`base64` не обязателен — `fernet` сам генерирует ключи в правильном base64-url формате.

### 5.2. Новый модуль `app/src-tauri/src/crypto.rs`

Функции:

- `is_crypto_token(s: &str) -> bool`  
  Проверка формата `crypto__<ENV>__<ciphertext>`.

- `decrypt_crypto_token(s: &str) -> Result<String, String>`  
  Распарсить env-имя, взять ключ из `std::env::var(env_name)`, расшифровать через `fernet::Fernet::new(key)`.

- `resolve_value(s: &str) -> Result<String, String>`  
  Если строка — `crypto__*`, расшифровывает; иначе возвращает как есть.

- `generate_fernet_key() -> String`  
  `Fernet::generate_key()` — для UI-кнопки генерации.

- `encrypt_text(plaintext: &str, env_var: &str) -> Result<String, String>`  
  Шифрует plain-значение и формирует `crypto__<ENV>__<ciphertext>`. Используется в UI при нажатии «Зашифровать».

### 5.3. Изменения в `app/src-tauri/src/lib.rs`

- Добавить `mod crypto;`.
- Изменить `stream_chat`:
  ```rust
  let base_url = crypto::resolve_value(&base_url)?;
  let api_key = crypto::resolve_value(&api_key)?;
  // дальше текущая логика
  ```
- Добавить Tauri-команды:
  - `generate_fernet_key() -> String`
  - `encrypt_text(plaintext: String, env_var: String) -> Result<String, String>`
  - `resolve_crypto_token(token: String) -> Result<String, String>` (опционально, для UI-индикации)
- Зарегистрировать новые команды в `invoke_handler`.

### 5.4. Обработка ошибок

- Отсутствует env-переменная Fernet-ключа → понятная ошибка во фронтенд.
- Невалидный `crypto__`-токен → ошибка «Ошибка расшифровки Fernet».
- Env-переменная задана, но не base64-url → ошибка от `fernet`.

---

## 6. Frontend (TypeScript / React)

### 6.1. Типы: `app/src/types/dictionaries.ts`

```ts
export interface LlmModelConfig {
  base_url: string;            // plain или crypto__<ENV>__<ct>
  model: string;
  temperature: number;
  max_tokens: number;
  api_key?: string;            // plain или crypto__<ENV>__<ct>
  external?: boolean;          // true по умолчанию
  system_prompt_path?: string;
  user_prompt_template: string;
}

export interface LlmYamlSettings {
  default_model?: string;
  models: Record<string, LlmModelConfig>;
}
```

### 6.2. `app/src/lib/llm.ts`

- `isCryptoToken(s: string): boolean` — проверка формата `crypto__`.
- `parseCryptoToken(s: string): { env: string; ciphertext: string } | null`.
- `resolveCryptoValue(value: string): Promise<string>` — вызывает Rust `resolve_crypto_token` (или `stream_chat` расшифровывает сам).
- `getEffectiveApiKey(model: LlmSettings): Promise<string | null>` — `api_key` модели, иначе fallback на `OPENAI_API_KEY` env.
- `getEffectiveBaseUrl(model: LlmSettings): string` — `base_url` модели или дефолт `https://api.openai.com/v1`.
- Обновить `streamChatCompletion` — передавать `base_url` и `api_key` как есть; Rust разберётся с расшифровкой.
- Обновить `LlmSettings` (UI-тип) — добавить `apiKey`, `external`.

### 6.3. `app/src/store/llm.ts`

Новый интерфейс стора:

```ts
interface LlmStore {
  models: Record<string, LlmSettings>;   // ключ = имя модели
  selectedModel: string;                  // активная модель
  yamlAvailable: boolean;
  apiKeyAvailable: boolean | null;

  setSelectedModel(name: string): void;
  addModel(name: string, template?: LlmSettings): void;
  removeModel(name: string): void;
  renameModel(oldName: string, newName: string): void;
  setModelSettings(name: string, patch: Partial<LlmSettings>): void;
  refreshApiKey(): Promise<void>;
}
```

- `readLlmFromDictionaries()`:
  - читает новую схему;
  - если старый плоский `llm` — мигрирует в `models.default`, `default_model: "default"`, `external: true`;
  - если `default_model` не задан — берёт первый ключ из `models`.
- Подписка на `useDictionaries` — обновлять стор при правке YAML в редакторе.

### 6.4. `app/src/lib/yaml-edit.ts`

- Переписать `setLlmSettings` для работы с новой схемой (`llm.models.<name>` + `llm.default_model`).
- Добавить:
  - `setLlmModelField(raw, modelName, field, value)`
  - `addLlmModel(raw, modelName, config)`
  - `removeLlmModel(raw, modelName)`
  - `renameLlmModel(raw, oldName, newName)`
  - `setDefaultLlmModel(raw, modelName)`
- Все операции через AST (`yaml` пакет) — сохраняем комментарии и стиль.

### 6.5. `app/src/components/SummaryView.tsx`

Новые элементы UI:

1. **Селектор модели** (вверху блока настроек):
   - Dropdown со списком `models`.
   - Кнопки «Добавить», «Удалить», «Дублировать» рядом.
   - Рядом с именем — бейдж `internal` / `external` и `🔒` если есть зашифрованные поля.

2. **Баннер предупреждения** (когда `external: true`):
   ```
   ⚠️ Внимание: выбрана внешняя модель «{name}». 
   Транскрипт будет отправлен на сторонний сервер ({resolved_base_url}). 
   Перед запуском проверьте текст на наличие персональных данных, паролей, токенов и коммерческой тайны.
   ```

3. **Индикаторы зашифрованных полей**:
   - Если `base_url` или `api_key` начинается с `crypto__` — в input показываем `🔒 зашифровано (env: XXX)` вместо ciphertext.
   - Рядом с каждым полем — кнопка «Зашифровать» (открывает диалог/промпт: ввод значения + env-переменная, вызов `encrypt_text` через Rust).

4. **Чекбокс подтверждения** (опционально, если хотим усилить):
   - «Я проверил транскрипт на чувствительные данные».
   - Без галочки кнопки запуска disabled. Это можно сделать позже; в MVP достаточно баннера.

5. **Кнопки запуска**:
   - Используют `selectedModel` и её конфиг.
   - Tooltip для `external` модели: «Данные уйдут на внешний сервер».

### 6.6. `app/src/App.css`

- Стили для `.model-selector`, `.security-warning`, `.crypto-badge`, `.model-badge-internal`, `.model-badge-external`.
- Использовать существующие CSS-переменные темы.

---

## 7. Обновление эталонного `settings.yaml`

Файл: `sample/transcript_optimizer/settings.yaml`

Переводим в новый формат. Добавляем комментарий-инструкцию, как сгенерировать ключ:

```yaml
# Настройки LLM.
# Для шифрования api_key / base_url:
#   1. Задайте env TRANSCRIPT_OPTIMIZER_KEY (Fernet base64-url ключ).
#   2. Зашифруйте значение через UI (кнопка 🔒) или Python:
#      crypto_util.get_encrypted_text("sk-...", "TRANSCRIPT_OPTIMIZER_KEY")
settings:
  llm:
    default_model: minimax
    models:
      minimax:
        base_url: https://api.minimax.io/v1
        model: MiniMax-M3
        temperature: 0.3
        max_tokens: 4096
        api_key: crypto__TRANSCRIPT_OPTIMIZER_KEY__gAAAAAB...
        external: true
        system_prompt_path: drill_ai_skill_summary.md
        user_prompt_template: |-
          Сделай саммари следующего транскрипта:

          {transcript}
```

---

## 8. Обратная совместимость и миграция

- **Старый `settings.llm` (плоский объект):**
  - Читаем как `models.default`.
  - `default_model = "default"`.
  - `external = true` (безопасный дефолт).
  - `api_key` берём из `OPENAI_API_KEY` env, если не задан в YAML.
- **Файл без `llm`:**
  - Используем `DEFAULT_LLM_SETTINGS` как модель `default`.
- **Первое сохранение через UI:**
  - Переписывает YAML в новую схему через AST-правку.

---

## 9. Проверки

### 9.1. Автоматические

```bash
cd app/src-tauri && cargo check
cd app && pnpm exec tsc --noEmit
pnpm exec vite build
```

### 9.2. Ручные

1. Открыть `sample/transcript_optimizer` — в селекторе моделей видны записи из `settings.yaml`.
2. Выбрать `minimax` → нажать «Саммари (raw)» → стрим уходит на `https://api.minimax.io/v1`.
3. Выбрать `openai` → запустить «Саммари (cleaned)» → используется другая модель.
4. Выбрать `local_qwen` → баннер `external` не показывается.
5. Зашифровать `base_url` через UI → input показывает `🔒 зашифровано`, запрос всё равно работает.
6. Указать `api_key: crypto__MISSING_KEY__...` → понятная ошибка «Не задан env MISSING_KEY».
7. Открыть старый `settings.yaml` (без `models`) — он виден как модель `default`, предупреждение показывается.

---

## 10. Риски и ограничения

| Риск | Митигация |
|---|---|
| Fernet-ключ в env требует `setx` + перезапуска GUI на Windows | Показать в UI инструкцию, как задать env. |
| Зашифрованный `base_url` нельзя отобразить в input | Показывать `🔒 зашифровано (env: XXX)` и имя модели как основной идентификатор. |
| Расшифровка в Rust всё равно оставляет plaintext в памяти Rust-процесса | Приемлемо: так же, как сейчас с `OPENAI_API_KEY` из env. |
| UI управления несколькими моделями усложняет `SummaryView` | Делать итеративно: сначала селектор + чтение, потом add/remove/duplicate. |
| AST-правка YAML с новой схемой может сломать комментарии | Тестировать на `sample/settings.yaml` и проверять diff после сохранения. |

---

## 11. Порядок реализации (рекомендуемый)

1. **Rust**: `crypto.rs` + интеграция `resolve_value` в `stream_chat` + новые команды.
2. **Типы**: `LlmModelConfig`, `LlmYamlSettings`.
3. **YAML-редактор**: `setLlmModelField`, `addLlmModel`, `removeLlmModel`, `renameLlmModel`, `setDefaultLlmModel`.
4. **Store**: чтение `models/default_model`, выбор модели, миграция старого формата.
5. **SummaryView**: селектор модели, баннер `external`, индикаторы `crypto__`.
6. **Шифрование в UI**: кнопки «Зашифровать» для `base_url` и `api_key`.
7. **Обновление `sample/settings.yaml`** и smoke-тесты.

---

## 12. Связь с бэклогом контрольной точки

Из `20260718_001_checkpoint.md`:
- Пункт 10 «История запусков LLM» — не делаем здесь.
- Пункт 11 «OS keychain для `api_key`» — не делаем; остаёмся на env + Fernet.
- Пункт 12 «Чанкинг длинных транскриптов» — не делаем.

Этот план закрывает собственную задачу: **множественные модели + шифрование + предупреждение о внешних моделях**.
