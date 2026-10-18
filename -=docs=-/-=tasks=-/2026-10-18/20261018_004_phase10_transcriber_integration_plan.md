# Phase 10: Интеграция пайплайна транскрибации в приложение (plan)

> Контекст:
> - `-=tasks=-/2026-10-18/20261018_001_transcriber_app_idea_final.md` — решения Q1–Q4
> - `-=tasks=-/2026-10-18/20261018_002_transcriber_spike_result.md` — спайк, вердикт GO
> - `-=tasks=-/2026-10-18/20261018_003_aivorelay_review_analysis.md` — обзор AIVORelay
> - Код-задел: `spike/transcriber/` (рабочий decode→ASR→диар→merge)

**Дата:** 2026-10-18
**Статус:** plan. Оценка объёма: **L** (7 подэтапов, код+UI+доки).

---

## 1. Цель фазы

Внутри transcript-optimizer появляется полный цикл: выбор видеофайла → прогресс
по стадиям → транскрипт со спикерами и таймкодами в существующем редакторе →
поверх него работают все текущие механики (замены из словаря с превью, OOV-грид,
саммари). Плюс: пресеты-YAML, post-processing hooks (заглушка), агент предложений
по правке словаря. Всё локально, CPU-only, sidecar-бинарь — как решено в Q1–Q4.

Критерий приёмки фазы: сквозной ручной прогон sample-видео (та же встреча
2026-10-16) из UI — с прогрессом, отменой, результатом в редакторе, применением
замен и генерацией саммари.

## 2. Архитектура

```
transcript-optimizer/
├── Cargo.toml                    # НОВОЕ: root workspace, members: app/src-tauri, pipeline
├── pipeline/                     # НОВОЕ: sidecar-крейт (перенос спайка)
│   ├── Cargo.toml                # transcribe-rs(onnx) + ort="=2.0.0-rc.12",
│   │                             # polyvoice(pipeline-native,vbx), audiopus, symphonia, rubato
│   ├── src/lib.rs                # decode/asr/diarize/merge — чистые функции, cargo test
│   └── src/main.rs               # stdio JSON-lines протокол
├── app/src-tauri/
│   ├── tauri.conf.json           # + externalBin, + shell permission
│   ├── binaries/                 # pipeline-<target-triple>.exe (gitignored, копия сборкой)
│   └── src/
│       ├── commands/transcribe.rs   # spawn sidecar, построчный stdout, emit событий, отмена
│       └── hooks/                   # PostProcessHook + yandex.rs (заглушка)
└── app/src/
    ├── store/transcribe.ts          # Zustand: состояние панели/прогресса
    ├── components/TranscribePanel.tsx
    ├── engine/transcript.ts         # +парсинг «Спикер N:» в префиксе реплики
    ├── lib/presets.ts               # presets.yaml (чтение через существующий YAML-стек)
    └── lib/proposals.ts             # пакетные предложения агента по словарю
```

**Протокол sidecar** (JSON, по строке на stdout):

- запрос (аргументы CLI): `{input, engine, model_dir, chunk_secs, limit_secs?,
  max_speakers?, clusterer?, embed_window_secs?}`
- события: `{"event":"stage","stage":"decode|asr|diar|merge","i":N,"n":M,"secs":T}`,
  `{"event":"done","result":{"text","segments","turns","blocks"}}`,
  `{"event":"error","message":"..."}`.

**Разделение ответственности:** sidecar — только decode+ASR+диаризация+сшивка
(сырой транскрипт). Замены, превью, undo, OOV, саммари — в приложении
существующими механизмами. Промпт-пресеты — хранение в YAML, применение —
зарезервировано (см. решения №3).

## 3. Подэтапы

### 10.1 Root workspace + крейт `pipeline`
- Корневой `Cargo.toml` workspace: `app/src-tauri` + `pipeline` (единый
  Cargo.lock; ML-депы только в `pipeline`, сборка app не затрагивается).
- Перенос логики спайка из `spike/transcriber/src/main.rs` в `pipeline/src/lib.rs`
  (функции `decode_audio`, `run_asr`, `run_diarization`, `merge`) + тонкий
  `main.rs` с протоколом.
- `cargo test`: merge-функция на синтетических сегментах/turns; decode на
  маленькой wav-фикстуре; OrtSession не грузим в тестах (модели не в CI).

### 10.2 Сборка и bundling sidecar
- Скрипт `app/scripts/build-pipeline.mjs` (или cargo alias): `cargo build
  --release -p pipeline` → копия в `app/src-tauri/binaries/pipeline-x86_64-pc-
  windows-msvc.exe`; `binaries/` в .gitignore.
- `tauri.conf.json`: `"bundle": {"externalBin": [...]}`, capabilities: shell
  sidecar permission (tauri-plugin-shell).

### 10.3 Tauri-команда и события
- `commands/transcribe.rs`: spawn sidecar (shell sidecar API), чтение stdout
  построчно, `app.emit("transcribe-progress" | "transcribe-done" | "transcribe-error")`.
- Отмена: `transcribe_cancel` убивает процесс, хвостовые события игнорируются.
- Ошибки spawn (нет бинаря/моделей) — человекочитаемыми строками в UI.

### 10.4 UI: панель «Транскрибация»
- Режим-обёртка `TranscribePanel` по образцу `MarkdownView` (режим в app-store,
  состояние переживёт переключения — LESSONS §16).
- Выбор файла (tauri dialog), выбор пресета, engine/model, `max_speakers`,
  «Старт», прогресс-бар стадий, отмена.
- Результат → новый документ транскрипта в существующем редакторе; дальше
  стандартный флоу (замены/саммари) без изменений.

### 10.5 Парсер транскрипта: метки спикеров
- Формат строки: `[HH:MM:SS] Спикер N: текст` (как в спайке).
- `engine/transcript.ts`: префикс спикера выделяется при парсинге, в
  `utt.text` попадает только текст; decorations/OOV/замены работают по тексту,
  метка сохраняется при экспорте. Тесты парсера на фикстурах (включая CRLF).

### 10.6 Пресеты-YAML
- `presets.yaml` в каталоге словарей: список `{id, name, initial_prompt,
  engine, model_dir?, chunk_secs, max_speakers, clusterer}`.
- UI-выбор пресета в панели; «редактор пресета» — через существующий
  Monaco/YAML-стек (без отдельной формы в этой фазе).

### 10.7 Хуки пост-обработки
- Трейт `PostProcessHook` (Rust, `app/src-tauri/src/hooks/`):
  `run(&self, ctx: &HookContext)`; `HookContext { transcript, preset_id,
  preset_name, video_path, meeting_date }`.
- `YandexMessengerHook` — заглушка с логированием (детали позже).
- Конфиг `hooks.yaml`; ошибка хука → событие `hook-error` в UI, пайплайн не
  роняет. Вызов — после применения замен в приложении.

### 10.8 Агент предложений по словарю
- `lib/proposals.ts`: пакетный проход по текущему транскрипту: OOV-кандидаты +
  частотность + fuzzy-матчи к существующим `from` (`similarity.ts`) →
  `Vec<Proposal {from, count, similar_to, suggested_to?}>`.
- UI: чеклист в `EditPanel` («Предложения агента»), применение выбранных —
  через существующий `yaml-edit.ts` CST-стек в `pending`/Превью/Применить.
- LLM-подсказка `to` — опция за рамками фазы (крюк в `store/llm.ts` описать).

### 10.9 Проверки и документация
- `cargo test -p pipeline`, `cargo clippy`, `pnpm exec tsc --noEmit`,
  `pnpm exec vite build` — зелёные.
- Ручной сквозной прогон (критерий приёмки §1), скриншоты не требуются.
- `-=PHASES=-/Phase_10.md` + чекпоинт дня.

## 4. Решения (зафиксировано в плане)

1. **Root Cargo workspace** — единый lockfile, изоляция ML-депов в `pipeline`.
2. **Замены — в приложении, не в sidecar.** Один источник правды (`engine/rules.ts`),
   бесплатно превью/undo/OOV. Sidecar не знает о словарях.
3. **`initial_prompt` хранится в пресете, но не подаётся в модель** (parakeet
   не принимает; поле — задел под будущие whisper-движки transcribe-rs).
   Имена/термины правит словарь замен — это ядро продукта.
4. **Модели**: каталог задаётся в настройках (дефолт `app_config_dir/models`);
   кнопка «использовать каталог моделей AivoRelay» подставит путь из
   `%LOCALAPPDATA%\Packages\MaxITService.AivoRelay_*\...\models`. Авто-закачка
   моделей НЕ входит в фазу (TLS-прокси ломает ureq; ручная инструкция в README).
5. **Агент — на TypeScript, не Rust** (уточнение буквы Q4 при сохранении сути
   «in-app proposal engine»): `norm`/`tokenize`/fuzzy уже живут в TS-движке;
   второй источник правды в Rust повторил бы грабли LESSONS §6 (разные правила
   отбора движка и агрегатора).
6. **Диаризация**: дефолт `Balanced`+VBx (лучший результат спайка), в UI — только
   `max_speakers`; AHC/`embed_window_secs` — поля пресета для экспериментов.
7. **Отмена** — kill sidecar; частичный результат не сохраняется.

## 5. Риски

- **externalBin/target-triple**: имя бинаря должно совпадать с triple сборки —
  аккуратность в скрипте сборки и CI; проверить `tauri build`.
- **Единый Cargo.lock**: конфликт версий депов app и pipeline (митигируется
  изоляцией; спайк показал рабочую комбинацию — переносим его lock как базу).
- **Парсер регресс**: задеваем общий парсер транскриптов — покрыть фиксстурами
  старый формат (без спикера) и новый.
- **Первый запуск без моделей**: понятная ошибка с путём и ссылкой на README.
- **Большие транскрипты** (час = ~66+ сегментов, сотни строк): рендер уже
  проверен объёмами саммари; мониторим.

## 6. NOT done (осознанные отсечения фазы)

- Авто-download моделей ASR/диаризации (отдельная задача: системный curl или
  native-tls из-за корпоративного прокси).
- Подача `initial_prompt` в ASR; сравнение движков в UI (parakeet фикс.
  первичным, GigaAM — только текстовый режим без сшивки).
- Тюнинг диаризации в UI (только поля пресета); «спикер на канал» для стерео.
- Авто-выбор пресета по имени родительской папки видео.
- LLM-подсказки `to` в агенте; массовый merge похожих из чеклиста.
- Реализация YandexMessengerHook (заглушка с логированием, как в ТЗ).

## 7. Порядок работ и коммиты

10.1 → 10.2 → 10.3 → 10.4 (вертикальный срез: к концу 10.4 сквозной путь
работает) → 10.5 → 10.6 → 10.7 → 10.8 → 10.9. Коммиты: `feat(pipeline): ...`
для крейта, `feat(app): ...` для приложения, доки отдельно (`docs(...)`).
