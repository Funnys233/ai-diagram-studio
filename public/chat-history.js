(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DiagramChatHistory = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const time = value => Number.isFinite(value) && value >= 0 ? value : 0;
  const validThread = value => value && typeof value.id === 'string' && value.id && Array.isArray(value.messages);
  const pending = item => item?.role === 'assistant' && item.pending === true;

  // Keep deletion records independently of the bounded history array. A stale
  // tab must not bring a deleted UUID back after the visible history is trimmed.
  function mergeDeleted(...sources) {
    const result = Object.create(null);
    for (const source of sources) {
      if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
      for (const [id, deletedAt] of Object.entries(source)) {
        if (id && Number.isFinite(deletedAt) && deletedAt >= 0) result[id] = Math.max(result[id] || 0, deletedAt);
      }
    }
    return result;
  }

  function messageEntries(messages) {
    const repetitions = new Map();
    return messages.filter(item => item && typeof item === 'object').map(item => {
      if (typeof item.id === 'string' && item.id) return [JSON.stringify(['id', item.id]), item];
      if (typeof item.taskId === 'string' && item.taskId) return [JSON.stringify(['task', item.taskId]), item];
      // Legacy messages have no IDs. Match each occurrence so repeated identical
      // questions remain separate, without duplicating the same old transcript.
      const legacy = JSON.stringify([item.role, item.content]);
      const occurrence = repetitions.get(legacy) || 0; repetitions.set(legacy, occurrence + 1);
      return [JSON.stringify(['legacy', legacy, occurrence]), item];
    });
  }

  function mergeMessage(stored, incoming) {
    let winner = time(incoming.updatedAt) >= time(stored.updatedAt) ? incoming : stored;
    if (pending(stored) !== pending(incoming) && stored.role === 'assistant' && incoming.role === 'assistant') {
      winner = pending(stored) ? incoming : stored;
    } else if (pending(stored) && pending(incoming) && typeof stored.content === 'string' && typeof incoming.content === 'string') {
      // A later page-hide timestamp does not make a shorter old snapshot newer.
      if (stored.content.startsWith(incoming.content)) winner = stored;
      else if (incoming.content.startsWith(stored.content)) winner = incoming;
    } else if (stored.taskStatus === 'succeeded' || incoming.taskStatus === 'succeeded') {
      winner = stored.taskStatus === 'succeeded' ? stored : incoming;
    }
    const other = winner === incoming ? stored : incoming;
    const result = { ...other, ...winner };
    const rank = receipt => ({ unknown: 0, pending: 1, settled: 2 }[receipt?.status] ?? -1);
    if (rank(other.turnUsage) > rank(winner.turnUsage)) result.turnUsage = other.turnUsage;
    if (result.role === 'assistant' && !result.pending && result.failed === false) delete result.notice;
    return result;
  }

  function limitMessages(messages) {
    if (messages.length <= 80) return messages;
    const selected = new Set();
    for (let index = 0; index < messages.length; index++) if (pending(messages[index])) {
      selected.add(index);
      for (let previous = index - 1; previous >= 0; previous--) if (messages[previous].role === 'user') { selected.add(previous); break; }
    }
    for (let index = messages.length - 1; index >= 0 && selected.size < 80; index--) selected.add(index);
    return messages.filter((item, index) => selected.has(index));
  }

  function mergeThread(stored, incoming) {
    const items = new Map(messageEntries(stored.messages));
    for (const [key, item] of messageEntries(incoming.messages)) items.set(key, items.has(key) ? mergeMessage(items.get(key), item) : { ...item });
    // Message updates must not revive removed reference documents. New clients
    // timestamp metadata edits separately; legacy clients only have updatedAt.
    const modernStored = Number.isFinite(stored.metadataUpdatedAt), modernIncoming = Number.isFinite(incoming.metadataUpdatedAt);
    const incomingMetadata = modernStored !== modernIncoming ? modernIncoming
      : time(modernIncoming ? incoming.metadataUpdatedAt : incoming.updatedAt) >= time(modernStored ? stored.metadataUpdatedAt : stored.updatedAt);
    const winner = incomingMetadata ? incoming : stored, other = incomingMetadata ? stored : incoming;
    return { ...other, ...winner, updatedAt: Math.max(time(stored.updatedAt), time(incoming.updatedAt)), messages: limitMessages([...items.values()]) };
  }

  function merge(rows, stored, deleted = {}) {
    const tombstones = mergeDeleted(deleted), threads = new Map();
    for (const row of [...(Array.isArray(stored) ? stored : []), ...(Array.isArray(rows) ? rows : [])]) {
      if (!validThread(row) || own(tombstones, row.id)) continue;
      const previous = threads.get(row.id);
      threads.set(row.id, mergeThread(previous || { id: row.id, messages: [] }, row));
    }
    const recent = [...threads.values()].filter(thread => thread.messages.length).sort((a, b) => time(b.updatedAt) - time(a.updatedAt) || a.id.localeCompare(b.id));
    const active = recent.filter(thread => thread.messages.some(pending));
    const kept = new Set(active.map(thread => thread.id));
    for (const thread of recent) if (kept.size < 40) kept.add(thread.id);
    // Limits apply to completed history. Do not discard recovery handles if
    // an exceptional number of pending tasks temporarily exceeds either limit.
    return recent.filter(thread => kept.has(thread.id));
  }

  return { merge, mergeDeleted };
});
