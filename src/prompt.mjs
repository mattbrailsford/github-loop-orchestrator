import { PLACEHOLDER_RE } from './config.mjs';

export const RECHECK =
  'Before acting, re-check that this issue or PR still qualifies for this route: it is still open ' +
  'and its labels are as expected. If it no longer qualifies, stop quietly without posting anything.';

export const SCHEDULED_RECHECK =
  'This is a scheduled run about the whole repo, not one issue or PR. If there is nothing to ' +
  'do, stop quietly without posting anything.';

export function usesPlaceholder(template, name) {
  return [...template.matchAll(PLACEHOLDER_RE)].some(([, n]) => n === name);
}

function requestBlock(values, request) {
  const from = `A maintainer (@${values.actor}) asked, in comment ${values.comment_id || 'on the issue body'}:`;
  if (!request || request.text.length === 0) {
    return `${from}\n<request>\n(nothing after the mention; read the comment itself)\n</request>`;
  }
  const safe = request.text.replace(/<\/?request/gi, (m) => m.replace('<', '&lt;'));
  const note = request.cut ? '\n(The request was cut for length; read the comment for the rest.)' : '';
  return `${from}\n<request>\n${safe}\n</request>${note}`;
}

export function buildPrompt(template, values, request, { scheduled = false } = {}) {
  const filled = template.replace(PLACEHOLDER_RE, (_, name) =>
    name === 'request' ? `\n\n${requestBlock(values, request)}\n\n` : String(values[name] ?? ''),
  );
  return `${filled.trim()}\n\n${scheduled ? SCHEDULED_RECHECK : RECHECK}`;
}
