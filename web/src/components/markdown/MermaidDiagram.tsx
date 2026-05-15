import { useEffect, useId, useRef, useState } from "react";

type MermaidStatus = "idle" | "rendered" | "error";
const PNG_EXPORT_SCALE = 4;

interface MermaidDiagramProps {
  chart: string;
}

let mermaidPromise: Promise<typeof import("mermaid")> | null = null;
let initialized = false;

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid");
  }
  return mermaidPromise;
}

export function MermaidDiagram({ chart }: MermaidDiagramProps) {
  const reactId = useId();
  const diagramRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<MermaidStatus>("idle");
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  const [downloadError, setDownloadError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const renderId = `mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;

    async function renderDiagram() {
      const source = chart.trim();
      if (!source) {
        setStatus("error");
        setError("Empty Mermaid diagram.");
        setSvg("");
        return;
      }

      try {
        const { default: mermaid } = await loadMermaid();
        if (!initialized) {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            theme: "neutral",
            flowchart: { htmlLabels: false },
          });
          initialized = true;
        }

        const { svg: renderedSvg } = await mermaid.render(renderId, source);
        if (!cancelled) {
          setSvg(renderedSvg);
          setError("");
          setDownloadError("");
          setStatus("rendered");
        }
      } catch (err) {
        if (!cancelled) {
          setSvg("");
          setError(err instanceof Error ? err.message : "Failed to render Mermaid diagram.");
          setStatus("error");
        }
      }
    }

    setStatus("idle");
    setError("");
    setSvg("");
    void renderDiagram();

    return () => {
      cancelled = true;
    };
  }, [chart, reactId]);

  const getDownloadableSvg = () => {
    const svgElement = diagramRef.current?.querySelector("svg");
    const clonedSvg = svgElement?.cloneNode(true) as SVGSVGElement | undefined;
    clonedSvg?.querySelectorAll("image, script, iframe, foreignObject").forEach((node) => node.remove());
    clonedSvg?.querySelectorAll("*").forEach((node) => {
      [...node.attributes].forEach((attribute) => {
        const value = attribute.value.trim();
        if (/^https?:\/\//i.test(value)) {
          node.removeAttribute(attribute.name);
        }
      });
    });

    if (clonedSvg) {
      const viewBox = clonedSvg.viewBox.baseVal;
      const fallbackWidth = Math.ceil(svgElement?.getBoundingClientRect().width || 1200);
      const fallbackHeight = Math.ceil(svgElement?.getBoundingClientRect().height || 800);
      const exportWidth = Math.ceil(viewBox?.width || fallbackWidth);
      const exportHeight = Math.ceil(viewBox?.height || fallbackHeight);
      clonedSvg.setAttribute("width", String(exportWidth));
      clonedSvg.setAttribute("height", String(exportHeight));
      if (!clonedSvg.getAttribute("viewBox")) {
        clonedSvg.setAttribute("viewBox", `0 0 ${exportWidth} ${exportHeight}`);
      }

      const exportStyle = document.createElementNS("http://www.w3.org/2000/svg", "style");
      exportStyle.textContent = `
        text, tspan { font-family: Arial, Helvetica, sans-serif; paint-order: stroke; }
        .nodeLabel, .edgeLabel, .label, .labelText { font-family: Arial, Helvetica, sans-serif; }
      `;
      clonedSvg.insertBefore(exportStyle, clonedSvg.firstChild);
    }

    const serializedSvg = clonedSvg ? new XMLSerializer().serializeToString(clonedSvg) : svg;
    const withNamespace = serializedSvg.includes("xmlns=")
      ? serializedSvg
      : serializedSvg.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');

    return withNamespace.replace(/<br([^/>]*)>/gi, "<br$1 />");
  };

  const downloadSvg = () => {
    if (!svg) return;
    setDownloadError("");
    const blob = new Blob([getDownloadableSvg()], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "diagram.svg";
    link.click();
    URL.revokeObjectURL(url);
  };

  const downloadPng = async () => {
    if (!svg) return;

    setDownloadError("");

    const image = new Image();
    const normalizedSvg = getDownloadableSvg();
    const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(normalizedSvg)}`;

    try {
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("Failed to load rendered SVG."));
        image.src = svgUrl;
      });

      const exportedSvg = new DOMParser().parseFromString(normalizedSvg, "image/svg+xml").documentElement;
      const viewBox = exportedSvg.getAttribute("viewBox")?.split(/\s+/).map(Number);
      const parsedWidth = parseFloat(exportedSvg.getAttribute("width") || "");
      const parsedHeight = parseFloat(exportedSvg.getAttribute("height") || "");
      const width = Math.max(viewBox?.[2] || parsedWidth || image.naturalWidth || image.width || 1200, 1);
      const height = Math.max(viewBox?.[3] || parsedHeight || image.naturalHeight || image.height || 800, 1);
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(width * PNG_EXPORT_SCALE);
      canvas.height = Math.ceil(height * PNG_EXPORT_SCALE);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas is not supported.");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.scale(PNG_EXPORT_SCALE, PNG_EXPORT_SCALE);
      context.drawImage(image, 0, 0, width, height);

      canvas.toBlob((blob) => {
        if (!blob) return;
        const pngUrl = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = pngUrl;
        link.download = "diagram.png";
        link.click();
        URL.revokeObjectURL(pngUrl);
      }, "image/png");
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : "Failed to download PNG.");
    }
  };

  if (status === "error") {
    return (
      <div className="mermaid-diagram mermaid-diagram-error">
        <div className="mb-2 text-xs font-medium text-destructive">Mermaid render failed: {error}</div>
        <pre className="m-0"><code>{chart}</code></pre>
      </div>
    );
  }

  return (
    <div className="mermaid-diagram">
      {svg ? (
        <>
          <div className="mermaid-diagram-actions">
            <button type="button" onClick={downloadSvg}>SVG</button>
            <button type="button" onClick={downloadPng}>PNG</button>
          </div>
          {downloadError && (
            <div className="mermaid-diagram-download-error">
              PNG download failed: {downloadError}. Try SVG instead.
            </div>
          )}
          <div ref={diagramRef} dangerouslySetInnerHTML={{ __html: svg }} />
        </>
      ) : (
        <div className="text-sm text-muted-foreground">Rendering diagram…</div>
      )}
    </div>
  );
}
