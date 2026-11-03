import assert from 'node:assert/strict'
import {test} from 'node:test'
import {type Deps, type PostLike, tick} from './tick.ts'

const T0 = Date.parse('2026-11-05T18:00:00Z')

function fakes(wiki: string | null, startMs = T0, listing = true, previous: PostLike[] = []) {
  const kv = new Map<string, string>()
  const posts: PostLike[] = []
  const mails: string[] = []
  let now = startMs
  let n = 0
  const deps: Deps = {
    nowMs: () => now,
    subreddit: 'testsub',
    subredditId: 't5_x',
    wikiPage: 'bot-schedule',
    windowMs: 30 * 60_000,
    redis: {
      get: async k => kv.get(k),
      set: async (k, v) => void kv.set(k, v),
      del: async k => void kv.delete(k),
      expire: async () => {},
      incrBy: async (k, by) => { const v = Number(kv.get(k) ?? 0) + by; kv.set(k, String(v)); return v },
    },
    reddit: {
      getWikiText: async page => (page === 'bot-schedule' ? (wiki === null ? null : {content: wiki, lastEditor: 'modperson'}) : null),
      getPostById: async id => posts.find(p => p.id === id) ?? null,
      myRecentPosts: async () => (listing ? [...posts] : []),
      previousAccountPosts: async () => previous,
      submitPost: async ({title, text}) => {
        const p: PostLike & {log: string[]} = {
          id: `t3_${++n}`, title, body: text, subredditName: 'testsub', stickied: false, distinguishedBy: undefined, log: [],
          async edit({text}) { this.body = text; this.log.push('edit') },
          async sticky(pos) { this.stickied = true; this.log.push(`sticky${pos}`) },
          async distinguish() { this.distinguishedBy = 'moderator'; this.log.push('distinguish') },
        }
        posts.push(p)
        return p
      },
      notifyMods: async subject => void mails.push(subject),
    },
  }
  return {deps, posts, mails, kv, advance: (ms: number) => { now += ms }}
}

const entry = (time: string, extra = '') =>
  `title: "Daily {{date %d %b}}"\npost_time: "${time}"\ntext: "Hello {{date %Y}}"\nsticky: 1\n${extra}`

test('a due entry is posted once, distinguished and stickied', async () => {
  const {deps, posts} = fakes(entry('2026-11-05 17:50 UTC'))
  const r1 = await tick(deps)
  assert.equal(r1?.created, 1)
  assert.equal(posts.length, 1)
  assert.equal(posts[0]!.title, 'Daily 05 Nov')
  assert.equal(posts[0]!.stickied, true)
  assert.equal(posts[0]!.distinguishedBy, 'moderator')
  const r2 = await tick(deps)
  assert.equal(r2?.created, 0)
  assert.equal(posts.length, 1)
})

test('a post is not repeated even when the app cannot list its own posts', async () => {
  const {deps, posts} = fakes(entry('2026-11-05 17:50 UTC'), T0, false)
  await tick(deps)
  await tick(deps)
  await tick(deps)
  assert.equal(posts.length, 1)
})

test('a removed post is left alone, not re-created or edited', async () => {
  const {deps, posts} = fakes(entry('2026-11-05 17:50 UTC'))
  await tick(deps)
  posts[0]!.body = '[removed]'
  const r = await tick(deps)
  assert.equal(posts.length, 1)
  assert.equal(r?.created, 0)
  assert.equal(posts[0]!.body, '[removed]')
})

test('a future entry waits, then posts when its time comes', async () => {
  const {deps, posts, advance} = fakes(entry('2026-11-05 18:05 UTC'))
  await tick(deps)
  assert.equal(posts.length, 0)
  advance(6 * 60_000)
  await tick(deps)
  assert.equal(posts.length, 1)
})

test('an entry long past is not posted, but an existing post keeps being updated', async () => {
  const {deps, posts, advance} = fakes(entry('2026-11-05 17:50 UTC'))
  await tick(deps)
  posts[0]!.body = 'edited by hand'
  advance(5 * 3600_000)
  await tick(deps)
  assert.equal(posts[0]!.body, 'Hello 2026')
  const late = fakes(entry('2026-11-01 17:50 UTC'))
  await tick(late.deps)
  assert.equal(late.posts.length, 0)
})

test('a failing post is reported once and posted when Reddit recovers', async () => {
  const f = fakes(entry('2026-11-05 17:50 UTC'))
  const real = f.deps.reddit.submitPost
  f.deps.reddit.submitPost = async () => { throw new Error('RATELIMIT') }
  await tick(f.deps)
  await tick(f.deps)
  assert.deepEqual(f.mails, ["Scheduled post failed: 'Daily 05 Nov'"])
  f.deps.reddit.submitPost = real
  await tick(f.deps)
  assert.equal(f.posts.length, 1)
  assert.deepEqual(f.mails, ["Scheduled post failed: 'Daily 05 Nov'", 'Resolved: scheduled post issue cleared'])
})

test('an unreadable schedule page is reported, and a second tick while locked is skipped', async () => {
  const f = fakes(null)
  await tick(f.deps)
  assert.deepEqual(f.mails, ['Scheduled posts: cannot read the schedule'])
  f.kv.set('tick-lock', '1')
  assert.equal(await tick(f.deps), null)
})

test('an entry the previous bot account already posted is not posted again, and its post is left alone', async () => {
  const old: PostLike = {
    id: 't3_old', title: 'Daily 05 Nov', body: 'from the old bot', subredditName: 'TestSub', stickied: true,
    async edit() { throw new Error('cannot edit another account\'s post') },
    async sticky() { throw new Error('should not be touched') },
    async distinguish() { throw new Error('should not be touched') },
  }
  const {deps, posts, mails} = fakes(entry('2026-11-05 17:55 UTC'), T0, true, [old])
  await tick(deps)
  assert.equal(posts.length, 0)
  assert.equal(mails.length, 0)
})
