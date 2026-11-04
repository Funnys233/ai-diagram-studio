(async function(){
 'use strict';
 const form=document.getElementById('loginForm'),button=document.getElementById('loginBtn'),error=document.getElementById('loginError');
 const next=new URLSearchParams(location.search).get('next');
 const destination=user=>window.DiagramAuthRedirect.destination(next,user);
 const registerLink=document.getElementById('registerLink');if(registerLink)registerLink.href='/register.html?next='+encodeURIComponent(window.DiagramAuthRedirect.destination(next,null,{register:true}));
 form.onsubmit=async e=>{e.preventDefault();button.disabled=true;error.textContent='';try{
  const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:document.getElementById('loginUsername').value,password:document.getElementById('loginPassword').value})});const b=await r.json();
  if(r.ok){document.getElementById('loginPassword').value='';location.replace(destination(b.user));}else error.textContent=b.error?.message||'登录失败';
 }catch{error.textContent='连接失败，请重试。';}finally{button.disabled=false;}};
 try{const r=await fetch('/api/auth/session'),b=await r.json();if(b.mode==='local'||b.user){location.replace(destination(b.user));return;}}catch{error.textContent='无法连接服务，请检查网络。';}
})();
