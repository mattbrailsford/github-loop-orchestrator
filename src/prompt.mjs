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

export function claimLine(claim, values) {
  return (
    `This run holds the claim: the label "${claim.label}" on ${values.repo}#${values.number}. ` +
    'While it is on, no other run starts for this item; anything else that comes in waits its turn. ' +
    `As your last step, whatever happened, remove the "${claim.label}" label. The one exception: if ` +
    'you fired a loop-edge, leave it on, because the run you started takes over the claim.'
  );
}

export function buildPrompt(template, values, request, { scheduled = false, claim = null } = {}) {
  const filled = template.replace(PLACEHOLDER_RE, (_, name) =>
    name === 'request' ? `\n\n${requestBlock(values, request)}\n\n` : String(values[name] ?? ''),
  );
  const tail = scheduled ? SCHEDULED_RECHECK : claim ? `${RECHECK}\n\n${claimLine(claim, values)}` : RECHECK;
  return `${filled.trim()}\n\n${tail}`;
}
