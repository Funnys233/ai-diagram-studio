'use strict';
const dns=require('node:dns').promises,net=require('node:net');
const {CloudError}=require('./cloud-runtime');
function publicAddress(address){
 const family=net.isIP(address);if(family===4){const p=address.split('.').map(Number),a=p[0],b=p[1];
  const c=p[2];
  return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0&&(c===0||c===2)||b===88&&c===99)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113||address==='168.63.129.16');
 }
 // IPv6 egress is restricted to global unicast, excluding documentation and transition ranges.
 if(family!==6||address.includes('.'))return false;
 const halves=address.toLowerCase().split('::'),left=halves[0]?halves[0].split(':'):[],right=halves[1]?halves[1].split(':'):[];
 const words=(halves.length===2?[...left,...Array(8-left.length-right.length).fill('0'),...right]:left).map(x=>parseInt(x,16));
 const a=words[0],b=words[1];
 return a>=0x2000&&a<=0x3fff&&a!==0x2002&&a!==0x3ffe&&!(a===0x2001&&(b===0||b===2||b===0xdb8||b>=0x10&&b<=0x2f));
}
async function pinnedOptions(urlString,resolve=dns.lookup,{signal,timeoutMs=5000}={}){
 const u=new URL(urlString);if(u.protocol!=='https:'||u.username||u.password)throw new CloudError(400,'unsafe-api-address','云端 API 必须使用公网 HTTPS 地址');
 const host=u.hostname.replace(/^\[|\]$/g,'');
 signal?.throwIfAborted();
 const addresses=net.isIP(host)?[{address:host,family:net.isIP(host)}]:await new Promise((accept,reject)=>{
  const timer=setTimeout(()=>finish(new CloudError(504,'dns-timeout','API 地址解析超时，请稍后重试')),timeoutMs);
  const abort=()=>finish(signal.reason||new DOMException('请求已取消','AbortError'));
  function finish(error,value){clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):accept(value);}
  signal?.addEventListener('abort',abort,{once:true});
  Promise.resolve().then(()=>resolve(host,{all:true,verbatim:true})).then(value=>finish(null,value),()=>finish(new CloudError(400,'dns-unavailable','API 地址无法解析，请检查域名')));
 });
 if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw new CloudError(400,'unsafe-api-address','API 地址不能指向本机、私网或元数据服务');
 // Pin the checked addresses at connection time, while retaining the hostname for TLS verification.
 return {agent:false,lookup:(hostname,options,callback)=>{
  if(hostname!==host)return callback(new Error('API 连接主机发生变化'));
  const selected=options?.family?addresses.filter(a=>a.family===options.family):addresses;if(!selected.length)return callback(new Error('API 地址族不可用'));
  if(options?.all)callback(null,selected);else callback(null,selected[0].address,selected[0].family);
 }};
}
module.exports={publicAddress,pinnedOptions};
