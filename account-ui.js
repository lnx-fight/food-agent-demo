// Device-scoped data management. There is no username/password flow.
window.XiaofanDevice=(()=>{
  let bridge,loaded=false,connecting=null,returnFocus;
  const el=id=>document.getElementById(id);
  function message(value){el('accountPanelMessage').textContent=value}
  async function request(path,body){
    const response=await fetch(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Requested-With':'Xiaofan'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.error||'请求失败'),{status:response.status});return data;
  }
  function download(data,name){
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function showGuest(){
    loaded=false;document.body.classList.add('public-mode');el('productApp').inert=false;bridge?.guest?.();
  }
  function connectionMessage(value){el('deviceConnectionStatus').textContent=value}
  async function enter(device){
    // Verify that the browser retained the cookie before exposing personal UI.
    const verified=await request('/api/device/session');
    if(verified.device?.id!==device.id)throw new Error('请允许本站保存浏览器数据后重试。');
    const remote=await request('/api/user/state');
    bridge.ready(device,remote);loaded=true;
    el('productApp').inert=false;el('accountBtn').hidden=false;el('onboardingAccount').hidden=false;
    connectionMessage('');
  }
  async function start(){
    if(loaded)return true;if(connecting)return connecting;
    connectionMessage('正在准备你的使用空间…');
    connecting=(async()=>{
      try{const data=await request('/api/device/session',{});await enter(data.device);return true}
      catch(error){showGuest();connectionMessage(error.message||'连接失败，请点击“开始使用”重试。');return false}
      finally{connecting=null}
    })();return connecting;
  }
  async function boot(callbacks){
    // Every visit uses the same workspace. Only an explicit personal action
    // creates/renews the browser identity or loads a personal profile.
    bridge=callbacks;showGuest();
  }
  function open(){if(!loaded)return;returnFocus=document.activeElement;el('accountPanel').hidden=false;el('accountClose').focus()}
  function close(){el('accountPanel').hidden=true;(returnFocus||el('accountBtn')).focus()}
  function status(kind,text){el('accountSyncStatus').textContent=text;el('accountSyncStatus').dataset.status=kind;el('accountSyncHelp').textContent=text;el('syncConflict').hidden=kind!=='conflict'}
  async function busy(button,action){button.disabled=true;try{await action()}catch(error){message(error.message)}finally{button.disabled=false}}
  el('onboardingAccount').onclick=open;el('accountBtn').onclick=open;el('accountClose').onclick=close;
  el('accountPanel').addEventListener('click',event=>{if(event.target===el('accountPanel'))close()});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!el('accountPanel').hidden)close()});
  el('accountPanel').addEventListener('keydown',event=>{if(event.key!=='Tab')return;const items=[...el('accountPanel').querySelectorAll('button,input,select,a[href]')].filter(item=>!item.disabled&&item.getClientRects().length),first=items[0],last=items.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}});
  el('accountExport').onclick=()=>busy(el('accountExport'),async()=>{
    await bridge.flush();const data=await request('/api/device/export');if(bridge.dirty())data.unsyncedLocalState=bridge.local();
    download(data,`xiaofan-${new Date().toISOString().slice(0,10)}.json`);message('已导出此浏览器的数据；未同步修改也已包含在文件中。');
  });
  el('exportPending').onclick=()=>download({format:'xiaofan-unsynced-export',exportedAt:new Date().toISOString(),state:bridge.local()},'xiaofan-unsynced.json');
  el('loadCloud').onclick=()=>busy(el('loadCloud'),async()=>{
    if(!confirm('载入云端会替换此浏览器尚未同步的修改。建议先导出本机修改。确定继续？'))return;
    bridge.replace(await request('/api/user/state'));el('syncConflict').hidden=true;message('已载入云端最新数据。');
  });
  el('retrySync').onclick=()=>busy(el('retrySync'),async()=>{message(await bridge.flush()?'数据已保存到云端':'同步尚未完成，请检查网络或处理上方冲突。')});
  el('accountDangerForm').onsubmit=event=>{
    event.preventDefault();const form=event.currentTarget;
    busy(form.querySelector('button'),async()=>{
      await bridge.flush();await request(`/api/device/${form.elements.action.value}`,{confirmation:form.elements.confirmation.value});
      bridge.forget();location.reload();
    });
  };
  el('accountDangerAction').onchange=()=>{el('accountDangerHint').textContent=el('accountDangerAction').value==='delete'?'输入“删除全部数据”，删除此浏览器使用空间及其全部云端记录，操作无法撤销。':'输入“清空数据”，删除此浏览器的档案、记录、对话、计划及工具日志。';el('accountDangerConfirmation').value=''};
  return {boot,start,status,open,expired(){loaded=false;showGuest();connectionMessage('此浏览器的使用凭证已失效。原有本机暂存仍保留；点击“开始使用”将创建新的使用空间。')}};
})();
