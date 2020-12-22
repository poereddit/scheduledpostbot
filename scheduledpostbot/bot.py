import json
import os
import logging
import time
import regex
import requests
import yaml
from datetime import datetime, timedelta, timezone
import praw
from prawcore.exceptions import InsufficientScope, Forbidden, NotFound
from requests.exceptions import HTTPError
from datetime import datetime, timezone
from dateutil.parser import parse
from dateutil.relativedelta import relativedelta
from dateutil.rrule import rrulestr
import threading

REQUIRED_SCOPES = ("wikiedit", "wikiread", "identity")


class Config:
    def __init__(self, config):
        self.client_id = config["auth"]["client_id"]
        self.client_secret = config["auth"]["client_secret"]
        self.refresh_token = config["auth"]["refresh_token"]
        self.user_agent = config["auth"]["user_agent"]

        self.loglevel = config.get("loglevel", "INFO")
        self.sub_name = config["sub_name"]
        self.pull_delay = config.get("pull_delay", 5) * 60  # in minutes

        self.wiki = config["wiki"]


def load_config():
    config_location = os.environ.get("CONFIG_FILE", "instance/config.json")

    with open(config_location) as f:
        config = json.load(f)

    return Config(config)


class Bot:
    def __init__(self, reddit, subreddit, config):
        self.reddit = reddit
        self.subreddit = subreddit
        self.config = config
        self.timers = []
        self.reddit.validate_on_submit = True

    def is_moderator(self, sub):
        if not sub:
            return False

        subreddit = None
        if type(sub) is praw.models.reddit.subreddit.Subreddit:
            subreddit = sub
        elif type(sub) is str:
            subreddit = self.reddit.subreddit(sub)
        else:
            return False

        for mod in subreddit.moderator():
            if mod.name == self.reddit.user.me().name:
                return True
        return False

    def update(self):
        posts = []

        schedule = self.read_schedule()
        if schedule:
            posts.extend(schedule)

        now = datetime.now(timezone.utc)
        queue = self.consider_posts(posts, now)
        self.submit_queue(queue, now)

        for timer in reversed(self.timers):
            if not timer.is_alive():
                self.timers.remove(timer)

        log.debug(f"Sleeping for {self.config.pull_delay / 60.0} minutes")
        time.sleep(self.config.pull_delay)

    def read_schedule(self):
        posts = []

        for attempt in range(5):
            try:
                page = self.get_wiki_page(self.config.wiki)
                if page and len(page.content_md) > 0:
                    for section in yaml.safe_load_all(page.content_md):
                        post = self.process_section(section)
                        if post:
                            posts.append(post)
                return posts
            except (Forbidden, NotFound) as e:
                log.error("unable to read schedule on /r/{}: {}".format(subreddit, e))
                break
            except Exception as e:
                log.error("exception reading schedule on /r/{}: {}".format(subreddit, e))

            delay = (attempt + 1) * 30
            log.debug("sleeping {} seconds".format(delay))
            time.sleep(delay)

        log.error("unable to read schedule on /r/{}. Please investigate!".format(subreddit))

    def get_wiki_page(self, wiki):
        try:
            return self.subreddit.wiki[wiki]
        except (Forbidden, NotFound) as e:
            log.error("unable to read schedule on /r/{}: {}".format(subreddit, e))
        except Exception as e:
            log.error("exception reading schedule on /r/{}: {}".format(subreddit, e))
        return None

    def process_section(self, section):
        post = {}

        try:
            if not section:
                return None

            if not section.get("update", True):
                return None

            if section.get("sandbox"):
                post["subreddit"] = reddit.subreddit(section.get("sandbox"))
            else:
                post["subreddit"] = subreddit

            if not (section.get("title") and section.get("post_time") and (section.get("text") or section.get("text_from_wiki"))):
                log.warning(
                    "Unable to parse section because some required fields are missing. Please make sure title, post_time, and text or text_from_wiki is present:\n{}".format(section))
                return None

            for field in ["title", "text"]:
                post[field] = section.get(field)

            if section.get("text_from_wiki"):
                page = self.get_wiki_page(section.get("text_from_wiki"))
                if not page:
                    return None
                post["text"] = page.content_md

            post["post_time"] = parse(section.get("post_time"))
            post["distinguish"] = section.get("distinguish", self.is_moderator(post["subreddit"]))

            if section.get("sticky") and self.is_moderator(post["subreddit"]):
                if regex.search(r'^1$', str(section.get("sticky"))):
                    post["sticky"] = 1
                elif regex.search(r'^(2|true)$', str(section.get("sticky"))):
                    post["sticky"] = 2

        except Exception as e:
            log.error("exception reading {} on /r/{}: {}".format(section, subreddit, e))
            return None

        return post

    def consider_posts(self, posts, now):
        queue = []

        for post in posts:
            try:
                current = post["post_time"]
                subreddit = post.get("subreddit")
                title = self.replace_dates(post["title"], now)
                if (now - current).total_seconds() < self.config.pull_delay or self.recently_exists(subreddit, title):
                    text = self.replace_dates(post["text"], now)
                    queue.append({
                        "subreddit": subreddit,
                        "title": title,
                        "text": text,
                        "when": current.isoformat(),
                        "sticky": post.get("sticky"),
                        "distinguish": post.get("distinguish")
                    })
            except Exception as e:
                log.error("exception considering {}: {}".format(post, e))

        return queue

    def replace_dates(self, string, now):
        for _ in range(100):
            m = regex.search(r'\{\{date(?:([+-])(\d+))?\s+(.*?)\}\}', string)
            if not m:
                break
            output_date = now
            if m.group(1) == "+":
                output_date += relativedelta(days=int(m.group(2)))
            elif m.group(1) == "-":
                output_date -= relativedelta(days=int(m.group(2)))
            timeformat = output_date.strftime(m.group(3))
            string = string[:m.start()] + timeformat + string[m.end():]

        return string

    def submit_queue(self, queue, now):
        if not queue:
            return
        queue.sort(key=lambda post: post["when"])
        try:
            for post in queue:
                delta = (parse(post["when"]) - now).total_seconds()
                log.debug("Submitting {} in {} seconds".format(post, delta))
                timer = threading.Timer(delta, self.submit_post, [post])
                self.timers.append(timer)
                timer.start()
        except Exception as e:
            log.error("exception posting queue {}: {}".format(queue, e))

    def recently_exists(self, subreddit, title):
        for recent in self.reddit.user.me().submissions.new(limit=100):
            if recent.subreddit == subreddit and recent.title == title:
                return recent
        return None

    def submit_post(self, post):
        submission = None

        for attempt in range(5):
            try:
                if not submission:
                    submission = self.recently_exists(post["subreddit"], post["title"])
                if not submission:
                    submission = post["subreddit"].submit(post["title"], selftext=post["text"])
                    submission.disable_inbox_replies()

                if post.get("distinguish") and not submission.distinguished:
                    submission.mod.distinguish()

                if post.get("sticky") and not submission.stickied:
                    if post["sticky"] == 1:
                        submission.mod.sticky(bottom=False)
                    else:
                        submission.mod.sticky(bottom=True)

                if submission.selftext != post["text"]:
                    submission.edit(post["text"])

                if submission:
                    return

            except Exception as e:
                logging.error("exception making post {}: {}".format(post, e))

            delay = (attempt + 1) * 30
            log.debug("sleeping {} seconds".format(delay))
            time.sleep(delay)

    def stop(self):
        for timer in self.timers:
            timer.cancel()


def connect(config):
    log.info("Connecting to reddit")

    reddit = praw.Reddit(
        client_id=config.client_id,
        client_secret=config.client_secret,
        refresh_token=config.refresh_token,
        user_agent=config.user_agent,
    )
    my_name = reddit.user.me(use_cache=True).name
    log.info(f"Connected as: {my_name}")
    return reddit


if __name__ == "__main__":
    config = load_config()

    logging.basicConfig(format='%(asctime)s %(name)s:%(levelname)s:%(message)s', datefmt='%y-%m-%d %H:%M:%S')
    log = logging.getLogger("scheduledpostbot")
    log.setLevel(config.loglevel)
    log.info(f"Starting scheduledpostbot with log level: {log.level}")

    try:
        reddit = connect(config)
        error_count = 0

        log.info(f"Getting subreddit {config.sub_name}")
        subreddit = reddit.subreddit(config.sub_name)
        bot = Bot(reddit, subreddit, config)

        while True:
            try:
                bot.update()
                error_count = 0
            except praw.exceptions.APIException:
                log.error(f"PRAW raised an API exception! Logging but ignoring.", exc_info=True)
                error_count = min(10, error_count+1)
            except HTTPError:
                log.error(f"requests raised an exception! Logging but ignoring.", exc_info=True)
                error_count = min(10, error_count+1)

            # in the case of an error, sleep longer and longer
            # one error, retry right away
            # more than one, delay a minute per consecutive error.
            # when reddit is down, this value will go up
            # when its just something like we cant reply to this deleted comment, try again right away
            time.sleep(max(0, error_count)*60)
    except KeyboardInterrupt:
        log.info("Shutting down scheduledpostbot")
        bot.stop()
    except InsufficientScope as e:
        log.error(f"PRAW raised InsufficientScope! Make sure you have the following scopes: {','.join(REQUIRED_SCOPES)}")
        raise e
