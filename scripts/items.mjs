/**
 * The units the eval gold set is labelled over, built once and shared by the
 * labeller (dev/label.mjs) and the eval harness (scripts/eval.mjs).
 *
 * Both sides MUST derive their units here. A gold set labelled over one sentence
 * split and scored against another measures nothing, and the mismatch is silent:
 * you get plausible-looking precision on units that were never compared.
 *
 * Three granularities, because the three decisions are made at three levels:
 *   claims    — per non-question sentence long enough to be a claim
 *   questions — per sentence containing '?'
 *   episodes  — per conversation, split at the same six-hour gap the scorer uses
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const core = createRequire(import.meta.url)(join(root, 'web/src/core.js'));

export const MIN_CLAIM_CANDIDATE = 4;   // shorter than this is never a claim under any definition
export const EPISODE_GAP_HOURS = 6;     // matches EPISODE_GAP_HOURS in core.js
export const EPISODE_PREVIEW = 14;      // messages of an episode shown to a labeller

export const tokenCount = s => (s.toLowerCase().match(/[a-z0-9']+/g) || []).length;

export const LABEL_VALUES = {
  claims: ['yes', 'no'],
  questions: ['phatic', 'rhetorical', 'substantive'],
  episodes: ['casual', 'logistics', 'argument', 'work'],
};

/**
 * @param {object[]} messages  parseChat().messages
 * @returns {{claims: object[], questions: object[], episodes: object[]}}
 *   Every item carries a stable `id` of "<messageIndex>.<sentenceIndex>" (or the
 *   episode ordinal), which is what a gold label is keyed on.
 */
export function buildItems(messages) {
  const claims = [], questions = [];
  messages.forEach((m, mi) => {
    // parseChat names the speaker `author`; only the scored copy calls it `who`.
    const who = m.author || m.who;
    core.splitSentences(m.text).forEach((text, si) => {
      if (!/[a-z]/i.test(text)) return;          // pure emoji or digits carry no label
      const id = `${mi}.${si}`;
      if (text.includes('?')) questions.push({ id, mi, si, who, text });
      else if (tokenCount(text) >= MIN_CLAIM_CANDIDATE) claims.push({ id, mi, si, who, text });
    });
  });

  const episodes = [];
  messages.forEach((m, mi) => {
    const prev = messages[mi - 1];
    const gap = prev && m.date && prev.date ? (m.date - prev.date) / 36e5 : Infinity;
    if (!episodes.length || gap >= EPISODE_GAP_HOURS) {
      episodes.push({ id: String(episodes.length), from: mi, to: mi, msgs: [] });
    }
    const e = episodes[episodes.length - 1];
    e.to = mi;
    if (e.msgs.length < EPISODE_PREVIEW) {
      e.msgs.push(`${m.author || m.who}: ${m.text.replace(/\s+/g, ' ').slice(0, 120)}`);
    }
  });
  for (const e of episodes) e.text = e.msgs.join('\n');

  return { claims, questions, episodes };
}
