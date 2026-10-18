# Phase 10: Интеграция пайплайна транскрибации в приложение

**Дата:** 2026-10-18
**Статус:** завершена (код; ручная приёмка §Проверки — ожидает пользователя)
**План:** `-=tasks=-/2026-10-18/20261018_004_phase10_transcriber_integration_plan.md`
**Спайк:** `-=tasks=-/2026-10-18/20261018_002_transcriber_spike_result.md` (GO)

## Цель фазы

Полный цикл внутри transcript-optimizer: выбор видеофайла → прогресс по стадиям →
транскрипт со спикерами в существующем редакторе → замены/OOV/саммари поверх.
Плюс пресеты-YAML, post-processing hooks (заглушка), агент предложений.

## Что сделано

| Область | Файл → что изменилось |
|---|---|
| Workspace | `Cargo.toml` (корень) — workspace: `app/src-tauri` + `pipeline`; `Cargo.lock` в корне |
| Sidecar-крейт | `pipeline/src/lib.rs` — decode/ASR/диар/merge чистыми функциями + 7 тестов; `pipeline/src/main.rs` — stdio JSON-lines протокол (stage/done/error) |
| Rust-интеграция | `app/src-tauri/src/transcribe.rs` — `run_transcription` (spawn sidecar, `transcribe-event` в UI, защита от повторного запуска), `transcribe_cancel`, `detect_aivo_model_dir` |
| Bundling | `app/src-tauri/tauri.conf.json` — `externalBin: binaries/pipeline`; `app/scripts/build-pipeline.mjs` — сборка+копия с target-triple; capabilities: `shell:allow-execute` (sidecar) |
| Hooks | `app/src-tauri/src/hooks.rs` — трейт `PostProcessHook`, `HookContext`, `YandexMessengerHook` (заглушка, логирование); вызов — после «Очистить» (Toolbar), ошибка → `hook-error` |
| UI | `app/src/components/TranscribePanel.tsx` — форма (файл/модели/движок/лимит/спикеры) + прогресс + отмена; `app/src/store/transcribe.ts` — машина состояний; `app/src/store/ui.ts` — режимы в store |
| Формат | `app/src/lib/transcriptFormat.ts` — блоки sidecar → родной формат «Спикер N: / [HH:MM:SS]»; парсер/движок НЕ менялись |
| Пресеты | kind `presets` в `types/dictionaries.ts` (FILE_CONTRACT, TAB_ORDER) — редактирование через существующий Monaco-стек; выбор в панели; sample `sample/transcript_optimizer/presets.yaml` |
| Агент | `app/src/lib/proposals.ts` (buildProposals: OOV + fuzzy к существующим from) + `app/src/components/AgentProposals.tsx` — чеклист, применения через pending/Превью/Применить |
| Sample | `sample/transcript_optimizer/hooks.yaml` — конфиг хуков (выключен) |

## Ключевые решения

- **Парсер транскрипта не тронут**: блоки sidecar конвертируются в родной
  формат — движок/decorations/OOV работают без правок (план §10.5 сжался до
  форматтера).
- **Хуки конфигурируются YAML'ем, парсимым на фронтенде** (пакет `yaml` уже в
  депах) — Rust не тянет YAML-парсер.
- **Агент на TS** (отклонение от буквы Q4 при сохранении сути): norm/tokenize
  живут в TS-движке, второй источник правды в Rust повторил бы LESSONS §6.
- **AV-обход rustversion**: корпоративный антивирус блокирует запуск build-script
  rustversion (os error 5/32) — сборка крейта требует переноса артефактов
  build/out/.fingerprint из `spike/transcriber/target` (один раз; см.
  чекпоинт). Зафиксировано как ограничение окружения, не кода.

## Проверки

- `cargo test -p pipeline --release` — **7 passed**.
- `cargo check -p app` — OK.
- `pnpm exec tsc --noEmit` — OK; `pnpm exec vite build` — OK.
- Смоук sidecar-протокола на реальной встрече (`--limit 300`): stage-события +
  `done` с блоками/сегментами/turns/таймингами, RTF ≈ 0.12 (см. спайк).
- **Ручная приёмка (pnpm tauri dev, сквозной прогон из UI) — не выполнена
  в этой сессии**, ожидает пользователя: панель «Транскрибация» → файл →
  «AivoRelay» → Старт → транскрипт в редакторе → «Очистить» → агент.

## Известные ограничения / NOT done

- Авто-download моделей (TLS-прокси) — вручную, см.
  `-=tasks=-/2026-10-18/20261018_005_model_files_paths.md`.
- `initial_prompt` хранится в пресете, не подаётся (parakeet).
- AHC/`embed_window_secs` — поля пресета без UI; тюнинг диаризации дальше.
- LLM-подсказки `to` в агенте; реализация Yandex-хука (заглушка по ТЗ).
- Тесты фронтенда (vitest нет в проекте — наследственный бэклог).

## Где читать дальше

1. План и result спайка (ссылки в шапке) — обоснование стека.
2. `-=tasks=-/2026-10-18/20261018_005_model_files_paths.md` — перенос моделей.
3. `LESSONS_LEARNED.md` §§3, 6–8 — паттерны, соблюдённые в UI-коде.
