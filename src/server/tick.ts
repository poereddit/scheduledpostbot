import {context, reddit as realReddit, redis as realRedis, settings} from '@devvit/web/server'
import {
  type Alerts, type Entry, type Problem, formatAlert, isDue, planAlerts, readSchedule,
} from '../shared/schedule.ts'

export type PostLike = {
  id: string
  title: string
  body?: string | undefined
  subredditName: string
  stickied: boolean
  distinguishedBy?: string | undefined
  edit(opts: {text: string}): Promise<unknown>
  sticky(position?: 1 | 2 | 3 | 4): Promise<unknown>
  distinguish(): Promise<unknown>
}

export type Deps = {
  nowMs(): number
  subreddit: string
  subredditId: string
  wikiPage: string
  windowMs: number
  redis: {
    get(key: string): Promise<string | undefined>
    set(key: string, value: string): Promise<unknown>
    del(key: string): Promise<unknown>
    expire(key: string, seconds: number): Promise<unknown>
    incrBy(key: string, value: number): Promise<number>
  }
  reddit: {
    getWikiText(page: string): Promise<{content: string; lastEditor?: string | undefined} | null>
    myRecentPosts(): Promise<PostLike[]>
    submitPost(opts: {title: string; text: string}): Promise<PostLike>
    notifyMods(subject: string, bodyMarkdown: string): Promise<unknown>
  }
}

const ALERTS_KEY = 'alerts'
const LOCK_KEY = 'tick-lock'
const LOCK_TTL_S = 55

const realDeps = async (): Promise<Deps> => {
  const wikiPage = ((await settings.get<string>('wikiPage')) ?? 'bot-schedule').trim() || 'bot-schedule'
  const minutes = Number((await settings.get<number>('windowMinutes')) ?? 30)
  const subreddit = context.subredditName
  return {
    nowMs: () => Date.now(),
    subreddit,
    subredditId: context.subredditId,
    wikiPage,
    windowMs: (Number.isFinite(minutes) && minutes > 0 ? minutes : 30) * 60_000,
    redis: realRedis as unknown as Deps['redis'],
    reddit: {
      async getWikiText(page) {
        try {
          const wp = await realReddit.getWikiPage(subreddit, page)
          return {content: wp.content, lastEditor: wp.revisionAuthor?.username}
        } catch {
          return null
        }
      },
      async myRecentPosts() {
        const me = await realReddit.getCurrentUsername()
        if (!me) return []
        const posts = await realReddit.getPostsByUser({username: me, sort: 'new', limit: 100}).all()
        return posts as unknown as PostLike[]
      },
      async submitPost({title, text}) {
        return (await realReddit.submitPost({subredditName: subreddit, title, text, runAs: 'APP'})) as unknown as PostLike
      },
      notifyMods: (subject, bodyMarkdown) =>
        realReddit.modMail.createModNotification({subject, bodyMarkdown, subredditId: context.subredditId as `t5_${string}`}),
    },
  }
}

// Keeps one scheduled post in line with its entry: creates it, then fixes distinguish, sticky and text.
async function applyEntry(entry: Entry, existing: PostLike | undefined, deps: Deps): Promise<PostLike> {
  const post = existing ?? (await deps.reddit.submitPost({title: entry.title, text: entry.text}))
  if (entry.distinguish && !post.distinguishedBy) await post.distinguish()
  if (entry.sticky && !post.stickied) await post.sticky(entry.sticky)
  if (existing && (existing.body ?? '') !== entry.text) await existing.edit({text: entry.text})
  return post
}

async function withTickLock<T>(redis: Deps['redis'], fn: () => Promise<T>): Promise<T | null> {
  if ((await redis.incrBy(LOCK_KEY, 1)) !== 1) return null // the previous tick is still running
  await redis.expire(LOCK_KEY, LOCK_TTL_S)
  try {
    return await fn()
  } finally {
    await redis.del(LOCK_KEY)
  }
}

export async function tick(deps?: Deps): Promise<{entries: number; due: number; created: number; problems: number} | null> {
  const d = deps ?? (await realDeps())
  return withTickLock(d.redis, async () => {
    const now = new Date(d.nowMs())
    const problems: Problem[] = []
    const wiki = await d.reddit.getWikiText(d.wikiPage)
    let entries: Entry[] = []
    if (!wiki) {
      problems.push({
        signature: 'wiki-unreadable',
        subject: 'Scheduled posts: cannot read the schedule',
        detail: `Cannot read the schedule wiki page '${d.wikiPage}'. No scheduled posts will run until this is fixed.`,
      })
    } else {
      const read = await readSchedule(wiki.content, now, async page => (await d.reddit.getWikiText(page))?.content ?? null)
      entries = read.entries
      problems.push(...read.problems)
    }

    const recent = await d.reddit.myRecentPosts()
    const findPost = (title: string) => recent.find(p => p.subredditName.toLowerCase() === d.subreddit.toLowerCase() && p.title === title)

    let due = 0
    let created = 0
    for (const entry of entries.sort((a, b) => a.postTimeMs - b.postTimeMs)) {
      const existing = findPost(entry.title)
      if (!isDue(entry, now.getTime(), d.windowMs, existing !== undefined)) continue
      due++
      try {
        await applyEntry(entry, existing, d)
        if (!existing) created++
      } catch (err) {
        problems.push({
          signature: `post:${entry.title}`,
          subject: `Scheduled post failed: '${entry.title}'`,
          detail: `Could not submit or update '${entry.title}': ${err instanceof Error ? err.message : err}`,
        })
      }
    }

    await sendAlerts(d, problems, wiki?.lastEditor, now.getTime())
    return {entries: entries.length, due, created, problems: problems.length}
  })
}

async function sendAlerts(d: Deps, problems: Problem[], lastEditor: string | undefined, nowMs: number) {
  const sent = JSON.parse((await d.redis.get(ALERTS_KEY)) ?? '{}') as Alerts
  const plan = planAlerts(problems, sent, nowMs)
  for (const p of plan.send) {
    try {
      await d.reddit.notifyMods(p.subject, formatAlert(p.detail, d.subreddit, d.wikiPage, lastEditor))
    } catch (err) {
      console.error(`could not send modmail: ${err instanceof Error ? err.message : err}`)
      delete plan.next[p.signature] // try again next tick
    }
  }
  for (const sig of plan.cleared) {
    try {
      await d.reddit.notifyMods(
        'Resolved: scheduled post issue cleared',
        `The previously reported problem (\`${sig}\`) no longer occurs. No action needed.`,
      )
    } catch (err) {
      console.error(`could not send all-clear: ${err instanceof Error ? err.message : err}`)
      plan.next[sig] = sent[sig]!
    }
  }
  const unchanged = JSON.stringify(plan.next) === JSON.stringify(sent)
  if (!unchanged) await d.redis.set(ALERTS_KEY, JSON.stringify(plan.next))
}
