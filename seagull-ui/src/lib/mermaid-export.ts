export interface RenderedMermaidDiagram {
  source_hash: string;
  data_url: string;
}

let mermaidPromise: Promise<typeof import("mermaid")> | null = null;
let initialized = false;

function loadMermaid() {
  mermaidPromise ??= import("mermaid");
  return mermaidPromise;
}

function extractMermaidSources(markdown?: string | null) {
  if (!markdown) return [];
  const sources: string[] = [];
  const pattern = /(?:^|\n)(```|~~~)(?:mermaid|mmd)\s*\n([\s\S]*?)\n\1(?=\n|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    const source = match[2].trim();
    if (source && !sources.includes(source)) sources.push(source);
  }
  return sources;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

function normalizeSvg(svg: string) {
  const documentNode = new DOMParser().parseFromString(svg, "image/svg+xml");
  const svgElement = documentNode.documentElement;
  svgElement.querySelectorAll("image, script, iframe").forEach((node) => node.remove());
  svgElement.querySelectorAll("*").forEach((node) => {
    [...node.attributes].forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith("on") || (["href", "xlink:href", "src"].includes(name) && /^https?:\/\//i.test(value))) {
        node.removeAttribute(attribute.name);
      }
    });
  });
  if (!svgElement.getAttribute("xmlns")) svgElement.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const viewBox = svgElement.getAttribute("viewBox")?.split(/\s+/).map(Number);
  const width = Math.max(viewBox?.[2] || parseFloat(svgElement.getAttribute("width") || "") || 1200, 1);
  const height = Math.max(viewBox?.[3] || parseFloat(svgElement.getAttribute("height") || "") || 800, 1);
  svgElement.setAttribute("width", String(width));
  svgElement.setAttribute("height", String(height));
  if (!svgElement.getAttribute("viewBox")) svgElement.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const style = documentNode.createElementNS("http://www.w3.org/2000/svg", "style");
  style.textContent = "text,tspan,.nodeLabel,.edgeLabel,.label{font-family:Arial,Helvetica,sans-serif;}";
  svgElement.insertBefore(style, svgElement.firstChild);
  return { svg: new XMLSerializer().serializeToString(svgElement), width, height };
}

async function svgToPngDataUrl(svg: string) {
  const normalized = normalizeSvg(svg);
  const blob = new Blob([normalized.svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Failed to rasterize Mermaid diagram."));
      image.src = url;
    });
    const maxDimension = 4096;
    const scale = Math.min(2, maxDimension / normalized.width, maxDimension / normalized.height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(normalized.width * scale));
    canvas.height = Math.max(1, Math.ceil(normalized.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is not supported.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.scale(scale, scale);
    context.drawImage(image, 0, 0, normalized.width, normalized.height);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function renderMermaidDiagramsForWechat(markdown?: string | null): Promise<RenderedMermaidDiagram[]> {
  const sources = extractMermaidSources(markdown);
  if (!sources.length) return [];
  const { default: mermaid } = await loadMermaid();
  if (!initialized) {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral", flowchart: { htmlLabels: false } });
    initialized = true;
  }
  const rendered: RenderedMermaidDiagram[] = [];
  for (const source of sources) {
    const renderId = `wechat-mermaid-${crypto.randomUUID().replace(/-/g, "")}`;
    const result = await mermaid.render(renderId, source);
    rendered.push({ source_hash: await sha256(source), data_url: await svgToPngDataUrl(result.svg) });
  }
  return rendered;
}
