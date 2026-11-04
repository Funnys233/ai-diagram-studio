const test=require('node:test'),assert=require('node:assert/strict'),Vision=require('../../lib/vision-check');
const OA=require('../../lib/adapters/openai-chat'),AN=require('../../lib/adapters/anthropic-messages');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
test('图片边界校验真实 PNG、尺寸和字节；只接受完整数据，不接受远程 URL/SVG',()=>{
 const image=Vision.validateImage(PNG);assert.equal(image.width,1);assert.equal(image.height,1);assert.equal(image.mime,'image/png');
 for(const data of ['https://test/a.png','data:image/svg+xml;base64,YQ==','data:image/png;base64,abcd',PNG.slice(0,-12)])assert.throws(()=>Vision.validateImage(data));
 const bytes=Buffer.from(image.base64,'base64');bytes.writeUInt32BE(10000,16);assert.throws(()=>Vision.validateImage('data:image/png;base64,'+bytes.toString('base64')),/4096/);
 assert.throws(()=>Vision.validateImage('data:image/png;base64,'+'a'.repeat(5000000)),/3 MB/);
});
test('JPEG 尺寸解析和 MIME 不一致拒绝',()=>{
 const b=Buffer.from([255,216,255,192,0,8,8,0,10,0,20,1,255,218,0,2,255,217]);
 const image=Vision.validateImage('data:image/jpeg;base64,'+b.toString('base64'));assert.equal(image.width,20);assert.equal(image.height,10);
 assert.throws(()=>Vision.validateImage(PNG.replace('image/png','image/jpeg')));
});
test('真实普通和渐进 JPEG 可上传，尾部附加数据移除且像素编码不变，浏览器与服务端一致',()=>{
 const context=vm.createContext({Uint8Array,DataView,atob,btoa});vm.runInContext(fs.readFileSync(path.join(__dirname,'../../lib/vision-check.js'),'utf8'),context);
 for(const name of ['baseline.jpg','progressive.jpg']){
  const bytes=fs.readFileSync(path.join(__dirname,'../helpers/images',name));const original='data:image/jpeg;base64,'+bytes.toString('base64');
  const withTrailer='data:image/jpeg;base64,'+Buffer.concat([bytes,Buffer.from('export metadata')]).toString('base64');
  for(const validate of [Vision.validateImage,context.DiagramVision.validateImage]){
   const image=validate(withTrailer);assert.equal(image.data,original);assert.equal(image.width,20);assert.equal(image.height,10);assert.equal(image.bytes,bytes.length);assert.equal(validate(original).data,original);
   assert.throws(()=>validate('data:image/jpeg;base64,'+bytes.subarray(0,-2).toString('base64')),/缺少结束标记/);
  }
 }
});
test('元数据内的假结束标记不能替代真实图像结束，坏长度和伪装扩展名仍被拒绝',()=>{
 const original=fs.readFileSync(path.join(__dirname,'../helpers/images/baseline.jpg'));
 // APP2 is length-delimited: an embedded thumbnail can itself contain FF D9.
 const metadata=Buffer.from([255,226,0,6,1,255,217,2]);
 const complete=Buffer.concat([original.subarray(0,2),metadata,original.subarray(2)]);
 const data=bytes=>'data:image/jpeg;base64,'+bytes.toString('base64');
 assert.equal(Vision.validateImage(data(complete)).width,20);
 assert.throws(()=>Vision.validateImage(data(complete.subarray(0,-2))),/缺少结束标记/);
 const badLength=Buffer.from(complete);badLength.writeUInt16BE(65535,4);assert.throws(()=>Vision.validateImage(data(badLength)),/数据不完整/);
 assert.throws(()=>Vision.validateImage(data(Buffer.from('renamed HEIC file'))),/不是 JPEG/);
});
test('OpenAI multipart透传、Anthropic转为图片 source；文本调用保持原格式',()=>{
 const messages=[{role:'system',content:'审核'},{role:'user',content:[{type:'image_url',image_url:{url:PNG,detail:'high'}},{type:'text',text:'检查图表'}]}];
 const model={modelId:'fixture'},provider={baseUrl:'http://127.0.0.1:1234',apiKey:''};
 const oa=OA.buildChatRequest(provider,model,messages);assert.deepEqual(oa.body.messages,messages);
 const an=AN.buildChatRequest(provider,model,messages);assert.equal(an.body.system,'审核');assert.equal(an.body.messages[0].content[0].type,'image');assert.equal(an.body.messages[0].content[0].source.media_type,'image/png');assert.equal(an.body.messages[0].content[1].text,'检查图表');
 assert.equal(AN.buildChatRequest(provider,model,[{role:'user',content:'ping'}]).body.messages[0].content,'ping');
});
