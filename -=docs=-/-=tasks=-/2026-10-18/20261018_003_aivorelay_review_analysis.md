# Обзор AIVORelay: что переиспользуем для пайплайна транскрибации (analysis)

> Контекст:
> - `-=tasks=-/2026-10-18/20261018_002_transcriber_spike_plan.md` — обновляемый план спайка
> - `-=tasks=-/2026-10-18/20261018_001_transcriber_app_idea_final.md` — решения Q1–Q4
> - Репозиторий: `C:\repos\github\AIVORelay` (локальный клон; upstream —
>   форк [cjpais/Handy](https://github.com/cjpais/Handy), MIT)

**Дата:** 2026-10-18
**Статус:** analysis (открытых вопросов нет; выводы учтены в ревизии плана 002).

---

## 1. Что смотрели и зачем

AIVORelay — Tauri 2 (Rust) приложение voice-to-text, которым пользователь уже
пользуется; основная модель пользователя — `parakeet-tdt-0.6b-v3`. Цель обзора —
найти переиспользуемое для спайка `20261018_002` (ffmpeg → ASR → диаризация) и
проверить принятые решения Q1–Q4.

## 2. Находки (переиспользуем)

| # | Находка | Где в AIVORelay | Вывод для нас |
|---|---|---|---|
| 1 | `transcribe-rs = "0.3.8"`, фичи `onnx` + `vad-silero` (+ `ort-directml` на Windows x64) — собирается и работает | `src-tauri/Cargo.toml:94,140` | Known-good рецепт версий/фич; риск собираемости Q2 снят |
| 2 | Parakeet v3: `parakeet-tdt-0.6b-v3-int8` (ONNX, tarball `blob.handy.computer/parakeet-v3-int8.tar.gz`); языки ru/uk + 23 EU | `src-tauri/src/managers/model.rs:461-468,661-667` | Первичная модель спайка — рабочая модель пользователя, русский поддержан |
| 3 | GigaAM — модель только для русского | `model.rs:842` | Опциональный кандидат на сравнение качества на ru |
| 4 | Нативный декод аудио без ffmpeg: WAV через `hound`, MP3/M4A/OGG/FLAC/WebM через `rodio` (Symphonia), миксдаун в моно + ресемплинг в 16 кГц (`rubato`) | `src-tauri/src/commands/file_transcription.rs:1929-1994` | Стадия ffmpeg из спайка убирается целиком |
| 5 | Структуры диаризованного транскрипта: `speaker_id`, `default_name`, фолбэк `Unknown speaker`, сессии спикеров | `src-tauri/src/file_transcription_diarization.rs` | Референс модели данных для сшивки с polyvoice |
| 6 | Профили (язык + промпт + custom vocabulary + LLM-постобработка) | UI + `managers` | Референс UX для пресетов-YAML (Q3) |
| 7 | `subtitle.rs`: сегменты → SRT/VTT, `TimedTranscriptToken` | `src-tauri/src/subtitle.rs` | Референс формата выхода с таймкодами |
| 8 | `engine_supervisor` — супервизия движка отдельным процессом | `src-tauri/src/engine_supervisor/` | Референс для архитектуры sidecar (Q1-в) в Phase 10 |

## 3. Ограничения (почему их CLI нам не подходит)

1. **CLI `--convert-file --json` не отдаёт таймкоды** — выход только `.txt`/`.md`,
   «word timestamps are not requested» (`CLI-SPEECH-TO-TEXT.md`;
   `cli_file_conversion.rs:1851-1862` — JSON: `ok/provider/characters/words/
   elapsed_ms`). Сшивка с диаризацией через их CLI невозможна — собственный
   sidecar с сегментными таймкодами остаётся необходимым.
2. **Диаризация облачная** (`DiarizedTranscriptProvider::{Deepgram, Soniox, Gemini}`)
   — локального аналога нет; выбор `polyvoice` остаётся единственным локальным путём.
3. **`initial_prompt` только для whisper.cpp-семейства** через отдельный крейт
   `transcribe-cpp` (`managers/transcription.rs:187-207`); в parakeet-ветке
   (transcribe-rs/ONNX) промпта нет. На основной модели пользователя leg
   «промпт дважды» сжимается до пост-обработки словарём — что и есть ядро
   transcript-optimizer.
4. CLI читает настройки из состояния приложения (провайдер/модель/диаризация) —
   внешняя связность, несовместимая с детерминированным пайплайном.

## 4. Лицензии

AIVORelay — MIT; transcript-optimizer — **Apache-2.0** (файл `LICENSE`, с initial
commit; единственный автор — пользователь, смена лицензии возможна в один коммит).
Включение MIT-кода в Apache-2.0 проект допустимо с сохранением копирайт-строки:
при заимствовании фрагментов (прежде всего `decode_audio_file`) завести
`THIRD_PARTY_NOTICES.md`. Зависимости `transcribe-rs`, `polyvoice` (обе MIT)
в Apache-2.0 проекте ограничений не создают.

## 5. Влияние на план спайка (ревизия 002)

- Стадия «ffmpeg-extract» → нативный декод (`hound` + `rodio` + `rubato`).
- Модели: `parakeet-tdt-0.6b-v3` int8 первичная; GigaAM опционально; Whisper
  исключён (вместе с риском whisper.cpp-toolchain — ONNX-путь его не требует).
- Проверка `initial_prompt` из целей спайка убрана (на parakeet неприменим).
- Риск собираемости понижен до «рецепт проверен AIVORelay».
