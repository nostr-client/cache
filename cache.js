/**
 * cache.js — IndexedDB event cache as a drop-in pool wrapper.
 * No build step, zero dependencies.
 *
 * Part of https://github.com/nostr-client — one repo, one thing.
 * License: AGPL-3.0-or-later
 *
 * What it does:
 *   - every event that flows through the pool is stored locally
 *   - get({ ids: [id] })            → instant if cached (events are immutable)
 *   - get({ kinds:[0], authors:[pk] }) and other replaceable lookups
 *     (profiles, contact lists, relay lists) → served from cache instantly,
 *     refreshed from the network in the background (stale-while-revalidate)
 *   - everything else passes through untouched
 *
 * Compose with verify so only verified events are ever cached:
 *   import { Pool } from 'https://nostr-client.github.io/pool/pool.js'
 *   import { withVerify } from 'https://nostr-client.github.io/verify/verify.js'
 *   import { withCache } from 'https://nostr-client.github.io/cache/cache.js'
 *   globalThis.__nostrClientPool = withCache(withVerify(new Pool()))
 *   // …then import components; defaultPool() picks this up.
 */

const DB_NAME = 'nostr-client-cache'
const DB_VERSION = 1
const EVENTS = 'events'            // id -> event (immutable)
const REPLACEABLE = 'replaceable'  // `${kind}:${pubkey}` -> newest event

let dbPromise = null
function openDb() {
  return (dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(EVENTS)
      req.result.createObjectStore(REPLACEABLE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  }))
}

async function idbGet(store, key) {
  const db = await openDb()
  return new Promise((resolve) => {
    const req = db.transaction(store).objectStore(store).get(key)
    req.onsuccess = () => resolve(req.result ?? null)
    req.onerror = () => resolve(null)
  })
}

async function idbPut(store, key, value) {
  const db = await openDb()
  return new Promise((resolve) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve()
  })
}

const isReplaceable = (kind) =>
  kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000)

async function storeEvent(event) {
  try {
    if (!event?.id) return
    await idbPut(EVENTS, event.id, event)
    if (isReplaceable(event.kind)) {
      const key = event.kind + ':' + event.pubkey
      const existing = await idbGet(REPLACEABLE, key)
      if (!existing || existing.created_at < event.created_at) {
        await idbPut(REPLACEABLE, key, event)
      }
    }
  } catch { /* quota/private-mode failures are non-fatal */ }
}

/** Wrap a pool with the cache. Falls back to the raw pool where IDB is unavailable. */
export function withCache(pool) {
  if (typeof indexedDB === 'undefined') return pool

  return {
    get urls() { return pool.urls },
    get relays() { return pool.relays },
    addRelay: (url) => pool.addRelay(url),
    removeRelay: (url) => pool.removeRelay(url),
    close: () => pool.close(),

    subscribe(filters, { onEvent, onEose, relays } = {}) {
      return pool.subscribe(filters, {
        relays, onEose,
        onEvent: (event, relay) => { storeEvent(event); onEvent?.(event, relay) },
      })
    },

    async list(filters, opts) {
      const events = await pool.list(filters, opts)
      for (const ev of events) storeEvent(ev)
      return events
    },

    async get(filter, opts) {
      // immutable by-id lookup: cache is authoritative
      if (filter.ids?.length === 1 && Object.keys(filter).length <= 2) {
        const cached = await idbGet(EVENTS, filter.ids[0])
        if (cached) return cached
        const event = await pool.get(filter, opts)
        if (event) storeEvent(event)
        return event
      }
      // replaceable single-author lookup: stale-while-revalidate
      if (
        filter.kinds?.length === 1 && isReplaceable(filter.kinds[0]) &&
        filter.authors?.length === 1
      ) {
        const key = filter.kinds[0] + ':' + filter.authors[0]
        const cached = await idbGet(REPLACEABLE, key)
        const refresh = pool.get(filter, opts).then((event) => {
          if (event) storeEvent(event)
          return event
        })
        if (cached) { refresh.catch(() => {}); return cached }
        return refresh
      }
      const event = await pool.get(filter, opts)
      if (event) storeEvent(event)
      return event
    },

    async publish(event, opts) {
      storeEvent(event) // your own events are instantly available offline
      return pool.publish(event, opts)
    },
  }
}

/** Rough cache stats for a settings page. */
export async function cacheStats() {
  const db = await openDb()
  const count = (store) => new Promise((resolve) => {
    const req = db.transaction(store).objectStore(store).count()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(0)
  })
  return { events: await count(EVENTS), replaceable: await count(REPLACEABLE) }
}

/** Wipe the cache. */
export async function clearCache() {
  const db = await openDb()
  await Promise.all([EVENTS, REPLACEABLE].map((store) => new Promise((resolve) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).clear()
    tx.oncomplete = resolve
    tx.onerror = resolve
  })))
}
