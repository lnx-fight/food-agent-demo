// Public examples never read account caches or invoke product APIs.
(()=>{
  const home=document.getElementById('guestHome');
  home.addEventListener('click',event=>{
    const action=event.target.closest('[data-login-purpose]');
    if(action){window.XiaofanAccount.requireLogin(action.dataset.loginPurpose);return}
    const filter=event.target.closest('[data-guest-filter]');
    if(!filter)return;
    for(const button of home.querySelectorAll('[data-guest-filter]'))button.setAttribute('aria-pressed',String(button===filter));
    for(const card of home.querySelectorAll('[data-guest-group]'))card.hidden=filter.dataset.guestFilter!=='all'&&card.dataset.guestGroup!==filter.dataset.guestFilter;
  });
})();
