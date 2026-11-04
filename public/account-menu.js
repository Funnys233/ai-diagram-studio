(() => {
 'use strict';
 function element(tag,text,className){const e=document.createElement(tag);if(text)e.textContent=text;if(className)e.className=className;return e;}
 function redirect(){window.location.replace('/login.html');}
 function mount({host,session,request,currentSelection=()=>null,onUsage=()=>{},autoRefresh=true}){
  if(!host||!session?.user)return null;
  let usageMeter=null,resetSnapshot=null,resetBusy=false;
  const api={user:session.user,refreshUsage};
  function renderUsage(usage){if(usage?.membership)renderMembership(usage.membership);usageMeter?.render(usage,currentSelection());renderResetCards(usage);onUsage(usage);}
  async function refreshUsage(){try{const response=await request('/api/usage'),data=await response.json();if(!response.ok||!data.usage)throw Error('额度读取失败');renderUsage(data.usage);}catch{usageMeter?.error();}}
 function passwordField(placeholder){
  const input=element('input');input.type='password';input.placeholder=placeholder;input.setAttribute('aria-label',placeholder);input.autocomplete='new-password';input.required=true;input.minLength=8;input.maxLength=128;return input;
 }
  const menu=element('details',null,'cloud-account nav-menu');menu.id='cloudAccount';const summary=element('summary',null,'nav-trigger');summary.id='cloudAccountSummary';const avatar=element('span',api.user.username.slice(0,1).toUpperCase(),'nav-avatar');avatar.setAttribute('aria-hidden','true');const username=element('span',api.user.username,'account-username'),planBadge=element('span',null,'account-plan');summary.append(avatar,username,planBadge);menu.appendChild(summary);
  function renderMembership(member){const names={trial:'体验用户',free:'普通用户',pro:'Pro',max:'Max'},plan=Object.hasOwn(names,member?.plan)?member.plan:'free';planBadge.textContent=names[plan];planBadge.dataset.plan=plan;summary.title=api.user.username+' · '+names[plan]+' · 账号设置';summary.setAttribute('aria-label','账号：'+api.user.username+'，'+names[plan]);}
  renderMembership(api.user.membership);
  const panel=element('div',null,'cloud-account-panel');const heading=element('div',null,'cloud-account-heading');const identity=element('div',null,'cloud-account-identity');identity.append(element('strong',api.user.username),element('span',api.user.role==='admin'?'管理员账号':'个人账号'));heading.appendChild(identity);panel.appendChild(heading);
  const usage=element('div');usage.id='cloudUsage';usage.setAttribute('aria-label','网站额度');panel.appendChild(usage);usageMeter=window.DiagramQuotaMeter?.create(usage);const usageLink=element('a','查看完整用量 →','ghost-btn small');usageLink.href='/usage.html';panel.appendChild(usageLink);panel.appendChild(element('p',api.user.membership?.plan==='trial'?'体验账号仅可使用三个全站免费模型，共用每日次数。联系管理员可升级账号。':'三个免费模型共用全站日次数；其他开放模型使用个人周点数。我的 API 仅统计。图表和聊天保存在当前浏览器。','check-note'));
  const resetSection=element('details',null,'cloud-reset-cards');resetSection.id='cloudResetCards';
  const resetSummary=element('summary','重置卡 · 读取中'),resetBody=element('div',null,'reset-card-body');
  const resetInfo=element('p','使用一张恢复本周个人额度；历史记录、周恢复时间与全站免费次数保持不变。','check-note'),resetAvailability=element('p',null,'check-note');
  const useReset=element('button','使用 1 张重置','ghost-btn small');useReset.id='useResetCardBtn';useReset.type='button';useReset.disabled=true;
  const resetConfirm=element('div',null,'reset-card-confirm');resetConfirm.id='resetCardConfirm';resetConfirm.hidden=true;
  const resetQuestion=element('p',null,'check-note'),confirmReset=element('button','确认重置','banner-btn primary'),cancelReset=element('button','取消','ghost-btn small');confirmReset.id='confirmResetCardBtn';confirmReset.type=cancelReset.type='button';
  const resetActions=element('div',null,'reset-card-actions');resetActions.append(confirmReset,cancelReset);resetConfirm.append(resetQuestion,resetActions);
  const resetHint=element('p',null,'check-note');resetHint.id='resetCardHint';resetHint.setAttribute('role','status');
  resetBody.append(resetInfo,resetAvailability,useReset,resetConfirm,resetHint);resetSection.append(resetSummary,resetBody);panel.appendChild(resetSection);
  function renderResetCards(value){
   const cards=value?.resetCards;if(!cards){useReset.disabled=true;return;}
   if(resetSnapshot?.resetCards?.revision!==cards.revision||!cards.canUse)resetConfirm.hidden=true;
   resetSnapshot=value;resetSummary.textContent='重置卡 · '+cards.balance+' 张';resetSection.hidden=value.membership?.plan==='trial'&&!cards.balance;
   useReset.disabled=resetBusy||!cards.canUse;confirmReset.disabled=useReset.disabled;
   resetQuestion.textContent='消耗 1 张重置卡，恢复本周已用的 '+(value.weekly?.usedPoints||0).toLocaleString('zh-CN',{maximumFractionDigits:3})+' 点？';
   useReset.title=cards.reason||'恢复本周个人额度';resetAvailability.textContent=cards.reason||'每次消耗 1 张，恢复到当前会员或特殊周上限。';
  }
  useReset.onclick=()=>{resetConfirm.hidden=false;resetHint.textContent='';confirmReset.focus();};cancelReset.onclick=()=>{resetConfirm.hidden=true;useReset.focus();};
  confirmReset.onclick=async()=>{
   if(resetBusy||!resetSnapshot?.resetCards?.canUse)return;resetBusy=true;renderResetCards(resetSnapshot);resetHint.textContent='正在重置…';
   try{const response=await request('/api/usage/weekly-reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:resetSnapshot.resetCards.revision})}),data=await response.json();if(!response.ok)throw Error(data.error?.message||'重置失败');api.user=data.user;renderUsage(data.usage);resetHint.textContent='已恢复 '+data.restoredPoints.toLocaleString('zh-CN',{maximumFractionDigits:3})+' 点，剩余 '+data.usage.resetCards.balance+' 张。';resetConfirm.hidden=true;}
   catch(error){resetHint.textContent=error.message||'连接失败，请刷新确认结果后再试。';await api.refreshUsage();}
   finally{resetBusy=false;if(resetSnapshot)renderResetCards(resetSnapshot);}
  };
  const connection=document.querySelector('[data-chatgpt-mount]');if(api.user.membership?.plan==='trial')connection?.remove();else if(connection){connection.classList.remove('chatgpt-chat-mount','chatgpt-drawer-mount');connection.classList.add('chatgpt-account-mount');panel.appendChild(connection);}
  const passwordSection=element('details',null,'cloud-password');passwordSection.id='cloudPasswordSection';
  passwordSection.appendChild(element('summary','修改密码','ghost-btn small'));
  const passwordForm=element('form',null,'cloud-invite');passwordForm.id='cloudPasswordForm';
  const current=passwordField('当前密码');current.id='cloudCurrentPassword';current.autocomplete='current-password';current.minLength=1;
  const next=passwordField('新密码（至少 8 位）');next.id='cloudNewPassword';
  const savePassword=element('button','保存新密码','banner-btn primary');savePassword.type='submit';savePassword.id='cloudSavePasswordBtn';
  const passwordHint=element('p',null,'check-note');passwordHint.id='cloudPasswordHint';passwordHint.setAttribute('role','status');
  passwordForm.append(current,next,element('p','至少 8 位，可只用数字，无需大小写或符号组合。','check-note'),savePassword,passwordHint);
  passwordForm.onsubmit=async e=>{e.preventDefault();savePassword.disabled=true;try{
   const r=await request('/api/auth/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({currentPassword:current.value,newPassword:next.value})});const b=await r.json();
   passwordHint.textContent=r.ok?'密码已修改，请用新密码重新登录。':b.error?.message||'修改失败';
   if(r.ok){current.value='';next.value='';setTimeout(redirect,800);}
  }catch{passwordHint.textContent='连接失败，请重试';}finally{savePassword.disabled=false;}};
  passwordSection.appendChild(passwordForm);panel.appendChild(passwordSection);
  if(api.user.role==='admin'){const adminLink=element('a','后台管理 →','ghost-btn small');adminLink.id='adminLink';adminLink.href='/admin.html';panel.appendChild(adminLink);}
  if(session.features?.agent!==false&&(api.user.role==='admin'||['free','pro','max'].includes(api.user.membership?.plan))){const agentLink=element('a','智能任务 →','ghost-btn small');agentLink.href='/agent.html';panel.appendChild(agentLink);}
  const logout=element('button','退出登录','ghost-btn small');logout.id='cloudLogoutBtn';logout.type='button';logout.onclick=async()=>{await request('/api/auth/logout',{method:'POST'});redirect();};heading.appendChild(logout);menu.appendChild(panel);host.appendChild(menu);window.DiagramNavigation?.register(menu);
  document.addEventListener('click',e=>{if(menu.open&&!menu.contains(e.target))menu.open=false;});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&menu.open){menu.open=false;summary.focus();}});
  document.addEventListener('diagram:model-selection',event=>usageMeter?.select(event.detail));
  menu.addEventListener('toggle',()=>{if(menu.open)api.refreshUsage();});
  const timer=autoRefresh?setInterval(()=>{if(!document.hidden)api.refreshUsage();},60000):null;window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
  document.addEventListener('visibilitychange',()=>{if(autoRefresh&&!document.hidden)api.refreshUsage();});if(autoRefresh)api.refreshUsage();
  return {refreshUsage,renderUsage,select:selection=>usageMeter?.select(selection),error:()=>usageMeter?.error(),open(){menu.open=true;summary.focus();}};
 }
 window.DiagramAccountMenu={mount};
})();
