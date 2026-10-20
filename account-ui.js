// 账号界面只持有公开账号信息；登录凭证仅保存在 HttpOnly Cookie 中。
window.XiaofanAccount=(()=>{
  let bridge,currentAccount,expiring=false,returnFocus,checking=false,accountLoaded=false;
  const el=id=>document.getElementById(id);
  function message(value){el('accountMessage').textContent=value;el('accountPanelMessage').textContent=value}
  async function request(path,body){
    const response=await fetch(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Requested-With':'Xiaofan'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.error||'请求失败'),{status:response.status});return data;
  }
  function download(data,name){
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function showGuest(){
    document.body.classList.remove('account-loading');document.body.classList.add('guest-mode');
    el('guestHome').hidden=false;el('productApp').inert=true;bridge?.guest?.();
  }
  function dismissLogin(){
    el('authGate').hidden=true;el('guestHome').inert=false;document.body.classList.remove('auth-modal-open');
    el('authPassword').value='';el('authError').textContent='';
    if(returnFocus?.isConnected)returnFocus.focus();
  }
  function requireLogin(reason='登录后开启你的小饭计划'){
    if(accountLoaded)return true;
    if(el('authGate').hidden)returnFocus=document.activeElement;
    el('authReason').textContent=reason;el('authGate').hidden=false;el('guestHome').inert=true;document.body.classList.add('auth-modal-open');
    (checking||el('authForm').hidden?el('authClose'):el('authUsername')).focus();return false;
  }
  function open(){if(!accountLoaded)return requireLogin('登录后管理你的账号与数据');returnFocus=document.activeElement;el('accountPanel').hidden=false;el('accountClose').focus()}
  function close(){el('accountPanel').hidden=true;(returnFocus||el('accountBtn')).focus()}
  function status(kind,text){
    el('accountSyncStatus').textContent=text;el('accountSyncStatus').dataset.status=kind;
    el('accountSyncHelp').textContent=text;
    el('syncConflict').hidden=kind!=='conflict';
  }
  async function busy(button,action){
    button.disabled=true;try{await action()}catch(error){message(error.message)}finally{button.disabled=false}
  }
  async function boot(callbacks){
    if(checking)return;bridge=callbacks;checking=true;
    el('authLoading').hidden=false;el('authLoading').textContent='正在连接账号服务…';el('authRetry').hidden=true;el('authForm').hidden=true;el('legacyChoice').hidden=true;
    try{
      const data=await request('/api/auth/session');
      if(!data.account){
        currentAccount=null;accountLoaded=false;checking=false;showGuest();el('authLoading').hidden=true;el('authForm').hidden=false;
        if(sessionStorage.getItem('xiaofan_login_expired')){sessionStorage.removeItem('xiaofan_login_expired');requireLogin('登录状态已过期，请重新登录后继续使用。')}
        else if(!el('authGate').hidden)el('authUsername').focus();
        return;
      }
      currentAccount=data.account;el('accountUsername').textContent=currentAccount.username;
      const remote=await request('/api/user/state');
      const legacy=bridge.legacy();
      if(!remote.state?.profile?.age&&legacy?.profile?.age&&!localStorage.getItem(`xiaofan_legacy_skipped_${currentAccount.id}`)){
        checking=false;el('authLoading').hidden=true;el('legacyChoice').hidden=false;requireLogin('登录成功，请选择如何开始使用。');
        el('importLegacyBtn').onclick=()=>busy(el('importLegacyBtn'),async()=>{
          const response=await fetch('/api/user/state',{method:'PUT',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Requested-With':'Xiaofan','X-State-Version':String(remote.stateVersion)},body:JSON.stringify(legacy)}),result=await response.json();
          if(!response.ok)throw new Error(result.error||'导入失败');
          localStorage.removeItem('fitpilot_user_v3');localStorage.setItem(`xiaofan_legacy_skipped_${currentAccount.id}`,'1');location.reload();
        });
        el('skipLegacyBtn').onclick=()=>{localStorage.setItem(`xiaofan_legacy_skipped_${currentAccount.id}`,'1');location.reload()};
        return;
      }
      accountLoaded=true;el('authGate').hidden=true;el('guestHome').hidden=true;el('guestHome').inert=false;el('productApp').inert=false;
      document.body.classList.remove('account-loading','guest-mode','auth-modal-open');el('accountBtn').hidden=false;el('onboardingAccount').hidden=false;
      bridge.ready(currentAccount,remote);
    }catch(error){
      currentAccount=null;accountLoaded=false;showGuest();el('authForm').hidden=false;
      if(error.status===401){el('authLoading').hidden=true;el('authError').textContent='登录状态已失效，请重新登录。'}
      else{el('authLoading').textContent='暂时连接不上账号服务，仍可继续浏览公开内容。';el('authRetry').hidden=false}
    }finally{checking=false}
  }
  el('authForm').onsubmit=async event=>{
    event.preventDefault();const button=el('authSubmit');button.disabled=true;el('authError').textContent='';
    try{await request('/api/auth/login',{username:el('authUsername').value,password:el('authPassword').value});el('authPassword').value='';location.reload()}catch(error){el('authError').textContent=error.message}finally{button.disabled=false}
  };
  el('authRetry').onclick=()=>boot(bridge);
  el('authClose').onclick=dismissLogin;el('authBrowse').onclick=dismissLogin;
  el('authGate').addEventListener('click',event=>{if(event.target===el('authGate'))dismissLogin()});
  el('legacyLogout').onclick=()=>busy(el('legacyLogout'),async()=>{await request('/api/auth/logout',{});location.reload()});
  el('onboardingAccount').onclick=open;
  el('accountBtn').onclick=open;el('accountClose').onclick=close;
  el('accountPanel').addEventListener('click',event=>{if(event.target===el('accountPanel'))close()});
  document.addEventListener('keydown',event=>{if(event.key!=='Escape')return;if(!el('authGate').hidden)dismissLogin();else if(!el('accountPanel').hidden)close()});
  // 将键盘焦点限制在账号对话框中。
  for(const id of ['accountPanel','authGate'])el(id).addEventListener('keydown',event=>{if(event.key!=='Tab')return;const items=[...el(id).querySelectorAll('button,input,a[href]')].filter(item=>!item.disabled&&item.getClientRects().length),first=items[0],last=items.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}});
  el('accountExport').onclick=()=>busy(el('accountExport'),async()=>{
    await bridge.flush();const data=await request('/api/account/export');
    if(bridge.dirty())data.unsyncedLocalState=bridge.local();
    download(data,`xiaofan-${new Date().toISOString().slice(0,10)}.json`);message('已导出账号数据；若有未同步记录，也已单独包含在文件中。');
  });
  el('exportPending').onclick=()=>download({format:'xiaofan-unsynced-export',exportedAt:new Date().toISOString(),state:bridge.local()},'xiaofan-unsynced.json');
  el('loadCloud').onclick=()=>busy(el('loadCloud'),async()=>{
    if(!confirm('载入云端会替换此设备尚未同步的修改。建议先点击“导出本机修改”保存副本。确定继续？'))return;
    const data=await request('/api/user/state');bridge.replace(data);el('syncConflict').hidden=true;message('已载入云端最新数据。');
  });
  el('retrySync').onclick=()=>busy(el('retrySync'),async()=>{if(await bridge.flush())message('数据已保存到云端');else message('同步尚未完成，请检查网络或处理上方冲突。')});
  for(const [id,path] of [['accountLogout','/api/auth/logout'],['accountLogoutAll','/api/auth/logout-all']])el(id).onclick=()=>busy(el(id),async()=>{
    await bridge.flush();if(bridge.dirty()&&!confirm('本机仍有未同步修改，已暂存在此设备。确定退出？'))return;
    await request(path,{});if(!bridge.dirty())bridge.forget();location.reload();
  });
  el('accountPasswordForm').onsubmit=event=>{
    event.preventDefault();const form=event.currentTarget;
    if(form.elements.newPassword.value!==form.elements.confirmPassword.value)return message('两次新密码不一致');
    busy(form.querySelector('button'),async()=>{await request('/api/account/password',{password:form.elements.password.value,newPassword:form.elements.newPassword.value});form.reset();message('密码已修改，其他设备已退出登录。')});
  };
  el('accountDangerForm').onsubmit=event=>{
    event.preventDefault();const form=event.currentTarget,action=form.elements.action.value;
    busy(form.querySelector('button'),async()=>{
      // 等待当前同步完成；服务器也会阻止与尚未完成的业务请求并发清除。
      await bridge.flush();
      await request(`/api/account/${action}`,{password:form.elements.password.value,confirmation:form.elements.confirmation.value});
      bridge.forget();location.reload();
    });
  };
  el('accountDangerAction').onchange=()=>{const deleting=el('accountDangerAction').value==='delete';el('accountDangerHint').textContent=deleting?'输入“注销账号”，删除账号及全部云端记录，操作无法撤销。':'输入“清空数据”，删除档案、记录、对话、计划及工具日志，保留账号。';el('accountDangerConfirmation').value=''};
  return {boot,status,open,requireLogin,dismissLogin,expired(){if(expiring)return;expiring=true;sessionStorage.setItem('xiaofan_login_expired','1');location.reload()}};
})();
