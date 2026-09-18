import { streamComplete, type CompleteMessage, type SSEvent } from "@/lib/api";

/** Parse `provider_id:model_id` selector value into parts. */
export function parseModelSelector(value: string | null): { provider_id?: string; model_id?: string } {
  if (!value) return {};
  const [provider_id, model_id] = value.split(":", 2);
  return { provider_id, model_id };
}

/**
 * Accumulate a streamed completion into a single string.
 * Returns the full text once the stream completes (or throws on error event).
 */
export async function runComplete(
  body: { messages: CompleteMessage[]; model_id?: string; provider_id?: string; temperature?: number },
  signal?: AbortSignal,
  onDelta?: (text: string, full: string) => void,
): Promise<string> {
  let full = "";
  for await (const event of streamComplete(body, signal)) {
    const e = event as SSEvent;
    if (e.type === "content") {
      full += e.text;
      onDelta?.(e.text, full);
    } else if (e.type === "error") {
      throw new Error((e as { message?: string }).message || "Completion failed");
    }
  }
  return full;
}

const TITLE_PROMPT = `### Task:
Generate a concise, 3-5 word title with an emoji summarizing the content in the content's primary language.
### Guidelines:
- The title should clearly represent the main theme or subject of the content.
- Use emojis that enhance understanding of the topic, but avoid quotation marks or special formatting.
- Write the title in the content's primary language.
- Prioritize accuracy over excessive creativity; keep it clear and simple.
- Your entire response must consist solely of the JSON object, without any introductory or concluding text.
- The output must be a single, raw JSON object, without any markdown code fences or other encapsulating text.
- Ensure no conversational text, affirmations, or explanations precede or follow the raw JSON output, as this will cause direct parsing failure.
### Output:
JSON format: { "title": "your concise title here" }
### Examples:
- { "title": "📉 Stock Market Trends" },
- { "title": "🍪 Perfect Chocolate Chip Recipe" },
- { "title": "Evolution of Music Streaming" },
- { "title": "Remote Work Productivity Tips" },
- { "title": "Artificial Intelligence in Healthcare" },
- { "title": "🎮 Video Game Development Insights" }`;

const ENHANCE_PROMPT = `Enhance the user's note to make it more useful and comprehensive, in the note's primary language.
- Preserve all original facts and intent; do not invent information.
- Improve clarity, structure, and formatting using markdown (headings, lists, task lists where implied, emphasis).
- Fix grammar and tighten wording.
- Return only the enhanced markdown note, no commentary.`;

export function buildTitleMessages(content: string): CompleteMessage[] {
  return [
    { role: "system", content: TITLE_PROMPT },
    { role: "user", content: content || "(empty note)" },
  ];
}

export function buildEnhanceMessages(content: string): CompleteMessage[] {
  return [
    { role: "system", content: ENHANCE_PROMPT },
    { role: "user", content: content || "(empty note)" },
  ];
}

/** Extract a JSON object { "title": "..." } from a possibly noisy LLM response. */
export function parseTitleResponse(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (parsed && typeof parsed.title === "string" && parsed.title.trim()) {
      return parsed.title.trim();
    }
  } catch {
    /* fall through */
  }
  return null;
}
