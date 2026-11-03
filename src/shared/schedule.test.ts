import assert from 'node:assert/strict'
import {test} from 'node:test'
import {isDue, planAlerts, readSchedule, replaceDates, strftime} from './schedule.ts'

const now = new Date('2026-11-05T18:00:00Z')
const noWiki = async () => null

test('strftime covers the usual directives in UTC', () => {
  const d = new Date('2026-03-04T09:05:07Z')
  assert.equal(strftime('%A, %B %d, %Y', d), 'Wednesday, March 04, 2026')
  assert.equal(strftime('%a %b %-d %y %H:%M:%S %I %p %j %%', d), 'Wed Mar 4 26 09:05:07 09 AM 063 %')
  assert.equal(strftime('%Q', d), '%Q')
})

test('replaceDates shifts by whole days and handles several tokens', () => {
  assert.equal(replaceDates('Daily {{date %Y-%m-%d}}', now), 'Daily 2026-11-05')
  assert.equal(replaceDates('{{date+1 %A}} and {{date-7 %b %d}}', now), 'Friday and Oct 29')
  assert.equal(replaceDates('no tokens', now), 'no tokens')
})

test('a complete entry is read, with defaults', async () => {
  const {entries, problems} = await readSchedule(
    'title: "Daily {{date %d %B}}"\npost_time: "2026-11-05 17:30 UTC"\ntext: hello\nsticky: 2\n',
    now,
    noWiki,
  )
  assert.deepEqual(problems, [])
  assert.equal(entries.length, 1)
  assert.equal(entries[0]!.title, 'Daily 05 November')
  assert.equal(entries[0]!.postTimeMs, Date.parse('2026-11-05T17:30:00Z'))
  assert.equal(entries[0]!.sticky, 2)
  assert.equal(entries[0]!.distinguish, true)
})

test('text_from_wiki is loaded, and a missing page is reported', async () => {
  const doc = 'title: A\npost_time: "2026-11-05 17:30 UTC"\ntext_from_wiki: body-page\n'
  const ok = await readSchedule(doc, now, async p => (p === 'body-page' ? 'from wiki {{date %Y}}' : null))
  assert.equal(ok.entries[0]!.text, 'from wiki 2026')
  const bad = await readSchedule(doc, now, noWiki)
  assert.equal(bad.entries.length, 0)
  assert.match(bad.problems[0]!.detail, /body-page/)
})

test('missing fields are named, update false and sandbox are skipped, other entries still read', async () => {
  const content = [
    'title: Broken\ntext: hi',
    'title: Off\npost_time: "2026-11-05 17:30 UTC"\ntext: hi\nupdate: false',
    'title: Test\npost_time: "2026-11-05 17:30 UTC"\ntext: hi\nsandbox: somewhere',
    'title: Good\npost_time: "2026-11-05 17:30 UTC"\ntext: hi',
  ].join('\n---\n')
  const {entries, problems} = await readSchedule(content, now, noWiki)
  assert.deepEqual(entries.map(e => e.title), ['Good'])
  assert.equal(problems.length, 1)
  assert.match(problems[0]!.detail, /post_time/)
  assert.equal(problems[0]!.signature, 'section-fields:Broken')
})

test('an unreadable post_time and broken YAML are reported, not thrown', async () => {
  const a = await readSchedule('title: X\npost_time: "whenever"\ntext: hi', now, noWiki)
  assert.equal(a.entries.length, 0)
  assert.match(a.problems[0]!.detail, /whenever/)
  const b = await readSchedule('title: [unclosed\n', now, noWiki)
  assert.equal(b.problems[0]!.signature, 'yaml')
})

test('isDue: inside the window, outside it, or already posted', () => {
  const entry = {title: 't', text: '', postTimeMs: 1_000_000, sticky: null, distinguish: true} as const
  const w = 30 * 60_000
  assert.equal(isDue(entry, 1_000_000 - 1, w, false), false) // not yet
  assert.equal(isDue(entry, 1_000_000, w, false), true)
  assert.equal(isDue(entry, 1_000_000 + w - 1, w, false), true)
  assert.equal(isDue(entry, 1_000_000 + w, w, false), false) // too late to create
  assert.equal(isDue(entry, 1_000_000 + 10 * w, w, true), true) // exists: keep it updated
})

test('alerts repeat once a day at most and clear once', () => {
  const p = {signature: 'a', subject: 's', detail: 'd'}
  const first = planAlerts([p], {}, 1000)
  assert.deepEqual(first.send, [p])
  const again = planAlerts([p], first.next, 2000)
  assert.deepEqual(again.send, [])
  const later = planAlerts([p], first.next, 1000 + 25 * 3600_000)
  assert.deepEqual(later.send, [p])
  const gone = planAlerts([], first.next, 5000)
  assert.deepEqual(gone.cleared, ['a'])
  assert.deepEqual(gone.next, {})
})
