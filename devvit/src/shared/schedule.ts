import {parseAllDocuments} from 'yaml'

export type Entry = {
  title: string // after {{date}} replacement
  text: string // after {{date}} replacement
  postTimeMs: number
  sticky: 1 | 2 | null
  distinguish: boolean
}

export type Problem = {signature: string; subject: string; detail: string}

export type TextLoader = (page: string) => Promise<string | null>

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const pad = (n: number, width = 2, fill = '0') => String(n).padStart(width, fill)

// strftime for the directives mods use in titles, in UTC like the Python bot.
export function strftime(format: string, d: Date): string {
  const hour12 = d.getUTCHours() % 12 || 12
  const dayOfYear = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86_400_000)
  const table: Record<string, string> = {
    Y: String(d.getUTCFullYear()),
    y: pad(d.getUTCFullYear() % 100),
    m: pad(d.getUTCMonth() + 1),
    d: pad(d.getUTCDate()),
    e: pad(d.getUTCDate(), 2, ' '),
    B: MONTHS[d.getUTCMonth()]!,
    b: MONTHS[d.getUTCMonth()]!.slice(0, 3),
    h: MONTHS[d.getUTCMonth()]!.slice(0, 3),
    A: WEEKDAYS[d.getUTCDay()]!,
    a: WEEKDAYS[d.getUTCDay()]!.slice(0, 3),
    w: String(d.getUTCDay()),
    H: pad(d.getUTCHours()),
    I: pad(hour12),
    M: pad(d.getUTCMinutes()),
    S: pad(d.getUTCSeconds()),
    p: d.getUTCHours() < 12 ? 'AM' : 'PM',
    j: pad(dayOfYear, 3),
    Z: 'UTC',
    z: '+0000',
    '%': '%',
  }
  return format.replace(/%(-?)([A-Za-z%])/g, (whole, dash: string, key: string) => {
    const value = table[key]
    if (value === undefined) return whole
    return dash ? value.replace(/^[0 ]+(?=.)/, '') : value
  })
}

const DATE_TOKEN = /\{\{date(?:([+-])(\d+))?\s+(.*?)\}\}/

// {{date %B %d}}, {{date+1 %A}}, {{date-7 %Y-%m-%d}}: today's date, shifted by whole days.
export function replaceDates(text: string, now: Date): string {
  let out = text
  for (let i = 0; i < 100; i++) {
    const m = DATE_TOKEN.exec(out)
    if (!m) break
    const shift = m[1] ? (m[1] === '+' ? 1 : -1) * Number(m[2]) : 0
    const when = new Date(now.getTime() + shift * 86_400_000)
    out = out.slice(0, m.index) + strftime(m[3]!, when) + out.slice(m.index + m[0].length)
  }
  return out
}

export function parsePostTime(value: unknown): number | null {
  if (typeof value !== 'string' && !(value instanceof Date)) return null
  const ms = value instanceof Date ? value.getTime() : Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

function stickyValue(raw: unknown): 1 | 2 | null {
  if (!raw) return null
  const s = String(raw)
  if (s === '1') return 1
  if (s === '2' || s === 'true') return 2
  return null
}

// Reads the schedule page. A bad entry is reported and skipped, so one typo doesn't stop the rest.
export async function readSchedule(
  content: string,
  now: Date,
  loadText: TextLoader,
): Promise<{entries: Entry[]; problems: Problem[]}> {
  const entries: Entry[] = []
  const problems: Problem[] = []
  if (!content.trim()) return {entries, problems}

  const docs = parseAllDocuments(content)
  for (const doc of docs) {
    if (doc.errors.length > 0) {
      problems.push({
        signature: 'yaml',
        subject: 'Scheduled posts: the schedule has a formatting error',
        detail: `The schedule page could not be read as YAML: ${doc.errors[0]!.message}`,
      })
      continue
    }
    const section = doc.toJS() as Record<string, unknown> | null
    if (!section || typeof section !== 'object' || Array.isArray(section)) continue
    const title = typeof section.title === 'string' ? section.title : ''
    const label = title || '<untitled section>'
    try {
      if (section.update === false || section.update === 0 || section.update === 'false') continue
      // Posting to another subreddit isn't possible from an installed app; use a test subreddit instead.
      if (section.sandbox) continue

      const hasText = Boolean(section.text || section.text_from_wiki)
      if (!(title && section.post_time && hasText)) {
        const missing = [
          ...(['title', 'post_time'] as const).filter(f => !section[f]),
          ...(hasText ? [] : ['text or text_from_wiki']),
        ]
        problems.push({
          signature: `section-fields:${label}`,
          subject: `Scheduled post not created: '${label}'`,
          detail:
            `The schedule entry '${label}' is missing required field(s): ${missing.join(', ')}. ` +
            'Every entry needs title, post_time, and either text or text_from_wiki. ' +
            'That post will not be made until this is fixed.',
        })
        continue
      }

      let text = typeof section.text === 'string' ? section.text : ''
      if (section.text_from_wiki) {
        const fromWiki = await loadText(String(section.text_from_wiki))
        if (fromWiki === null) {
          problems.push({
            signature: `section:${label}`,
            subject: `Scheduled post not created: '${label}'`,
            detail: `The wiki page '${String(section.text_from_wiki)}' named in text_from_wiki could not be read. That post will not be made until it is fixed.`,
          })
          continue
        }
        text = fromWiki
      }

      const postTimeMs = parsePostTime(section.post_time)
      if (postTimeMs === null) {
        problems.push({
          signature: `section:${label}`,
          subject: `Scheduled post not created: '${label}'`,
          detail: `Could not read post_time '${String(section.post_time)}' for '${label}'. Use a form like 2026-11-05 18:00 UTC. That post will not be made until the entry is corrected.`,
        })
        continue
      }

      entries.push({
        title: replaceDates(title, now),
        text: replaceDates(text, now),
        postTimeMs,
        sticky: stickyValue(section.sticky),
        distinguish: section.distinguish === undefined ? true : Boolean(section.distinguish),
      })
    } catch (err) {
      problems.push({
        signature: `section:${label}`,
        subject: `Scheduled post not created: '${label}'`,
        detail: `Could not read the schedule entry '${label}': ${err instanceof Error ? err.message : err}. That post will not be made until the entry is corrected.`,
      })
    }
  }
  return {entries, problems}
}

// An entry is acted on when its time has come and is still inside the window, or when its post
// already exists (so later edits to the text or sticky flag still apply).
export function isDue(entry: Entry, nowMs: number, windowMs: number, exists: boolean): boolean {
  if (exists) return true
  const age = nowMs - entry.postTimeMs
  return age >= 0 && age < windowMs
}

export type Alerts = Record<string, number> // signature -> when it was last sent (ms)
export const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000

// Decides which problems to send now, and which earlier ones have cleared.
export function planAlerts(
  problems: Problem[],
  sent: Alerts,
  nowMs: number,
): {send: Problem[]; cleared: string[]; next: Alerts} {
  const active = new Set(problems.map(p => p.signature))
  const next: Alerts = {}
  const send: Problem[] = []
  for (const p of problems) {
    const last = sent[p.signature]
    if (last !== undefined && nowMs - last < ALERT_COOLDOWN_MS) {
      next[p.signature] = last
    } else {
      next[p.signature] = nowMs
      send.push(p)
    }
  }
  const cleared = Object.keys(sent).filter(sig => !active.has(sig))
  return {send, cleared, next}
}

export function formatAlert(detail: string, subreddit: string, wiki: string, lastEditor?: string): string {
  const lines = [
    "The scheduled post bot hit a problem it can't resolve on its own:",
    '',
    `> ${detail}`,
    '',
    `Schedule: /r/${subreddit}/wiki/${wiki}`,
  ]
  if (lastEditor) lines.push(`Last edited by /u/${lastEditor}, most likely the person to look at this.`)
  lines.push(
    '',
    "This notice repeats at most once a day while the problem persists, and you'll get an all-clear once it's fixed.",
  )
  return lines.join('\n')
}
