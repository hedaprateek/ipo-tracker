'use strict';

// A cache read is not a new source observation. Keep the original timestamp,
// coalesce concurrent requests, and retain the last successful snapshot on error.
function createLiveCache({read, write, now = Date.now}) {
  const entries = new Map(), pending = new Map();
  return async function get(key, produce, {force = false, ttl = 60000} = {}) {
    if (pending.has(key)) return pending.get(key);
    const previous = entries.get(key) || read(key);
    if (!force && previous && now() - Date.parse(previous.fetchedAt) < ttl) return previous;
    const job = (async () => {
      try {
        const value = await produce(previous);
        if (!Array.isArray(value) || !value.length) throw new Error('Source returned no records');
        const snapshot = {[key]: value, fetchedAt: new Date(now()).toISOString()};
        entries.set(key, snapshot);
        write(key, snapshot);
        return snapshot;
      } catch (error) {
        if (!previous) throw error;
        return {...previous, sourceError: error.message};
      } finally { pending.delete(key); }
    })();
    pending.set(key, job);
    return job;
  };
}
module.exports = {createLiveCache};
