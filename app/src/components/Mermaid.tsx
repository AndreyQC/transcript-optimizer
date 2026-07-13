import { useEffect, useId, useState } from "react";
import mermaid from "mermaid";

// Инициализация mermaid один раз при первом импорте. `startOnLoad: false` —
// рендерим диаграммы вручную через mermaid.render() в компоненте.
mermaid.initialize({
  startOnLoad: false,
  theme: "default",
  securityLevel: "loose", // разрешаем клики/интерактив в диаграммах (MVP).
});

// Рендер одной Mermaid-диаграммы из ```mermaid-блока. Принимает исходник диаграммы
// (без ограды). При ошибке парсинга показывает исходник + сообщение об ошибке.
export function Mermaid({ chart }: { chart: string }) {
  // useId даёт стабильный уникальный id для mermaid.render (иначе несколько
  // диаграмм на странице конфликтуют по id).
  const rawId = useId();
  // mermaid требует id без спецсимволов — чистим до alphanumeric/dash.
  const id = `mmd-${rawId.replace(/[^a-zA-Z0-9]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const trimmed = chart.trim();
        if (trimmed.length === 0) {
          setSvg("");
          setError(null);
          return;
        }
        const { svg: rendered } = await mermaid.render(id, trimmed);
        if (!cancelled) {
          setSvg(rendered);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          // mermaid.render при ошибке бросает с сообщением; показываем исходник.
          setSvg(null);
          setError(String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chart, id]);

  if (error) {
    return (
      <div className="mermaid-block mermaid-error">
        <div className="mermaid-error-title">Ошибка Mermaid:</div>
        <pre>{chart}</pre>
        <code className="mermaid-error-msg">{error}</code>
      </div>
    );
  }

  if (svg === null) {
    return <div className="mermaid-block mermaid-loading">Рендер диаграммы…</div>;
  }

  return (
    <div
      className="mermaid-block"
      // SVG из mermaid — доверенный, рендерим через dangerouslySetInnerHTML.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
