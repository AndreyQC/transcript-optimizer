import { useMemo, useState } from "react";
import { useDictionaries, selectGlossaryCategories } from "../store/dictionaries";
import {
  addEntry,
  deleteEntry,
  type AddEntryInput,
} from "../lib/yaml-edit";
import type { DictKind } from "../types/dictionaries";

// Превью diff: какие строки добавились/удалились.
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

// Поля формы по kind. Упрощённая модель — для этапа 1 достаточно.
interface FormState {
  to: string;
  label: string;
  description: string;
  from: string; // ввод через запятую
  id: string;
  title: string;
  value: string;
  key: string;
  isLemma: boolean;
}

const empty: FormState = {
  to: "",
  label: "",
  description: "",
  from: "",
  id: "",
  title: "",
  value: "",
  key: "",
  isLemma: false,
};

export function EditPanel() {
  const activeKind = useDictionaries((s) => s.activeKind);
  const activeEntry = useDictionaries((s) =>
    s.entries.find((e) => e.kind === activeKind),
  );
  const applyEdit = useDictionaries((s) => s.applyEdit);
  const undoFn = useDictionaries((s) => s.undo);
  const canUndo = useDictionaries((s) =>
    activeKind ? (s.undoState.stacks[activeKind] ?? []).length > 0 : false,
  );
  const cats = useDictionaries(selectGlossaryCategories);

  const [form, setForm] = useState<FormState>(empty);
  const [pending, setPending] = useState<string | null>(null); // превью нового raw
  const [pendingBefore, setPendingBefore] = useState<string>("");
  const [err, setErr] = useState<string>("");

  function handleUndo() {
    if (!activeKind) return;
    const ok = undoFn(activeKind);
    if (!ok) setErr("Нечего отменять");
  }

  // Список существующих записей для удаления (упрощённо: только replacements/glossary).
  const existingKeys = useMemo<string[]>(() => {
    if (!activeEntry?.data) return [];
    const d = activeEntry.data as Record<string, unknown>;
    if (activeKind === "replacements") {
      const out: string[] = [];
      const r = (d.replacements as Record<string, unknown>) ?? {};
      const l = (d.lemma_replacements as Record<string, unknown>) ?? {};
      out.push(...Object.keys(r).map((k) => k));
      out.push(...Object.keys(l).map((k) => `${k} (lemma)`));
      return out;
    }
    if (activeKind === "glossary") {
      return Object.keys((d.categories as Record<string, unknown>) ?? {});
    }
    if (activeKind === "lemma_irregular") {
      return Object.keys((d.lemma_irregular as Record<string, unknown>) ?? {});
    }
    return [];
  }, [activeEntry, activeKind]);

  function buildAddInput(): AddEntryInput | null {
    if (!activeKind) return null;
    switch (activeKind) {
      case "replacements":
        return {
          kind: "replacements",
          isLemma: form.isLemma,
          to: form.to.trim(),
          label: form.label.trim(),
          description: form.description.trim() || undefined,
          from: form.from.split(",").map((s) => s.trim()).filter(Boolean),
        };
      case "glossary":
        return {
          kind: "glossary",
          id: form.id.trim(),
          title: form.title.trim(),
          description: form.description.trim() || undefined,
        };
      case "lemma_irregular":
        return {
          kind: "lemma_irregular",
          key: form.key.trim(),
          value: form.value.trim(),
        };
      default:
        return null;
    }
  }

  function handlePreview() {
    setErr("");
    if (!activeEntry) return;
    const input = buildAddInput();
    if (!input) return;
    const res = addEntry(activeEntry.raw, input);
    if (!res.ok) {
      setErr(res.error ?? "ошибка");
      setPending(null);
      return;
    }
    setPendingBefore(activeEntry.raw);
    setPending(res.raw);
  }

  function handleApply() {
    if (!activeKind || !pending) return;
    applyEdit(activeKind, pending);
    setForm(empty);
    setPending(null);
  }

  function handleDelete(key: string) {
    if (!activeEntry || !activeKind) return;
    const isLemma = key.endsWith(" (lemma)");
    const realKey = isLemma ? key.replace(" (lemma)", "") : key;
    const res = deleteEntry(activeEntry.raw, {
      kind: activeKind,
      key: realKey,
      isLemma,
    });
    if (res.ok) applyEdit(activeKind, res.raw);
    else setErr(res.error ?? "ошибка удаления");
  }

  if (!activeEntry || !activeKind) return null;

  const kind = activeKind as DictKind;
  const showForm = kind === "replacements" || kind === "glossary" || kind === "lemma_irregular";

  return (
    <aside className="edit-panel">
      <div className="edit-panel-header">
        <h3>Правка словаря</h3>
        <button
          onClick={handleUndo}
          className="btn-mini btn-undo"
          disabled={!canUndo}
          title="Отменить последнюю структурную правку"
        >
          ↶ Undo
        </button>
      </div>
      {err && <div className="edit-err">{err}</div>}

      {showForm && (
        <>
          <div className="edit-form">
            {kind === "replacements" && (
              <>
                <label>
                  lemma-правило?
                  <input
                    type="checkbox"
                    checked={form.isLemma}
                    onChange={(e) => setForm({ ...form, isLemma: e.target.checked })}
                  />
                </label>
                <label>
                  to (канонический термин)
                  <input value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />
                </label>
                <label>
                  label (категория)
                  <select
                    value={form.label}
                    onChange={(e) => setForm({ ...form, label: e.target.value })}
                  >
                    <option value="">— выбрать —</option>
                    {[...cats].map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </label>
                <label>
                  description (опц.)
                  <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
                </label>
                <label>
                  {form.isLemma ? "from_lemmas (через запятую)" : "from (через запятую)"}
                  <input value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />
                </label>
              </>
            )}
            {kind === "glossary" && (
              <>
                <label>
                  id (snake_case)
                  <input value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} />
                </label>
                <label>
                  title
                  <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
                </label>
                <label>
                  description (опц.)
                  <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
                </label>
              </>
            )}
            {kind === "lemma_irregular" && (
              <>
                <label>
                  слово (flexia)
                  <input value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} />
                </label>
                <label>
                  лемма
                  <input value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
                </label>
              </>
            )}
            <div className="edit-actions">
              <button onClick={handlePreview} className="btn">Превью</button>
              {pending && <button onClick={handleApply} className="btn">Применить</button>}
              {pending && <button onClick={() => setPending(null)} className="btn">Отмена</button>}
            </div>
          </div>

          {pending && (
            <div className="edit-diff">
              <h4>Предпросмотр diff</h4>
              <pre>
                {computeDiff(pendingBefore, pending).slice(0, 60).map((l, i) => (
                  <div key={i} className={`diff-line diff-${l.sign}`}>{l.sign} {l.text}</div>
                ))}
              </pre>
            </div>
          )}
        </>
      )}

      {existingKeys.length > 0 && (
        <div className="edit-list">
          <h4>Записи ({existingKeys.length})</h4>
          <ul>
            {existingKeys.map((k) => (
              <li key={k}>
                <span>{k}</span>
                <button onClick={() => handleDelete(k)} className="btn-mini">✕</button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}
