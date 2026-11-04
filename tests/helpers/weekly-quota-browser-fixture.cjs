'use strict';
// Isolated browser fixture: all inference is sent to this process's local gateway.
const http = require('node:http');
const dns = require('node:dns').promises, lookup = dns.lookup;
dns.lookup = (host, options) => host === 'api.fixture.example' ? Promise.resolve([{ address: '8.8.8.8', family: 4 }]) : lookup(host, options);
const service = require('../../lib/model-service'), original = service.callWithLock;
let gatewayBase, gatewayCalls = 0, failUsage = false, lastReasoningEffort = null;
let drawingAttempts = 0;
let completedStreamsClosed = 0, hangUsage = false;
let failModels = false, delayNextCreation = false;
const recoveryStreams = new Set();
service.callWithLock = (lock, messages, timeout, options) => original({ ...lock, baseUrl: gatewayBase }, messages, timeout, { ...options, networkPolicy: false });
const originalProbe = service.probeReasoningEfforts;
service.probeReasoningEfforts = (lock, options) => originalProbe({ ...lock, baseUrl: gatewayBase }, { ...options, networkPolicy: false });
const { createServer, cloudRuntime: cloud } = require('../../server');
(async () => {
  const gateway = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => raw += chunk);
    req.on('end', () => {
      const body=JSON.parse(raw || '{}'); gatewayCalls++; lastReasoningEffort=body.reasoning_effort||null;
      if(process.env.REASONING_COMPAT_FIXTURE==='true'&&body.reasoning_effort?.startsWith('diagram_probe_')){
        const invalid=body.reasoning_effort.slice(0,3)+'...'+body.reasoning_effort.slice(-3);
        res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:`Invalid value: '${invalid}'. Supported values are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', and 'max'.`}}));return;
      }
      const text=JSON.stringify(body.messages||[]);
      if(process.env.CHAT_COMPLETION_FIXTURE==='true'){
        res.writeHead(200,{'Content-Type':'text/event-stream'});
        res.write('data: '+JSON.stringify({choices:[{delta:{content:'已经生成的第一段。'}}]})+'\n\n');
        const finish=setTimeout(()=>{
          if(JSON.stringify(body.messages?.at(-1)?.content).includes('出错'))res.write('data: '+JSON.stringify({error:{message:'fixture terminal error'}})+'\n\n');
          else res.write('data: '+JSON.stringify({choices:[{delta:{content:'完整回复结束。'},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:100}})+'\n\ndata: [DONE]\n\n');
        },150);
        const ping=setInterval(()=>res.write(': ping\n\n'),100);
        res.once('close',()=>{completedStreamsClosed++;clearTimeout(finish);clearInterval(ping);});return;
      }
      if(process.env.STREAM_BUSY_FIXTURE==='true'){
        res.writeHead(200,{'Content-Type':'text/event-stream'});
        if(JSON.stringify(body.messages?.at(-1)?.content||'').includes('部分输出'))res.write('data: '+JSON.stringify({choices:[{delta:{content:'已经生成的部分回答。'}}]})+'\n\n');
        else res.write('data: '+JSON.stringify({choices:[{delta:{role:'assistant',content:''}}]})+'\n\n');
        return res.end('data: '+JSON.stringify({error:{message:'The service is busy. Please retry later.'}})+'\n\n');
      }
      if(process.env.CACHE_USAGE_FIXTURE==='true'){
        const last=JSON.stringify(body.messages?.at(-1)?.content||'');
        const usage={prompt_tokens:1000,completion_tokens:100,total_tokens:1100,...(last.includes('缓存未知')?{}:{prompt_tokens_details:{cached_tokens:last.includes('缓存零')?0:800}})};
        const content=last.includes('画图缓存')?require('./fixtures').sampleModel():'缓存统计测试回复。';
        if(body.stream){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{content},finish_reason:'stop'}],usage:null})+'\n\n');return res.end((body.stream_options?.include_usage?'data: '+JSON.stringify({choices:[],usage})+'\n\n':'')+'data: [DONE]\n\n');}
        res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({choices:[{message:{content},finish_reason:'stop'}],usage}));
      }
      if(process.env.TURN_USAGE_FIXTURE==='true'&&JSON.stringify(body.messages?.at(-1)?.content||'').includes('费用限流')){
        res.writeHead(429,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Upstream rate limit exceeded, please retry later'}}));return;
      }
      if(process.env.TURN_USAGE_FIXTURE==='true'&&text.includes('费用失败')){
        res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'fixture failure'},usage:{prompt_tokens:100,completion_tokens:100}}));return;
      }
      if(process.env.TURN_USAGE_FIXTURE==='true'&&text.includes('费用取消')){
        res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();res.write('data: '+JSON.stringify({choices:[{delta:{content:'开始回答，等待取消。'}}]})+'\n\n');return;
      }
      if(process.env.CHAT_RECOVERY_FIXTURE==='true'&&text.includes('恢复测试')){
        res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();
        if(!text.includes('等待首字'))res.write('data: '+JSON.stringify({choices:[{delta:{content:'已保存的第一段。'}}]})+'\n\n');
        recoveryStreams.add(res);res.once('close',()=>recoveryStreams.delete(res));return;
      }
      if(process.env.MATH_RENDER_FIXTURE==='true'){
        const content=require('node:fs').readFileSync(require('node:path').join(__dirname,'math-reply.txt'),'utf8');
        res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();let offset=0;
        const timer=setInterval(()=>{
          if(offset<content.length){res.write('data: '+JSON.stringify({choices:[{delta:{content:content.slice(offset,offset+16)}}]})+'\n\n');offset+=16;return;}
          clearInterval(timer);res.end('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:100}})+'\n\ndata: [DONE]\n\n');
        },50);res.once('close',()=>clearInterval(timer));return;
      }
      const drawing=process.env.TURN_USAGE_FIXTURE==='true'&&text.includes('画图费用重试');
      const content=drawing?(++drawingAttempts===1?'invalid XML':require('./fixtures').sampleModel()):'这是本地模拟回复。';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }));
    });
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  gatewayBase = 'http://127.0.0.1:' + gateway.address().port;
  const admin = cloud.data.users[0];
  if(process.env.RELAY_RATE_FIXTURE==='true'){
    const models=['gpt-6-luna','gpt-6.1-sol','gpt-6-astra',...(process.env.ADMIN_HIDE56_FIXTURE==='true'?['gpt-5.6-luna','gpt-5.6-sol','gpt-5.6-terra']:[])].map(modelId=>({modelId,displayName:modelId,enabled:true,reasoningLevels:['low','medium','high'],defaultEffort:'low'}));
    const subscription=require('../../server').chatgptCloud;
    const account={id:require('node:crypto').randomUUID(),clientId:'oaiapp_relay_fixture',accessToken:'fixture-only-token',refreshToken:'fixture-only-refresh',expiresAt:Date.now()+86400000,scopes:['chatgpt.tokens.use.direct'],models,preferences:{}};
    subscription.data.accounts.push(account);subscription.data.activeId=account.id;subscription.save();
    for(const model of models)subscription.shareModel(model.modelId);
    await cloud.platform.createProvider({providerId:'relay',name:'中转',baseUrl:'https://api.fixture.example',protocol:'openai-chat-completions',apiKey:'fixture-relay',models:models.map(({modelId})=>({modelId,capabilityProfile:'custom',reasoningLevels:['low','medium','high']}))});
    await cloud.platform.createProvider({providerId:'luna-only',name:'Luna专用',baseUrl:'https://api.fixture.example',protocol:'openai-chat-completions',apiKey:'fixture-luna',models:[{modelId:'gpt-6-luna'}]});
  }
  for (const username of ['alice', 'bob']) await cloud.createUser({ identity: { user: admin } }, { username, password: 'fixture-password-123' });
  const alice = cloud.data.users.find(user => user.username === 'alice'), bob = cloud.data.users.find(user => user.username === 'bob');
  if(process.env.GROK_CLAUDE_FIXTURE==='true'){
    for(const [providerId,ids]of [['grok',['grok-4.6-latest','grok-4.7']],['anthropic',['claude-sonnet-5-5','claude-opus-5-5','claude-fable-5.1']]])await cloud.platform.createProvider({providerId,name:providerId,baseUrl:'https://api.fixture.example',protocol:'openai-chat-completions',apiKey:'fixture-new-models',models:ids.map(modelId=>({modelId,capabilityProfile:'custom',reasoningLevels:['low']}))});
    for(const username of ['maxuser','trialuser'])await cloud.createUser({identity:{user:admin}},{username,password:'fixture-password-123'});
    cloud.change(data=>{for(const [username,plan]of [['bob','pro'],['maxuser','max'],['trialuser','trial']])data.users.find(u=>u.username===username).membership={plan,expiresAt:plan==='trial'?null:Date.now()+86400000};});
  }
  await cloud.platform.createProvider({ providerId: 'mota', name: '测试共享模型', baseUrl: 'https://api.fixture.example', protocol: 'openai-chat-completions', apiKey: 'fixture-only' });
  for (const [modelId, displayName] of [['deepseek-ai/DeepSeek-V4.1-Flash', '免费 DeepSeek'], ['Qwen/Qwen3.8-27B', '免费 Qwen'], ['Qwen/Qwen3.8-Flash-Next', '免费 Flash'], ['future-open-model', '新增开放模型']]) await cloud.platform.addModel('mota', { modelId, displayName, capabilityProfile: 'custom', reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'] });
  if (process.env.QUOTA_MULTIPLIER_FIXTURE === 'true' || process.env.MEMBERSHIP_FIXTURE === 'true') for (const modelId of ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra']) await cloud.platform.addModel('mota', { modelId, displayName: modelId, capabilityProfile: 'custom', reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'] });
  if(process.env.REASONING_COMPAT_FIXTURE==='true')await cloud.platform.addModel('mota',{modelId:'gpt-6-luna',displayName:'Luna 中转测试'});
  if(process.env.LUNA_TERRA_FIXTURE==='true'){
    await cloud.platform.createProvider({providerId:'zz1',name:'luna专用',baseUrl:'https://api.fixture.example',protocol:'openai-chat-completions',apiKey:'fixture-dedicated',models:[{modelId:'gpt-6-luna'}]});
    await cloud.platform.addModel('mota',{modelId:'gpt-5.6-terra',displayName:'GPT-5.6 Terra'});
    for(const username of ['maxuser','trialuser'])await cloud.createUser({identity:{user:admin}},{username,password:'fixture-password-123'});
    cloud.change(data=>{for(const [username,plan]of [['bob','pro'],['maxuser','max'],['trialuser','trial']])data.users.find(u=>u.username===username).membership={plan,expiresAt:plan==='trial'?null:Date.now()+86400000};});
  }
  const personal = cloud.providerStore(alice.id);
  await personal.createProvider({ providerId: 'mine', name: '我的 API', baseUrl: 'https://api.fixture.example', protocol: 'openai-chat-completions', apiKey: 'fixture-personal' });
  await personal.addModel('mine', { modelId: 'my-model', displayName: '个人模型' });
  const seeds = [
    [admin, 'platform', 'mota', 'future-open-model', { prompt_tokens: 1000, completion_tokens: 250 }],
    [admin, 'chatgpt', 'chatgpt:fixture', 'gpt-shared', { input_tokens: 500, output_tokens: 125 }],
    [alice, 'platform', 'mota', 'future-open-model', { prompt_tokens: 600, completion_tokens: 100 }],
    [alice, 'platform', 'mota', 'Qwen/Qwen3.8-27B', { prompt_tokens: 300, completion_tokens: 50 }],
    [alice, 'personal', 'mine', 'my-model', { prompt_tokens: 150, completion_tokens: 25 }],
    [alice, 'platform', 'mota', 'future-open-model', null],
    [bob, 'platform', 'mota', 'future-open-model', { prompt_tokens: 4000, completion_tokens: 1000 }],
  ];
  for (const [user, source, providerId, modelId, usage] of seeds) {
    const session = { userId: user.id, hash: 'fixture-' + user.id, expires: Date.now() + 3600000 };
    if (!cloud.data.sessions.some(row => row.hash === session.hash)) cloud.change(data => data.sessions.push(session));
    const options = cloud.callOptions({ identity: { user, session } }, source, providerId, modelId);
    const id = options.beforeCall({ reasoningEffort: usage ? 'medium' : 'high' }); options.afterCall(id, { usage }, null);
  }
  const app = createServer();
  const server = http.createServer((req, res) => {
    if (process.env.CHAT_LOGIC_FIXTURE === 'true') {
      if (req.url === '/fixture-logic/fail-models') { failModels = true; res.end('ok'); return; }
      if (req.url === '/fixture-logic/restore-models') { failModels = false; res.end('ok'); return; }
      if (req.url === '/fixture-logic/delay-create') { delayNextCreation = true; res.end('ok'); return; }
      if (req.url === '/api/conversation/models' && failModels) { res.writeHead(503, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:{message:'模拟模型目录暂不可用'}})); return; }
      if (req.url === '/api/conversation/tasks' && req.method === 'POST' && delayNextCreation) {
        delayNextCreation = false; const end = res.end.bind(res);
        res.end = (...args) => { const timer = setTimeout(() => end(...args), 30000); res.once('close', () => clearTimeout(timer)); return res; };
      }
    }
    if(process.env.CHAT_COMPLETION_FIXTURE==='true'&&req.url==='/fixture-hang-usage'){hangUsage=true;res.end('ok');return;}
    if(process.env.CHAT_COMPLETION_FIXTURE==='true'&&req.url==='/api/usage'&&hangUsage){res.writeHead(200,{'Content-Type':'application/json'});res.flushHeaders();return;}
    if (process.env.CHAT_RECOVERY_FIXTURE === 'true' && req.url.startsWith('/fixture-recovery/')) {
      const action=req.url.split('/').pop();
      for(const stream of recoveryStreams){
        if(action==='chunk')stream.write('data: '+JSON.stringify({choices:[{delta:{content:'切换后仍继续显示。'}}]})+'\n\n');
        if(action==='finish'){stream.end('data: '+JSON.stringify({choices:[{delta:{content:'完整回复结束。'},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:100}})+'\n\ndata: [DONE]\n\n');}
      }
      res.end('ok');return;
    }
    if (process.env.MEMBERSHIP_FIXTURE === 'true' && req.method === 'POST' && req.url === '/fixture-membership-expire') { cloud.change(data => { data.users.find(user => user.id === alice.id).membership.expiresAt = Date.now() - 1; }); res.end('ok'); return; }
    if (req.url === '/fixture-stats') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ gatewayCalls, ...(process.env.REASONING_COMPAT_FIXTURE==='true'?{lastReasoningEffort}:{}),...(process.env.CHAT_COMPLETION_FIXTURE==='true'?{completedStreamsClosed}:{}) })); return; }
    if (req.url === '/fixture-fail-usage') { failUsage = true; res.end('ok'); return; }
    if (req.url === '/api/usage' && failUsage) { failUsage = false; res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: '模拟额度读取失败' } })); return; }
    if (req.url.startsWith('/fixture-editor')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><html><body style="background:#fafbf8;font:14px system-ui;color:#7c897c"><p>编辑器协议测试</p><script>let xml='';const send=data=>parent.postMessage(JSON.stringify(data),'*');addEventListener('message',event=>{let m;try{m=JSON.parse(event.data);}catch{return;}if(m.action==='load'){xml=m.xml;send({event:'load',xml,currentPage:0});}if(m.action==='viewbox')send({event:'viewbox',currentPage:0,message:m});if(m.action==='getDiff')send({event:'getDiff',xml,message:m});});send({event:'init'});</script></body></html>`); return;
    }
    app.emit('request', req, res);
  });
  server.listen(Number(process.env.PORT), '127.0.0.1', () => console.log('WEEKLY_QUOTA_FIXTURE_READY'));
})().catch(error => { console.error(error.stack); process.exit(1); });
