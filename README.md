# cache

An IndexedDB event cache as a **drop-in pool wrapper**. Zero dependencies, no
build step. One file: [`cache.js`](cache.js).

Part of [nostr-client](https://github.com/nostr-client) — a modular, composable
nostr client where each repo does one thing.

**Live demo:** https://nostr-client.github.io/cache/ (reload it — profiles
come back instantly)

## Use

```js
import { Pool } from 'https://nostr-client.github.io/pool/pool.js'
import { withVerify } from 'https://nostr-client.github.io/verify/verify.js'
import { withCache } from 'https://nostr-client.github.io/cache/cache.js'

// verify inside, cache outside: only verified events are ever stored
globalThis.__nostrClientPool = withCache(withVerify(new Pool()))
// …then import components — defaultPool() picks this up
```

## Semantics (kept deliberately conservative)

| lookup | behavior |
|---|---|
| `get({ ids: [id] })` | cache is authoritative — events are immutable |
| `get({ kinds:[0/3/10002…], authors:[pk] })` | **stale-while-revalidate**: cached instantly, refreshed in background |
| `subscribe` / `list` | passthrough; everything seen is stored |
| `publish` | passthrough; your own events cached immediately |

No cache invalidation heuristics, no TTLs to tune, no wrong answers for
immutable data — the only staleness window is replaceable events between
page loads. Falls back to the raw pool where IndexedDB is unavailable.

Also exported: `cacheStats()`, `clearCache()`.

## License

AGPL-3.0-or-later
