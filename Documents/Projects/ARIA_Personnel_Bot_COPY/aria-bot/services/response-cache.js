/**
 * services/response-cache.js — In-memory response cache with TTL
 *
 * Purpose: Eliminate redundant LLM calls for repeated queries.
 * Caches: nl-query data answers (5 min) and weather (10 min).
 * Does NOT cache: agent responses, greetings, action proposals (always fresh).
 *
 * Architecture:
 *   - Keyed by normalized query string (lowercase, trimmed, whitespace-collapsed)
 *   - Per-entry TTL (default 5 min)
 *   - Max 500 entries; LRU eviction discards oldest on overflow
 *   - Zero external dependencies — plain Map, zero SQLite, zero disk I/O
 *
 * Why in-memory only (not SQLite):
 *   - TTLs are 5-10 min — cross-restart persistence adds no value
 *   - Single-user, single-session app — memory footprint is negligible
 *   - Keeps this module dependency-free (can be used before DB is ready)
 */

'use strict';

const MAX_ENTRIES = 500;

// Map key → { value, expiresAt, createdAt }
const _cache = new Map();

/**
 * Normalize a query string to a stable cache key.
 * "How much did I spend on Food? " → "how much did i spend on food?"
 */
function _normalize(query) {
  return (query || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Evict the oldest entry when cache is full (simple LRU approximation).
 * Map iteration order is insertion order, so first entry is oldest.
 */
function _evictOldest() {
  const firstKey = _cache.keys().next().value;
  if (firstKey !== undefined) _cache.delete(firstKey);
}

/**
 * Look up a cached response for the given query.
 * Returns the cached value, or null if not found / expired.
 * Expired entries are deleted on access (lazy expiry).
 *
 * @param {string} query - The raw user message
 * @returns {any|null} Cached response object or null
 */
function get(query) {
  const key = _normalize(query);
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _cache.delete(key);
    return null;
  }
  return entry.value;
}

/**
 * Store a response in the cache.
 *
 * @param {string} query     - The raw user message (will be normalized)
 * @param {any}    value     - The response object to cache
 * @param {number} ttlSecs   - Time-to-live in seconds (default 300 = 5 min)
 */
function set(query, value, ttlSecs = 300) {
  const key = _normalize(query);
  if (_cache.size >= MAX_ENTRIES) _evictOldest();
  _cache.set(key, {
    value,
    expiresAt: Date.now() + ttlSecs * 1000,
    createdAt: Date.now(),
  });
}

/**
 * Remove a specific query from the cache (call on writes that invalidate data).
 * e.g. after a new reminder is created, queries like "show tasks" should be invalidated.
 */
function invalidate(query) {
  _cache.delete(_normalize(query));
}

/**
 * Invalidate all entries whose key contains any of the given terms.
 * Used for broad invalidation after writes (e.g. a new transaction → purge all spend queries).
 *
 * @param {string[]} terms - Substrings to match against cached keys
 */
function invalidateByTerms(terms) {
  const lower = terms.map(t => t.toLowerCase());
  for (const key of _cache.keys()) {
    if (lower.some(t => key.includes(t))) {
      _cache.delete(key);
    }
  }
}

/**
 * Clear the entire cache (e.g. on user logout or data reset).
 */
function clear() {
  _cache.clear();
}

/**
 * Return cache stats for debugging / monitoring.
 */
function stats() {
  const now = Date.now();
  let expired = 0;
  for (const entry of _cache.values()) {
    if (now > entry.expiresAt) expired++;
  }
  return { total: _cache.size, expired, active: _cache.size - expired, maxEntries: MAX_ENTRIES };
}

module.exports = { get, set, invalidate, invalidateByTerms, clear, stats };
