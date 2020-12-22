# scheduledpostbot

A bot for the poe subreddit to schedule and udpate posts from a wiki page config

HOW TO
===
Build your docker container
```
docker build -t scheduledpostbot:latest .
```

Upload a secret with your config
```
cat instance/config.json | docker secret create scheduledpostconfig.json -
```

Create the service
```
docker service create --name scheduledposttest --secret scheduledpostconfig.json -e CONFIG_FILE='/run/secrets/scheduledpostconfig.json' scheduledpostbot:latest
```


boom done
