// Public examples do not read personal caches or create a device until use starts.
(()=>{
  const home=document.getElementById('guestHome');
  document.addEventListener('click',event=>{
    const action=event.target.closest('[data-start-product]');
    if(action){switchView(action.dataset.personalView||'today');return}
    const filter=event.target.closest('[data-guest-filter]');
    if(!filter)return;
    for(const button of home.querySelectorAll('[data-guest-filter]'))button.setAttribute('aria-pressed',String(button===filter));
    for(const card of home.querySelectorAll('[data-guest-group]'))card.hidden=filter.dataset.guestFilter!=='all'&&card.dataset.guestGroup!==filter.dataset.guestFilter;
  });
})();
