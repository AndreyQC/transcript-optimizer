import { useDictionaries } from "../store/dictionaries";
import {
  KIND_LABEL,
  TAB_ORDER,
  type DictKind,
} from "../types/dictionaries";

// Вкладки словарей. Порядок фиксирован (TAB_ORDER); show только распознанные.
export function DictionaryTabs() {
  const entries = useDictionaries((s) => s.entries);
  const activeKind = useDictionaries((s) => s.activeKind);
  const setActive = useDictionaries((s) => s.setActive);

  const presentKinds = new Set(entries.map((e) => e.kind));
  const visibleTabs = TAB_ORDER.filter((k) => presentKinds.has(k));

  if (visibleTabs.length === 0) return null;

  return (
    <nav className="tabs">
      {visibleTabs.map((kind: DictKind) => (
        <button
          key={kind}
          className={kind === activeKind ? "tab active" : "tab"}
          onClick={() => setActive(kind)}
        >
          {KIND_LABEL[kind]}
          {entries.find((e) => e.kind === kind)?.dirty ? " *" : ""}
        </button>
      ))}
    </nav>
  );
}
