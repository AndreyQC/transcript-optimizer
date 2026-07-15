import { useMemo, useState } from "react";
import {
  useDictionaries,
  getGlossaryCategories,
  getSimilarityThresholds,
} from "../store/dictionaries";
import {
  addEntry,
  deleteEntry,
  dedupByTo,
  findRuleLine,
  type AddEntryInput,
} from "../lib/yaml-edit";
import { findSimilar } from "../lib/similarity";
import {
  SimilarFromPanel,
  buildFromPool,
  type SimilarCandidateRow,
} from "./SimilarFromPanel";
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
  const setActive = useDictionaries((s) => s.setActive);
  const setPendingScroll = useDictionaries((s) => s.setPendingScroll);
  const canUndo = useDictionaries((s) =>
    activeKind ? (s.undoState.stacks[activeKind] ?? []).length > 0 : false,
  );
  // Set категорий вычисляем в useMemo (селектор с новым Set ломает ре-рендер).
  const entries = useDictionaries((s) => s.entries);
  const cats = useMemo(() => getGlossaryCategories(entries), [entries]);
  const thresholds = useMemo(() => getSimilarityThresholds(entries), [entries]);

  const [form, setForm] = useState<FormState>(empty);
  const [pending, setPending] = useState<string | null>(null); // превью нового raw
  const [pendingBefore, setPendingBefore] = useState<string>("");
  const [err, setErr] = useState<string>("");

  // Режим «append to existing rule» — кнопка «Добавить в это правило».
  // Здесь хранится и контекст: какое именно значение из from[] пытаемся дописать.
  const [appendTarget, setAppendTarget] = useState<{
    ruleKey: string;
    section: "from" | "from_lemmas";
    newFrom: string; // какое именно from из ввода пользователя дописываем
  } | null>(null);
  // «Игнорировать» — помнит на время жизни компонента (на активной вкладке).
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  function handleUndo() {
    if (!activeKind) return;
    const ok = undoFn(activeKind);
    if (!ok) setErr("Нечего отменять");
  }

  // Дедупликация по `to` (см. 20260715_003_dedup_by_to.md).
  // Сравнение идёт по lowercase+trim; первое правило по ключу побеждает,
  // остальные удаляются. Через существующий pending/Превью/Применить —
  // никаких новых кнопок в форме.
  function handleDedup() {
    setErr("");
    if (!activeEntry) return;
    const res = dedupByTo(activeEntry.raw);
    if (!res.ok) {
      setErr(res.error ?? "ошибка дедупликации");
      setPending(null);
      return;
    }
    if (res.noop) {
      setErr("Дублей по to нет — словарь чист");
      setPending(null);
      return;
    }
    setPendingBefore(activeEntry.raw);
    setPending(res.raw);
  }

  // Список существующих записей для удаления (только replacements/glossary).
  // Для replacements и lemma_replacements элемент — { key, to? }, чтобы в UI
  // вывести «rule_key (to)» (фича 2026-07-15: показ канонической формы рядом).
  // Для glossary и lemma_irregular — строки (там `to` нет).
  type ListItem = string | { key: string; to?: string };
  const existingKeys = useMemo<ListItem[]>(() => {
    if (!activeEntry?.data) return [];
    const d = activeEntry.data as Record<string, unknown>;
    if (activeKind === "replacements") {
      const out: ListItem[] = [];
      const r = (d.replacements as Record<string, { to?: string }>) ?? {};
      for (const [k, rule] of Object.entries(r)) {
        out.push({ key: k, to: rule.to });
      }
      const l = (d.lemma_replacements as Record<string, { to?: string }>) ?? {};
      for (const [k, rule] of Object.entries(l)) {
        out.push({ key: `${k} (lemma)`, to: rule.to });
      }
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

  // Похожие `from` — берём ПЕРВОЕ непустое значение из формы (то, что
  // пользователь сейчас вводит через запятую). Если введено несколько — мы
  // предупреждаем только по первому (UX-компромисс: split+zip был бы шумным).
  // Только для replacements — для glossary/lemma_irregular панель не нужна.
  const similarRows = useMemo<SimilarCandidateRow[]>(() => {
    if (activeKind !== "replacements") return [];
    const firstInputFrom = form.from
      .split(",")
      .map((s) => s.trim())
      .find(Boolean);
    if (!firstInputFrom) return [];
    const section: "from" | "from_lemmas" = form.isLemma ? "from_lemmas" : "from";
    const pool = buildFromPool(entries, section);
    if (pool.length === 0) return [];
    const isPhrase = firstInputFrom.includes(" ");
    const threshold = isPhrase ? thresholds.phrase : thresholds.word;
    const hits = findSimilar(firstInputFrom, pool, threshold);
    return hits.map((h) => ({
      ruleKey: h.sourceKey,
      to: h.to,
      value: h.candidate.valueNorm,
      section,
      score: h.score,
    }));
  }, [activeKind, form.from, form.isLemma, entries, thresholds]);

  // Отфильтрованный (по dismissed) список для панели.
  const visibleSimilarRows = similarRows.filter((r) => !dismissed.has(r.ruleKey));

  function buildAddInput(): AddEntryInput | null {
    if (!activeKind) return null;
    switch (activeKind) {
      case "replacements": {
        // Режим append: вместо создания нового правила — дописать первое from в
        // существующее правило. Остальные from отбрасываются (по одному — это
        // соответствует UX-кнопке «Добавить в это правило»).
        if (appendTarget) {
          const trimmed = appendTarget.newFrom.trim();
          if (!trimmed) return null;
          return {
            kind: "replacements",
            appendFromToRule: appendTarget.ruleKey,
            appendFromSection: appendTarget.section,
            from: [trimmed],
          };
        }
        return {
          kind: "replacements",
          isLemma: form.isLemma,
          to: form.to.trim(),
          label: form.label.trim(),
          description: form.description.trim() || undefined,
          from: form.from.split(",").map((s) => s.trim()).filter(Boolean),
        };
      }
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
    setAppendTarget(null);
    setDismissed(new Set());
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
        {activeKind === "replacements" && (
          <button
            onClick={handleDedup}
            className="btn-mini"
            disabled={!!pending || !activeEntry}
            title="Слить правила с одинаковым `to` (lowercase+trim; первое по ключу побеждает)"
          >
            ⚙ Дедуплицировать
          </button>
        )}
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

                {appendTarget && (
                  <div className="edit-append-info">
                    Будет дописано в правило <code>{appendTarget.ruleKey}</code>
                    <button
                      type="button"
                      className="btn btn-mini"
                      onClick={() => {
                        setAppendTarget(null);
                        setPending(null);
                      }}
                    >
                      Отмена (вернуться к «создать новое»)
                    </button>
                  </div>
                )}

                {/* Панель похожих from — только когда не в append-режиме. */}
                {!appendTarget && (
                  <SimilarFromPanel
                    scope="edit"
                    rows={visibleSimilarRows}
                    onAppend={(row) => {
                      const firstInput = form.from
                        .split(",")
                        .map((s) => s.trim())
                        .find(Boolean);
                      if (!firstInput) {
                        setErr("Введите from для добавления в существующее правило");
                        return;
                      }
                      setErr("");
                      setAppendTarget({
                        ruleKey: row.ruleKey,
                        section: row.section,
                        newFrom: firstInput,
                      });
                      setPending(null);
                    }}
                    onOpen={(row) => {
                      const entry = entries.find((e) => e.kind === "replacements");
                      if (!entry) return;
                      const line = findRuleLine(entry.raw, row.ruleKey);
                      setActive("replacements");
                      if (line !== null) {
                        setPendingScroll("replacements", row.ruleKey, line);
                      }
                    }}
                    onDismiss={(ruleKey) => {
                      const next = new Set(dismissed);
                      next.add(ruleKey);
                      setDismissed(next);
                    }}
                  />
                )}
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
            {existingKeys.map((it, idx) => {
              // Для replacements/lemma_replacements — { key, to? }, иначе строка.
              const key = typeof it === "string" ? it : it.key;
              const to = typeof it === "string" ? undefined : it.to;
              return (
                <li key={`${key}:${idx}`}>
                  <span>
                    {key}
                    {to ? (
                      <>
                        {" "}
                        (<code>{to}</code>)
                      </>
                    ) : null}
                  </span>
                  <button onClick={() => handleDelete(key)} className="btn-mini">
                    ✕
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </aside>
  );
}
