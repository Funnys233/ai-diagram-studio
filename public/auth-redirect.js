(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.DiagramAuthRedirect=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const fallback='/chat.html',origin='https://diagram.invalid';
 function destination(next,user,{register=false}={}){
  if(typeof next!=='string'||!next.startsWith('/')||next.startsWith('//')||/[\u0000-\u0020\\]/.test(next))return fallback;
  try{
   const url=new URL(next,origin);if(url.origin!==origin)return fallback;
   const pathname=decodeURIComponent(url.pathname).toLowerCase();
   if(['/admin','/admin/','/admin.html'].includes(pathname))return !register&&user?.role==='admin'?'/admin.html':fallback;
   if(['/agent','/agent/','/agent.html'].includes(pathname))return !register&&(user?.role==='admin'||user?.role==='user'&&['free','pro','max'].includes(user?.membership?.plan))?'/agent.html':fallback;
   if(!['/','/index.html','/chat.html','/usage.html','/requirements.html'].includes(pathname))return fallback;
   return pathname+url.search+url.hash;
  }catch{return fallback;}
 }
 return {destination};
});
