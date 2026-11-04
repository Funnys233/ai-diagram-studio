const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('会话查询仍在等待时快速登录，提交已被拦截且凭证只进入POST正文',async()=>{
 const elements={loginForm:{},loginBtn:{disabled:false},loginError:{textContent:''},loginUsername:{value:'fixture-admin'},loginPassword:{value:'fixture-password'}},requests=[],redirects=[];
 let resolveSession;
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../public/login.js'),'utf8'),{
  document:{getElementById:id=>elements[id]},URLSearchParams,window:{DiagramAuthRedirect:require('../../public/auth-redirect')},
  location:{search:'?next=%2Fusage.html',replace:url=>redirects.push(url)},
  fetch:(url,options)=>{requests.push({url,options});if(url==='/api/auth/session')return new Promise(resolve=>resolveSession=resolve);return Promise.resolve({ok:true,json:async()=>({user:{username:'fixture-admin'}})});}
 });
 assert.equal(typeof elements.loginForm.onsubmit,'function');let prevented=false;
 await elements.loginForm.onsubmit({preventDefault(){prevented=true;}});
 assert.equal(prevented,true);assert.equal(requests[1].url,'/api/auth/login');assert.equal(requests[1].options.method,'POST');assert.equal(JSON.parse(requests[1].options.body).password,'fixture-password');assert.deepEqual(redirects,['/usage.html']);assert.equal(elements.loginPassword.value,'');
 resolveSession({json:async()=>({mode:'cloud',user:null})});
});
