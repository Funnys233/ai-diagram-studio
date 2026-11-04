const test = require('node:test');
const assert = require('node:assert/strict');
const { createParser } = require('../../lib/sse');
const { createModelStream } = require('../../lib/model-stream');
const openai = require('../../lib/adapters/openai-chat');
const anthropic = require('../../lib/adapters/anthropic-messages');
const accept = (stream, data) => stream.accept({ data: JSON.stringify(data) });

test('SSE splits CRLF, comments, BOM and multiline data; incomplete event never dispatched', () => {
  const events = [], parser = createParser(e => events.push(e));
  for (const ch of '\uFEFF: hello\r\nevent: progress\r\ndata: 第一段\r\ndata: 第二段\r\n\r\nevent: result\ndata: 未完成') parser.push(ch);
  assert.deepEqual(events, [{ event: 'progress', data: '第一段\n第二段' }]);
});
test('SSE limits one event including ignored lines', () => {
  const parser = createParser(() => {}, 20);
  assert.throws(() => parser.push(':'.repeat(21)), /大小限制/);
});
test('OpenAI assembles only answer text and reports reasoning state without its content', () => {
  const progress = [], s = createModelStream(openai.protocol, openai, 'test', e => progress.push(e));
  accept(s, { model:'m', choices:[{index:0, delta:{reasoning_content:'private reasoning'}}] });
  accept(s, { choices:[{index:0, delta:{content:'图表'}}] });
  accept(s, { choices:[{index:0, delta:{}, finish_reason:'stop'}] });
  accept(s, { choices:[], usage:{completion_tokens:4} });
  s.accept({data:'[DONE]'});
  assert.equal(s.finish().text,'图表');
  assert.equal(s.finish().usage.completion_tokens,4);
  assert.deepEqual(progress,[{phase:'thinking',chars:0},{phase:'generating',chars:2}]);
  assert.ok(!JSON.stringify(progress).includes('private'));
});
test('Anthropic assembles text, merges cumulative usage and requires message_stop', () => {
  const s = createModelStream(anthropic.protocol, anthropic, 'test');
  accept(s,{type:'message_start',message:{model:'claude',usage:{input_tokens:7}}});
  accept(s,{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'private'}});
  accept(s,{type:'content_block_start',content_block:{type:'text',text:'首'}});
  accept(s,{type:'content_block_delta',delta:{type:'text_delta',text:'段'}});
  accept(s,{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:2}});
  accept(s,{type:'message_stop'});
  assert.deepEqual(s.finish(),{text:'首段',model:'claude',usage:{input_tokens:7,output_tokens:2},finishReason:'end_turn'});
});
for (const adapter of [openai,anthropic]) {
  test(`${adapter.protocol}: incomplete stream is rejected even with complete XML`,()=>{
    const s = createModelStream(adapter.protocol,adapter,'test');
    accept(s,adapter === openai ? {choices:[{delta:{content:'<mxGraphModel/>'},finish_reason:'stop'}]} : {type:'content_block_delta',delta:{type:'text_delta',text:'<mxGraphModel/>'}});
    assert.throws(()=>s.finish(),e=>e.code==='stream-incomplete');
  });
  test(`${adapter.protocol}: explicit token truncation is rejected`,()=>{
    const s = createModelStream(adapter.protocol,adapter,'test');
    if(adapter === openai) {
      accept(s,{choices:[{delta:{content:'xml'},finish_reason:'length'}]}); s.accept({data:'[DONE]'});
    } else {
      accept(s,{type:'content_block_delta',delta:{type:'text_delta',text:'xml'}});
      accept(s,{type:'message_delta',delta:{stop_reason:'max_tokens'}}); accept(s,{type:'message_stop'});
    }
    assert.throws(()=>s.finish(),e=>e.code==='model-truncated');
  });
}
test('Malformed events, upstream stream errors and oversized answer fail explicitly',()=>{
  const s = createModelStream(openai.protocol,openai,'test',null,3);
  assert.throws(()=>s.accept({data:'not json'}),e=>e.code==='protocol-mismatch');
  assert.throws(()=>accept(s,{error:{message:'failed'}}),e=>e.code==='server-error');
  assert.throws(()=>accept(s,{choices:[{delta:{content:'long'}}]}),e=>e.code==='output-too-large');
});
test('失败或未完成的订阅响应保留接口已返回的token用量，回复内容仍被拒绝',()=>{
 const adapter=require('../../lib/adapters/chatgpt-responses');
 const stream=createModelStream(adapter.protocol,adapter,'fixture');
 assert.throws(()=>accept(stream,{type:'response.incomplete',response:{usage:{input_tokens:17,output_tokens:8}}}),error=>error.code==='stream-incomplete');
 assert.deepEqual(stream.getUsage(),{input_tokens:17,output_tokens:8});
 assert.throws(()=>stream.finish(),error=>error.code==='stream-incomplete');
});
