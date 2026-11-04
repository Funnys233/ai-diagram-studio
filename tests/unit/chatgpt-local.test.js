const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ChatGPTLocal, verifyIdentity } = require('../../lib/chatgpt-local');
const responses = require('../../lib/adapters/chatgpt-responses');
const { createModelStream } = require('../../lib/model-stream');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture', use: 'sig', alg: 'RS256' };
function jwt(claims = {}, key = privateKey) {
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iss: 'https://auth.openai.com', aud: 'oaiapp_fixture', sub: 'alice', email: 'alice@example.test', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...claims })).toString('base64url');
  return `${head}.${body}.${crypto.sign('sha256', Buffer.from(`${head}.${body}`), key).toString('base64url')}`;
}
function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-chatgpt-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const requests = [];
  const runtime = new ChatGPTLocal({ filePath: path.join(directory, 'auth.json'), request: async (url, form, token) => {
    requests.push({ url, form, token });
    if (url.endsWith('jwks.json')) return { status: 200, data: { keys: [jwk] } };
    if (url.endsWith('/models')) return { status: 200, data: { models: [{ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list', input_modalities: ['text', 'image'], supported_reasoning_levels: [{ effort: 'none' }, { effort: 'low' }, { effort: 'high' }], default_reasoning_level: 'high' }, { slug: 'hidden', visibility: 'hide' }] } };
    if (url.endsWith('openid-configuration')) return { status: 200, data: { revocation_endpoint: 'https://auth.openai.com/revoke' } };
    if (url.endsWith('/revoke')) return { status: 200 };
    throw Error('Unexpected request');
  }, ...overrides });
  runtime.load();
  return { runtime, requests, directory };
}
async function signIn(runtime, clientId = 'oaiapp_fixture', subject = 'alice', scope = 'chatgpt.tokens.use.direct') {
  const authorize = new URL(runtime.start(8080).authorizationUrl);
  const original = runtime.request;
  runtime.request = async (url, form, token) => url.endsWith('/oauth/token') ? { status: 200, data: { id_token: jwt({ nonce: authorize.searchParams.get('nonce'), sub: subject, aud: clientId }), access_token: 'private-access-token', refresh_token: 'private-refresh-token', token_type: 'Bearer', expires_in: 3600, scope } } : original(url, form, token);
  await runtime.callback(new URL(`http://127.0.0.1:8080/auth/callback?state=${authorize.searchParams.get('state')}&code=one-use&client_id=${clientId}`));
  runtime.request = original;
  return authorize;
}

test('identity rejects forged signatures, nonce, issuer, audience and expiration', () => {
  assert.equal(verifyIdentity(jwt({ nonce: 'correct' }), 'oaiapp_fixture', 'correct', [jwk]).subject, 'alice');
  for (const claims of [{ nonce: 'wrong' }, { nonce: 'correct', iss: 'https://attacker.test' }, { nonce: 'correct', aud: 'other' }, { nonce: 'correct', exp: 1 }, { nonce: 'correct', iat: Date.now() / 1000 + 999 }]) assert.throws(() => verifyIdentity(jwt(claims), 'oaiapp_fixture', 'correct', [jwk]));
  const forged = jwt({ nonce: 'correct' }).split('.'); forged[1] = Buffer.from(JSON.stringify({ sub: 'attacker' })).toString('base64url');
  assert.throws(() => verifyIdentity(forged.join('.'), 'oaiapp_fixture', 'correct', [jwk]));
});

test('registration uses PKCE, persists a host, rejects stale and replayed callbacks, never returns credentials', async t => {
  const { runtime } = fixture(t);
  const authorize = new URL(runtime.start(8080).authorizationUrl), host = authorize.searchParams.get('ext_agent_host_id');
  assert.equal(authorize.origin, 'https://auth.openai.com'); assert.equal(authorize.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(authorize.searchParams.get('redirect_uri'), 'http://127.0.0.1:8080/auth/callback');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(authorize.searchParams.get('scope').includes('chatgpt.tokens.use.direct'));
  await assert.rejects(runtime.callback(new URL('http://127.0.0.1/auth/callback?state=wrong&code=bad')));
  const valid = await signIn(runtime); const account = runtime.account();
  await assert.rejects(runtime.callback(new URL(`http://127.0.0.1/auth/callback?state=${valid.searchParams.get('state')}&code=replay&client_id=oaiapp_fixture`)));
  assert.equal(fs.statSync(runtime.filePath).mode & 0o777, 0o600);
  const restarted = new ChatGPTLocal({ filePath: runtime.filePath });
  assert.equal(new URL(restarted.start(8090, account.id).authorizationUrl).searchParams.get('ext_agent_host_id'), host);
  const reconnect = new URL(runtime.start(8080, account.id).authorizationUrl);
  assert.equal(reconnect.searchParams.get('client_id'), 'oaiapp_fixture'); assert.equal(reconnect.searchParams.has('agent_name_hint'), false);
  assert.equal(reconnect.searchParams.has('id_token_hint'), false);
  assert.doesNotMatch(JSON.stringify(runtime.status()), /private-access-token|private-refresh-token|eyJ/);
});

test('granted scope controls inference; catalog uses listed slugs and isolates same-email registrations', async t => {
  const { runtime } = fixture(t);
  await signIn(runtime, 'oaiapp_no_plan', 'alice', 'openid email');
  await assert.rejects(runtime.refreshModels(), /尚未授权/); assert.equal(runtime.catalog().length, 0);
  await signIn(runtime); await runtime.refreshModels();
  const first = runtime.account();
  await signIn(runtime, 'oaiapp_other_workspace'); await runtime.refreshModels();
  assert.equal(runtime.data.accounts.length, 3); assert.notEqual(runtime.account().id, first.id);
  assert.equal(runtime.catalog().length, 2); assert.equal(runtime.catalog()[0].models.length, 1);
  const selected = runtime.resolve('chatgpt:' + first.id, 'fixture-model'); assert.equal(selected.ok, true);
  assert.equal(selected.lock.model.visionInput, true); assert.deepEqual(selected.lock.model.reasoningLevels, ['low', 'high']);
  assert.equal(selected.lock.model.supportsNone, true);
  assert.equal(runtime.resolve('chatgpt:' + first.id, 'hidden').ok, false);
  runtime.preference('chatgpt:' + first.id, 'fixture-model', { thinkingMode: 'responses-off', reasoningEffort: 'high' });
  assert.equal(runtime.resolve('chatgpt:' + first.id, 'fixture-model').lock.model.thinkingMode, 'responses-off');
  assert.equal(runtime.resolve('chatgpt:' + runtime.account().id, 'fixture-model').lock.model.thinkingMode, undefined);
});

test('refresh is serialized and rotating credentials are persisted; transient failures keep session', async t => {
  const { runtime } = fixture(t); await signIn(runtime);
  const account = runtime.account(); account.expiresAt = 0; let calls = 0;
  runtime.request = async (url, form) => { assert.equal(form.client_id, 'oaiapp_fixture'); assert.equal(form.resource, 'https://api.openai.com/v1'); calls++; await new Promise(resolve => setTimeout(resolve, 10)); return { status: 200, data: { access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600 } }; };
  assert.deepEqual(await Promise.all([runtime.token(account.id), runtime.token(account.id)]), ['rotated-access', 'rotated-access']); assert.equal(calls, 1);
  assert.equal(JSON.parse(fs.readFileSync(runtime.filePath)).accounts[0].refreshToken, 'rotated-refresh');
  account.expiresAt = 0; runtime.request = async () => { throw Error('offline'); };
  await assert.rejects(runtime.token(account.id)); assert.equal(account.refreshToken, 'rotated-refresh');
});

test('disconnect prevents an in-flight refresh from resurrecting credentials and retains registration', async t => {
  const { runtime } = fixture(t); await signIn(runtime); const account = runtime.account(); account.expiresAt = 0;
  let finishRefresh; const original = runtime.request;
  runtime.request = async (url, form) => form?.grant_type === 'refresh_token' ? new Promise(resolve => { finishRefresh = resolve; }) : original(url, form);
  const pending = runtime.token(account.id); const rejected = assert.rejects(pending);
  assert.equal((await runtime.disconnect(account.id)).revoked, true);
  finishRefresh({ status: 200, data: { access_token: 'must-not-be-saved', expires_in: 3600 } }); await rejected;
  assert.equal(account.accessToken, ''); assert.equal(account.clientId, 'oaiapp_fixture'); assert.equal(runtime.catalog().length, 0);
});

test('Responses request preserves history/images, moves system instructions, omits unsupported parameters', () => {
  const request = responses.buildChatRequest({ apiKey: 'secret' }, { modelId: 'fixture-model', maxTokens: 10, temperature: .7, reasoningEffort: 'high' }, [{ role: 'system', content: 'draw XML' }, { role: 'user', content: 'earlier' }, { role: 'assistant', content: 'answer' }, { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } }] }]);
  assert.equal(request.url, 'https://api.openai.com/v1/responses'); assert.equal(request.body.instructions, 'draw XML');
  assert.equal(request.body.stream, true); assert.equal(request.body.store, false); assert.equal(request.body.input.length, 3);
  assert.equal(request.body.input[2].content[1].type, 'input_image'); assert.equal(request.body.input[1].content, 'answer');
  for (const key of ['temperature', 'max_tokens', 'max_output_tokens', 'previous_response_id', 'messages']) assert.equal(key in request.body, false);
  assert.deepEqual(request.body.reasoning, { effort: 'high' });
});

test('cancel and disconnect abort active subscription requests without another billing path', async t => {
  let started; let calls = 0;
  const { runtime } = fixture(t, { post: async (url, headers, body, timeout, options) => {
    calls++; started();
    return new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  } });
  await signIn(runtime); await runtime.refreshModels();
  const lock = runtime.resolve('chatgpt:' + runtime.account().id, 'fixture-model').lock;
  const controller = new AbortController(); let ready = new Promise(resolve => { started = resolve; });
  const call = runtime.call(lock, [{ role: 'user', content: 'test' }], 1000, { signal: controller.signal });
  const cancelled = assert.rejects(call, e => e.name === 'AbortError'); await ready; controller.abort(); await cancelled;
  ready = new Promise(resolve => { started = resolve; });
  const second = runtime.call(lock, [{ role: 'user', content: 'test' }], 1000); const disconnected = assert.rejects(second, e => e.name === 'AbortError');
  await ready; await runtime.disconnect(runtime.account().id); await disconnected;
  assert.equal(calls, 2); assert.equal(runtime.catalog().length, 0);
});

test('Responses success requires completed event; partial XML and usage failures never succeed', () => {
  const progress = [], deltas = [];
  const stream = () => createModelStream('chatgpt-responses', responses, 'ChatGPT', e => progress.push(e), 1000, d => deltas.push(d));
  const event = (stream, data) => stream.accept({ data: JSON.stringify(data) });
  const complete = stream(); event(complete, { type: 'response.reasoning_summary_text.delta', delta: 'private thought' }); event(complete, { type: 'response.output_text.delta', delta: '<mxGraphModel/>' });
  assert.throws(() => complete.finish(), /未完整/);
  event(complete, { type: 'response.completed', response: { status: 'completed', model: 'fixture-model', usage: { input_tokens: 1 } } });
  assert.equal(complete.finish().text, '<mxGraphModel/>'); assert.ok(progress.some(p => p.phase === 'thinking')); assert.doesNotMatch(JSON.stringify(progress), /private thought/);
  const failed = stream(); event(failed, { type: 'response.output_text.delta', delta: '<mxGraphModel/>' });
  assert.throws(() => event(failed, { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'sensitive upstream data' } } }), /额度/);
  assert.throws(() => failed.finish(), /未完整/);
  const incomplete = stream(); assert.throws(() => event(incomplete, { type: 'response.incomplete' }), /未完整/);
});


test('Luna supports off even when cached SIWC levels omit none; unknown models stay strict', async t => {
  const {runtime}=fixture(t);await signIn(runtime);await runtime.refreshModels();
  const account=runtime.account(),providerId='chatgpt:'+account.id;
  account.models=[{modelId:'gpt-6-luna',displayName:'Luna',enabled:true,supportsNone:false,reasoningLevels:['low','medium','high'],defaultEffort:'medium'}, {modelId:'gpt-6-astra',enabled:true,supportsNone:false,reasoningLevels:['low','high'],defaultEffort:'high'}];runtime.save();
  assert.equal(runtime.resolve(providerId,'gpt-6-luna').lock.model.supportsNone,true);
  assert.equal(runtime.resolve(providerId,'gpt-6-astra').lock.model.supportsNone,false);
  assert.throws(()=>runtime.preference(providerId,'gpt-6-astra',{thinkingMode:'responses-off'}));
  runtime.preference(providerId,'gpt-6-luna',{thinkingMode:'responses-off',reasoningEffort:'high'});
  let lock=runtime.resolve(providerId,'gpt-6-luna').lock;
  assert.deepEqual(responses.buildChatRequest({apiKey:'fixture'},lock.model,[{role:'user',content:'test'}]).body.reasoning,{effort:'none'});
  runtime.preference(providerId,'gpt-6-luna',{thinkingMode:'responses-on'});lock=runtime.resolve(providerId,'gpt-6-luna').lock;
  assert.deepEqual(responses.buildChatRequest({apiKey:'fixture'},lock.model,[{role:'user',content:'test'}]).body.reasoning,{effort:'high'});
  const original=runtime.request;runtime.request=async(url,...args)=>url.endsWith('/models')?{status:200,data:{models:[{slug:'gpt-6-luna',visibility:'list',supported_reasoning_levels:[{effort:'low'},{effort:'medium'}],default_reasoning_level:'medium'}]}}:original(url,...args);
  await runtime.refreshModels();assert.equal(runtime.account().models[0].supportsNone,true);
});
