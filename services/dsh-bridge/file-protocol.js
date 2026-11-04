'use strict';
const crypto = require('node:crypto');
const LIMITS = Object.freeze({ documents: 5, documentCharacters: 50000, documentTotalCharacters: 200000, artifacts: 5, artifactBytes: 256 * 1024, artifactTotalBytes: 1024 * 1024, sessionArtifactBytes: 5 * 1024 * 1024, globalArtifactBytes: 32 * 1024 * 1024 });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const taskId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
function validateModelSelection(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === 'modelId,providerId'
    && typeof value.providerId === 'string' && /^(?:platform|personal|chatgpt):[a-zA-Z0-9_-]{1,128}$/.test(value.providerId)
    && typeof value.modelId === 'string' && value.modelId.length > 0 && value.modelId.length <= 200 && value.modelId.isWellFormed()
    && !/[\p{Cc}]/u.test(value.modelId);
}
function validateUsage(value) {
  const keys = ['calls', 'complete', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'reasoningTokens'];
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key))
    && count(value.calls) && value.calls <= 1024 && typeof value.complete === 'boolean'
    && keys.slice(2).every(key => value[key] === undefined || count(value[key]))
    && (!value.complete || count(value.inputTokens) && count(value.outputTokens))
    && (value.calls !== 0 || keys.slice(2).every(key => value[key] === undefined || value[key] === 0))
    && (value.cachedInputTokens === undefined || value.inputTokens === undefined || value.cachedInputTokens <= value.inputTokens)
    && (value.cacheWriteInputTokens === undefined || value.inputTokens === undefined || value.cacheWriteInputTokens <= value.inputTokens)
    && (value.cachedInputTokens === undefined || value.cacheWriteInputTokens === undefined || value.inputTokens === undefined || value.cachedInputTokens + value.cacheWriteInputTokens <= value.inputTokens)
    && (value.reasoningTokens === undefined || value.outputTokens === undefined || value.reasoningTokens <= value.outputTokens));
}
function taskCapability(secret, id) {
  if (typeof secret !== 'string' || secret.length < 8 || !taskId(id)) throw Error('Invalid task capability');
  return 'dsh-task.' + id + '.' + crypto.createHmac('sha256', secret).update('dsh-task-v1:' + id).digest('hex');
}
function verifyTaskCapability(secret, value) {
  if (typeof value !== 'string') return null;
  const match = /^dsh-task\.([a-zA-Z0-9_-]{1,64})\.([a-f0-9]{64})$/.exec(value);
  if (!match || typeof secret !== 'string' || secret.length < 8) return null;
  const expected = taskCapability(secret, match[1]);
  return crypto.timingSafeEqual(Buffer.from(value), Buffer.from(expected)) ? match[1] : null;
}
const safeName = name => typeof name === 'string' && name.length > 0 && name.length <= 160 && name.isWellFormed() && !/[\\/<>:"|?*\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(name) && !/^[. ]|[. ]$/u.test(name) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
const outputName = name => safeName(name) && /\.(?:md|txt|csv|json|html|xml|svg|drawio|js|ts|py|css|yaml|yml)$/i.test(name);
function validateDocuments(documents) {
  return Array.isArray(documents) && documents.length <= LIMITS.documents && new Set(documents.map(d => d?.id)).size === documents.length && documents.every(d => d && Object.keys(d).sort().join(',') === 'id,name,text' && typeof d.id === 'string' && UUID.test(d.id) && safeName(d.name) && typeof d.text === 'string' && d.text.isWellFormed() && d.text.trim().length > 0 && !d.text.includes('\0') && d.text.length <= LIMITS.documentCharacters) && documents.reduce((sum, d) => sum + d.text.length, 0) <= LIMITS.documentTotalCharacters;
}
function validateArtifacts(artifacts) {
  return Array.isArray(artifacts) && artifacts.length <= LIMITS.artifacts && new Set(artifacts.map(a => a?.id)).size === artifacts.length && artifacts.every(a => a && Object.keys(a).sort().join(',') === 'id,name,text' && typeof a.id === 'string' && UUID.test(a.id) && outputName(a.name) && typeof a.text === 'string' && a.text.isWellFormed() && !a.text.includes('\0') && Buffer.byteLength(a.text) <= LIMITS.artifactBytes) && artifacts.reduce((sum, a) => sum + Buffer.byteLength(a.text), 0) <= LIMITS.artifactTotalBytes;
}
function fingerprint(ownerHash, body) {
  const identity = [ownerHash, body.conversationId, body.prompt];
  if (body.parentTaskId) identity.push(body.parentTaskId);
  if (body.documents?.length) identity.push(body.documents.map(d => [d.id, d.name, digest(d.text)]));
  if (body.modelSelection) identity.push([body.modelSelection.providerId, body.modelSelection.modelId]);
  return digest(JSON.stringify(identity));
}
module.exports = { LIMITS, digest, safeName, outputName, validateDocuments, validateArtifacts, fingerprint, validateModelSelection, validateUsage, taskCapability, verifyTaskCapability };
