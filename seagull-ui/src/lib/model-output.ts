const COMPLETE_REASONING_BLOCK_RE = /<(?:think|analysis)\b[^>]*>[\s\S]*?<\/(?:think|analysis)\s*>/gi;
const UNCLOSED_REASONING_BLOCK_RE = /<(?:think|analysis)\b[^>]*>[\s\S]*$/gi;
const ORPHAN_REASONING_CLOSE_RE = /<\/(?:think|analysis)\s*>/gi;
const PARTIAL_REASONING_TAG_RE = /<(?:t(?:h(?:i(?:n(?:k)?)?)?)?|a(?:n(?:a(?:l(?:y(?:s(?:i(?:s)?)?)?)?)?)?)?)$/i;

export function stripModelThinking(content: string): string {
  return content
    .replace(COMPLETE_REASONING_BLOCK_RE, "")
    .replace(UNCLOSED_REASONING_BLOCK_RE, "")
    .replace(ORPHAN_REASONING_CLOSE_RE, "")
    .replace(PARTIAL_REASONING_TAG_RE, "")
    .trimStart();
}
