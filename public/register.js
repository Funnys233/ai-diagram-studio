(async()=>{
 'use strict';
 const $=id=>document.getElementById(id),next=new URLSearchParams(location.search).get('next');
 const destination=window.DiagramAuthRedirect.destination(next,null,{register:true});
 $('loginLink').href='/login.html?next='+encodeURIComponent(destination);
 $('registerForm').onsubmit=async event=>{event.preventDefault();$('registerError').textContent='';
  if($('registerPassword').value!==$('registerConfirm').value){$('registerError').textContent='两次输入的密码不一致。';$('registerConfirm').focus();return;}
  $('registerBtn').disabled=true;
  try{
   const response=await fetch('/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:$('registerUsername').value,password:$('registerPassword').value})}),body=await response.json();
   if(!response.ok)throw Error(body.error?.message||'注册失败，请稍后重试。');
   $('registerPassword').value='';$('registerConfirm').value='';location.replace(destination);
  }catch(error){$('registerError').textContent=error.message||'连接失败，请重试。';}
  finally{$('registerBtn').disabled=false;}
 };
 try{const response=await fetch('/api/auth/session'),session=await response.json();if(response.ok&&(session.mode==='local'||session.user))location.replace(destination);}catch{$('registerError').textContent='无法连接服务，请检查网络。';}
})();
