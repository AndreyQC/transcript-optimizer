// Агент предложений по словарю (Phase 10 §10.8): чеклист OOV-кандидатов
// по текущему транскрипту. Агент не пишет в словарь сам — выбранные
// применения уходят в pending/Превью/Применить родительского EditPanel.

import { useMemo, useState } from "react";
import { useDictionaries } from "../store/dictionaries";
import { useTranscript } from "../store/transcript";
import { addEntry } from "../lib/yaml-edit";
import { norm } from "../engine/tokenizer";
import { buildProposals, type Proposal } from "../lib/proposals";
import type {
  FillerFile,
  GlossaryFile,
  ReplacementsFile,
} from "../types/dictionaries";

export function AgentProposals({
  onApply,
  busy,
}: {
  // onApply(newRaw) — кладёт результат в pending родителя.
  onApply: (before: string, after: string) => void;
  busy: boolean;
}) {
  const transcript = useTranscript((s) => s.transcript);
  const cleanResult = useTranscript((s) => s.cleanResult);
  const entries = useDictionaries((s) => s.entries);
  const setActive = useDictionaries((s) => s.setActive);

  const [open, setOpen] = useState(false);
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [toMap, setToMap] = useState<Record<string, string>>({});
  const [label, setLabel] = useState<string>("");
  const [err, setErr] = useState<string>("");

  // Входы агента: стабильные ссылки, производное — в useMemo (LESSONS §3).
  const repEntry = entries.find((e) => e.kind === "replacements");
  const fillerData = entries.find((e) => e.kind === "filler")?.data as
    | FillerFile
    | undefined;
  const glossaryData = entries.find((e) => e.kind === "glossary")?.data as
    | GlossaryFile
    | undefined;

  const existingFrom = useMemo(() => {
    const rep = repEntry?.data as ReplacementsFile | undefined;
    if (!rep?.replacements) return [] as string[];
    return Object.values(rep.replacements).flatMap((r) =>
      (r.from ?? []).map((f) => norm(f).replace(/\s+/g, " ").trim()),
    );
  }, [repEntry]);

  const phraseNorms = useMemo(() => {
    const phrases = (fillerData?.filler_phrases ?? []).concat(
      Object.values((repEntry?.data as ReplacementsFile | undefined)?.replacements ?? {}).flatMap(
        (r) => r.from ?? [],
      ),
    );
    return phrases
      .map((p) => norm(p).replace(/\s+/g, " ").trim())
      .filter((p) => p.includes(" "));
  }, [fillerData, repEntry]);

  const categories = useMemo(
    () => Object.keys(glossaryData?.categories ?? {}),
    [glossaryData],
  );

  function collect() {
    setErr("");
    if (!cleanResult) {
      setErr("Сначала откройте транскрипт и примените «Очистить»");
      return;
    }
    const list = buildProposals(
      cleanResult,
      transcript?.parsed ?? null,
      phraseNorms,
      existingFrom,
    );
    setProposals(list);
    setChecked(new Set());
    setToMap({});
    if (categories.length > 0 && !label) setLabel(categories[0]);
  }

  function apply() {
    setErr("");
    if (!repEntry) {
      setErr("replacements.yaml не открыт");
      return;
    }
    const chosen = (proposals ?? []).filter(
      (p) => checked.has(p.from) && (toMap[p.from] ?? "").trim() !== "",
    );
    if (chosen.length === 0) {
      setErr("Не выбрано ни одного предложения с заполненным `to`");
      return;
    }
    if (!label) {
      setErr("Укажите категорию (label) для новых правил");
      return;
    }
    let raw = repEntry.raw;
    for (const p of chosen) {
      const res = addEntry(raw, {
        kind: "replacements",
        to: toMap[p.from].trim(),
        label,
        from: [p.from],
      });
      if (!res.ok) {
        setErr(res.error ?? `ошибка добавления «${p.from}»`);
        return;
      }
      raw = res.raw;
    }
    onApply(repEntry.raw, raw);
    setActive("replacements");
    setProposals(null);
  }

  if (!open) {
    return (
      <button className="btn-mini" onClick={() => setOpen(true)}>
        🤖 Предложения агента
      </button>
    );
  }

  return (
    <div className="agent-proposals">
      <div className="agent-proposals-header">
        <strong>Предложения агента</strong>
        <button className="btn-mini" onClick={() => setOpen(false)}>
          Свернуть
        </button>
      </div>
      <p className="transcribe-hint">
        Кандидаты из OOV текущего транскрипта. Заполните «to», отметьте
        нужное — применения пойдут через Превью (undo работает как обычно).
      </p>
      <div className="transcribe-row">
        <button className="btn-mini" onClick={collect} disabled={busy}>
          Собрать предложения
        </button>
        {categories.length > 0 && (
          <label className="transcribe-inline">
            категория
            <select value={label} onChange={(e) => setLabel(e.target.value)}>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {err && <div className="transcribe-error">{err}</div>}
      {proposals && proposals.length === 0 && (
        <p className="transcribe-hint">OOV-кандидатов нет — словарь покрывает текст.</p>
      )}
      {proposals && proposals.length > 0 && (
        <>
          <div className="agent-list">
            {proposals.map((p) => (
              <div key={p.from} className="agent-row">
                <input
                  type="checkbox"
                  checked={checked.has(p.from)}
                  onChange={(e) => {
                    const next = new Set(checked);
                    if (e.target.checked) next.add(p.from);
                    else next.delete(p.from);
                    setChecked(next);
                  }}
                />
                <span className="agent-from" title={p.from}>
                  {p.from} ×{p.count}
                  {p.similar.length > 0 && (
                    <em className="agent-similar"> ≈ {p.similar.join(", ")}</em>
                  )}
                </span>
                <span className="agent-arrow">→</span>
                <input
                  className="agent-to"
                  placeholder="to"
                  value={toMap[p.from] ?? ""}
                  onChange={(e) =>
                    setToMap({ ...toMap, [p.from]: e.target.value })
                  }
                />
              </div>
            ))}
          </div>
          <div className="transcribe-row">
            <button className="btn-mini" onClick={apply} disabled={busy}>
              Добавить выбранное ({checked.size})
            </button>
          </div>
        </>
      )}
    </div>
  );
}
