# tyo-mq-samples repo — design

Date: 2026-07-06
Status: approved direction from user ("both" — mini-apps first plus feature cookbook);
user later asked for all four mini-apps: job queue, browser chat, IoT telemetry,
and microservices events. Implemented and verified 2026-07-06.

## Goal

A public samples repository that demonstrates tyo-mq usage end-to-end, to help the
project gain attention. Visitors should be able to clone, `npm install`, and see
something working within a minute, and the README should make the feature set
(durable delivery, ACK/retry/DLQ, topics, consumer groups, broadcast, auth/realms,
HTTP API) visible at a glance.

## Repository layout

Created as a sibling repo at `/data/tyolab/node/tyo-mq-samples`, own git history,
Apache-2.0 (matching tyo-mq). Depends on `tyo-mq@^0.13.3` from npm.

```
tyo-mq-samples/
  README.md              # pitch, quickstart, index of all samples
  LICENSE
  package.json           # dep: tyo-mq; npm scripts for each sample
  .gitignore
  apps/
    job-queue/
      README.md
      demo.js            # one command: starts server + dispatcher + 2 workers in-process
    chat/
      README.md
      server.js          # tyo-mq server + tiny static file server; the client
                         #   bundle is served straight from node_modules
      public/index.html
      public/app.js      # uses window.mq from the browserified client
    iot-telemetry/
      README.md
      demo.js            # devices on org/tyolab/<site>/<device>/telemetry topics,
                         #   wildcard fleet monitor, cmd topic back to hot devices
    microservices/
      README.md
      demo.js            # starts server, forks the three services, plays storefront
      services/order-service.js
      services/inventory-service.js
      services/email-service.js
  cookbook/
    README.md
    01-hello-pubsub.js
    02-durable-ack.js    # durable + auto-ACK + manual ACK + retry + DLQ inspection
    03-topics-wildcards.js  # MQTT-style +/# patterns (IoT telemetry flavour)
    04-consumer-groups.js   # round-robin load balancing
    05-broadcast.js         # realm and group broadcast
    06-auth-realms.js       # tokens, roles, realm scoping
    07-http-api.js          # /health, /api/metrics, /api/stats
```

## Key design decisions

1. **Self-contained scripts.** Every cookbook script and the job-queue demo start
   their own `Server` in-process on a unique port (17361–17368), run the scenario,
   print annotated output, and exit cleanly. Zero setup, no separate terminal
   needed. The chat app is the exception: it runs a long-lived server and the
   user opens a browser.
2. **Explicit API forms.** Samples use the unambiguous call shapes:
   `consumer.subscribe(producerName, eventName, handler, options)` and
   `consumer.subscribe(topicPattern, handler, { mode: 'topic' })`.
3. **Chat routing.** Chat messages are produced as event `chat` and consumed via a
   topic-mode subscription (`{ mode: 'topic' }` on `chat`), which matches the event
   from any producer — each browser tab is its own producer.
4. **npm dependency.** `package.json` references the published `tyo-mq` package so
   the repo works standalone once cloned.
5. **Verification.** Every script is run and its output checked before the repo is
   considered done; the chat app is exercised with a real browser (two tabs
   exchanging messages) and screenshotted for the README.

## Out of scope (for now)

- Clustering / Redis samples (requires external Redis; mentioned in README with a
  pointer to docs/CLUSTERING.md).
- Publishing the repo to GitHub — left to the user.
