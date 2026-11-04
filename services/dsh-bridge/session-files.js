'use strict';
// This module owns a fixed manifest and UUID blobs. Neither the browser nor the
// model ever supplies a host path. It is shared by the adapter and file tools.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { LIMITS, digest, outputName, validateDocuments, validateArtifacts } = require('./file-protocol');
const ID = /^[a-zA-Z0-9_-]{1,64}$/;
function directory(folder) {
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(folder); if (!info.isDirectory() || info.isSymbolicLink()) throw Error('File workspace unavailable');
}
function readJson(file) {
  const info = fs.lstatSync(file); if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw Error('Invalid file manifest');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function atomic(file, value) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp'; let fd;
  try { fd = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(fd, value); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; fs.renameSync(temp, file); }
  finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} }
}
function openFiles(folder, sessionId) {
  if (!path.isAbsolute(folder) || !ID.test(sessionId)) throw Error('Invalid file workspace');
  directory(folder); const manifestPath = path.join(folder, 'manifest.json'), blobRoot = path.join(folder, 'outputs'); directory(blobRoot);
  function load() {
    let state;
    try { state = readJson(manifestPath); } catch (error) { if (error.code === 'ENOENT') return { version: 1, sessionId, documents: [], artifacts: [] }; throw error; }
    if (state.version !== 1 || state.sessionId !== sessionId || !Array.isArray(state.documents) || !Array.isArray(state.artifacts) || state.documents.length > 100 || state.artifacts.length > 100 || state.documents.some(d => !ID.test(d.taskId) || !validateDocuments([{ id: d.id, name: d.name, text: d.text }]))) throw Error('Invalid file manifest');
    for (const item of state.artifacts) if (!ID.test(item.taskId) || !/^[a-f0-9-]{36}$/.test(item.id) || !outputName(item.name) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > LIMITS.artifactBytes || !/^[a-f0-9]{64}$/.test(item.sha256)) throw Error('Invalid file manifest');
    return state;
  }
  const save = state => atomic(manifestPath, JSON.stringify(state));
  function readArtifact(item) {
    const taskRoot = path.join(blobRoot, item.taskId); const rootInfo = fs.lstatSync(taskRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw Error('Output workspace unavailable');
    const file = path.join(taskRoot, item.id + '.blob'), info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== item.bytes) throw Error('Output file unavailable');
    const text = fs.readFileSync(file, 'utf8'); if (digest(text) !== item.sha256) throw Error('Output file changed');
    return { id: item.id, name: item.name, text };
  }
  return {
    stage(taskId, documents = []) {
      if (!ID.test(taskId) || !validateDocuments(documents)) throw Error('Invalid document input');
      const state = load();
      for (const doc of documents) {
        const existing = state.documents.find(item => item.id === doc.id);
        if (existing) { if (existing.name !== doc.name || existing.text !== doc.text) throw Error('Document identity already used'); }
        else state.documents.push({ ...doc, taskId });
      }
      if (state.documents.length > 100 || state.documents.reduce((sum, d) => sum + Buffer.byteLength(d.text), 0) > 2 * 1024 * 1024) throw Error('Conversation document capacity reached');
      save(state);
    },
    listDocuments() { return load().documents.map(({ id, name, text }) => ({ id, name, characters: text.length })); },
    readDocument(id, offset = 0, length = 20000) {
      if (!ID.test(id) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 30000) throw Error('Invalid document window');
      const doc = load().documents.find(item => item.id === id); if (!doc) throw Error('Document not found');
      return { id, name: doc.name, text: doc.text.slice(offset, offset + length), offset, totalCharacters: doc.text.length, nextOffset: offset + length < doc.text.length ? offset + length : null };
    },
    write(taskId, name, text) {
      if (!ID.test(taskId) || !outputName(name) || typeof text !== 'string' || !text.isWellFormed() || text.includes('\0') || Buffer.byteLength(text) > LIMITS.artifactBytes) throw Error('Invalid output: use a supported filename and at most 256 KiB of UTF-8 text');
      const state = load(), previous = state.artifacts.find(item => item.taskId === taskId && item.name === name);
      const next = state.artifacts.filter(item => item !== previous);
      const item = { id: crypto.randomUUID(), taskId, name, bytes: Buffer.byteLength(text), sha256: digest(text) };
      if (next.filter(a => a.taskId === taskId).length >= LIMITS.artifacts || next.filter(a => a.taskId === taskId).reduce((sum, a) => sum + a.bytes, item.bytes) > LIMITS.artifactTotalBytes || next.reduce((sum, a) => sum + a.bytes, item.bytes) > LIMITS.sessionArtifactBytes || next.length >= 100) throw Error('Output capacity reached');
      const taskRoot = path.join(blobRoot, taskId); directory(taskRoot);
      atomic(path.join(taskRoot, item.id + '.blob'), text);
      state.artifacts = [...next, item]; save(state);
      if (previous) { try { fs.unlinkSync(path.join(taskRoot, previous.id + '.blob')); } catch {} }
      return { id: item.id, name, bytes: item.bytes };
    },
    listOutputs() { return load().artifacts.map(({ id, name, bytes, taskId }) => ({ id, name, bytes, taskId })); },
    readOutput(id, offset = 0, length = 20000) {
      if (!ID.test(id) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 30000) throw Error('Invalid output window');
      const item = load().artifacts.find(a => a.id === id); if (!item) throw Error('Output not found'); const result = readArtifact(item);
      return { id, name: result.name, text: result.text.slice(offset, offset + length), offset, totalCharacters: result.text.length, nextOffset: offset + length < result.text.length ? offset + length : null };
    },
    artifacts(taskId) {
      if (!ID.test(taskId)) throw Error('Invalid task identity');
      const items = load().artifacts.filter(item => item.taskId === taskId).map(readArtifact);
      if (!validateArtifacts(items)) throw Error('Invalid output files'); return items;
    },
  };
}
module.exports = { openFiles };
