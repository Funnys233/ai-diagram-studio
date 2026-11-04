const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-chatgpt-http-'));
process.env.PROVIDERS_CONFIG_PATH = path.join(directory, 'providers.json');
process.env.DEEPSEEK_API_KEY = '';
const { createServer, chatgptLocal: runtime } = require('../../server');
const { sampleModel } = require('../helpers/fixtures');
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
let base, server, nonce, captured = [], outputMode = 'chat';
function identity() {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'integration' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iss: 'https://auth.openai.com', sub: 'integration', aud: 'oaiapp_integration', nonce, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, email: 'fixture@example.test' })).toString('base64url');
  return `${header}.${body}.${crypto.sign('sha256', Buffer.from(`${header}.${body}`), privateKey).toString('base64url')}`;
}
async function request(route, body, headers = {}) {
  const result = await fetch(base + route, body === undefined ? { headers } : { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await result.text(); let data; try { data = JSON.parse(text); } catch { /* SSE or HTML */ }
  return { status: result.status, text, data };
}
test.before(async () => {
  runtime.request = async (url, form) => {
    if (url.endsWith('/oauth/token')) { assert.equal(form.client_id, 'oaiapp_integration'); assert.ok(form.code_verifier); return { status: 200, data: { id_token: identity(), access_token: 'test-access-sensitive', refresh_token: 'test-refresh-sensitive', token_type: 'Bearer', scope: 'openid chatgpt.tokens.use.direct', expires_in: 3600 } }; }
    if (url.endsWith('/jwks.json')) return { status: 200, data: { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'integration' }] } };
    if (url.endsWith('/models')) return { status: 200, data: { models: [{ slug: 'integration-model', display_name: 'Integration Model', visibility: 'list', input_modalities: ['text', 'image'] }] } };
    if (url.endsWith('openid-configuration')) return { status: 200, data: { revocation_endpoint: 'https://auth.openai.com/revoke' } };
    if (url.endsWith('/revoke')) return { status: 200 };
    throw Error('unexpected mock URL');
  };
  runtime.post = async (url, headers, body, timeout, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(headers.Authorization, 'Bearer test-access-sensitive');
    captured.push(body);
    const emit = data => options.onEvent({ data: JSON.stringify(data) });
    emit({ type: 'response.output_item.added', item: { type: 'reasoning' } });
    emit({ type: 'response.output_text.delta', delta: outputMode === 'chat' ? '本地对话正常。' : sampleModel() });
    if (outputMode === 'failure') emit({ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } });
    else emit({ type: 'response.completed', response: { status: 'completed', model: 'integration-model' } });
    return { status: 200, streaming: true };
  };
  server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });

test('local login, catalog, drawing and conversation use the same subscription connection', async () => {
  assert.equal((await request('/api/auth/session')).data.mode, 'local');
  const start = await request('/api/chatgpt/connect', {}); assert.equal(start.status, 200);
  const auth = new URL(start.data.authorizationUrl); nonce = auth.searchParams.get('nonce');
  const callback = await request(`/auth/callback?state=${auth.searchParams.get('state')}&code=fixture-code&client_id=oaiapp_integration`);
  assert.equal(callback.status, 200); assert.match(callback.text, /已连接/); assert.doesNotMatch(callback.text, /sensitive|fixture-code/);
  assert.equal((await request('/api/chatgpt/models', {})).data.count, 1);
  const catalog = (await request('/api/models/catalog')).data;
  const providerId = catalog.providers[0].providerId; assert.match(providerId, /^chatgpt:/);
  const chatCatalog = (await request('/api/conversation/models')).data; assert.equal(chatCatalog.providers[0].providerId, providerId);
  const conversation = await request('/api/conversation', { providerId, modelId: 'integration-model', message: '你好', history: [{ role: 'user', content: '第一轮' }, { role: 'assistant', content: '上一轮回答' }], stream: true });
  assert.match(conversation.text, /event: delta/); assert.match(conversation.text, /本地对话正常/); assert.match(conversation.text, /thinking/); assert.match(conversation.text, /event: result/);
  assert.equal(captured[0].input.length, 3); assert.equal(captured[0].input[1].content, '上一轮回答'); assert.equal(captured[0].store, false);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
  const imageChat = await request('/api/conversation', { providerId, modelId: 'integration-model', message: '继续看图', multimodal: true, images: [png], history: [{ role: 'user', content: '上一轮图片', images: [png] }] });
  assert.equal(imageChat.status, 200); assert.equal(captured.at(-1).input[0].content[1].type, 'input_image'); assert.equal(captured.at(-1).input[1].content[1].image_url, png);
  const imageDrawing = await request('/api/vision/edit', { providerId, modelId: 'integration-model', message: '讨论此图', editMode: 'multimodal', currentXml: sampleModel(), vision: { image: png, baseXml: sampleModel() } });
  assert.equal(imageDrawing.status, 200); assert.equal(imageDrawing.data.kind, 'multimodal-chat'); assert.ok(captured.at(-1).input.at(-1).content.some(part => part.type === 'input_image'));
  outputMode = 'drawing';
  const diagram = await request('/api/chat', { providerId, modelId: 'integration-model', message: '生成图表', stream: true });
  assert.match(diagram.text, /event: result/); assert.match(diagram.text, /mxGraphModel/); assert.doesNotMatch(diagram.text, /event: error/);
  outputMode = 'failure';
  const failed = await request('/api/chat', { providerId, modelId: 'integration-model', message: '生成图表', stream: true });
  assert.match(failed.text, /event: error/); assert.doesNotMatch(failed.text, /event: result/); assert.match(failed.text, /额度/);
  for (const route of ['/api/chatgpt', '/api/models/catalog', '/api/conversation/models']) assert.doesNotMatch((await request(route)).text, /test-access-sensitive|test-refresh-sensitive|id_token|code_verifier/);
  await request('/api/chatgpt/disconnect', { accountId: runtime.data.activeId });
  assert.equal((await request('/api/models/catalog')).data.providers.length, 0);
  const disconnected = await request('/api/conversation', { providerId, modelId: 'integration-model', message: '不应调用' }); assert.equal(disconnected.status, 400);
});

test('document upload and follow-up preserve full text without multimodal or model-native file support', async () => {
  outputMode='chat';
  const auth=new URL((await request('/api/chatgpt/connect',{})).data.authorizationUrl);nonce=auth.searchParams.get('nonce');
  assert.equal((await request(`/auth/callback?state=${auth.searchParams.get('state')}&code=document-code&client_id=oaiapp_integration`)).status,200);
  await request('/api/chatgpt/models',{});
  const providerId='chatgpt:'+runtime.account().id;
  const uploaded=await request('/api/conversation/documents',{name:'项目说明.md',data:Buffer.from('# 松林项目\n'+'资料'.repeat(2500)+'\n最终预算为 73021 元。').toString('base64')});
  assert.equal(uploaded.status,200);assert.ok(uploaded.data.document.text.length>4000);
  const documents=[uploaded.data.document];
  const first=await request('/api/conversation',{providerId,modelId:'integration-model',message:'项目预算是多少？',documents,multimodal:false});
  assert.equal(first.status,200);assert.ok(captured.at(-1).input.some(item=>typeof item.content==='string'&&item.content.includes('最终预算为 73021 元')));
  const follow=await request('/api/conversation',{providerId,modelId:'integration-model',message:'再确认金额单位',documents,history:[{role:'user',content:'项目预算是多少？'},{role:'assistant',content:'73021 元。'}],multimodal:false});
  assert.equal(follow.status,200);assert.equal(captured.at(-1).input.length,4);assert.ok(captured.at(-1).input.some(item=>typeof item.content==='string'&&item.content.includes('项目说明.md')));
  const onlyDocument=await request('/api/conversation',{providerId,modelId:'integration-model',documents});assert.equal(onlyDocument.status,200);
  const before=captured.length;
  assert.equal((await request('/api/conversation',{providerId,modelId:'integration-model',message:'bad',documents:[{...documents[0],text:''}]})).status,400);assert.equal(captured.length,before);
  assert.equal((await request('/api/conversation/documents',{name:'bad.pdf',data:Buffer.from('invalid').toString('base64')})).status,422);
  assert.equal((await request('/api/conversation/documents',{name:'plan.txt',data:Buffer.from('test').toString('base64')},{Origin:'https://attacker.test'})).status,403);
});

test('loopback guards reject foreign origins and forged OAuth state without a network call', async () => {
  const count = captured.length;
  assert.equal((await request('/api/chatgpt/connect', {}, { Origin: 'https://attacker.test' })).status, 403);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    http.get(base + '/api/chatgpt', { headers: { Host: 'attacker.test' } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); }).on('error', reject);
  });
  assert.equal(foreignHostStatus, 403);
  const forged = await request('/auth/callback?state=forged&code=never-redeem&client_id=oaiapp_attacker'); assert.equal(forged.status, 400);
  assert.doesNotMatch(forged.text, /never-redeem/); assert.equal(captured.length, count);
});

test('multimodal PDF pages reach Responses as images and remain available in follow-up',async()=>{
  const {pdfFile,scannedPdfFile}=require('../helpers/document-fixtures.cjs');
  const providerId='chatgpt:'+runtime.account().id;
  const uploaded=await request('/api/conversation/documents',{name:'scan.pdf',data:scannedPdfFile().toString('base64'),multimodal:true});
  assert.equal(uploaded.status,200);assert.equal(uploaded.data.document.text,'');
  const documents=[uploaded.data.document],body={providerId,modelId:'integration-model',message:'页面是什么颜色？',documents,multimodal:true};
  const before=captured.length;
  assert.equal((await request('/api/conversation',{...body,multimodal:false})).status,400);assert.equal(captured.length,before);
  assert.equal((await request('/api/conversation',body)).status,200);
  const content=captured.at(-1).input[0].content;assert.equal(content[2].type,'input_image');assert.match(content[1].text,/scan.pdf · 第 1 页/);assert.match(content[2].image_url,/^data:image\/jpeg;base64,/);
  assert.equal((await request('/api/conversation',{...body,message:'继续描述排版',history:[{role:'user',content:'上一轮问题'},{role:'assistant',content:'有红色圆形'}]})).status,200);
  assert.equal(captured.at(-1).input[2].content[2].type,'input_image');
  const textPdf=(await request('/api/conversation/documents',{name:'text.pdf',data:pdfFile('Text stays available').toString('base64'),multimodal:true})).data.document;
  assert.equal((await request('/api/conversation',{...body,documents:[textPdf],multimodal:false})).status,200);
  assert.equal(typeof captured.at(-1).input[0].content,'string');assert.match(captured.at(-1).input[0].content,/Text stays available/);
});
