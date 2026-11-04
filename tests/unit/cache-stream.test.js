const test=require('node:test'),assert=require('node:assert/strict');
const {createModelStream}=require('../../lib/model-stream'),Usage=require('../../lib/usage-report');
const chat=require('../../lib/adapters/openai-chat'),responses=require('../../lib/adapters/chatgpt-responses'),anthropic=require('../../lib/adapters/anthropic-messages');
const event=data=>({data:JSON.stringify(data)});
test('Chat流保留最终空choices中的缓存用量，Responses完成事件保留同一明细',()=>{
 const usage={input_tokens:1000,output_tokens:20,input_tokens_details:{cached_tokens:800}};
 const stream=createModelStream('chatgpt-responses',responses,'fixture');
 stream.accept(event({type:'response.output_text.delta',delta:'回复'}));
 stream.accept(event({type:'response.completed',response:{status:'completed',model:'fixture',usage}}));
 assert.deepEqual(Usage.cacheUsage(stream.finish().usage),{cachedTokens:800,inputTokens:1000});
 const c=createModelStream('openai-chat-completions',chat,'fixture');c.accept(event({choices:[{delta:{content:'回复'},finish_reason:'stop'}],usage:null}));
 c.accept(event({choices:[],usage:{prompt_tokens:1000,completion_tokens:20,prompt_tokens_details:{cached_tokens:800}}}));c.accept({data:'[DONE]'});
 assert.deepEqual(Usage.cacheUsage(c.finish().usage),{cachedTokens:800,inputTokens:1000});
});
test('Anthropic起始事件的缓存分类在输出用量增量合并后仍然存在',()=>{
 const c=createModelStream('anthropic-messages',anthropic,'fixture');
 c.accept(event({type:'message_start',message:{model:'fixture',usage:{input_tokens:100,cache_read_input_tokens:800,cache_creation_input_tokens:100}}}));
 c.accept(event({type:'content_block_delta',delta:{type:'text_delta',text:'回复'}}));
 c.accept(event({type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:20}}));c.accept(event({type:'message_stop'}));
 assert.deepEqual(Usage.cacheUsage(c.finish().usage),{cachedTokens:800,inputTokens:1000});
});
