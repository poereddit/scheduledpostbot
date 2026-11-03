# scheduledpostbot (Devvit)

Posts and updates scheduled threads from a wiki page, so moderators can change the schedule without touching code. It is a port of the Python bot in the repository root.

## The schedule page

Each entry is a YAML document on the wiki page (default `bot-schedule`, changeable in the app settings). Separate entries with `---`.

```yaml
title: "Daily Thread {{date %B %d}}"
post_time: "2026-11-05 18:00 UTC"
text: "Body text. Today is {{date %A}}."
sticky: 1
```

- `title`, `post_time` and either `text` or `text_from_wiki` (the name of another wiki page to use as the body) are required.
- `sticky`: `1` or `2` for that sticky slot, `true` for slot 2.
- `distinguish`: defaults to true; set `false` to skip.
- `update: false` turns an entry off.
- `{{date FORMAT}}` in the title or text becomes today's date in UTC, using strftime codes such as `%Y`, `%B`, `%d`, `%A`. `{{date+1 FORMAT}}` and `{{date-7 FORMAT}}` shift by whole days.
- `post_time` needs a time zone, for example `2026-11-05 18:00 UTC`.

## How it behaves

- A check runs every minute. An entry is posted once its `post_time` has passed, if that was within the last 30 minutes (setting: late-post window).
- After that, the app keeps the post matching its entry: it fixes distinguish and sticky, and puts the text back if it was changed.
- A post is matched to its entry by title, among the app's own recent posts.
- Problems such as a missing field, a bad time or an unreadable wiki page go to mod mail, once a day at most, with an all-clear when fixed. One bad entry does not stop the others.

## Differences from the Python bot

- Entries with `sandbox` are skipped; use a test subreddit instead.
- Posts appear a few seconds to a minute after `post_time`, not on the second.

## Run the checks

```
npm install
npm test
```
