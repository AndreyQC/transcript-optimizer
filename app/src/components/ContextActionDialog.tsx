import { useMemo, useState, useEffect } from "react";
import {
  addEntry,
  type AddEntryInput,
} from "../lib/yaml-edit";
import { useDictionaries, getGlossaryCategories } from "../store/dictionaries";
import {
  ACTION_HINT,
  ACTION_LABEL,
  type ContextAction,
  type Selection,
} from "./contextMenuActions";
import type { DictKind } from "../types/dictionaries";

// Превью diff: какие строки добавились/удалились (переиспользуем логику EditPanel).
function computeDiff(before: string, after: string) {
  const a = before.split("\n");
  const b = after.split("\n");
  const out: { sign: "+" | "-" | " "; text: string }[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    const la = a[i] ?? null;
    const lb = b[i] ?? null;
    if (la === lb) out.push({ sign: " ", text: la ?? "" });
    else {
      if (la !== null) out.push({ sign: "-", text: la });
      if (lb !== null) out.push({ sign: "+", text: lb });
    }
  }
  return out;
}

interface Props {
  action: ContextAction | null;
  selection: Selection | null;
  onClose: () => void;
}

// Модалка действия контекстного меню. Для replace требует to + label,
// для lemma — значение леммы, остальные — подтверждение по выделению.
export function ContextActionDialog({ action, selection, onClose }: Props) {
  const entries = useDictionaries((s) => s.entries);
  const applyEdit = useDictionaries((s) => s.applyEdit);
  const cats = useMemo(() => getGlossaryCategories(entries), [entries]);

  // Локальные поля формы.
  const [to, setTo] = useState("");
  const [label, setLabel] = useState("");
  const [lemma, setLemma] = useState("");
  const [err, setErr] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [pendingBefore, setPendingBefore] = useState("");
  const [done, setDone] = useState(false);

  // Сброс формы при смене действия.
  useEffect(() => {
    if (action) {
      setTo("");
      setLabel("");
      setLemma("");
      setErr("");
      setPending(null);
      setPendingBefore("");
      setDone(false);
    }
  }, [action]);

  if (!action || !selection) return null;

  // Какой словарь правит это действие.
  function targetKind(a: ContextAction): DictKind {
    switch (a) {
      case "whitelist":
        return "whitelist";
      case "filler_word":
      case "filler_phrase":
      case "keep":
        return "filler";
      case "replace":
        return "replacements";
      case "lemma":
        return "lemma_irregular";
    }
  }

  // Построить AddEntryInput для текущего действия и формы.
  function buildInput(a: ContextAction, sel: Selection): AddEntryInput | null {
    switch (a) {
      case "whitelist":
        return { kind: "whitelist", value: sel.text };
      case "filler_word":
        return { kind: "filler", section: "filler_words", value: sel.text };
      case "filler_phrase":
        return { kind: "filler", section: "filler_phrases", value: sel.text };
      case "keep":
        return { kind: "filler", section: "keep_override", value: sel.text };
      case "replace": {
        if (!to.trim()) return null;
        if (!label.trim()) return null;
        return {
          kind: "replacements",
          to: to.trim(),
          label: label.trim(),
          from: [sel.text],
        };
      }
      case "lemma": {
        if (!lemma.trim()) return null;
        return { kind: "lemma_irregular", key: sel.text, value: lemma.trim() };
      }
    }
  }

  function handlePreview() {
    setErr("");
    const input = buildInput(action!, selection!);
    if (!input) {
      setErr(
        action === "replace"
          ? "Заполните to и выберите категорию (label)."
          : "Укажите лемму.",
      );
      return;
    }
    const kind = targetKind(action!);
    const entry = entries.find((e) => e.kind === kind);
    if (!entry) {
      setErr(`Словарь ${kind} не открыт.`);
      return;
    }
    const res = addEntry(entry.raw, input);
    if (!res.ok) {
      setErr(res.error ?? "ошибка");
      setPending(null);
      return;
    }
    setPendingBefore(entry.raw);
    setPending(res.raw);
  }

  function handleApply() {
    if (!pending) return;
    const kind = targetKind(action!);
    applyEdit(kind, pending);
    setDone(true);
    // Автозакрытие после короткой паузы.
    setTimeout(() => onClose(), 400);
  }

  return (
    <div className="ctx-backdrop" onClick={onClose}>
      <div
        className="ctx-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="ctx-header">
          <h3>{ACTION_LABEL[action]}</h3>
          <button className="ctx-close" onClick={onClose} aria-label="Закрыть">
            ✕
          </button>
        </div>

        <div className="ctx-target">
          <span className="ctx-target-label">Выделено:</span>
          <code className="ctx-target-value">{selection.text}</code>
        </div>
        <div className="ctx-hint">{ACTION_HINT[action]}</div>

        {action === "replace" && (
          <div className="ctx-form">
            <label>
              to (канонический термин)
              <input
                value={to}
                onChange={(e) => setTo(e.target.value)}
                autoFocus
              />
            </label>
            <label>
              label (категория глоссария)
              <select value={label} onChange={(e) => setLabel(e.target.value)}>
                <option value="">— выбрать —</option>
                {[...cats].map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {action === "lemma" && (
          <div className="ctx-form">
            <label>
              лемма (каноническая форма)
              <input
                value={lemma}
                onChange={(e) => setLemma(e.target.value)}
                autoFocus
              />
            </label>
          </div>
        )}

        {err && <div className="edit-err">{err}</div>}

        <div className="ctx-actions">
          <button onClick={handlePreview} className="btn">
            Превью
          </button>
          {pending && !done && (
            <button onClick={handleApply} className="btn">
              Применить
            </button>
          )}
          {pending && !done && (
            <button onClick={() => setPending(null)} className="btn">
              Отмена превью
            </button>
          )}
          {done && <span className="ctx-done">✓ Применено (undo доступен)</span>}
        </div>

        {pending && (
          <div className="edit-diff">
            <h4>Предпросмотр diff</h4>
            <pre>
              {computeDiff(pendingBefore, pending)
                .slice(0, 60)
                .map((l, i) => (
                  <div key={i} className={`diff-line diff-${l.sign}`}>
                    {l.sign} {l.text}
                  </div>
                ))}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
