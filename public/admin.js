(() => {
 'use strict';
 const $=id=>document.getElementById(id);
 const api={user:null,refreshUsage:refreshOverview};
 let csrf='',latestUsers=[],pendingBatch=null,batchBusy=false;
 function element(tag,text,className){const node=document.createElement(tag);if(text)node.textContent=text;if(className)node.className=className;return node;}
 function setStatus(text,error=false){$('adminStatus').textContent=text;$('adminStatus').classList.toggle('is-error',error);}
 function deny(text){$('adminContent').hidden=true;$('refreshBtn').disabled=true;setStatus(text,true);}
 async function request(url,options={}){
  const headers=new Headers(options.headers||{});if(!['GET','HEAD'].includes((options.method||'GET').toUpperCase()))headers.set('X-CSRF-Token',csrf);
  const response=await fetch(url,{...options,headers,credentials:'same-origin'});
  if(response.status===401){deny('登录已失效，请重新登录。');location.replace('/login.html?next=%2Fadmin.html');throw Error('请先登录');}
  if(response.status===403){deny('当前账号没有后台管理权限。');throw Error('当前账号没有后台管理权限');}
  return response;
 }
 function renderCounts(){
  $('userCount').textContent=latestUsers.length;$('activeCount').textContent=latestUsers.filter(user=>!user.disabled).length;
  $('memberCount').textContent=latestUsers.filter(user=>['pro','max'].includes(user.membership?.plan)).length;syncBatchControls();
 }
 function batchUsers(action){return latestUsers.filter(user=>action==='reset-cards'?!user.disabled&&['pro','max'].includes(user.membership?.plan):user.resetCards?.canReset);}
 function syncBatchControls(){
  $('bulkResetBtn').disabled=batchBusy||!batchUsers('weekly-reset').length;$('bulkGrantBtn').disabled=batchBusy||!batchUsers('reset-cards').length;$('bulkCardCount').disabled=batchBusy||!!pendingBatch;
  $('bulkConfirmBtn').disabled=batchBusy;$('bulkCancelBtn').disabled=batchBusy;
 }
 function closeBatch(){pendingBatch=null;$('bulkConfirm').hidden=true;syncBatchControls();}
 async function prepareBatch(action){
  batchBusy=true;closeBatch();$('bulkStatus').textContent='正在核对用户范围…';syncBatchControls();
  try{
   await updateUsers($('adminUsers'));const users=batchUsers(action),count=Number($('bulkCardCount').value);
   if(!users.length)throw Error(action==='reset-cards'?'没有有效的 Pro / Max 用户。':'没有可重置的用户；正在生成、未消耗、体验或停用的账号会跳过。');
   if(action==='reset-cards'&&(!Number.isSafeInteger(count)||count<1||count>1000))throw Error('每人数量须为 1–1000 的整数。');
   pendingBatch={action,count,targets:users.map(user=>({id:user.id,revision:user.resetCards.revision}))};
   const points=users.reduce((sum,user)=>sum+Math.round((user.weeklyUsedPoints||0)*1000),0)/1000;
   $('bulkQuestion').textContent=action==='reset-cards'?'为 '+users.length+' 位有效 Pro / Max 用户每人发放 '+count+' 张重置卡，共 '+users.length*count+' 张？普通、体验、已到期和停用账号不参与。':'重置 '+users.length+' 位用户本周已用的 '+points.toLocaleString('zh-CN',{maximumFractionDigits:3})+' 点？不消耗卡，保留周上限、恢复时间、历史和免费日池；正在生成、未消耗、体验或停用的账号会跳过。';
   $('bulkTargets').textContent='本次用户：'+users.map(user=>user.username).join('、');$('bulkConfirm').hidden=false;$('bulkStatus').textContent='确认后执行；本操作不受账号搜索影响。';$('bulkConfirmBtn').focus();
  }catch(error){$('bulkStatus').textContent=error.message;}finally{batchBusy=false;syncBatchControls();}
 }
 async function executeBatch(){
  if(batchBusy||!pendingBatch)return;const batch=pendingBatch;batchBusy=true;syncBatchControls();$('bulkStatus').textContent='正在执行…';
  try{
   const response=await request('/api/users/bulk-'+batch.action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({targets:batch.targets,...(batch.action==='reset-cards'?{count:batch.count}:{})})}),data=await response.json();if(!response.ok)throw Error(data.error?.message||'操作失败');
   closeBatch();await updateUsers($('adminUsers'));await refreshOverview();$('bulkStatus').textContent=batch.action==='reset-cards'?'已为 '+data.processed+' 位 Pro / Max 用户发放 '+data.totalCards+' 张重置卡。':'已重置 '+data.processed+' 位用户，恢复 '+data.restoredPoints.toLocaleString('zh-CN',{maximumFractionDigits:3})+' 点；未消耗重置卡。';
  }catch(error){closeBatch();$('bulkStatus').textContent=error.message+' 请刷新核对后重新确认。';try{await updateUsers($('adminUsers'));}catch{}}
  finally{batchBusy=false;syncBatchControls();}
 }
 function filterUsers(){const query=$('userSearch').value.trim().toLowerCase();const rows=[...$('adminUsers').children];for(const row of rows)row.hidden=!row.dataset.username.includes(query);$('noUsers').hidden=rows.some(row=>!row.hidden);}
 async function refreshOverview(){const response=await request('/api/usage'),body=await response.json();if(!response.ok)throw Error(body.error?.message||'额度读取失败');$('freeCount').textContent=body.usage.free.calls+' / '+body.usage.free.limit;}
 function passwordField(placeholder){const input=element('input');input.type='password';input.placeholder=placeholder;input.setAttribute('aria-label',placeholder);input.autocomplete='new-password';input.required=true;input.minLength=8;input.maxLength=128;return input;}
 async function updateUsers(container){
  const res=await request('/api/users'),data=await res.json();if(!res.ok)throw Error(data.error?.message||'用户列表读取失败');container.textContent='';latestUsers=data.users||[];renderCounts();
  for(const u of data.users||[]){
   const row=element('div',null,'cloud-user-row');row.dataset.userId=u.id;row.dataset.username=u.username.toLowerCase();row.classList.toggle('is-disabled',Boolean(u.disabled));row.appendChild(element('span',u.username+(u.role==='admin'?' · 管理员':u.disabled?' · 已停用':'')));
   if(u.id!==api.user.id){
    const controls=element('div',null,'cloud-user-actions');
    const btn=element('button',u.disabled?'启用':'禁用','ghost-btn small');btn.type='button';btn.onclick=async()=>{btn.disabled=true;try{const r=await request('/api/users/'+u.id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({disabled:!u.disabled})});const body=await r.json();if(!r.ok)throw Error(body.error?.message||'更新失败');await updateUsers(container);setStatus(u.disabled?'账号已启用。':'账号已停用，已有登录已失效。');}catch(error){setStatus(error.message,true);}finally{btn.disabled=false;}};controls.appendChild(btn);
    if(u.role==='user'){
     const reset=element('button','重置密码','ghost-btn small');reset.type='button';reset.dataset.action='reset-password';
     const form=element('form',null,'cloud-invite cloud-reset-password');form.hidden=true;form.appendChild(element('strong','重置 '+u.username+' 的密码'));
     const password=passwordField('新密码（至少 8 位）');password.name='newPassword';
     const submit=element('button','保存新密码','banner-btn primary');submit.type='submit';
     const hint=element('p',null,'check-note');hint.setAttribute('role','status');
     form.append(password,submit,hint);
     reset.onclick=()=>{form.hidden=!form.hidden;if(!form.hidden)password.focus();else{password.value='';hint.textContent='';}};
     form.onsubmit=async e=>{e.preventDefault();submit.disabled=true;try{
      const r=await request('/api/users/'+u.id+'/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({newPassword:password.value})});const b=await r.json();
      hint.textContent=r.ok?'密码已重置，请将新密码交给该用户。':b.error?.message||'重置失败';if(r.ok)password.value='';
     }catch{hint.textContent='连接失败，请重试';}finally{submit.disabled=false;}};
     const remove=element('button','删除','ghost-btn small danger-btn');remove.type='button';remove.dataset.action='delete-user';
     const deletion=element('form',null,'cloud-delete-user');deletion.hidden=true;deletion.append(element('strong','删除 '+u.username),element('p','删除账号、个人 API 配置和重置卡，已有登录会失效。保留历史用量；删除无法撤销。','check-note'));
     const name=element('input');name.name='username';name.placeholder='输入 '+u.username+' 确认';name.autocomplete='off';name.required=true;name.setAttribute('aria-label','输入 '+u.username+' 确认删除');
     const removeConfirm=element('button','确认删除','ghost-btn small danger-btn'),removeCancel=element('button','取消','ghost-btn small');removeConfirm.type='submit';removeConfirm.disabled=true;removeCancel.type='button';const removeHint=element('p',null,'check-note');removeHint.setAttribute('role','status');
     name.oninput=()=>{removeConfirm.disabled=name.value.trim()!==u.username;};remove.onclick=()=>{deletion.hidden=!deletion.hidden;if(!deletion.hidden)name.focus();};removeCancel.onclick=()=>{deletion.hidden=true;name.value='';removeConfirm.disabled=true;removeHint.textContent='';remove.focus();};
     deletion.onsubmit=async event=>{event.preventDefault();if(name.value.trim()!==u.username)return;removeConfirm.disabled=true;try{const response=await request('/api/users/'+u.id,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:name.value.trim()})}),data=await response.json();if(!response.ok)throw Error(data.error?.message||'删除失败');await updateUsers(container);closeBatch();setStatus('已删除 '+u.username+'，历史用量已保留。'+(data.configurationRemoved?'':'个人配置文件清理未完成，请联系维护者。'));}catch(error){removeHint.textContent=error.message;}finally{removeConfirm.disabled=name.value.trim()!==u.username;}};
     deletion.append(name,removeConfirm,removeCancel,removeHint);controls.appendChild(remove);row.appendChild(deletion);
     controls.appendChild(reset);row.appendChild(form);
    }
    row.insertBefore(controls,row.querySelector('form'));
   }
   if(window.DiagramMembership)row.appendChild(window.DiagramMembership.userForm(u,request,async()=>{await updateUsers(container);await api.refreshUsage();}));
   const resetSection=element('details',null,'cloud-reset-controls');resetSection.dataset.action='quota-reset';
   const cards=u.resetCards||{balance:0,revision:0};resetSection.appendChild(element('summary','额度重置 · 重置卡 '+cards.balance+' 张'));
   const resetHint=element('p','本周已用 '+(u.weeklyUsedPoints||0).toLocaleString('zh-CN',{maximumFractionDigits:3})+' 点；直接重置不消耗重置卡。','check-note');resetHint.setAttribute('role','status');
   const grant=element('form',null,'reset-card-grant'),grantLabel=element('label','发放重置卡'),count=element('input');count.name='count';count.type='number';count.min='1';count.max='1000';count.step='1';count.value='1';count.required=true;count.inputMode='numeric';count.setAttribute('aria-label',u.username+' 的重置卡发放数量');grantLabel.append(count,element('span','张'));
   const grantButton=element('button','发放','ghost-btn small');grantButton.type='submit';grant.append(grantLabel,grantButton);
   grant.onsubmit=async event=>{event.preventDefault();grantButton.disabled=true;try{const response=await request('/api/users/'+u.id+'/reset-cards',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({count:Number(count.value),revision:cards.revision})}),data=await response.json();if(!response.ok)throw Error(data.error?.message||'发放失败');await updateUsers(container);setStatus('已向 '+u.username+' 发放 '+Number(count.value)+' 张重置卡。');}catch(error){resetHint.textContent=error.message;}finally{grantButton.disabled=false;}};
   const direct=element('button','一键重置周额度','ghost-btn small');direct.type='button';direct.dataset.action='reset-weekly';direct.disabled=!cards.canReset;direct.title=cards.canReset?'恢复本周个人额度，不消耗卡':u.membership?.plan==='trial'?'体验用户没有周额度':u.disabled?'账号已停用':!u.weeklyUsedPoints?'本周尚未消耗额度，无需重置':'请等待周额度请求完成';
   const confirmBox=element('div',null,'reset-card-confirm');confirmBox.hidden=true;const question=element('p','确认恢复 '+u.username+' 本周已用的 '+(u.weeklyUsedPoints||0).toLocaleString('zh-CN',{maximumFractionDigits:3})+' 点？保留历史和原周上限。','check-note'),confirm=element('button','确认重置','banner-btn primary'),cancel=element('button','取消','ghost-btn small');confirm.type=cancel.type='button';confirm.dataset.action='confirm-weekly-reset';const actions=element('div',null,'reset-card-actions');actions.append(confirm,cancel);confirmBox.append(question,actions);
   direct.onclick=()=>{confirmBox.hidden=false;confirm.focus();};cancel.onclick=()=>{confirmBox.hidden=true;direct.focus();};confirm.onclick=async()=>{confirm.disabled=true;try{const response=await request('/api/users/'+u.id+'/weekly-reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:cards.revision})}),data=await response.json();if(!response.ok)throw Error(data.error?.message||'重置失败');await updateUsers(container);await refreshOverview();setStatus('已为 '+u.username+' 恢复 '+data.restoredPoints.toLocaleString('zh-CN',{maximumFractionDigits:3})+' 点周额度。');}catch(error){resetHint.textContent=error.message;}finally{confirm.disabled=false;}};
   resetSection.append(grant,direct,confirmBox,resetHint);row.appendChild(resetSection);
   if(u.membership?.plan==='trial'){row.appendChild(element('p','体验账号仅开放三个免费模型；调整会员后可使用对应模型与周额度。','check-note'));container.appendChild(row);continue;}
   const quotaForm=element('form',null,'cloud-weekly-limit');quotaForm.dataset.action='weekly-limit';
   const quotaLabel=element('label','每周额度');const quotaInput=element('input');quotaInput.type='number';quotaInput.name='limitPoints';quotaInput.min='1';quotaInput.max='1000000';quotaInput.step='1';quotaInput.required=true;quotaInput.inputMode='numeric';quotaInput.setAttribute('aria-label',u.username+' 的每周额度（点）');
   if(Number.isSafeInteger(u.weeklyLimitPoints)&&u.weeklyLimitPoints>0)quotaInput.value=String(u.weeklyLimitPoints);else quotaInput.placeholder='暂未知';
   quotaLabel.append(quotaInput,element('span','点'));const quotaSave=element('button','保存','ghost-btn small');quotaSave.type='submit';
   const quotaHint=element('p',u.customWeeklyLimitPoints!=null?'当前使用特殊额度':'当前跟随会员等级额度','check-note');quotaHint.setAttribute('role','status');quotaForm.append(quotaLabel,quotaSave,quotaHint);
   const inherit=element('button','恢复等级额度','ghost-btn small');inherit.type='button';inherit.dataset.action='inherit-quota';inherit.hidden=u.customWeeklyLimitPoints==null;
   inherit.onclick=async()=>{inherit.disabled=true;try{const response=await request('/api/users/'+u.id+'/weekly-limit',{method:'DELETE'}),result=await response.json();if(!response.ok)throw Error(result.error?.message||'恢复失败');await updateUsers(container);await api.refreshUsage();}catch(error){quotaHint.textContent=error.message;inherit.disabled=false;}};quotaForm.insertBefore(inherit,quotaHint);
   quotaForm.onsubmit=async event=>{event.preventDefault();const limitPoints=Number(quotaInput.value);if(!Number.isSafeInteger(limitPoints)||limitPoints<=0||limitPoints>1000000){quotaHint.textContent='请输入 1–1000000 的整数';return;}quotaSave.disabled=true;quotaHint.textContent='正在保存…';try{
    const response=await request('/api/users/'+encodeURIComponent(u.id)+'/weekly-limit',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({limitPoints})});const result=await response.json();if(!response.ok)throw Error(result.error?.message||'保存失败');await updateUsers(container);if(u.id===api.user.id)await api.refreshUsage();setStatus('特殊额度已保存，本周立即生效。');
   }catch(error){quotaHint.textContent=error.message||'连接失败，请重试';}finally{quotaSave.disabled=false;}};
   row.appendChild(quotaForm);
   container.appendChild(row);
  }
  filterUsers();
 }
 function mount(){
  const form=element('form',null,'cloud-invite');form.id='cloudInviteForm';
  const username=element('input');username.placeholder='账号（3–40 位）';username.setAttribute('aria-label','新用户账号');username.autocomplete='off';username.required=true;username.minLength=3;username.maxLength=40;username.id='cloudInviteUsername';
  const password=passwordField('初始密码（至少 8 位）');password.id='cloudInvitePassword';
  const usernameLabel=element('label','账号'),passwordLabel=element('label','初始密码');usernameLabel.appendChild(username);passwordLabel.appendChild(password);
  const button=element('button','创建账号','banner-btn primary');button.type='submit';const hint=element('p','新账号默认普通用户，可在左侧调整会员。','check-note');hint.id='cloudInviteHint';hint.setAttribute('role','status');
  form.append(usernameLabel,passwordLabel,button,hint);$('adminCreate').appendChild(form);
  form.onsubmit=async event=>{event.preventDefault();button.disabled=true;try{const response=await request('/api/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:username.value,password:password.value})});const body=await response.json();if(!response.ok)throw Error(body.error?.message||'创建失败');password.value='';hint.textContent='账号已创建，请将初始密码交给该用户。';await updateUsers($('adminUsers'));}catch(error){hint.textContent=error.message;}finally{button.disabled=false;}};
  $('adminPlans').appendChild(window.DiagramMembership.settings(request,async()=>{await updateUsers($('adminUsers'));await refreshOverview();}));
  $('userSearch').oninput=filterUsers;$('bulkResetBtn').onclick=()=>prepareBatch('weekly-reset');$('bulkGrantBtn').onclick=()=>prepareBatch('reset-cards');$('bulkCancelBtn').onclick=()=>{closeBatch();$('bulkStatus').textContent='已取消，未做修改。';};$('bulkConfirmBtn').onclick=executeBatch;
 }
 async function refresh(){
  $('refreshBtn').disabled=true;
  try{await Promise.all([updateUsers($('adminUsers')),refreshOverview()]);$('adminContent').hidden=false;setStatus('已更新 · '+new Date().toLocaleTimeString('zh-CN',{hour12:false}));}
  catch(error){setStatus(error.message||'读取失败，请刷新重试。',true);}
  finally{$('refreshBtn').disabled=false;}
 }
 $('refreshBtn').onclick=refresh;
 $('adminLogout').onclick=async()=>{const button=$('adminLogout');button.disabled=true;try{await request('/api/auth/logout',{method:'POST'});location.replace('/login.html');}catch(error){setStatus(error.message,true);button.disabled=false;}};
 window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
 (async()=>{try{
  const response=await fetch('/api/auth/session'),session=await response.json();
  if(!response.ok||!session.user){location.replace('/login.html?next=%2Fadmin.html');return;}
  if(session.mode!=='cloud'||session.user.role!=='admin'){deny('当前账号没有后台管理权限。');return;}
  api.user=session.user;csrf=session.csrf;$('adminName').textContent=session.user.username;mount();await refresh();
 }catch(error){deny(error.message||'无法读取管理信息，请刷新重试。');}})();
})();
