export const MAX_REQUEST_LENGTH = 4000;

const FENCE_RE = /^(`{3,}|~{3,})/;
const CLAUDE_SIGNOFF_RE = /^\s*_?\*{0,2}Generated (with|by)\b[^\n]*Claude/i;
const LEADING_MENTION_RE =/^\s*@([A-Za-z0-9][A-Za-z0-9-]*(?:\[bot\])?)/;

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// One entry per line; null for lines inside a fenced block or a quote, which never count.
export function visibleLines(text) {
  const lines = (text ?? '').replace(/\r\n?/g, '\n').split('\n');
  let fence = null;
  return lines.map((line) => {
    const trimmed = line.trimStart();
    const marker = trimmed.match(FENCE_RE);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      return null;
    }
    if (marker) {
      fence = marker[1];
      return null;
    }
    if (trimmed.startsWith('>')) return null;
    return line;
  });
}

// Blanks inline code with spaces, so offsets still line up with the original line.
function blankInlineCode(line) {
  return line.replace(/(`+)[\s\S]+?\1/g, (m) => ' '.repeat(m.length));
}

function mentionPattern(login) {
  return new RegExp(`(^|[^A-Za-z0-9_@./-])@${escapeRegExp(login)}(?![A-Za-z0-9_-])`, 'gi');
}

export function findMention(text, logins) {
  const lines = visibleLines(text);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === null) continue;
    const scan = blankInlineCode(lines[i]);
    let best = null;
    for (const login of logins) {
      const re = mentionPattern(login);
      const m = re.exec(scan);
      if (m && (best === null || m.index < best.start)) {
        const start = m.index + m[1].length;
        best = { line: i, start, end: start + 1 + login.length, login };
      }
    }
    if (best) return best;
  }
  return null;
}

// The first line that counts (not blank, not a quote, not code) must start with one of the
// prefixes. A quote-reply above it is fine; the prefix part-way through a line is not.
export function findAddress(text, prefixes) {
  const lines = visibleLines(text);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === null || lines[i].trim() === '') continue;
    const lead = lines[i].length - lines[i].trimStart().length;
    const rest = lines[i].slice(lead);
    const prefix = prefixes.find((p) => rest.startsWith(p));
    if (!prefix) return null;
    // Claude Code signs what it writes with "🤖 Generated with Claude Code". That's a sign-off,
    // not someone addressing the routine.
    if (CLAUDE_SIGNOFF_RE.test(rest.slice(prefix.length))) return null;
    return { line: i, start: lead, end: lead + prefix.length };
  }
  return null;
}

export function extractAddressedRequest(text, prefixes, max = MAX_REQUEST_LENGTH) {
  return requestFrom(text, findAddress(text, prefixes), [], max);
}

export function extractRequest(text, logins, max = MAX_REQUEST_LENGTH) {
  return requestFrom(text, findMention(text, logins), logins, max);
}

function requestFrom(text, hit, logins, max) {
  if (!hit) return null;
  const lines = visibleLines(text);
  const own = new Set(logins.map((l) => l.toLowerCase()));
  const out = [lines[hit.line].slice(hit.end)];

  for (let i = hit.line + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === null) continue;
    const lead = line.match(LEADING_MENTION_RE);
    if (lead && !own.has(lead[1].toLowerCase())) break;
    out.push(line);
  }

  let request = out
    .join('\n')
    .replace(/^[\s,:;-]+/, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  let cut = false;
  if (request.length > max) {
    request = request.slice(0, max).trimEnd();
    cut = true;
  }
  return { text: request, cut };
}
