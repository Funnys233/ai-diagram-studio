/** Shared image boundary for multimodal input. No XML writes or model-name inference. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.DiagramVision=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const MAX_IMAGE_BYTES=3*1024*1024,MAX_SIDE=4096,MAX_PIXELS=8000000,MAX_BODY_BYTES=10*1024*1024;
 class VisionError extends Error{constructor(message,code='invalid-vision'){super(message);this.code=code;this.name='VisionError';}}
 function validateImage(data){
  if(typeof data!=='string'||data.length>Math.ceil(MAX_IMAGE_BYTES/3)*4+40)throw new VisionError('图片超过 3 MB 上限或数据不合法','image-too-large');
  const m=/^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
  if(!m||m[2].length%4!==0)throw new VisionError('仅支持完整 PNG / JPEG 的 base64 图片');
  let bytes;try{bytes=typeof Buffer!=='undefined'?Uint8Array.from(Buffer.from(m[2],'base64')):Uint8Array.from(atob(m[2]),c=>c.charCodeAt(0));}catch(e){throw new VisionError('图片 base64 不合法');}
  if(bytes.length>MAX_IMAGE_BYTES)throw new VisionError('图片超过 3 MB 上限','image-too-large');
  const view=new DataView(bytes.buffer),be=(p)=>view.getUint32(p,false);let width=0,height=0;
  if(m[1]==='image/png'){
   if(bytes.length<45||![137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v)||be(8)!==13||String.fromCharCode(...bytes.slice(12,16))!=='IHDR')throw new VisionError('PNG 文件头不合法');
   width=be(16);height=be(20);let p=8,ended=false,hasData=false;
   while(p+12<=bytes.length){const len=be(p),kind=String.fromCharCode(...bytes.slice(p+4,p+8));if(p+12+len>bytes.length)throw new VisionError('PNG 数据不完整');if(kind==='IDAT')hasData=true;p+=12+len;if(kind==='IEND'){ended=len===0&&p===bytes.length;break;}}
   if(!ended||!hasData)throw new VisionError('PNG 数据不完整');
  }else{
   if(bytes.length<6||bytes[0]!==255||bytes[1]!==216)throw new VisionError('文件内容不是 JPEG 图片，请重新导出为 JPEG 或 PNG');
   let p=2,ended=false,hasScan=false;
   while(p<bytes.length){
    if(bytes[p++]!==255)throw new VisionError('JPEG 标记不合法');
    while(p<bytes.length&&bytes[p]===255)p++;
    if(p>=bytes.length)break;
    const marker=bytes[p++];
    if(marker===0xd9){ended=hasScan;break;}
    if(marker===0x01)continue;
    if(marker===0x00||marker===0xd8||marker>=0xd0&&marker<=0xd7)throw new VisionError('JPEG 标记不合法');
    if(p+2>bytes.length)break;
    const len=view.getUint16(p,false);if(len<2||p+len>bytes.length)throw new VisionError('JPEG 数据不完整');
    if([0xc0,0xc1,0xc2].includes(marker)){if(len<8)throw new VisionError('JPEG 尺寸不合法');height=view.getUint16(p+3,false);width=view.getUint16(p+5,false);}p+=len;
    if(marker===0xda){
     hasScan=true;
     // Walk entropy data, including stuffed FF bytes and restart markers. A
     // progressive JPEG may have several scans; metadata can contain fake EOI.
     while(p<bytes.length){
      if(bytes[p]!==255){p++;continue;}
      const start=p++;while(p<bytes.length&&bytes[p]===255)p++;
      if(p>=bytes.length)break;
      if(bytes[p]===0x00||bytes[p]>=0xd0&&bytes[p]<=0xd7){p++;continue;}
      p=start;break;
     }
    }
   }
   if(!ended)throw new VisionError('JPEG 数据不完整（缺少结束标记），请重新导出图片');
   // Keep the original encoded image, excluding unrelated bytes after EOI.
   if(p<bytes.length){
    bytes=bytes.slice(0,p);
    let base64;
    if(typeof Buffer!=='undefined')base64=Buffer.from(bytes).toString('base64');
    else{const chunks=[];for(let i=0;i<bytes.length;i+=8192)chunks.push(String.fromCharCode(...bytes.subarray(i,i+8192)));base64=btoa(chunks.join(''));}
    m[2]=base64;data=`data:${m[1]};base64,${base64}`;
   }
  }
  if(!width||!height||width>MAX_SIDE||height>MAX_SIDE||width*height>MAX_PIXELS)throw new VisionError('图片须在 4096 × 4096、800 万像素以内，请拆分过大的图表或缩小参考图','image-dimensions');
  return {data,mime:m[1],base64:m[2],width,height,bytes:bytes.length};
 }
 function validateImages(value){
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>3)throw new VisionError("每条消息最多添加 3 张图片");
  const images=value.map(validateImage);
  if(images.reduce((n,i)=>n+i.bytes,0)>6*1024*1024)throw new VisionError("附件总大小不能超过 6 MB","image-too-large");
  return images;
 }
 return {validateImages,MAX_IMAGE_BYTES,MAX_SIDE,MAX_PIXELS,MAX_BODY_BYTES,VisionError,validateImage};
});
