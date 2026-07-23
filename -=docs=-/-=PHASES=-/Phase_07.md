# Phase 7: Множественные модели LLM + шифрование + предупреждение external

**Дата:** 2026-07-19  
**Статус:** завершён  
**План:** `-=tasks=-/2026-07-19/20260719_001_model_selection_crypto_plan.md`

---

## Цель фазы

Добавить в режим «Саммари»:
1. Хранение нескольких конфигураций OpenAI-совместимых моделей в `settings.yaml`.
2. Выбор конкретной модели в UI перед формированием саммари.
3. Шифрование `api_key` и `base_url` в формате `crypto__<ENV>__<ciphertext>`, совместимом с Python `cryptography.fernet`.
4. Флаг `external` у модели и предупреждение о необходимости проверить транскрипт на чувствительные данные.

---

## Что сделано

### Backend (Rust)

| Файл | Что изменилось |
|---|---|
| `app/src-tauri/Cargo.toml` | Добавлены чистые Rust-крейты: `aes`, `cbc`, `hmac`, `sha2`, `base64`, `rand`. Убран `fernet` (требовал OpenSSL). |
| `app/src-tauri/src/crypto.rs` (новый) | Реализация Fernet: `is_crypto_token`, `decrypt_crypto_token`, `resolve_value`, `generate_fernet_key`, `encrypt_text`. Ключ: `key[:16]` — signing key, `key[16:]` — encryption key (как в Python). |
| `app/src-tauri/src/lib.rs` | `stream_chat` теперь расшифровывает `base_url` и `api_key`. Добавлены команды `generate_fernet_key`, `encrypt_text`, `resolve_crypto_token`. |

### Frontend

| Файл | Что изменилось |
|---|---|
| `app/src/types/dictionaries.ts` | Новые типы: `LlmYamlSettings` (`default_model` + `models`), `LlmModelConfig` (`base_url`, `model`, `api_key`, `external`, ...). |
| `app/src/lib/yaml-edit.ts` | `setLlmSettings` переписана под новую схему `settings.llm`. |
| `app/src/lib/llm.ts` | Добавлены `apiKey`, `external` в `LlmSettings`; `isCryptoToken`, `parseCryptoToken`, `getEffectiveApiKey`, `generateFernetKey`, `encryptText`. |
| `app/src/store/llm.ts` | Store теперь хранит карту `models`, выбранную `selectedModel`, поддерживает add/remove/rename, мигрирует старый плоский `settings.llm`. |
| `app/src/components/SummaryView.tsx` | Селектор модели, баннер `external`, индикаторы 🔒 для зашифрованных полей, кнопки «Зашифровать/Изменить» для `base_url` и `api_key`. |
| `app/src/App.css` | Стили `.security-warning`, `.model-selector`, `.crypto-input-row`. |
| `sample/transcript_optimizer/settings.yaml` | Переведён в новый формат с 3 моделями (`minimax`, `openai`, `local_ollama`). |

---

## Ключевые архитектурные решения

- **Fernet в Rust**: чисто Rust (`aes` + `cbc` + `hmac` + `sha2`), без OpenSSL. Проверена двусторонняя совместимость с Python `cryptography.fernet`.
- **Расшифровка в Rust**: секретный Fernet-ключ из env не попадает во фронтенд. Фронтенд передаёт зашифрованный токен как есть, Rust расшифровывает перед HTTP-запросом.
- **Схема YAML**: `settings.llm.default_model` + `settings.llm.models.<name>`.
- **Backward compatibility**: старый плоский `settings.llm` автоматически мигрируется в `models.default`.
- **API-ключ**: приоритет у `api_key` модели; если пусто — fallback на `OPENAI_API_KEY` env.
- **External-флаг**: `external: true` по умолчанию (если не задано), чтобы неожиданно не отправить данные наружу.

---

## Проверки

```bash
cd app/src-tauri && cargo check              # OK
cargo test crypto::tests --lib                # 5 passed
cd app && pnpm exec tsc --noEmit             # OK
pnpm exec vite build                          # OK
```

Ручная cross-проверка Fernet:
- Python-сгенерированный токен расшифровывается Rust.
- Rust-сгенерированный токен расшифровывается Python.

---

## Известные ограничения / NOT done

- Шифрование через `window.prompt` — функционально, но не самый элегантный UI. Можно заменить на inline-форму или диалог Tauri.
- Нет автоматического теста Rust → Python в CI (проверено вручную).
- `external` — булев флаг; не инферируется автоматически из URL (localhost и т.д.).
- Нет ограничения TTL при расшифровке (как в Python без TTL).

---

## Где читать дальше

- План фазы: `-=tasks=-/2026-07-19/20260719_001_model_selection_crypto_plan.md`
- Общие конвенции: `-=CHECKPOINTS=-/CHECKPOINTS_CONVENTION.md`
- Предыдущий снапшот: `-=tasks=-/2026-07-18/20260718_001_checkpoint.md`
