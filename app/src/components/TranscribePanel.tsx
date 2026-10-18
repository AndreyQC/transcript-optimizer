import { useMemo } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useTranscribe, stageLabel, type TranscribeEngine } from "../store/transcribe";
import { useDictionaries } from "../store/dictionaries";
import type { PresetsFile } from "../types/dictionaries";

// Панель «Транскрибация»: форма запуска sidecar-пайплайна + прогресс.
// Результат открывается во вкладке «Транскрипт» (там замены/саммари).
export function TranscribePanel() {
  const s = useTranscribe();
  const running = s.running;

  // Пресеты из presets.yaml (kind "presets" файлового контракта).
  // Подписка на стабильный entry (урок LESSONS §3), производный массив —
  // в useMemo.
  const presetsEntry = useDictionaries((st) =>
    st.entries.find((e) => e.kind === "presets"),
  );
  const presets = useMemo(
    () => (presetsEntry?.data as PresetsFile | undefined)?.presets ?? [],
    [presetsEntry],
  );

  const applyPreset = (id: string) => {
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    if (preset.engine) s.setEngine(preset.engine as TranscribeEngine);
    if (preset.model_dir) s.setModelDir(preset.model_dir);
    s.setMaxSpeakers(preset.max_speakers ?? null);
  };

  const progressPct = (() => {
    if (!running || !s.stage || !s.stageProgress || s.stageProgress.n === 0) return null;
    const { i, n } = s.stageProgress;
    return Math.round((i / n) * 100);
  })();

  return (
    <div className="transcribe-panel">
      {presets.length > 0 && (
        <div className="transcribe-row">
          <label className="transcribe-label">Пресет</label>
          <select
            className="transcribe-select"
            defaultValue=""
            disabled={running}
            onChange={(e) => applyPreset(e.target.value)}
          >
            <option value="">— вручную —</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="transcribe-row">
        <label className="transcribe-label">Видеофайл</label>
        <input
          className="transcribe-input"
          value={s.inputPath}
          placeholder="путь к webm/mp4/mp3/wav…"
          onChange={(e) => s.setInputPath(e.target.value)}
          disabled={running}
        />
        <button
          className="transcribe-btn"
          disabled={running}
          onClick={async () => {
            const picked = await open({
              multiple: false,
              filters: [
                {
                  name: "Видео/аудио",
                  extensions: ["webm", "mkv", "mp4", "m4a", "mp3", "ogg", "opus", "flac", "wav"],
                },
              ],
            });
            if (typeof picked === "string") s.setInputPath(picked);
          }}
        >
          Выбрать…
        </button>
      </div>

      <div className="transcribe-row">
        <label className="transcribe-label">Каталог моделей</label>
        <input
          className="transcribe-input"
          value={s.modelDir}
          placeholder="…​/models/parakeet-tdt-0.6b-v3-int8"
          onChange={(e) => s.setModelDir(e.target.value)}
          disabled={running}
        />
        <button
          className="transcribe-btn"
          disabled={running}
          title="Найти каталог моделей AivoRelay"
          onClick={() => void s.detectAivoModels()}
        >
          AivoRelay
        </button>
      </div>

      <div className="transcribe-row">
        <label className="transcribe-label">Движок</label>
        <select
          className="transcribe-select"
          value={s.engine}
          disabled={running}
          onChange={(e) => s.setEngine(e.target.value as "parakeet" | "gigaam")}
        >
          <option value="parakeet">parakeet-v3 (таймкоды, спикеры)</option>
          <option value="gigaam">gigaam-v3 (только текст, ru)</option>
        </select>
        <label className="transcribe-label transcribe-inline">
          Лимит, с
          <input
            className="transcribe-num"
            type="number"
            min={0}
            value={s.limitSecs ?? ""}
            placeholder="—"
            disabled={running}
            onChange={(e) => s.setLimitSecs(e.target.value ? Number(e.target.value) : null)}
          />
        </label>
        <label className="transcribe-label transcribe-inline">
          Макс. спикеров
          <input
            className="transcribe-num"
            type="number"
            min={0}
            max={255}
            value={s.maxSpeakers ?? ""}
            placeholder="авто"
            disabled={running}
            onChange={(e) => s.setMaxSpeakers(e.target.value ? Number(e.target.value) : null)}
          />
        </label>
      </div>

      <div className="transcribe-row">
        {running ? (
          <button className="transcribe-btn danger" onClick={() => void s.cancel()}>
            Отменить
          </button>
        ) : (
          <button
            className="transcribe-btn primary"
            disabled={!s.inputPath || !s.modelDir}
            onClick={() => void s.start()}
          >
            Транскрибировать
          </button>
        )}
        {running && s.stage && (
          <span className="transcribe-progress-text">
            {stageLabel(s.stage)}
            {s.stageProgress && s.stageProgress.n > 1
              ? ` — ${s.stageProgress.i}/${s.stageProgress.n}`
              : ""}
            {progressPct !== null ? ` (${progressPct}%)` : ""}
          </span>
        )}
        {progressPct !== null && (
          <div className="transcribe-progress">
            <div className="transcribe-progress-fill" style={{ width: `${progressPct}%` }} />
          </div>
        )}
      </div>

      {s.error && <div className="transcribe-error">{s.error}</div>}
      {s.summary && <div className="transcribe-summary">{s.summary}</div>}

      <p className="transcribe-hint">
        Модели ASR не скачиваются автоматически: кнопка «AivoRelay» подставит
        каталог уже установленного AivoRelay, либо укажите путь вручную
        (инструкция — -=docs=-/-=tasks=-/2026-10-18/20261018_005_model_files_paths.md).
        Диаризация требует 9 файлов в %LOCALAPPDATA%\polyvoice\models.
      </p>
    </div>
  );
}
