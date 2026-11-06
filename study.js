/* =========================================================
   STUDY TOOLS
   - Display preferences: text size + light / dark mode
   - History Progress (flashcard + mock quiz results, kept on this device)
   - Pomodoro timer that rings like an alarm
========================================================= */

/* ---------------------------------------------------------
   DISPLAY PREFERENCES  (the <head> script applies them before first paint)
--------------------------------------------------------- */
const FONT_MIN = 12, FONT_MAX = 24, FONT_DEFAULT = 16;
function prefGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
function prefSet(k, v){ try{ localStorage.setItem(k, v); }catch(e){} }

function isDarkTheme(){ return document.documentElement.getAttribute('data-theme')==='dark'; }
function applyThemeMode(mode){
  const dark = mode==='dark';
  if(dark) document.documentElement.setAttribute('data-theme','dark');
  else document.documentElement.removeAttribute('data-theme');
  prefSet('shTheme', dark ? 'dark' : 'light');
  const meta = document.querySelector('meta[name="theme-color"]');
  if(meta) meta.setAttribute('content', dark ? '#14181A' : '#F6F5F0');
}
function currentFontSize(){
  const n = parseInt(prefGet('shFont'), 10);
  return (n>=FONT_MIN && n<=FONT_MAX) ? n : FONT_DEFAULT;
}
function setFontSize(n){
  n = Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(n)));
  prefSet('shFont', String(n));
  document.documentElement.style.setProperty('--fs', String(n/FONT_DEFAULT));
  return n;
}

/* ---------------------------------------------------------
   HISTORY PROGRESS
--------------------------------------------------------- */
const HIST_KEY = 'shHistory';
function histAll(){ const l = lsGet(HIST_KEY, []); return Array.isArray(l) ? l : []; }
function histAdd(entry){
  const list = histAll();
  list.push(Object.assign({id: uid(), t: Date.now(), school: (typeof currentSchool!=='undefined' ? currentSchool : null)}, entry));
  lsSet(HIST_KEY, list.slice(-500));
}
function histForSchool(){ return histAll().filter(e=>e.school===currentSchool); }
function histPct(list){
  let c = 0, t = 0;
  list.forEach(e=>{ c += e.correct||0; t += e.total||0; });
  return t ? Math.round(c/t*100) : null;
}
function histLast(subjectId, kind){
  const l = histForSchool().filter(e=>e.subjectId===subjectId && e.kind===kind);
  if(!l.length) return null;
  const e = l[l.length-1];
  return e.total ? Math.round(e.correct/e.total*100) : null;
}
function histClear(){
  if(!confirm('Clear all history progress on this device?')) return;
  const keep = histAll().filter(e=>e.school!==currentSchool);
  lsSet(HIST_KEY, keep);
  renderReviewers();
}
function histBar(pct){
  return `<div class="bar"><i style="width:${pct===null?0:pct}%"></i></div>`;
}
function histWhen(t){
  const d = new Date(t);
  return d.toLocaleDateString(undefined, {month:'short', day:'numeric'}) + ' · ' +
    d.toLocaleTimeString(undefined, {hour:'numeric', minute:'2-digit'});
}
function historyHtml(){
  const list = histForSchool();
  if(!list.length){
    return `<div class="card" style="text-align:center;">
      <h3>No history yet</h3>
      <p style="color:var(--ink-soft);">Finish a flashcard round or a mock quiz and your results will show up here.</p></div>`;
  }
  const flash = list.filter(e=>e.kind==='flash'), quiz = list.filter(e=>e.kind==='quiz');
  const card = (label, arr)=>{
    const pct = histPct(arr);
    return `<div class="hist-card">
      <small>${label}</small>
      <b>${pct===null ? '—' : pct+'%'}</b>
      ${histBar(pct)}
      <span>${arr.length} round${arr.length===1?'':'s'}</span></div>`;
  };
  let html = `<div class="hist-summary">${card('Flashcards correct', flash)}${card('Mock quiz correct', quiz)}</div>`;

  // per subject
  const subjects = {};
  list.forEach(e=>{ (subjects[e.subjectId] = subjects[e.subjectId] || {name:e.subject, flash:[], quiz:[]})[e.kind==='quiz'?'quiz':'flash'].push(e); });
  html += `<div class="section-label">By subject</div><div class="hist-list">`;
  Object.keys(subjects).forEach(id=>{
    const s = subjects[id];
    const live = (S().reviewerSubjects||[]).find(x=>x.key===id);
    const fp = histPct(s.flash), qp = histPct(s.quiz);
    html += `<div class="hist-row">
      <h4>${esc(live ? live.name : (s.name||'Subject'))}</h4>
      <div class="hist-line"><span>Flashcards</span>${histBar(fp)}<em>${fp===null?'—':fp+'%'}</em></div>
      <div class="hist-line"><span>Mock quiz</span>${histBar(qp)}<em>${qp===null?'—':qp+'%'}</em></div>
    </div>`;
  });
  html += `</div>`;

  // recent
  html += `<div class="section-label">Recent</div><div class="hist-list">`;
  list.slice(-12).reverse().forEach(e=>{
    const pct = e.total ? Math.round(e.correct/e.total*100) : 0;
    html += `<div class="hist-recent">
      <span class="kind ${e.kind}">${e.kind==='quiz'?'Quiz':'Cards'}</span>
      <div class="hist-recent-text"><b>${esc(e.subject||'Subject')}</b><small>${esc((e.scope ? e.scope + ' · ' : '') + histWhen(e.t))}</small></div>
      <div class="hist-recent-score"><b>${pct}%</b><small>${e.correct}✓ ${e.wrong}✕</small></div>
    </div>`;
  });
  html += `</div><button class="btn ghost sm" style="margin-top:18px;" onclick="histClear()">Clear history</button>
    <p class="hist-note">History is saved on this device.</p>`;
  return html;
}

/* ---------------------------------------------------------
   POMODORO TIMER
   Focus → alarm (sound + vibration up to 1 minute, banner on top)
   → "Rest" or "Finish" → rest → alarm again → "Focus again" or "Finish".
   The timer works from clock times, so it stays right if the phone sleeps.
   In the Android app the alarm is also scheduled as notifications so it
   rings when the screen is off.
--------------------------------------------------------- */
const POMO_KEY = 'shPomo';
const POMO_NOTIF_BASE = 300000;
const POMO_RING_MS = 60000;
let pomo = Object.assign({phase:'idle', focus:25, rest:5, endAt:0, ringFor:null, ringAt:0, paused:false, remaining:0}, lsGet(POMO_KEY, {}) || {});
const POMO_SOUND = 'alarm.wav';     // replace this file with your own sound (same name)
let pomoFile = null, pomoCtx = null, pomoBeepTimer = null, pomoVibeTimer = null, pomoRinging = false;

function pomoSave(){ lsSet(POMO_KEY, pomo); }
function pomoClamp(v, lo, hi, d){ v = parseInt(v, 10); if(!(v>=lo)) v = d; return Math.min(hi, Math.max(lo, v)); }
function pomoFmt(ms){
  const s = Math.max(0, Math.ceil(ms/1000));
  return Math.floor(s/60) + ':' + String(s%60).padStart(2,'0');
}
function pomoRefreshView(){
  if(typeof currentPage!=='undefined' && currentPage==='reviewers' && revMode==='pomodoro' && !document.getElementById('modalScrim').classList.contains('show')) renderReviewers();
}

/* ---- sound + vibration ---- */
function pomoPrimeAudio(){
  try{
    if(!pomoFile){ pomoFile = new Audio(POMO_SOUND); pomoFile.loop = true; pomoFile.preload = 'auto'; }
    // unlock playback while the tap is still fresh
    const p = pomoFile.play();
    if(p && p.then) p.then(()=>{ pomoFile.pause(); pomoFile.currentTime = 0; }).catch(()=>{});
  }catch(e){}
  try{
    const AC = window.AudioContext || window.webkitAudioContext;
    if(!AC) return;
    if(!pomoCtx) pomoCtx = new AC();
    if(pomoCtx.state==='suspended') pomoCtx.resume();
  }catch(e){}
}
function pomoBeep(){
  try{
    if(!pomoCtx) return;
    if(pomoCtx.state==='suspended') pomoCtx.resume();
    const t = pomoCtx.currentTime;
    [880, 1175].forEach((f, i)=>{
      const o = pomoCtx.createOscillator(), g = pomoCtx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      const s = t + i*0.22;
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.5, s+0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, s+0.2);
      o.connect(g); g.connect(pomoCtx.destination);
      o.start(s); o.stop(s+0.22);
    });
  }catch(e){}
}
function pomoVibrate(){ try{ if(navigator.vibrate) navigator.vibrate([450,150,450,150,450]); }catch(e){} }
function pomoStartAlarm(){
  pomoStopAlarm();
  pomoRinging = true;
  pomoVibrate();
  let fileOk = false;
  try{
    if(pomoFile){
      pomoFile.currentTime = 0;
      const p = pomoFile.play();
      fileOk = true;
      if(p && p.catch) p.catch(()=>{ if(pomoRinging && !pomoBeepTimer){ pomoBeep(); pomoBeepTimer = setInterval(pomoBeep, 900); } });
    }
  }catch(e){ fileOk = false; }
  if(!fileOk){ pomoBeep(); pomoBeepTimer = setInterval(pomoBeep, 900); }
  pomoVibeTimer = setInterval(pomoVibrate, 2200);
}
function pomoStopAlarm(){
  pomoRinging = false;
  clearInterval(pomoBeepTimer); clearInterval(pomoVibeTimer);
  pomoBeepTimer = pomoVibeTimer = null;
  try{ if(pomoFile){ pomoFile.pause(); pomoFile.currentTime = 0; } }catch(e){}
  try{ if(navigator.vibrate) navigator.vibrate(0); }catch(e){}
}

/* ---- notifications (so it rings with the screen off) ---- */
function pomoLN(){ return (typeof isNativeApp==='function' && isNativeApp() && typeof getLocalNotifications==='function') ? getLocalNotifications() : null; }
async function pomoCancelNotifs(){
  const LN = pomoLN();
  if(!LN) return;
  try{ await LN.cancel({notifications: [0,1,2,3,4].map(i=>({id: POMO_NOTIF_BASE+i}))}); }catch(e){}
}
async function pomoScheduleNotifs(at, phase){
  const LN = pomoLN();
  if(!LN) return;
  try{
    await pomoCancelNotifs();
    try{ await LN.createChannel({id:'pomodoro-alarm', name:'Pomodoro alarm', description:'Rings when a focus or rest period ends', importance:5, visibility:1, vibration:true, sound:POMO_SOUND}); }catch(e){}
    const focus = phase==='focus';
    const title = focus ? 'Focus time is over' : 'Rest is over';
    const body = focus ? 'Continue to rest for ' + pomo.rest + ' min, or stop.' : 'Add another ' + pomo.focus + '-min round, or finish.';
    // repeats so it keeps ringing for about a minute
    const list = [0, 15, 30, 45, 60].map((sec, i)=>({
      id: POMO_NOTIF_BASE+i, title, body, channelId:'pomodoro-alarm', sound:POMO_SOUND,
      actionTypeId: focus ? 'POMO_FOCUS_END' : 'POMO_REST_END', extra:{pomo:phase},
      schedule: {at: new Date(at + sec*1000), allowWhileIdle:true},
      smallIcon: 'ic_stat_icon_config_sample'
    }));
    await LN.schedule({notifications: list});
  }catch(e){ console.error('Pomodoro notification error:', e); }
}
// Buttons on the notification itself (Continue / Stop after focus, Add / Finish after rest)
async function pomoSetupNotifActions(){
  const LN = pomoLN();
  if(!LN) return;
  try{
    await LN.registerActionTypes({types:[
      {id:'POMO_FOCUS_END', actions:[{id:'continue', title:'Continue'}, {id:'stop', title:'Stop', destructive:true}]},
      {id:'POMO_REST_END',  actions:[{id:'add', title:'Add'}, {id:'finish', title:'Finish', destructive:true}]}
    ]});
    await LN.addListener('localNotificationActionPerformed', ev=>{
      const type = ev && ev.notification && ev.notification.actionTypeId;
      if(type && !/^POMO_/.test(type)) return;          // activity reminders are handled in notifications.js
      const id = ev && ev.actionId, ph = pomo.phase;
      pomoCancelNotifs();
      const focusDone = ph==='focus' || (ph==='ring' && pomo.ringFor==='focus');
      const restDone  = ph==='rest'  || (ph==='ring' && pomo.ringFor==='rest');
      if(id==='continue' && focusDone) pomoRest();
      else if(id==='add' && restDone) pomoFocusAgain();
      else if(id==='stop' || id==='finish') pomoFinish();
      else pomoTick();                 // tapped the notification itself: show the banner
    });
  }catch(e){ console.error('Pomodoro actions error:', e); }
}
function pomoAskNotify(){
  try{
    if(!pomoLN() && 'Notification' in window && Notification.permission==='default') Notification.requestPermission();
  }catch(e){}
}
function pomoWebNotify(title, body){
  try{
    if(!pomoLN() && 'Notification' in window && Notification.permission==='granted' && document.hidden){
      new Notification(title, {body, icon:'GaEs_Icon.png', tag:'gabay-pomodoro'});
    }
  }catch(e){}
}

/* ---- banner on top ---- */
function pomoShowBanner(){
  const el = document.getElementById('pomoBanner');
  if(!el) return;
  const focusEnded = pomo.ringFor==='focus';
  el.innerHTML = `
    <div class="pb-text">
      <svg viewBox="0 0 24 24"><path d="M12 22a2.4 2.4 0 0 0 2.4-2.4h-4.8A2.4 2.4 0 0 0 12 22zm7-6.5v-5a7 7 0 0 0-5.2-6.8V3a1.8 1.8 0 0 0-3.6 0v.7A7 7 0 0 0 5 10.5v5L3 17.5V19h18v-1.5l-2-2z"/></svg>
      <div><b>${focusEnded ? 'Focus time is over' : 'Rest is over'}</b>
      <span>${focusEnded ? 'Continue to rest for ' + pomo.rest + ' min?' : 'Add another ' + pomo.focus + '-min round?'}</span></div>
    </div>
    <div class="pb-actions">
      <button class="pb-main" onclick="${focusEnded ? 'pomoRest()' : 'pomoFocusAgain()'}">${focusEnded ? 'Continue' : 'Add'}</button>
      <button onclick="pomoFinish()">${focusEnded ? 'Stop' : 'Finish'}</button>
    </div>`;
  el.classList.add('show');
}
function pomoHideBanner(){
  const el = document.getElementById('pomoBanner');
  if(el){ el.classList.remove('show'); el.innerHTML = ''; }
}

/* ---- state changes ---- */
function pomoBegin(phase){
  pomoStopAlarm();
  pomo.phase = phase;
  pomo.endAt = Date.now() + (phase==='focus' ? pomo.focus : pomo.rest)*60000;
  pomo.ringFor = null; pomo.ringAt = 0; pomo.paused = false; pomo.remaining = 0;
  pomoSave();
  pomoHideBanner();
  pomoScheduleNotifs(pomo.endAt, phase);
  pomoRefreshView();
}
function pomoStart(){
  const f = document.getElementById('pomoFocus'), r = document.getElementById('pomoRest');
  pomo.focus = pomoClamp(f && f.value, 1, 180, 25);
  pomo.rest = pomoClamp(r && r.value, 1, 60, 5);
  pomoPrimeAudio(); pomoAskNotify();
  pomoBegin('focus');
}
function pomoSetting(key, v){
  pomo[key] = key==='focus' ? pomoClamp(v, 1, 180, 25) : pomoClamp(v, 1, 60, 5);
  pomoSave();
}
function pomoRest(){ pomoPrimeAudio(); pomoBegin('rest'); }
function pomoFocusAgain(){ pomoPrimeAudio(); pomoBegin('focus'); }
function pomoPause(){
  if(!(pomo.phase==='focus' || pomo.phase==='rest') || pomo.paused) return;
  pomo.paused = true;
  pomo.remaining = Math.max(0, pomo.endAt - Date.now());
  pomoSave();
  pomoCancelNotifs();                // nothing should ring while paused
  pomoRefreshView();
}
function pomoResume(){
  if(!pomo.paused) return;
  pomoPrimeAudio();
  pomo.paused = false;
  pomo.endAt = Date.now() + pomo.remaining;
  pomo.remaining = 0;
  pomoSave();
  pomoScheduleNotifs(pomo.endAt, pomo.phase);
  pomoRefreshView();
}
function pomoFinish(){
  pomoStopAlarm();
  // a focus period stopped early is still counted for the time you actually studied
  if(pomo.phase==='focus'){
    const planned = pomo.focus*60000;
    const left = pomo.paused ? pomo.remaining : Math.max(0, pomo.endAt - Date.now());
    const mins = Math.floor((planned - left)/60000);
    if(mins>=1) pomoLogAdd({phase:'focus', minutes:mins, planned:pomo.focus, done:false});
  }
  pomo.phase = 'idle'; pomo.ringFor = null; pomo.endAt = 0; pomo.ringAt = 0; pomo.paused = false; pomo.remaining = 0;
  pomoSave();
  pomoHideBanner();
  pomoCancelNotifs();
  pomoRefreshView();
}
function pomoRing(kind){
  pomoLogAdd({phase:kind, minutes:(kind==='focus' ? pomo.focus : pomo.rest), planned:(kind==='focus' ? pomo.focus : pomo.rest), done:true});
  pomo.phase = 'ring'; pomo.ringFor = kind; pomo.ringAt = Date.now();
  pomoSave();
  pomoShowBanner();
  pomoStartAlarm();
  pomoWebNotify(kind==='focus' ? 'Focus time is over' : 'Rest is over', 'Open Gabay Estudyante to choose what’s next.');
  if(!document.hidden) pomoCancelNotifs();      // we are already ringing in the app
  pomoRefreshView();
}
function pomoTick(){
  const now = Date.now();
  if((pomo.phase==='focus' || pomo.phase==='rest') && !pomo.paused && now >= pomo.endAt){
    pomoRing(pomo.phase);
  } else if(pomo.phase==='ring' && pomoRinging && now - pomo.ringAt >= POMO_RING_MS){
    pomoStopAlarm();                              // the banner stays until you choose
  }
  const clock = document.getElementById('pomoClock');
  if(clock && (pomo.phase==='focus' || pomo.phase==='rest')) clock.textContent = pomoFmt((pomo.paused ? pomo.remaining : pomo.endAt - now));
  const bar = document.getElementById('pomoBar');
  if(bar && (pomo.phase==='focus' || pomo.phase==='rest')){
    const total = (pomo.phase==='focus' ? pomo.focus : pomo.rest)*60000;
    bar.style.width = Math.min(100, Math.max(0, 100 - ((pomo.paused ? pomo.remaining : pomo.endAt-now))/total*100)) + '%';
  }
}

/* ---- usage history ---- */
const POMO_LOG_KEY = 'shPomoLog';
function pomoLogAll(){ const l = lsGet(POMO_LOG_KEY, []); return Array.isArray(l) ? l : []; }
function pomoLogAdd(e){
  const l = pomoLogAll();
  l.push(Object.assign({id: uid(), t: Date.now()}, e));
  lsSet(POMO_LOG_KEY, l.slice(-300));
}
function pomoLogClear(){
  if(!confirm('Clear the Pomodoro usage history on this device?')) return;
  lsSet(POMO_LOG_KEY, []);
  pomoRefreshView();
}
function pomoMinText(m){ return m>=60 ? Math.floor(m/60) + ' h ' + (m%60 ? (m%60) + ' min' : '') : m + ' min'; }
function pomoLogHtml(){
  const log = pomoLogAll();
  if(!log.length) return `<div class="pomo-log"><div class="section-label">Usage history</div><p style="color:var(--ink-soft);font-size:calc(13px * var(--fs));">Your focus sessions will be listed here.</p></div>`;
  const today = new Date().toDateString();
  const focus = log.filter(e=>e.phase==='focus');
  const todayMin = focus.filter(e=>new Date(e.t).toDateString()===today).reduce((a,e)=>a+e.minutes, 0);
  const allMin = focus.reduce((a,e)=>a+e.minutes, 0);
  const rows = log.slice(-12).reverse().map(e=>`<div class="hist-recent">
      <span class="kind ${e.phase==='focus'?'flash':'quiz'}">${e.phase==='focus'?'Focus':'Rest'}</span>
      <div class="hist-recent-text"><b>${pomoMinText(e.minutes)}${e.done ? '' : ' of ' + e.planned + ' min'}</b><small>${esc(histWhen(e.t))}</small></div>
      <div class="hist-recent-score"><small>${e.done ? 'Completed' : 'Stopped early'}</small></div></div>`).join('');
  return `<div class="pomo-log"><div class="section-label">Usage history</div>
    <div class="pomo-log-total"><div><b>${pomoMinText(todayMin)}</b><small>Focused today</small></div><div><b>${pomoMinText(allMin)}</b><small>Focused in total</small></div></div>
    <div class="hist-list">${rows}</div>
    <button class="btn ghost sm" style="margin-top:14px;" onclick="pomoLogClear()">Clear usage history</button></div>`;
}

function pomodoroHtml(){
  const run = pomo.phase==='focus' || pomo.phase==='rest';
  let body;
  if(run){
    body = `<div class="pomo-live ${pomo.phase} ${pomo.paused?'pomo-paused':''}">
      <span class="pomo-phase">${pomo.phase==='focus' ? 'Focus' : 'Rest'}${pomo.paused ? ' · Paused' : ''}</span>
      <div class="pomo-clock" id="pomoClock">${pomoFmt(pomo.paused ? pomo.remaining : pomo.endAt - Date.now())}</div>
      <div class="bar"><i id="pomoBar" style="width:0%"></i></div>
      <div class="pomo-actions">
        ${pomo.paused ? `<button class="btn" onclick="pomoResume()">Resume</button>` : `<button class="btn" onclick="pomoPause()">Pause</button>`}
        <button class="btn ghost" onclick="pomoFinish()">Stop</button>
      </div>
    </div>`;
  } else if(pomo.phase==='ring'){
    const focusEnded = pomo.ringFor==='focus';
    body = `<div class="pomo-live ring">
      <span class="pomo-phase">${focusEnded ? 'Focus time is over' : 'Rest is over'}</span>
      <div class="pomo-clock">0:00</div>
      <div class="result-actions" style="justify-content:center;">
        <button class="btn" onclick="${focusEnded ? 'pomoRest()' : 'pomoFocusAgain()'}">${focusEnded ? 'Continue' : 'Add'}</button>
        <button class="btn ghost" onclick="pomoFinish()">${focusEnded ? 'Stop' : 'Finish'}</button>
      </div></div>`;
  } else {
    body = `<p style="color:var(--ink-soft);font-size:calc(13px * var(--fs));">Study for a set time. When it ends, your phone rings and vibrates for up to a minute and a notification asks you to Continue (start the rest) or Stop. The timer only moves on when you tap Continue. After the rest it rings again: Add another round, or Finish.</p>
      <div class="pomo-fields">
        <label><span>Focus (minutes)</span><input id="pomoFocus" type="number" inputmode="numeric" min="1" max="180" value="${pomo.focus}" onchange="pomoSetting('focus', this.value)"></label>
        <label><span>Rest (minutes)</span><input id="pomoRest" type="number" inputmode="numeric" min="1" max="60" value="${pomo.rest}" onchange="pomoSetting('rest', this.value)"></label>
      </div>
      <button class="btn" style="width:100%;margin-top:6px;" onclick="pomoStart()">Start focus</button>`;
  }
  return `<div class="card pomo-card"><h3>Pomodoro Timer</h3>${body}</div>` + pomoLogHtml();
}

function pomoInit(){
  setTimeout(pomoSetupNotifActions, 0);   // after notifications.js has loaded
  setInterval(pomoTick, 500);
  document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) pomoTick(); });
  if(pomo.phase==='ring'){
    pomoShowBanner();
    if(Date.now() - pomo.ringAt < POMO_RING_MS){ pomoPrimeAudio(); pomoStartAlarm(); }
  }
  pomoTick();
}
pomoInit();
