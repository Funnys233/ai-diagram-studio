(function(){
 'use strict';
 const nativeFetch=window.fetch.bind(window);
 const api={enabled:false,user:null,csrf:null,scope:'personal',onScopeChange:null};
 window.DiagramCloud=api;
 let accountMenu=null;
 function redirect(){window.location.replace('/login.html');}
 async function request(url,options={}){
  const headers=new Headers(options.headers||{});let target=url;
  if(api.enabled&&typeof url==='string'&&url.startsWith('/api/')){
   if(!['GET','HEAD'].includes((options.method||'GET').toUpperCase()))headers.set('X-CSRF-Token',api.csrf||'');
   if(url.startsWith('/api/providers'))headers.set('X-Provider-Scope',api.scope);
   // Generation preferences belong to the current user, rather than public provider configuration.
   const m=/^\/api\/providers\/([^/]+)\/models\/([^/]+)$/.exec(url);
   if(m&&options.method==='PUT'){
    const providerId=decodeURIComponent(m[1]);let body;try{body=JSON.parse(options.body);}catch{}
    if(providerId.includes(':')&&body&&Object.keys(body).every(k=>['thinkingMode','reasoningEffort','revision'].includes(k))){target='/api/preferences';options={...options,body:JSON.stringify({...body,providerId,modelId:decodeURIComponent(m[2])})};}
   }
  }
  const response=await nativeFetch(target,{...options,headers});
  if(api.enabled&&response.status===401)redirect();return response;
 }
 api.refreshUsage=async()=>accountMenu?.refreshUsage();
 function mount(){
  const trial=api.user.membership?.plan==='trial';if(!trial)document.getElementById('cloudScopeBar').classList.remove('hidden');else{document.getElementById('modelSettingsBtn').hidden=true;document.getElementById('modelSettingsBtn').classList.add('hidden');}
  const select=document.getElementById('cloudApiScope');if(api.user.role!=='admin')select.querySelector('[value="platform"]').remove();
  select.onchange=async()=>{api.scope=select.value;document.getElementById('cloudScopeNote').textContent=api.scope==='platform'?'平台模型对所有已登录用户开放。':'个人配置仅本人可用。';await api.onScopeChange?.();};
  accountMenu=window.DiagramAccountMenu.mount({host:document.querySelector('.topbar-right'),session:{user:api.user},request,currentSelection(){const label=document.getElementById('modelSelectLabel');return label?.dataset.providerId?{providerId:label.dataset.providerId,modelId:label.dataset.modelId}:null;}});
 }
 api.ready=(async()=>{
  try{const response=await nativeFetch('/api/auth/session');if(!response.ok)throw Error();const info=await response.json();api.enabled=info.mode==='cloud';if(!api.enabled)return info;api.user=info.user;api.csrf=info.csrf;window.fetch=request;if(!api.user){redirect();return info;}mount();return info;}
  catch{document.body.textContent='无法确认服务状态，请检查网络并刷新页面。';throw new Error('会话检查失败');}
 })();
})();
