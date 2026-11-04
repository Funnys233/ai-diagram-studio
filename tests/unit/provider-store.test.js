// provider-store 单元测试：校验、持久化、密钥不泄漏、默认选择、损坏文件
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProviderStore, ValidationError, seedFromEnv } = require('../../lib/provider-store.js');

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pstore-')), name || 'providers.json');
}

function makeStore(env) {
  return new ProviderStore({ filePath: tmpFile(), env: env || {} }).load();
}

const VALID = {
  providerId: 'gw-one',
  name: '网关一',
  baseUrl: 'https://gw.example.com/v1',
  protocol: 'openai-chat-completions',
  apiKey: 'sk-test-secret',
  enabled: true,
};

test('创建提供商：字段校验与重复 ID 字段级错误', async () => {
  const store = makeStore();
  const created = await store.createProvider(VALID);
  assert.equal(created.providerId, 'gw-one');
  assert.equal(created.hasKey, true);
  assert.equal(created.authKind, 'bearer');

  await assert.rejects(() => store.createProvider(VALID), (e) => {
    assert.ok(e instanceof ValidationError);
    assert.equal(e.fields.providerId, 'Provider ID "gw-one" 已存在');
    return true;
  });

  for (const bad of [
    [{ ...VALID, providerId: '1abc' }, 'providerId'],
    [{ ...VALID, providerId: 'ABC' }, 'providerId'],
    [{ ...VALID, name: '' }, 'name'],
    [{ ...VALID, baseUrl: 'not-a-url' }, 'baseUrl'],
    [{ ...VALID, baseUrl: 'http://insecure.example.com' }, 'baseUrl'], // 外部地址必须 https
    [{ ...VALID, protocol: 'openai-responses' }, 'protocol'],
  ]) {
    const id = 'ok-' + Math.random().toString(36).slice(2, 8);
    await assert.rejects(
      () => store.createProvider({ ...bad[0], providerId: bad[1] === 'providerId' ? bad[0].providerId : id }),
      (e) => e instanceof ValidationError && Boolean(e.fields[bad[1]]),
    );
  }
  // 本机 http 允许（本地模型服务）
  const local = await store.createProvider({ ...VALID, providerId: 'local-llm', baseUrl: 'http://127.0.0.1:11434' });
  assert.equal(local.baseUrl, 'http://127.0.0.1:11434');
});

test('list/catalog 绝不泄漏 apiKey', async () => {
  const store = makeStore();
  await store.createProvider(VALID);
  for (const p of store.list()) {
    assert.equal(p.apiKey, undefined);
    assert.ok(!('apiKey' in p));
    assert.equal(p.hasKey, true);
  }
  const raw = JSON.stringify(store.catalog());
  assert.ok(!raw.includes('sk-test-secret'));
});

test('模型：添加/重复/大小写敏感/参数校验/默认切换/删除清理', async () => {
  const store = makeStore();
  await store.createProvider(VALID);
  const m1 = await store.addModel('gw-one', { modelId: 'GPT-4o' }); // 大小写敏感，原样保留
  assert.equal(m1.modelId, 'GPT-4o');
  assert.equal(m1.isDefault, true); // 首个模型自动默认

  await assert.rejects(
    () => store.addModel('gw-one', { modelId: 'GPT-4o' }),
    (e) => e instanceof ValidationError && /已存在/.test(e.fields.modelId || ''),
  );
  await store.addModel('gw-one', { modelId: 'gpt-4o' }); // 不同大小写 = 不同模型
  assert.equal(store.getRaw('gw-one').models.length, 2);

  await assert.rejects(() => store.addModel('gw-one', { modelId: 'x', maxTokens: 0 }), (e) => Boolean(e.fields.maxTokens));
  await assert.rejects(() => store.addModel('gw-one', { modelId: 'x', temperature: 3 }), (e) => Boolean(e.fields.temperature));

  await store.setDefaultModel('gw-one', 'gpt-4o');
  const models = store.getRaw('gw-one').models;
  assert.equal(models.find((m) => m.modelId === 'gpt-4o').isDefault, true);
  assert.equal(models.find((m) => m.modelId === 'GPT-4o').isDefault, false);

  await store.deleteModel('gw-one', 'gpt-4o'); // 默认模型被删 → 默认引用清空，不静默指到其它模型
  const remaining = store.getRaw('gw-one').models;
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].modelId, 'GPT-4o');
  assert.equal(store.defaultSelectionRaw(), null);
  await store.setDefaultModel('gw-one', 'GPT-4o'); // 用户重新指定后恢复
  assert.equal(store.defaultSelectionRaw().modelId, 'GPT-4o');
});

test('密钥编辑语义：留空(undefined)保留、null 清除、字符串替换', async () => {
  const store = makeStore();
  await store.createProvider(VALID);
  await store.updateProvider('gw-one', { apiKey: '' }); // 空串上层已映射为 undefined；直接传等价于不修改
  assert.equal(store.getRaw('gw-one').apiKey, 'sk-test-secret');
  await store.updateProvider('gw-one', {});
  assert.equal(store.getRaw('gw-one').apiKey, 'sk-test-secret');
  await store.updateProvider('gw-one', { apiKey: null });
  assert.equal(store.getRaw('gw-one').apiKey, '');
  assert.equal(store.getSanitized('gw-one').hasKey, false);
  await store.updateProvider('gw-one', { apiKey: 'sk-new' });
  assert.equal(store.getRaw('gw-one').apiKey, 'sk-new');
});

test('持久化：重启（新实例同一路径）后配置保留，版本号递增', async () => {
  const file = tmpFile();
  const s1 = new ProviderStore({ filePath: file, env: {} }).load();
  await s1.createProvider(VALID);
  await s1.addModel('gw-one', { modelId: 'm1' });

  const s2 = new ProviderStore({ filePath: file, env: {} }).load();
  assert.equal(s2.getRaw('gw-one').name, '网关一');
  assert.equal(s2.getRaw('gw-one').apiKey, 'sk-test-secret');
  assert.equal(s2.getRaw('gw-one').models[0].modelId, 'm1');
  assert.ok(s2.data.revision >= 2); // revision（写入计数）递增；version 恒为 schema 版本
});

test('R3：写盘失败回滚——更新/创建/删除/默认变更失败后内存、磁盘、revision、默认引用保持原状', async () => {
  const file = tmpFile();
  const store = new ProviderStore({ filePath: file, env: {} }).load();
  await store.createProvider(VALID);
  await store.addModel('gw-one', { modelId: 'm1' });
  await store.addModel('gw-one', { modelId: 'm2' });
  const revisionBefore = store.data.revision;
  const beforeDisk = fs.readFileSync(file, 'utf8');
  const snapshot = () => JSON.stringify(store.data);

  store.writeSync = () => { throw new Error('injected disk failure'); };

  let before = snapshot();
  await assert.rejects(() => store.updateProvider('gw-one', { name: '不应保存的名称' }), /injected disk failure/);
  assert.equal(snapshot(), before, '更新失败：内存不得变化');
  assert.equal(store.getRaw('gw-one').name, '网关一');

  await assert.rejects(() => store.createProvider({ ...VALID, providerId: 'ghost' }), /injected disk failure/);
  assert.equal(store.getRaw('ghost'), null, '创建失败：内存不得出现新提供商');

  await assert.rejects(() => store.deleteProvider('gw-one'), /injected disk failure/);
  assert.ok(store.getRaw('gw-one'), '删除失败：内存不得删除');

  await assert.rejects(() => store.setDefaultModel('gw-one', 'm2'), /injected disk failure/);
  assert.equal(store.defaultSelectionRaw().modelId, 'm1', '默认变更失败：默认引用保持原状');
  assert.equal(store.getRaw('gw-one').models.find((m) => m.modelId === 'm1').isDefault, true);
  assert.equal(store.getRaw('gw-one').models.find((m) => m.modelId === 'm2').isDefault, false);

  assert.equal(snapshot(), before, '四类失败后内存整体保持原状');
  assert.equal(fs.readFileSync(file, 'utf8'), beforeDisk, '四类失败后磁盘保持原状');
  assert.equal(store.data.revision, revisionBefore, '失败不得递增编辑版本');
});

test('R3：写盘失败后队列仍可继续接受合法更新', async () => {
  const store = makeStore();
  await store.createProvider(VALID);
  store.writeSync = () => { throw new Error('injected disk failure'); };
  await assert.rejects(() => store.updateProvider('gw-one', { name: '失败写入' }), /injected disk failure/);
  delete store.writeSync; // 磁盘故障恢复

  const updated = await store.updateProvider('gw-one', { name: '恢复后的名称' });
  assert.equal(updated.name, '恢复后的名称');
  assert.equal(store.getRaw('gw-one').name, '恢复后的名称');
  const reloaded = new ProviderStore({ filePath: store.filePath, env: {} }).load();
  assert.equal(reloaded.getRaw('gw-one').name, '恢复后的名称', '失败后的成功写入正常落盘');
});

test('损坏文件：备份 + 回退种子，绝不假装读到旧配置', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{broken json', 'utf8');
  const messages = [];
  const store = new ProviderStore({
    filePath: file,
    env: { DEEPSEEK_API_KEY: 'sk-env-seed', DEEPSEEK_BASE_URL: 'https://api.deepseek.com', DEEPSEEK_MODEL: 'deepseek-flash' },
    log: (m) => messages.push(m),
  }).load();
  assert.ok(messages.some((m) => /损坏/.test(m)));
  assert.ok(fs.readdirSync(path.dirname(file)).some((f) => f.includes('.corrupt-')));
  assert.equal(store.getRaw('deepseek').models[0].modelId, 'deepseek-flash');
});

test('env 种子：仅无持久文件时生成；有文件时绝不覆盖', () => {
  const env = { DEEPSEEK_API_KEY: 'sk-env', DEEPSEEK_BASE_URL: 'https://api.deepseek.com/', DEEPSEEK_MODEL: 'deepseek-flash' };
  const file = tmpFile();
  const s1 = new ProviderStore({ filePath: file, env }).load();
  assert.equal(s1.getRaw('deepseek').baseUrl, 'https://api.deepseek.com'); // 尾斜杠规范化
  assert.equal(fs.existsSync(file), true);

  // 用户改配置后重启：种子不得覆盖
  const s1b = new ProviderStore({ filePath: file, env }).load();
  s1b.data.providers[0].name = '用户改名';
  s1b.writeSync();
  const s2 = new ProviderStore({ filePath: file, env }).load();
  assert.equal(s2.getRaw('deepseek').name, '用户改名');
});

test('resolveSelection：不存在/停用/未启用模型明确拒绝，省略字段回退默认', async () => {
  const store = makeStore();
  await store.createProvider(VALID);
  await store.addModel('gw-one', { modelId: 'm1' });
  await store.addModel('gw-one', { modelId: 'm2', enabled: false });

  let r = store.resolveSelection('nope', 'm1');
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  assert.equal(r.code, 'provider-not-found');

  r = store.resolveSelection('gw-one', 'nope');
  assert.equal(r.code, 'model-not-found');
  assert.equal(r.status, 404);

  r = store.resolveSelection('gw-one', 'm2');
  assert.equal(r.code, 'model-disabled');

  await store.updateProvider('gw-one', { enabled: false });
  r = store.resolveSelection('gw-one', 'm1');
  assert.equal(r.code, 'provider-disabled');
  await store.updateProvider('gw-one', { enabled: true });

  // 省略 modelId → 提供商默认模型；省略全部 → 全局默认
  r = store.resolveSelection('gw-one');
  assert.equal(r.ok, true);
  assert.equal(r.model.modelId, 'm1');
  r = store.resolveSelection(undefined, undefined);
  assert.equal(r.ok, true);
  assert.equal(r.provider.providerId, 'gw-one');

  // mock 始终可用
  r = store.resolveSelection('mock');
  assert.equal(r.ok, true);
  assert.equal(r.mock, true);

  // 默认模型停用 → 省略字段的旧调用明确拒绝，绝不静默改路由
  await store.updateModel('gw-one', 'm1', { enabled: false });
  r = store.resolveSelection(undefined, undefined);
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.equal(r.code, 'default-model-unavailable');
  await store.updateModel('gw-one', 'm1', { enabled: true });

  // 全部停用 → 明确拒绝，绝不静默回退
  const empty = makeStore();
  r = empty.resolveSelection(undefined, undefined);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no-model-configured');
});

test('并发写串行化：同时创建不丢数据、不互相覆盖', async () => {
  const store = makeStore();
  await Promise.all(
    Array.from({ length: 8 }, (_, i) => store.createProvider({
      providerId: `c${i}`,
      name: `并发${i}`,
      baseUrl: 'https://gw.example.com',
      protocol: 'openai-chat-completions',
    })),
  );
  assert.equal(store.data.providers.length, 8);
  const file = store.filePath;
  const reloaded = new ProviderStore({ filePath: file, env: {} }).load();
  assert.equal(reloaded.data.providers.length, 8);
});

test('seedFromEnv 无 Key 时返回 null', () => {
  assert.equal(seedFromEnv({}), null);
});

test('新建提供商与选中的模型一次写入，非法或重复模型不会产生半成品', async () => {
  const store=makeStore();
  const models=[{modelId:'draft-one',visionInput:true},{modelId:'draft-two',maxTokens:1234}];
  const saved=await store.createProvider({...VALID,models});
  assert.deepEqual(saved.models.map(m=>m.modelId),['draft-one','draft-two']);
  assert.equal(saved.models[0].isDefault,true);assert.equal(saved.models[0].visionInput,true);
  assert.equal(new ProviderStore({filePath:store.filePath,env:{}}).load().getRaw(VALID.providerId).models.length,2);
  const before=structuredClone(store.data);
  for(const invalid of [[{modelId:'duplicate'},{modelId:'duplicate'}],[{modelId:'valid'},{modelId:''}],[{modelId:'bad',maxTokens:-1}],{}]){
    await assert.rejects(store.createProvider({...VALID,providerId:'bad-draft',models:invalid}),ValidationError);
    assert.deepEqual(store.data,before);
  }
});
