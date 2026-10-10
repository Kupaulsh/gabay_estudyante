/* =========================================================
   APP STATE
========================================================= */
let DATA = {};              // { pccm: {...}, tup: {...} } — populated on demand from Supabase
let currentSchool = null;   // 'pccm' | 'tup'
let currentPage = 'hub';
let calCursor = new Date();

function S(){ return DATA[currentSchool]; }

/* ---- Safety helpers ----
   Everything admins type is untrusted text once it reaches innerHTML.
   esc() makes text safe for HTML bodies and attribute values;
   safeUrl() only lets http(s)/mailto links through (blocks javascript: etc.)
   and returns an already-escaped string, so don't wrap it in esc() again. */
function esc(s){
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function safeUrl(u){
  const s = String(u ?? '').trim();
  try{
    const parsed = new URL(s);
    if(['http:','https:','mailto:'].includes(parsed.protocol)) return esc(s);
  }catch(e){}
  return '#';
}

/* ---- Re-render the current page without jumping to the top ---- */
function rerender(){
  const r = {hub:renderHub, calendar:renderCalendar, schedule:renderSchedule,
    activities:renderActivities, reviewers:renderReviewers, howto:renderHowTo, rules:renderRules};
  (r[currentPage] || renderHub)();
}

/* ---- Types & colors ----
   Calendar entries and activities both have a "type". Built-ins are fixed;
   admins can add custom ones (stored in the item_types table) and pick a color. */
const DEFAULT_TYPE_COLOR = '#6B7280';
const BUILTIN_TYPES = {
  // One shared list for Activities and the Calendar (calendar entries use the activity types and colors)
  activity: [
    {key:'Assignment', label:'Assignment', color:'#2E9E5B', builtin:true},  // green
    {key:'Activity',   label:'Activity',   color:'#D64545', builtin:true},  // red
    {key:'Project',    label:'Project',    color:'#F08A24', builtin:true}   // orange
  ]
};
function safeColor(c){ return /^#[0-9a-fA-F]{6}$/.test(c || '') ? c : DEFAULT_TYPE_COLOR; }
function typeList(kind){      // `kind` is kept for older callers; there is just one list now
  const t = (S() && S().types) || {};
  const custom = (t.activity || []).slice();
  // custom calendar-only types made before the lists were merged are kept too
  (t.event || []).forEach(x=>{
    if(!custom.some(c=>c.key===x.key) && !BUILTIN_TYPES.activity.some(c=>c.key===x.key)) custom.push(x);
  });
  return BUILTIN_TYPES.activity.concat(custom);
}
function typeInfo(kind, key){
  return typeList(kind).find(t=>t.key===key) || {key, label:key || 'Other', color:DEFAULT_TYPE_COLOR};
}
// Lighten (amt > 0) or darken (amt < 0) a #rrggbb color
function shade(hex, amt){
  const n = parseInt(safeColor(hex).slice(1), 16);
  let r = (n>>16)&255, g = (n>>8)&255, b = n&255;
  const target = amt < 0 ? 0 : 255, p = Math.abs(amt);
  r = Math.round((target-r)*p + r); g = Math.round((target-g)*p + g); b = Math.round((target-b)*p + b);
  return '#' + [r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('');
}
function tagStyle(color){
  const c = safeColor(color);
  return `background:${c}26;color:${shade(c,-0.4)};`;
}
function typeOptionsHtml(kind, selectedKey){
  let html = typeList(kind).map(t=>`<option value="${esc(t.key)}" ${t.key===selectedKey?'selected':''}>${esc(t.label)}</option>`).join('');
  if(selectedKey && !typeList(kind).some(t=>t.key===selectedKey)){
    html += `<option value="${esc(selectedKey)}" selected>${esc(selectedKey)}</option>`;
  }
  return html;
}

/* ---- Type manager (admin): add custom types, pick colors, remove ---- */
function openTypeManager(kind){
  kind = 'activity';
  const title = 'Types';
  const rows = typeList(kind).map(t=>`<div class="type-row">
      ${t.builtin
        ? `<span class="type-swatch" style="background:${safeColor(t.color)}"></span>`
        : `<input type="color" class="type-color" value="${safeColor(t.color)}" onchange="adminSetTypeColor('${t.id}','${kind}',this.value)" aria-label="Color">`}
      <span class="type-name">${esc(t.label)}</span>
      ${t.builtin
        ? `<span class="type-note">Built-in</span>`
        : `<button class="btn sm danger" onclick="adminDeleteType('${t.id}','${kind}')">Remove</button>`}
    </div>`).join('');
  openModal(`<h3>${title}</h3>
    <p class="modal-sub">Used for both the Calendar and Activities. Pick a color for each type; built-in types can't be removed.</p>
    <div class="type-list">${rows}</div>
    <div class="section-label">Add a type</div>
    <div class="type-add">
      <input id="ty_name" placeholder="e.g. Exam, Holiday" maxlength="30">
      <input id="ty_color" type="color" value="#7C5CBF" aria-label="Color">
      <button class="btn" onclick="adminAddType('${kind}')">Add</button>
    </div>`);
}
async function adminAddType(kind){
  const name = document.getElementById('ty_name').value.trim();
  const color = document.getElementById('ty_color').value;
  if(!name){ alert('Give the type a name.'); return; }
  const clash = typeList(kind).some(t=>t.label.toLowerCase()===name.toLowerCase() || String(t.key).toLowerCase()===name.toLowerCase());
  if(clash){ alert('A type with that name already exists.'); return; }
  const ok = await dbAddType(currentSchool, kind, name, color);
  if(!ok) return;
  await refreshCurrentSchool();
  rerender();
  openTypeManager(kind);
}
async function adminSetTypeColor(id, kind, color){
  await dbUpdateType(id, {color});
  await refreshCurrentSchool();
  rerender();
}
async function adminDeleteType(id, kind){
  if(!confirm('Remove this type? Items already using it will show in gray.')) return;
  await dbDeleteType(id);
  await refreshCurrentSchool();
  rerender();
  openTypeManager(kind);
}

/* ---- Tag chip editor (used by the activity forms) ---- */
let tagDraft = [];
function tagEditorHtml(prefix){
  return `<div class="tag-editor" onclick="document.getElementById('${prefix}_input').focus()">
    <div class="tag-chips" id="${prefix}_chips"></div>
    <input id="${prefix}_input" placeholder="Add a tag, press Enter" onkeydown="tagKey(event,'${prefix}')" onblur="tagCommit('${prefix}')">
  </div>`;
}
function renderTagChips(prefix){
  const el = document.getElementById(prefix+'_chips');
  if(!el) return;
  el.innerHTML = tagDraft.map((t,i)=>`<span class="tag">#${esc(t)}<button type="button" class="chip-x" onclick="event.stopPropagation();tagRemove('${prefix}',${i})" aria-label="Remove tag">×</button></span>`).join('');
}
function tagCommit(prefix){
  const input = document.getElementById(prefix+'_input');
  if(!input) return;
  const v = input.value.replace(/^#+/, '').replace(/,/g, '').trim();
  if(!v) return;               // nothing typed: don't re-render (keeps the × buttons clickable)
  input.value = '';
  if(!tagDraft.includes(v)) tagDraft.push(v);
  renderTagChips(prefix);
}
function tagKey(e, prefix){
  if(e.key==='Enter' || e.key===','){ e.preventDefault(); tagCommit(prefix); }
  else if(e.key==='Backspace' && !e.target.value && tagDraft.length){ tagDraft.pop(); renderTagChips(prefix); }
}
function tagRemove(prefix, i){ tagDraft.splice(i,1); renderTagChips(prefix); }
function tagValues(prefix){ tagCommit(prefix); return tagDraft.slice(); }

/* =========================================================
   NAVIGATION / SHELL
========================================================= */
function logoFallback(img, name){
  if(!img.dataset.triedJpg){
    img.dataset.triedJpg = '1';
    img.src = name.toLowerCase() + '-logo.jpg';
  } else {
    const badge = document.createElement('div');
    badge.className = 'badge';
    badge.textContent = name;
    img.replaceWith(badge);
  }
}

function setSchoolDotLogo(school){
  const dot = document.getElementById('topSchoolDot');
  dot.style.background = 'transparent';
  dot.innerHTML = '';
  const img = document.createElement('img');
  img.alt = school.toUpperCase() + ' logo';
  img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:inherit;';
  img.src = school + '-logo.png';
  img.onerror = function(){
    if(!img.dataset.triedJpg){
      img.dataset.triedJpg = '1';
      img.src = school + '-logo.jpg';
    } else {
      dot.style.background = 'var(--accent)';
      dot.textContent = school.toUpperCase();
    }
  };
  dot.appendChild(img);
}

function applyTheme(school){
  const d = DATA[school];
  if(!d) return;
  document.documentElement.style.setProperty('--accent', d.accentColor || '#2F6F5E');
  document.documentElement.style.setProperty('--bg', d.bgColor || '#F6F5F0');
}
function resetTheme(){
  document.documentElement.style.removeProperty('--accent');
  document.documentElement.style.removeProperty('--bg');
}

/* ---- Landing page: one card per school ---- */
function parseSchoolName(full){
  const i = String(full||'').indexOf(' · ');
  return i<0 ? {short:String(full||''), desc:''} : {short:full.slice(0,i), desc:full.slice(i+3)};
}
function renderLanding(){
  const grid = document.getElementById('schoolGrid');
  if(!grid) return;
  grid.innerHTML = (SCHOOLS||[]).map(sc=>{
    const n = parseSchoolName(sc.full_name);
    return `<div class="school-card" onclick="enterApp('${esc(sc.id)}')">
      <img class="logo" src="${esc(sc.id)}-logo.png" alt="${esc(n.short)} logo" onerror="logoFallback(this,'${esc(String(sc.id).toUpperCase().slice(0,4))}')">
      <h3>${esc(n.short)}</h3>
      <p>${esc(n.desc)}</p>
    </div>`;
  }).join('');
}
async function initLanding(){
  renderLanding();
  await loadSchools();
  renderLanding();
}

/* ---- Small toast message ---- */
let toastTimer = null;
function showToast(msg, ms){
  const el = document.getElementById('toast');
  if(!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>el.classList.remove('show'), ms || 2600);
}
function showSyncStatus(){ showToast(syncLabel(), 3200); }

/* ---- Top bar ---- */
function updateTopbar(){
  const d = S();
  if(!d) return;
  document.getElementById('topSchoolName').textContent = d.fullName;
  const sem = (d.semesters||[]).find(x=>x.id===d.semesterId);
  document.getElementById('topSemester').textContent = sem ? sem.name : '';
  syncTopbarSpacer();
}
function showChrome(on){
  document.getElementById('bottomNav').style.display = on ? 'flex' : 'none';
  document.getElementById('editBtn').style.display = on ? 'flex' : 'none';
}

async function enterApp(school){
  currentSchool = school;
  document.getElementById('landing').style.display='none';
  document.getElementById('app').classList.add('active');
  document.body.classList.add('in-app');
  setSchoolDotLogo(school);
  document.getElementById('topSchoolName').textContent = 'Loading…';
  document.getElementById('topSemester').textContent = '';
  setPageContent(`<p style="color:var(--ink-soft);">Loading ${esc(school.toUpperCase())}…</p>`);

  DATA[school] = await loadSchoolData(school);

  applyTheme(school);
  updateTopbar();
  buildBottomNav();
  showChrome(true);
  updateEditButton();
  if(S().offlineEmpty){
    currentPage = 'hub';
    setPageContent(`<div class="card"><h3>You're offline</h3>
      <p style="color:var(--ink-soft);">${esc(S().fullName)} hasn't been downloaded to this device yet. Connect to the internet once and it will be saved for offline use.</p></div>`);
    syncTopbarSpacer();
    return;
  }
  goPage('hub');
  syncTopbarSpacer();
  await initNotifications();
  scheduleAllNotifications();
}
function syncTopbarSpacer(){
  const topbar = document.querySelector('.topbar');
  const app = document.getElementById('app');
  if(!topbar || !app) return;
  requestAnimationFrame(()=>{
    app.style.paddingTop = topbar.offsetHeight + 'px';
    document.documentElement.style.setProperty('--topbar-h', topbar.offsetHeight + 'px');
  });
}
window.addEventListener('resize', syncTopbarSpacer);
async function refreshCurrentSchool(){
  if(!currentSchool) return;
  DATA[currentSchool] = await loadSchoolData(currentSchool);
  applyTheme(currentSchool);
  updateTopbar();
  scheduleAllNotifications();
}
// Called when the connection comes back: pull the newest data quietly
async function afterReconnect(){
  if(!currentSchool) { loadSchools().then(renderLanding); return; }
  await refreshCurrentSchool();
  if(!document.getElementById('modalScrim').classList.contains('show')) rerender();
}
function goLanding(){
  document.getElementById('app').classList.remove('active');
  document.body.classList.remove('in-app');
  document.getElementById('landing').style.display='flex';
  showChrome(false);
  currentSchool = null;
  resetTheme();
  closeModal();
  renderLanding();
}

/* =========================================================
   ACCOUNT  (bottom menu → Account)
   Switch / add school, switch / add semester, sign out
========================================================= */
function slugify(t){ return String(t||'').toLowerCase().replace(/[^a-z0-9]+/g,''); }

function openAccount(){
  const email = (typeof signedInEmail === 'string') ? signedInEmail : '';
  const d = S();
  const canManage = isSignedInAdmin;
  const n = PENDING.length;

  const who = email
    ? `<p class="acct-who">Signed in as <b>${esc(email)}</b>${isSignedInAdmin ? ' · admin' : ' · not on the admin list'}</p>`
    : `<p class="acct-who">You're browsing without an account. Sign in once with Google to edit — the app remembers you after that.</p>
       <button class="btn" style="width:100%;" onclick="closeModal();openSignInModal()">Sign in with Google</button>`;

  const schools = (SCHOOLS||[]).map(sc=>{
    const nm = parseSchoolName(sc.full_name);
    const cur = sc.id===currentSchool;
    return `<button class="pick-row ${cur?'current':''}" onclick="${cur?'closeModal()':`switchSchool('${esc(sc.id)}')`}">
      <span>${esc(nm.short)}<small>${esc(nm.desc)}</small></span>${cur?'<span class="pick-check">✓</span>':''}</button>`;
  }).join('');

  const sems = (d.semesters||[]);
  const semList = sems.length
    ? sems.map(sm=>{
        const cur = sm.id===d.semesterId;
        return `<button class="pick-row ${cur?'current':''}" onclick="${cur?'closeModal()':`switchSemester('${esc(sm.id)}')`}">
          <span>${esc(sm.name)}</span>${cur?'<span class="pick-check">✓</span>':''}</button>`;
      }).join('')
    : `<p class="modal-sub" style="margin:0 0 10px;">${d.semestersOk ? 'No semesters yet.' : 'Semesters need a one-time database update (run migration_semesters.sql in Supabase).'}</p>`;

  const addSchool = canManage ? `
    <div class="acct-add" id="addSchoolBox" style="display:none;">
      <input id="ns_short" placeholder="School name or short name (e.g. ADMU)" maxlength="30">
      <input id="ns_desc" placeholder="Course / program (e.g. BS Computer Science)" maxlength="80">
      <div class="row"><button class="btn" style="flex:1;" onclick="adminAddSchool()">Add school</button>
        <button class="btn ghost" onclick="toggleAcctBox('addSchoolBox','ns_short')">Cancel</button></div>
    </div>
    <button class="btn ghost sm" id="addSchoolBtn" onclick="toggleAcctBox('addSchoolBox','ns_short')">+ Add school</button>` : '';

  const addSem = (canManage && d.semestersOk) ? `
    <div class="acct-add" id="addSemBox" style="display:none;">
      <div class="row"><input id="ns_sem" placeholder="e.g. Semester 2" maxlength="30" onkeydown="if(event.key==='Enter'){event.preventDefault();adminAddSemester();}">
        <button class="btn" onclick="adminAddSemester()">Add</button></div>
      ${sems.length ? '' : '<p class="modal-sub" style="margin:0;">Everything you have now will be labelled <b>Semester 1</b>.</p>'}
    </div>
    <button class="btn ghost sm" id="addSemBtn" onclick="toggleAcctBox('addSemBox','ns_sem')">+ Add semester</button>` : '';

  const sync = n
    ? `<div class="modal-section"><div class="modal-section-title">Sync</div>
        <p class="acct-sync">${n} change${n===1?'':'s'} saved on this device, waiting to sync.</p>
        <button class="btn ghost sm" onclick="if(confirm('Throw away the changes that have not synced yet?')){discardPending();refreshCurrentSchool().then(()=>{closeModal();rerender();});}">Discard unsynced changes</button></div>`
    : '';

  openModal(`<h3>Account</h3>
    <div class="modal-section">${who}</div>
    <div class="modal-section"><div class="modal-section-title">School</div>
      <div class="pick-list">${schools}</div>${addSchool}</div>
    <div class="modal-section"><div class="modal-section-title">Semester</div>
      <div class="pick-list">${semList}</div>${addSem}</div>
    ${sync}
    ${email ? `<div class="modal-actions"><button class="btn danger" onclick="signOutAdmin()">Sign out</button></div>` : ''}`);
}
function toggleAcctBox(boxId, focusId){
  const box = document.getElementById(boxId);
  const btn = document.getElementById(boxId==='addSchoolBox' ? 'addSchoolBtn' : 'addSemBtn');
  const show = box.style.display==='none';
  box.style.display = show ? 'grid' : 'none';
  if(btn) btn.style.display = show ? 'none' : '';
  if(show) document.getElementById(focusId).focus();
}
async function switchSchool(id){
  closeModal();
  await enterApp(id);
}
function switchSemester(id){
  DATA[currentSchool] = reshapeForSemester(currentSchool, id);
  updateTopbar();
  closeModal();
  rerender();
  scheduleAllNotifications();
  showToast('Switched to ' + ((S().semesters||[]).find(x=>x.id===id)||{}).name);
}
async function adminAddSchool(){
  const short = document.getElementById('ns_short').value.trim();
  const desc = document.getElementById('ns_desc').value.trim();
  if(!short){ alert('Enter the school name.'); return; }
  const id = slugify(short);
  if(!id){ alert('Use letters or numbers in the school name.'); return; }
  if((SCHOOLS||[]).some(sc=>sc.id===id)){ alert('That school already exists.'); return; }
  const full = desc ? `${short} · ${desc}` : short;
  const ok = await dbAddSchool(id, full);
  if(!ok) return;
  // Give the new school a first semester right away when semesters are available
  if(S().semestersOk) await mutate('semesters', 'insert', {row:{school_id:id, name:'Semester 1'}});
  await loadSchools();   // online: fetched; offline: cached list + the queued new school
  closeModal();
  await enterApp(id);
  showToast('Added ' + short);
}
async function adminAddSemester(){
  const name = document.getElementById('ns_sem').value.trim();
  if(!name){ alert('Give the semester a name.'); return; }
  const sems = S().semesters || [];
  const taken = sems.map(x=>x.name.toLowerCase());
  if(!sems.length) taken.push('semester 1');
  if(taken.includes(name.toLowerCase())){ alert('A semester with that name already exists.'); return; }
  const newId = await dbAddSemester(currentSchool, name, sems.length>0);
  if(!newId) return;
  rememberSemester(currentSchool, newId);
  await refreshCurrentSchool();
  closeModal();
  rerender();
  showToast('Now in ' + name);
}

const PAGES = [
  {id:'calendar', label:'Calendar', title:'Calendar', sub:'Tap a date to see events, due dates, and projects.',
    icon:'<path d="M7 2v2M17 2v2M3 8h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" fill="none" stroke="currentColor" stroke-width="1.8"/>'},
  {id:'schedule', label:'Schedule', title:'Schedule', sub:'Your full class list — tap a class for its syllabus and materials.',
    icon:'<path d="M4 4h16v16H4z M4 9h16 M9 4v16" fill="none" stroke="currentColor" stroke-width="1.8"/>'},
  {id:'activities', label:'Activities', title:'Activities', sub:'Assignments, activities, and projects across subjects.',
    icon:'<path d="M9 11l3 3L22 4 M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" fill="none" stroke="currentColor" stroke-width="1.8"/>'},
  {id:'reviewers', label:'Reviewers', title:'Reviewers', sub:'Flashcards, mock quizzes, and readable PDFs per subject.',
    icon:'<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" fill="none" stroke="currentColor" stroke-width="1.8"/>'},
  {id:'howto', label:'How-To', title:'How-To', sub:'Frequently asked questions.',
    icon:'<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.5-2 1.7-2 3.3M12 17h.01" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'},
  {id:'rules', label:'Rules & Others', title:'Rules and Others', sub:'Vision, mission, core values, guidelines, and anything else you add.',
    icon:'<path d="M12 2 3 6v6c0 5 4 8.5 9 10 5-1.5 9-5 9-10V6z" fill="none" stroke="currentColor" stroke-width="1.8"/>'}
];

const HUB_META = {title:'Menu', sub:'Choose where you want to go.'};

function buildBottomNav(){
  const nav = document.getElementById('bottomNav');
  nav.innerHTML = '';
  PAGES.forEach(p=>{
    const el = document.createElement('button');
    el.className = 'nav-btn';
    el.id = 'nav-' + p.id;
    el.setAttribute('aria-label', p.label);
    el.title = p.label;
    el.innerHTML = `<svg viewBox="0 0 24 24">${p.icon}</svg>`;
    el.onclick = ()=>goPage(p.id);
    nav.appendChild(el);
  });
  const acct = document.createElement('button');
  acct.className = 'nav-btn';
  acct.id = 'nav-account';
  acct.setAttribute('aria-label', 'Account');
  acct.title = 'Account';
  acct.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  acct.onclick = ()=>openAccount();
  nav.appendChild(acct);
  document.querySelectorAll('.nav-btn').forEach(el=>el.classList.toggle('active', el.id==='nav-'+currentPage));
}

function goPage(id){
  currentPage = id;
  document.querySelectorAll('.nav-btn').forEach(el=>el.classList.toggle('active', el.id==='nav-'+id));
  if(id==='hub'){ renderHub(); scrollPageTop(); return; }
  const renderers = {calendar:renderCalendar, schedule:renderSchedule,
    activities:renderActivities, reviewers:renderReviewers, howto:renderHowTo, rules:renderRules};
  renderers[id]();
  scrollPageTop();
}

function renderHub(){
  let html = `<div class="hub-list">`;
  PAGES.forEach(p=>{
    html += `<div class="hub-row" onclick="goPage('${p.id}')">
      <div class="hub-icon"><svg viewBox="0 0 24 24" style="width:22px;height:22px;fill:none;stroke:var(--ink);stroke-width:1.6">${p.icon}</svg></div>
      <div class="hub-text">
        <h4>${p.label}</h4>
        <p>${p.sub}</p>
      </div>
      <span class="hub-arrow">›</span>
    </div>`;
  });
  html += `</div>`;
  setPageContent(html);
}

/* =========================================================
   MODAL
========================================================= */
// The page lives in a fixed box between the top bar and the bottom menu; the box scrolls, not the screen
function scrollPageTop(){
  const m = document.getElementById('pageContent');
  if(m.scrollTo) m.scrollTo({top:0, behavior:'smooth'}); else m.scrollTop = 0;
}
function setPageContent(html){
  const box = document.getElementById('pageContent');
  box.classList.remove('fit');
  box.innerHTML = html;
  enforceAdminVisibility();
}
function enforceAdminVisibility(){
  if(!isAdmin){
    document.querySelectorAll('[data-admin-only]').forEach(el=>el.remove());
  }
  document.body.classList.toggle('is-admin', !!isAdmin);
}

function openModal(html, accentColor){
  const box = document.getElementById('modalBox');
  box.innerHTML = `<button class="modal-close" onclick="closeModal()">✕</button>${html}`;
  box.style.borderTop = accentColor ? `5px solid ${accentColor}` : '';
  document.getElementById('modalScrim').classList.add('show');
}
function closeModal(){ document.getElementById('modalScrim').classList.remove('show'); }

/* =========================================================
   CALENDAR
========================================================= */
function getUpcomingDue(limit){
  const today = todayISO();
  const items = [];
  S().events.forEach(e=>{
    if(e.date >= today){
      const subj = S().subjects.find(s=>s.id===e.subjectId);
      items.push({date:e.date, title:e.title, type:e.type, id:e.id, subj: subj?subj.name:'', done:isEventDone(e)});
    }
  });
  items.sort((a,b)=>a.date.localeCompare(b.date));
  const dates = [...new Set(items.map(i=>i.date))].slice(0, limit||8);
  return dates.map(d=>({date:d, items: items.filter(i=>i.date===d)}));
}
function daysFromToday(iso){
  const d1 = new Date(todayISO()+'T00:00'), d2 = new Date(iso+'T00:00');
  const diff = Math.round((d2-d1)/86400000);
  if(diff===0) return 'Today';
  if(diff===1) return 'Tomorrow';
  return `In ${diff} days`;
}

/* Done state.
   Calendar entries that were generated from an Activity share that activity's
   completed flag, so checking one place updates the other. Manual entries keep their own flag. */
function getDoneSet(){
  try{ return new Set(JSON.parse(localStorage.getItem('shDoneItems')||'[]')); }catch(e){ return new Set(); }
}
function isEventDone(e){
  return e.sourceActivityId ? getCompletedSet().has(e.sourceActivityId) : getDoneSet().has(e.id);
}
function toggleEventDone(id){
  const e = S().events.find(x=>x.id===id);
  if(!e) return;
  if(e.sourceActivityId){
    toggleCompletedFlag(e.sourceActivityId);
  } else {
    const done = getDoneSet();
    if(done.has(id)) done.delete(id); else done.add(id);
    localStorage.setItem('shDoneItems', JSON.stringify([...done]));
  }
}
function toggleDone(id){ toggleEventDone(id); renderCalendar(); }
function toggleDoneFromDay(id, iso){ toggleEventDone(id); renderCalendar(); openDay(iso); }

function openQuickAddEvent(){
  openModal(`<h3>Add to calendar</h3>
    <div class="form-grid">
      <input id="qa_ev_title" placeholder="Title">
      <div class="two-col">
        <input id="qa_ev_date" type="date" value="${todayISO()}">
        <select id="qa_ev_type">${typeOptionsHtml('activity','Assignment')}</select>
      </div>
      <select id="qa_ev_subject"><option value="">General (not tied to a subject)</option>${S().subjects.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
      <textarea id="qa_ev_desc" placeholder="Description / instructions" rows="3"></textarea>
    </div>
    <div class="modal-actions"><button class="btn" onclick="quickAddEvent()">Add to calendar</button></div>`);
}
async function quickAddEvent(){
  const title = document.getElementById('qa_ev_title').value.trim();
  if(!title){ alert('Title required.'); return; }
  await dbAddEvent(currentSchool, {
    title, date: document.getElementById('qa_ev_date').value,
    type: document.getElementById('qa_ev_type').value,
    subject_id: document.getElementById('qa_ev_subject').value || null,
    description: document.getElementById('qa_ev_desc').value
  });
  await refreshCurrentSchool();
  closeModal();
  renderCalendar();
}
const CHECK_SVG = '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function renderCalendar(){
  const y = calCursor.getFullYear(), m = calCursor.getMonth();
  const first = new Date(y,m,1);
  const startDow = first.getDay();
  const daysInMonth = new Date(y,m+1,0).getDate();
  const monthName = calCursor.toLocaleString('default',{month:'long'});
  let html = `<div class="cal-layout">
  <div class="card cal-card">
    <div class="cal-head">
      <button onclick="shiftMonth(-1)">‹</button>
      <h3>${monthName} ${y}</h3>
      <button onclick="shiftMonth(1)">›</button>
    </div>
    <div class="cal-grid">`;
  ['S','M','T','W','T','F','S'].forEach(d=> html += `<div class="cal-dow">${d}</div>`);
  for(let i=0;i<startDow;i++) html += `<div class="cal-cell empty"></div>`;
  const isThisMonth = todayISO().slice(0,7) === `${y}-${String(m+1).padStart(2,'0')}`;
  const todayNum = new Date().getDate();
  for(let d=1; d<=daysInMonth; d++){
    const iso = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const evs = S().events.filter(e=>e.date===iso);
    const types = [...new Set(evs.map(e=>e.type))];
    const allDone = evs.length>0 && evs.every(isEventDone);
    const dots = types.map(t=>`<i style="background:${safeColor(typeInfo('activity',t).color)}"></i>`).join('');
    const isToday = isThisMonth && d===todayNum;
    html += `<div class="cal-cell ${isToday?'today':''}" onclick="openDay('${iso}')">${d}<div class="cal-dots ${allDone?'is-done':''}">${dots}</div></div>`;
  }
  html += `</div></div>

  <div class="cal-sidebar">
    ${isAdmin?`<div class="cal-admin-row">
      <button class="btn-tag" onclick="openQuickAddEvent()">+ Add</button>
      <button class="btn-tag ghost" onclick="openTypeManager('activity')">🎨 Types</button>
    </div>`:''}
    <div class="card cal-upcoming-card">
    <div class="section-label" style="margin-top:0;">Coming Up</div>
    <div class="hub-list cal-upcoming-scroll">`;
  const groups = getUpcomingDue(8);
  if(groups.length===0){
    html += `<p style="color:var(--ink-soft);font-size:13px;">Nothing due soon.</p>`;
  } else {
    groups.forEach(g=>{
      html += `<div class="section-label" style="margin-top:14px;">${daysFromToday(g.date)} · ${esc(g.date)}</div>`;
      g.items.forEach((u,ui)=>{
        const info = typeInfo('activity', u.type);
        html += `<div class="hub-row upcoming-row ${u.done?'is-done':''} ${ui>0?'upcoming-divider':''}" style="border-left:4px solid ${safeColor(info.color)};">
          <div class="hub-text" onclick="openDay('${u.date}')" style="cursor:pointer;">
            <h4>${esc(u.title)}</h4>
            <p>${u.subj?esc(u.subj):'General'}</p>
          </div>
          <div class="upcoming-side">
            <span class="tag" style="${tagStyle(info.color)}margin:0;">${esc(info.label)}</span>
            <button class="check-btn ${u.done?'checked':''}" onclick="event.stopPropagation();toggleDone('${u.id}')" aria-label="Mark done">${CHECK_SVG}</button>
            ${isAdmin?`<div style="display:flex;gap:4px;">
              <button class="icon-btn" onclick="event.stopPropagation();adminEditEvent('${u.id}')" aria-label="Edit">✎</button>
              <button class="icon-btn danger" onclick="event.stopPropagation();quickDeleteEvent('${u.id}')" aria-label="Delete">✕</button>
            </div>`:''}
          </div>
        </div>`;
      });
    });
  }
  html += `</div>
  </div>
  </div>
  </div>`;
  setPageContent(html);
  document.getElementById('pageContent').classList.add('fit');   // calendar page never scrolls; only the Coming Up list does
}
async function quickDeleteEvent(id){
  if(!confirm('Delete this calendar entry?')) return;
  await dbDeleteEvent(id);
  await refreshCurrentSchool();
  renderCalendar();
}
function shiftMonth(n){ calCursor.setMonth(calCursor.getMonth()+n); renderCalendar(); }
function openDay(iso){
  const evs = S().events.filter(e=>e.date===iso);
  let html = `<h3>${new Date(iso+'T00:00').toDateString()}</h3>`;
  if(evs.length===0){ html += `<p style="color:var(--ink-soft);">No events on this date.</p>`; }
  evs.forEach(e=>{
    const subj = S().subjects.find(s=>s.id===e.subjectId);
    const info = typeInfo('activity', e.type);
    const done = isEventDone(e);
    html += `<div class="day-item ${done?'is-done':''}" style="--tcolor:${safeColor(info.color)};">
      <div class="day-item-top">
        <span class="tag" style="${tagStyle(info.color)}margin:0;">${esc(info.label)}</span>
        <div style="display:flex;gap:6px;align-items:center;">
          <button class="check-btn ${done?'checked':''}" onclick="toggleDoneFromDay('${e.id}','${iso}')" aria-label="Mark done">${CHECK_SVG}</button>
          ${isAdmin?`<button class="icon-btn" onclick="closeModal();adminEditEvent('${e.id}')" aria-label="Edit">✎</button>
          <button class="icon-btn danger" onclick="quickDeleteEventFromDay('${e.id}','${iso}')" aria-label="Delete">✕</button>`:''}
        </div>
      </div>
      <h4>${esc(e.title)}</h4>
      ${subj?`<p style="font-size:12px;">${esc(subj.name)}</p>`:''}
      <p>${nl2br(e.desc)}</p>
    </div>`;
  });
  openModal(html);
}
async function quickDeleteEventFromDay(id, iso){
  if(!confirm('Delete this calendar entry?')) return;
  await dbDeleteEvent(id);
  await refreshCurrentSchool();
  openDay(iso);
}

/* =========================================================
   SCHEDULE
========================================================= */
function parseTimeStart(timeStr){
  if(!timeStr) return 24*60+1; // no time set — sort to the end of the day
  const m = timeStr.match(/(\d{1,2}):(\d{2})/);
  if(!m) return 24*60+1;
  let hour = parseInt(m[1],10);
  const min = parseInt(m[2],10);
  const ampm = timeStr.match(/\b(AM|PM)\b/i);
  if(ampm){
    const p = ampm[1].toUpperCase();
    if(p==='PM' && hour<12) hour += 12;
    if(p==='AM' && hour===12) hour = 0;
  }
  return hour*60+min;
}
const ICON_CLOCK = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
const ICON_USER  = '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>';
const ICON_ROOM  = '<svg viewBox="0 0 24 24"><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>';
const DAY_NAMES = {Mon:'Monday',Tue:'Tuesday',Wed:'Wednesday',Thu:'Thursday',Fri:'Friday',Sat:'Saturday',Sun:'Sunday'};

function renderSchedule(){
  const order = {Mon:0,Tue:1,Wed:2,Thu:3,Fri:4,Sat:5,Sun:6};
  const rows = [];
  S().subjects.forEach(s=>{
    if(s.schedule.length===0){
      rows.push({subject:s, day:null, time:'', room:'', professor:''});
    } else {
      s.schedule.forEach(sl=> rows.push({subject:s, day:sl.day, time:sl.time, room:sl.room, professor:sl.professor}));
    }
  });
  rows.sort((a,b)=>{
    const dayDiff = (order[a.day]??9)-(order[b.day]??9);
    if(dayDiff!==0) return dayDiff;
    return parseTimeStart(a.time)-parseTimeStart(b.time);
  });
  let html = '';
  if(isAdmin){
    html += `<button class="btn" onclick="adminAddSubject()" style="margin-bottom:6px;">+ Add subject</button>`;
  }
  if(rows.length===0) html += `<p style="color:var(--ink-soft);">No schedule yet.</p>`;

  // Group the sorted rows by day
  const groups = [];
  rows.forEach(r=>{
    let g = groups[groups.length-1];
    if(!g || g.day !== r.day){ g = {day:r.day, items:[]}; groups.push(g); }
    g.items.push(r);
  });

  groups.forEach(g=>{
    const label = g.day ? (DAY_NAMES[g.day] || g.day) : 'Unscheduled';
    html += `<div class="sched-day"><span>${esc(label)}</span><small>${g.items.length} ${g.items.length===1?'class':'classes'}</small></div>
    <div class="sched-list">`;
    g.items.forEach(r=>{
      const s = r.subject;
      const clickAction = isAdmin ? `adminEditSubject('${s.id}')` : `openSubject('${s.id}')`;
      const nMat = s.materials.length, nSyl = s.syllabus.length, nBook = (s.books||[]).length;
      html += `<div class="sched-card" style="--subj:${safeColor(s.color)};" onclick="${clickAction}">
        <div class="sched-card-head">
          <div class="sched-title">
            <h4>${esc(s.name)}</h4>
            ${s.code?`<span class="sched-code">${esc(s.code)}</span>`:''}
          </div>
          ${isAdmin?`<button class="icon-btn danger" onclick="event.stopPropagation();quickDeleteSubject('${s.id}')" aria-label="Delete subject">✕</button>`:''}
        </div>
        <div class="sched-meta">
          <span class="sched-meta-item">${ICON_CLOCK}${esc(r.time||'TBA')}</span>
          <span class="sched-meta-item">${ICON_USER}${esc(r.professor||'Professor TBA')}</span>
          <span class="sched-meta-item">${ICON_ROOM}Room ${esc(r.room||'TBA')}</span>
        </div>
        <div class="sched-chips">
          <span class="sched-chip">${nMat} material${nMat!==1?'s':''}</span>
          <span class="sched-chip">${nSyl} syllabus</span>
          <span class="sched-chip">${nBook} book${nBook!==1?'s':''}</span>
        </div>
      </div>`;
    });
    html += `</div>`;
  });
  setPageContent(html);
}
async function quickDeleteSubject(id){
  if(!confirm('Delete this subject and all its schedule, syllabus, materials, flashcards, and quiz content?')) return;
  await dbDeleteSubject(id);
  await refreshCurrentSchool();
  renderSchedule();
}

/* =========================================================
   SUBJECTS
========================================================= */
function renderSubjects(){
  let html = `<div class="hub-list">`;
  S().subjects.forEach(s=>{
    html += `<div class="hub-row" onclick="openSubject('${s.id}')">
      <div class="chip" style="background:${esc(s.color)}">${esc(s.code.slice(0,4))}</div>
      <div class="hub-text">
        <h4>${esc(s.name)}</h4>
        <p>${s.materials.length} material${s.materials.length!==1?'s':''} · ${s.syllabus.length} syllabus file${s.syllabus.length!==1?'s':''}</p>
      </div>
      <span class="hub-arrow">›</span>
    </div>`;
  });
  html += `</div>`;
  setPageContent(html);
}
function openSubject(id){
  const s = S().subjects.find(x=>x.id===id);
  let html = `<h3>${esc(s.name)}</h3>`;
  if(s.schedule.length===0){
    html += `<p style="color:var(--ink-soft);font-size:13px;">No schedule set yet.</p>`;
  } else {
    s.schedule.forEach(sl=>{
      html += `<p style="color:var(--ink-soft);font-size:13px;margin:0 0 4px;">${esc(sl.day||'')} · ${esc(sl.time||'TBA')} · ${esc(sl.professor||'Professor TBA')} · Room ${esc(sl.room||'TBA')}</p>`;
    });
  }
  html += `<div class="section-label">Syllabus</div>`;
  if(s.syllabus.length===0) html += `<p style="font-size:13px;color:var(--ink-soft);">No syllabus uploaded yet.</p>`;
  s.syllabus.forEach(f=> html += fileRow(f));
  html += `<div class="section-label">Materials</div>`;
  if(s.materials.length===0) html += `<p style="font-size:13px;color:var(--ink-soft);">No materials uploaded yet.</p>`;
  s.materials.forEach(f=> html += fileRow(f));
  html += `<div class="section-label">PDF Books</div>`;
  if(!s.books || s.books.length===0) html += `<p style="font-size:13px;color:var(--ink-soft);">No books added yet.</p>`;
  (s.books||[]).forEach(b=> html += fileRow({label: b.label + (b.author?` — ${b.author}`:''), type:'BOOK', url:b.url}));
  openModal(html, s.color);
}
function fileRow(f, subLabel){
  return `<a class="file-row" href="${safeUrl(f.url)}" target="_blank" rel="noopener">
    <div class="ficon">${esc((f.type||'FILE').slice(0,3).toUpperCase())}</div>
    <div class="file-row-text">
      <div class="file-row-title">${esc(f.label)}</div>
      ${subLabel?`<div class="file-row-sub">${esc(subLabel)}</div>`:''}
    </div>
  </a>`;
}

/* =========================================================
   ACTIVITIES
========================================================= */
let actSort = 'general';
let showCompleted = false;
function getCompletedSet(){
  try{ return new Set(JSON.parse(localStorage.getItem('shCompletedActivities')||'[]')); }catch(e){ return new Set(); }
}
// Flip an activity's completed flag. Calendar entries generated from it read this same flag.
function toggleCompletedFlag(id){
  const done = getCompletedSet();
  if(done.has(id)) done.delete(id); else done.add(id);
  localStorage.setItem('shCompletedActivities', JSON.stringify([...done]));
  scheduleAllNotifications();   // completed work shouldn't keep sending due reminders
}
function toggleActivityDone(id){
  toggleCompletedFlag(id);
  renderActivities();
}
function toggleShowCompleted(){ showCompleted = !showCompleted; renderActivities(); }
async function quickDeleteActivity(id){
  if(!confirm('Delete this activity?')) return;
  await dbDeleteActivity(id);
  await refreshCurrentSchool();
  renderActivities();
}
// Admin: remove one hashtag straight from an activity card
async function adminRemoveActivityTag(id, index){
  const a = S().activities.find(x=>x.id===id);
  if(!a) return;
  const tags = (a.tags||[]).slice();
  tags.splice(index, 1);
  await dbUpdateActivity(id, {tags});
  await refreshCurrentSchool();
  renderActivities();
}

const ICON_BOOK = '<svg viewBox="0 0 24 24"><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5zM4 19.5A2.5 2.5 0 0 1 6.5 17H20"/></svg>';
const ICON_CAL = '<svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="16.5" rx="3"/><path d="M8 2.5v4M16 2.5v4M3 10h18"/></svg>';

// "Today", "Tomorrow", "In 3 days", "2 days overdue"
function dueInfo(iso){
  if(!iso) return {text:'No due date', cls:''};
  const diff = Math.round((new Date(iso+'T00:00') - new Date(todayISO()+'T00:00'))/86400000);
  const nice = new Date(iso+'T00:00').toLocaleDateString('default',{month:'short', day:'numeric'});
  if(diff<0)  return {text:`${nice} · ${-diff} day${diff===-1?'':'s'} overdue`, cls:'is-late'};
  if(diff===0) return {text:`${nice} · Due today`, cls:'is-soon'};
  if(diff===1) return {text:`${nice} · Tomorrow`, cls:'is-soon'};
  return {text:`${nice} · In ${diff} days`, cls:''};
}

function activityCard(a, isDone){
  const subj = S().subjects.find(s=>s.id===a.subjectId);
  const color = subj ? safeColor(subj.color) : '#B9B5A8';
  const info = typeInfo('activity', a.type);
  const due = dueInfo(a.due);
  const tags = (a.tags||[]).map((t,i)=>`<span class="tag">#${esc(t)}${isAdmin?`<button type="button" class="chip-x" onclick="event.stopPropagation();adminRemoveActivityTag('${a.id}',${i})" aria-label="Remove tag">×</button>`:''}</span>`).join('');
  const instr = (a.instructions||'').trim();
  return `<div class="act-card ${isDone?'is-done':''}" style="--subj:${color};" onclick="openActivity('${a.id}')">
    ${a.image?`<img class="act-img" src="${safeUrl(a.image)}" alt="">`:''}
    <div class="act-card-head">
      <div class="act-title">
        <span class="act-type" style="${tagStyle(info.color)}">${esc(info.label)}</span>
        <h4>${esc(a.title)}</h4>
      </div>
      <button class="check-btn lg ${isDone?'checked':''}" onclick="event.stopPropagation();toggleActivityDone('${a.id}')" aria-label="Mark completed">${CHECK_SVG}</button>
    </div>
    <div class="sched-meta">
      <span class="sched-meta-item">${ICON_BOOK}${esc(subj?subj.name:'General')}</span>
      <span class="sched-meta-item act-due ${isDone?'':due.cls}">${ICON_CAL}${esc(due.text)}</span>
    </div>
    ${instr?`<p class="act-note">${esc(instr)}</p>`:''}
    ${tags?`<div class="sched-chips">${tags}</div>`:''}
    ${isAdmin?`<div class="act-card-admin">
      <button class="icon-btn" onclick="event.stopPropagation();adminEditActivity('${a.id}')" aria-label="Edit">✎</button>
      <button class="icon-btn danger" onclick="event.stopPropagation();quickDeleteActivity('${a.id}')" aria-label="Delete">✕</button>
    </div>`:''}
  </div>`;
}
// A heading like the Schedule page's day headings, followed by that group's cards
function actGroup(label, items, done, dotColor){
  const dot = dotColor ? `<i class="type-dot" style="background:${safeColor(dotColor)}"></i>` : '';
  return `<div class="sched-day"><span>${dot}${esc(label)}</span><small>${items.length} ${items.length===1?'item':'items'}</small></div>
    <div class="sched-list">${items.map(a=>activityCard(a, done)).join('')}</div>`;
}

/* ---- Type dropdown with a "new type" box right beside it (half and half) ---- */
const TYPE_PALETTE = ['#7C5CBF','#2A7DE1','#E0559B','#14A3A3','#8A6D3B','#5B6B7A','#B5483A','#3E8E41'];
function nextTypeColor(kind){
  const custom = ((S().types||{})[kind]||[]).length;
  return TYPE_PALETTE[custom % TYPE_PALETTE.length];
}
function typeFieldHtml(kind, id, selectedKey){
  return `<div class="type-inline">
    <select id="${id}" aria-label="Type">${typeOptionsHtml(kind, selectedKey)}</select>
    <div class="type-inline-add">
      <input id="${id}_new" type="text" placeholder="New type" maxlength="30" aria-label="New type name"
        onkeydown="if(event.key==='Enter'){event.preventDefault();inlineAddType('${kind}','${id}');}">
      <input id="${id}_color" type="color" value="${nextTypeColor(kind)}" aria-label="Color for the new type">
      <button type="button" class="btn" onclick="inlineAddType('${kind}','${id}')" aria-label="Add this type">+</button>
    </div>
  </div>`;
}
async function inlineAddType(kind, selId){
  const input = document.getElementById(selId + '_new');
  const name = input.value.trim();
  if(!name){ input.focus(); return; }
  const sel = document.getElementById(selId);
  const existing = typeList(kind).find(t=>t.label.toLowerCase()===name.toLowerCase() || String(t.key).toLowerCase()===name.toLowerCase());
  if(existing){ sel.value = existing.key; input.value = ''; showToast('That type already exists — selected it.'); return; }
  const ok = await dbAddType(currentSchool, kind, name, document.getElementById(selId + '_color').value);
  if(!ok) return;
  await refreshCurrentSchool();
  sel.innerHTML = typeOptionsHtml(kind, name);      // the fresh list, with the new type selected
  input.value = '';
  document.getElementById(selId + '_color').value = nextTypeColor(kind);
  rerender();
  showToast('Added type "' + name + '"');
}

let quickAddCount = 0;
function openQuickAddActivity(){
  tagDraft = [];
  quickAddCount = 0;
  openModal(`<h3>Add activity</h3>
    <div class="modal-notice" id="qa_ac_notice" style="display:none;"></div>
    <div class="form-grid">
      <input id="qa_ac_title" placeholder="Title">
      <select id="qa_ac_subject"><option value="">General (not tied to a subject)</option>${S().subjects.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
      ${typeFieldHtml('activity','qa_ac_type','Assignment')}
      <div class="two-col dates">
        <div><label>Start</label><input id="qa_ac_start" type="date" value="${todayISO()}"></div>
        <div><label>Due</label><input id="qa_ac_due" type="date" value="${todayISO()}"></div>
      </div>
      <textarea id="qa_ac_instr" placeholder="Instructions" rows="3"></textarea>
      <div><label>Tags</label>${tagEditorHtml('qa_ac_tags')}</div>
      <input id="qa_ac_img" placeholder="Image URL (optional — direct image link)">
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="quickAddActivity()">Add activity</button>
      <button class="btn ghost" onclick="closeModal()">Done</button>
    </div>`);
}
// Saves the activity and keeps the box open, cleared and ready for the next one
async function quickAddActivity(){
  const titleEl = document.getElementById('qa_ac_title');
  const title = titleEl.value.trim();
  if(!title){ alert('Title required.'); titleEl.focus(); return; }
  const subjectId = document.getElementById('qa_ac_subject').value || null;
  const type = document.getElementById('qa_ac_type').value;
  const start = document.getElementById('qa_ac_start').value;
  const due = document.getElementById('qa_ac_due').value;
  const instructions = document.getElementById('qa_ac_instr').value;
  const tags = tagValues('qa_ac_tags');
  const newId = await dbAddActivity(currentSchool, {
    title, subject_id: subjectId, type, start_date: start, due_date: due,
    instructions, tags,
    image_url: document.getElementById('qa_ac_img').value.trim()
  });
  if(!newId) return;     // an error was already shown; keep what was typed
  await dbSyncActivityCalendarEvents(currentSchool, newId, subjectId, title, type, start, due, instructions);
  await refreshCurrentSchool();
  rerender();            // the Activities page behind the box updates right away

  // Clear the boxes (subject and type stay, since batches usually share them)
  quickAddCount++;
  titleEl.value = '';
  document.getElementById('qa_ac_instr').value = '';
  document.getElementById('qa_ac_img').value = '';
  document.getElementById('qa_ac_start').value = todayISO();
  document.getElementById('qa_ac_due').value = todayISO();
  tagDraft = [];
  renderTagChips('qa_ac_tags');
  const note = document.getElementById('qa_ac_notice');
  note.style.display = '';
  note.textContent = `✓ Saved “${title}”` + (quickAddCount>1 ? ` · ${quickAddCount} added` : '') + ' — add the next one, or tap Done.';
  titleEl.focus();
}

function renderActivities(){
  const completed = getCompletedSet();
  const acts = S().activities.filter(a=>!completed.has(a.id));
  const doneActs = S().activities.filter(a=>completed.has(a.id));

  let html = `<div class="filter-row" style="justify-content:space-between;">
    <div style="display:flex;align-items:center;gap:10px;">
      <label>Sort by</label>
      <select onchange="actSort=this.value;renderActivities()">
        <option value="general" ${actSort==='general'?'selected':''}>General</option>
        <option value="due" ${actSort==='due'?'selected':''}>Due date</option>
        <option value="subject" ${actSort==='subject'?'selected':''}>Subject</option>
        <option value="type" ${actSort==='type'?'selected':''}>Type</option>
      </select>
    </div>
    ${isAdmin?`<div class="act-admin-row">
      <button class="btn-tag" onclick="openQuickAddActivity()">+ Add</button>
      <button class="btn-tag ghost" onclick="openTypeManager('activity')">🎨 Types</button>
    </div>`:''}
  </div>`;

  if(acts.length===0){
    html += `<p style="color:var(--ink-soft);">No activities yet.</p>`;
  } else if(actSort==='due'){
    const byDate = {};
    acts.forEach(a=>{ const k=a.due||'No due date'; (byDate[k]=byDate[k]||[]).push(a); });
    Object.keys(byDate).sort((a,b)=>a.localeCompare(b)).forEach(date=>{
      byDate[date].sort((a,b)=>a.title.localeCompare(b.title));
      html += actGroup(date==='No due date' ? date : (dueInfo(date).text), byDate[date], false);
    });
  } else if(actSort==='type'){
    const order = typeList('activity').map(t=>t.key);
    const byType = {};
    acts.forEach(a=>{ (byType[a.type]=byType[a.type]||[]).push(a); });
    Object.keys(byType).sort((x,y)=>{
      const ix = order.indexOf(x), iy = order.indexOf(y);
      return (ix<0?999:ix)-(iy<0?999:iy) || String(x).localeCompare(String(y));
    }).forEach(key=>{
      const info = typeInfo('activity', key);
      byType[key].sort((a,b)=>(a.due||'9999').localeCompare(b.due||'9999') || a.title.localeCompare(b.title));
      html += actGroup(info.label, byType[key], false, info.color);
    });
  } else if(actSort==='subject'){
    const bySubj = {};
    acts.forEach(a=>{ const subj=S().subjects.find(s=>s.id===a.subjectId); const k=subj?subj.name:'General'; (bySubj[k]=bySubj[k]||[]).push(a); });
    Object.keys(bySubj).sort((a,b)=>a.localeCompare(b)).forEach(name=>{
      bySubj[name].sort((a,b)=>(a.due||'').localeCompare(b.due||''));
      html += actGroup(name, bySubj[name], false);
    });
  } else { // general: subject-grouped, group order = earliest due within group, items sorted by due
    const bySubj = {};
    acts.forEach(a=>{ const subj=S().subjects.find(s=>s.id===a.subjectId); const k=subj?subj.name:'General'; (bySubj[k]=bySubj[k]||[]).push(a); });
    const groupNames = Object.keys(bySubj);
    groupNames.forEach(name=> bySubj[name].sort((a,b)=>(a.due||'9999').localeCompare(b.due||'9999')));
    groupNames.sort((a,b)=>{
      const da = bySubj[a][0]?.due || '9999-99-99';
      const db = bySubj[b][0]?.due || '9999-99-99';
      return da.localeCompare(db);
    });
    groupNames.forEach(name=>{
      html += actGroup(name, bySubj[name], false);
    });
  }

  html += `<button class="btn ghost sm" style="margin-top:20px;" onclick="toggleShowCompleted()">${showCompleted?'▾':'▸'} Completed School Works (${doneActs.length})</button>`;
  if(showCompleted){
    html += `<div style="margin-top:10px;">`;
    if(doneActs.length===0) html += `<p style="color:var(--ink-soft);font-size:13px;">Nothing completed yet.</p>`;
    if(doneActs.length) html += `<div class="sched-list">${doneActs.map(a=>activityCard(a,true)).join('')}</div>`;
    html += `</div>`;
  }
  setPageContent(html);
}
function openActivity(id){
  const a = S().activities.find(x=>x.id===id);
  const subj = S().subjects.find(s=>s.id===a.subjectId);
  const info = typeInfo('activity', a.type);
  openModal(`<h3>${esc(a.title)}</h3>
    <p style="color:var(--ink-soft);font-size:13px;">${esc(subj?subj.name:'General')} · <span class="tag" style="${tagStyle(info.color)}margin:0;">${esc(info.label)}</span></p>
    <p><b>Starts:</b> ${esc(a.start||'TBA')} &nbsp; <b>Due:</b> ${esc(a.due||'TBA')}</p>
    ${a.image?`<img src="${safeUrl(a.image)}" style="max-width:100%;max-height:220px;object-fit:contain;border-radius:12px;margin:10px 0;display:block;">`:''}
    <p>${nl2br(a.instructions)}</p>
    <div>${(a.tags||[]).map(t=>`<span class="tag">#${esc(t)}</span>`).join('')}</div>`, subj?safeColor(subj.color):null);
}

/* =========================================================
   REVIEWERS
========================================================= */
let revMode = 'flashcards';
let revView = 'list'; // 'list' | 'detail'  (flashcards only)
let revSubjectId = null;
let flashIdx = 0, flashFlipped = false;

// Mock quiz state
let quizStage = 'list'; // 'list' | 'setup' | 'active' | 'results'
let quizTimed = false;
let quizMinutes = 10;
let quizQuestions = [];
let quizIndex = 0;
let quizAnswers = [];
let quizTimerId = null;
let quizSecondsLeft = 0;

function revSetMode(m){
  revMode = m; revView = 'list'; quizStage = 'list';
  stopQuizTimer();
  renderReviewers();
}
function revOpenSubject(id){
  revSubjectId = id;
  if(revMode==='quiz'){
    quizStage = 'setup'; quizTimed = false; quizMinutes = 10;
  } else {
    revView = 'detail'; flashIdx = 0; flashFlipped = false;
  }
  renderReviewers();
}
function revBack(){
  if(revMode==='quiz'){ stopQuizTimer(); quizStage = 'list'; }
  else { revView = 'list'; }
  renderReviewers();
}

function openReviewerAdd(){
  if(S().subjects.length===0){ alert('Add a subject first (Schedule page).'); return; }
  if(revMode==='flashcards'){
    openFlashcardModal(revView==='detail' ? revSubjectId : null);
    return;
  }
  const subjOpts = S().subjects.map(s=>`<option value="${s.id}" ${s.id===revSubjectId?'selected':''}>${esc(s.name)}</option>`).join('');
  let fields = '';
  if(revMode==='quiz'){
    fields = `<input id="qa_qz_q" placeholder="Question">
      <input id="qa_qz_choices" placeholder="Choices, separated by $ (e.g. A $ B $ C $ D)">
      <input id="qa_qz_answer" placeholder="Correct answer (must match one choice exactly)">
      <select id="qa_qz_diff"><option>Easy</option><option>Average</option><option>Hard</option><option>Very Hard</option></select>
      <input id="qa_qz_img" placeholder="Image URL (optional)">`;
  } else if(revMode==='pdf'){
    fields = `<input id="qa_mat_label" placeholder="Label (e.g. Week 1 Notes)">
      <input id="qa_mat_type" value="PDF" placeholder="Type">
      <input id="qa_mat_url" placeholder="Link (Google Drive URL)">`;
  } else if(revMode==='books'){
    fields = `<input id="qa_bk_label" placeholder="Book title">
      <input id="qa_bk_author" placeholder="Author (optional)">
      <input id="qa_bk_url" placeholder="Link (Google Drive URL)">`;
  }
  const what = revMode==='quiz'?'quiz question':revMode==='pdf'?'PDF material':'book';
  openModal(`<h3>Add ${what}</h3>
    <div class="form-grid">
      <select id="qa_rev_subject">${subjOpts}</select>
      ${fields}
    </div>
    <div class="modal-actions"><button class="btn" onclick="quickAddReviewerItem()">Add ${what}</button></div>`);
}
async function quickAddReviewerItem(){
  const subjId = document.getElementById('qa_rev_subject').value;
  if(revMode==='quiz'){
    const q = document.getElementById('qa_qz_q').value.trim();
    const choices = document.getElementById('qa_qz_choices').value.split('$').map(c=>c.trim()).filter(Boolean);
    const answerIdx = choices.indexOf(document.getElementById('qa_qz_answer').value.trim());
    if(!q||choices.length<2||answerIdx===-1){ alert('Fill all fields; correct answer must exactly match one choice.'); return; }
    await dbAddQuiz(subjId, q, choices, answerIdx, document.getElementById('qa_qz_diff').value, document.getElementById('qa_qz_img').value.trim());
  } else if(revMode==='pdf'){
    const label = document.getElementById('qa_mat_label').value.trim();
    const url = document.getElementById('qa_mat_url').value.trim();
    if(!label||!url){alert('Label and link are required.');return;}
    await dbAddFile('materials', subjId, label, document.getElementById('qa_mat_type').value.trim(), url);
  } else if(revMode==='books'){
    const label = document.getElementById('qa_bk_label').value.trim();
    const url = document.getElementById('qa_bk_url').value.trim();
    if(!label||!url){alert('Title and link are required.');return;}
    await dbAddBook(subjId, label, document.getElementById('qa_bk_author').value.trim(), url);
  }
  await refreshCurrentSchool();
  closeModal();
  renderReviewers();
}

/* ---- Flashcards: Add card / Edit card ---- */
function openFlashcardModal(subjectId, cardId, notice){
  if(S().subjects.length===0){ alert('Add a subject first (Schedule page).'); return; }
  const subj = subjectId ? S().subjects.find(x=>x.id===subjectId) : null;
  const card = (subj && cardId) ? subj.flashcards.find(c=>c.id===cardId) : null;
  const subjectField = subj
    ? `<div><span class="modal-subject" style="--subj:${safeColor(subj.color)};">${esc(subj.name)}</span><input type="hidden" id="fc_subject" value="${esc(subj.id)}"></div>`
    : `<div><label>Subject</label><select id="fc_subject">${S().subjects.map(x=>`<option value="${x.id}" ${x.id===revSubjectId?'selected':''}>${esc(x.name)}</option>`).join('')}</select></div>`;
  openModal(`<h3>${card?'Edit card':'Add card'}</h3>
    ${notice?`<div class="modal-notice">${esc(notice)}</div>`:''}
    <div class="form-grid">
      ${subjectField}
      <div><label>Question</label><textarea id="fc_q" rows="3" placeholder="Front of the card">${esc(card?card.q:'')}</textarea></div>
      <div><label>Answer</label><textarea id="fc_a" rows="3" placeholder="Back of the card">${esc(card?card.a:'')}</textarea></div>
      <div><label>Image URL (optional)</label><input id="fc_img" value="${esc(card?card.image:'')}" placeholder="Direct image link"></div>
    </div>
    <div class="modal-actions">
      ${card
        ? `<button class="btn" onclick="saveFlashcard('${card.id}')">Save changes</button>`
        : `<button class="btn" onclick="saveFlashcard(null,false)">Add card</button>
           <button class="btn ghost" onclick="saveFlashcard(null,true)">Add &amp; next</button>`}
    </div>`);
  setTimeout(()=>{ const q = document.getElementById('fc_q'); if(q) q.focus(); }, 60);
}
async function saveFlashcard(cardId, addAnother){
  const subjId = document.getElementById('fc_subject').value;
  const q = document.getElementById('fc_q').value.trim();
  const a = document.getElementById('fc_a').value.trim();
  const img = document.getElementById('fc_img').value.trim();
  if(!q || !a){ alert('Fill in both the question and the answer.'); return; }
  if(cardId) await dbUpdateFlashcard(cardId, {question:q, answer:a, image_url:img});
  else await dbAddFlashcard(subjId, q, a, img);
  await refreshCurrentSchool();
  if(addAnother){
    rerender();
    openFlashcardModal(subjId, null, 'Card added. Add another, or close when you’re done.');
  } else {
    closeModal();
    rerender();
  }
}
async function deleteFlashcard(id){
  if(!confirm('Delete this flashcard?')) return;
  await dbDeleteFlashcard(id);
  await refreshCurrentSchool();
  flashFlipped = false;
  renderReviewers();
}

function renderReviewers(){
  const addLabel = {flashcards:'+ Add card', quiz:'+ Add question', pdf:'+ Add PDF', books:'+ Add book'}[revMode];
  let html = `<div class="rev-tabs">
    <button class="rev-tab ${revMode==='flashcards'?'active':''}" onclick="revSetMode('flashcards')">Flashcards</button>
    <button class="rev-tab ${revMode==='quiz'?'active':''}" onclick="revSetMode('quiz')">Mock Quiz</button>
    <button class="rev-tab ${revMode==='pdf'?'active':''}" onclick="revSetMode('pdf')">Readable PDF</button>
    <button class="rev-tab ${revMode==='books'?'active':''}" onclick="revSetMode('books')">PDF Books</button>
  </div>
  ${isAdmin?`<div class="rev-admin-row"><button class="btn-tag" onclick="openReviewerAdd()">${addLabel}</button></div>`:''}`;

  if(S().subjects.length===0){
    setPageContent(html + `<p style="color:var(--ink-soft);">No subjects yet.</p>`);
    return;
  }

  if(revMode==='pdf'){
    const rows = [];
    S().subjects.forEach(s=>{
      s.materials.filter(m=>(m.type||'').toLowerCase()==='pdf').forEach(f=> rows.push(fileRow(f, s.name)));
    });
    html += `<div class="section-label">Readable PDFs</div>`;
    html += rows.length ? `<div class="hub-list">${rows.join('')}</div>`
      : `<p style="color:var(--ink-soft);">No PDF materials linked yet — add them via Admin → Subjects → Materials (type: PDF).</p>`;
    setPageContent(html);
    return;
  }

  if(revMode==='books'){
    const rows = [];
    S().subjects.forEach(s=>{
      (s.books||[]).forEach(b=> rows.push(fileRow({label:b.label + (b.author?` — ${b.author}`:''), type:'BOOK', url:b.url}, s.name)));
    });
    html += `<div class="section-label">PDF Books</div>`;
    html += rows.length ? `<div class="hub-list">${rows.join('')}</div>`
      : `<p style="color:var(--ink-soft);">No books added yet — add them via Admin → Subjects → PDF Books.</p>`;
    setPageContent(html);
    return;
  }

  if(revMode==='flashcards'){
    if(revView==='list'){
      html += renderRevSubjectList('flashcards');
      setPageContent(html);
      return;
    }
    const s = S().subjects.find(x=>x.id===revSubjectId);
    html += `<button class="btn ghost sm" onclick="revBack()" style="margin-bottom:16px;">‹ Back to subjects</button>`;
    html += `<div class="section-label" style="margin-top:0;">${esc(s.name)}</div>`;
    if(s.flashcards.length===0){ html += `<p style="color:var(--ink-soft);">No flashcards yet for this subject.</p>`; }
    else{
      const c = s.flashcards[flashIdx % s.flashcards.length];
      const imgHtml = (c.image && !flashFlipped) ? `<img src="${safeUrl(c.image)}" style="max-width:100%;max-height:180px;border-radius:12px;margin-bottom:14px;object-fit:contain;">` : '';
      html += `<div class="flash-card ${flashFlipped?'is-flipped':''}" onclick="flashFlipped=!flashFlipped;renderReviewers()">
        <div style="display:flex;flex-direction:column;align-items:center;">${imgHtml}<div>${esc(flashFlipped ? c.a : c.q)}</div></div>
      </div>
      ${isAdmin?`<div class="flash-admin">
        <button class="btn ghost sm" onclick="openFlashcardModal('${s.id}','${c.id}')">Edit card</button>
        <button class="btn danger sm" onclick="deleteFlashcard('${c.id}')">Delete card</button>
      </div>`:''}
      <div class="flash-nav">
        <button class="btn ghost" onclick="flashIdx=(flashIdx-1+${s.flashcards.length})%${s.flashcards.length};flashFlipped=false;renderReviewers()">‹ Prev</button>
        <span style="font-size:12.5px;color:var(--ink-soft);">${flashIdx%s.flashcards.length+1} / ${s.flashcards.length} · tap card to flip</span>
        <button class="btn ghost" onclick="flashIdx=(flashIdx+1)%${s.flashcards.length};flashFlipped=false;renderReviewers()">Next ›</button>
      </div>`;
    }
    setPageContent(html);
    return;
  }

  // ---- Mock Quiz ----
  if(quizStage==='list'){
    html += renderRevSubjectList('quiz');
    setPageContent(html);
    return;
  }
  const s = S().subjects.find(x=>x.id===revSubjectId);
  if(quizStage==='setup') html += renderQuizSetup(s);
  else if(quizStage==='active') html += renderQuizActive(s);
  else if(quizStage==='results') html += renderQuizResults(s);
  setPageContent(html);
}

function renderRevSubjectList(mode){
  let html = `<div class="section-label">${mode==='flashcards'?'Choose a subject to review':'Choose a subject to test yourself'}</div>
  <div class="hub-list">`;
  S().subjects.forEach(s=>{
    const count = mode==='flashcards' ? s.flashcards.length : s.quiz.length;
    const noun = mode==='flashcards' ? (count===1?'flashcard':'flashcards') : (count===1?'question':'questions');
    html += `<div class="hub-row" onclick="revOpenSubject('${s.id}')">
      <div class="chip" style="background:${esc(s.color)}">${esc(s.code.slice(0,4))}</div>
      <div class="hub-text">
        <h4>${esc(s.name)}</h4>
        <p>${count} ${noun}</p>
      </div>
      <span class="hub-arrow">›</span>
    </div>`;
  });
  html += `</div>`;
  return html;
}

/* ---- Quiz setup (timer choice) ---- */
function renderQuizSetup(s){
  return `
    <button class="btn ghost sm" onclick="revBack()" style="margin-bottom:16px;">‹ Back to subjects</button>
    <div class="card">
      <h3>${esc(s.name)} — Mock Quiz</h3>
      <p style="color:var(--ink-soft);font-size:13px;">${s.quiz.length} question${s.quiz.length!==1?'s':''} available.</p>
      ${s.quiz.length===0 ? `<p style="color:var(--ink-soft);margin-top:12px;">No quiz questions yet for this subject — add some via Admin.</p>` : `
      <div class="section-label" style="margin-top:18px;">Timer</div>
      <div class="quiz-setup-options">
        <button class="quiz-setup-opt ${!quizTimed?'active':''}" onclick="quizTimed=false;renderReviewers()">No Timer</button>
        <button class="quiz-setup-opt ${quizTimed?'active':''}" onclick="quizTimed=true;renderReviewers()">Timer</button>
      </div>
      ${quizTimed?`
        <div class="section-label">Minutes</div>
        <input type="number" min="1" max="180" value="${quizMinutes}" style="max-width:130px;" onchange="quizMinutes=Math.max(1,parseInt(this.value)||10)">
      `:''}
      <button class="btn" style="margin-top:20px;" onclick="startQuiz('${s.id}')">Start Quiz</button>
      `}
    </div>
  `;
}

function startQuiz(subjectId){
  const s = S().subjects.find(x=>x.id===subjectId);
  quizQuestions = s.quiz.slice();
  quizIndex = 0;
  quizAnswers = new Array(quizQuestions.length).fill(null);
  quizStage = 'active';
  if(quizTimed){
    quizSecondsLeft = quizMinutes*60;
    startQuizTimer();
  }
  renderReviewers();
}
function startQuizTimer(){
  stopQuizTimer();
  quizTimerId = setInterval(()=>{
    quizSecondsLeft--;
    if(quizSecondsLeft<=0){
      quizSecondsLeft = 0;
      stopQuizTimer();
      finishQuiz();
      return;
    }
    const el = document.getElementById('quizTimerDisplay');
    if(el) el.textContent = formatQuizTime(quizSecondsLeft);
  },1000);
}
function stopQuizTimer(){
  if(quizTimerId){ clearInterval(quizTimerId); quizTimerId = null; }
}
function formatQuizTime(sec){
  const m = Math.floor(sec/60), s = sec%60;
  return `${m}:${String(s).padStart(2,'0')}`;
}

/* ---- Quiz active (one question at a time) ---- */
function renderQuizActive(s){
  const q = quizQuestions[quizIndex];
  const selected = quizAnswers[quizIndex];
  return `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
      <span style="font-size:12.5px;color:var(--ink-soft);">Question ${quizIndex+1} of ${quizQuestions.length}</span>
      ${quizTimed?`<span id="quizTimerDisplay" class="tag due" style="font-family:'Manrope';font-weight:700;">${formatQuizTime(quizSecondsLeft)}</span>`:''}
    </div>
    <div class="card">
      <span class="tag">${esc(q.difficulty||'Easy')}</span>
      ${q.image?`<img src="${safeUrl(q.image)}" style="max-width:100%;max-height:220px;border-radius:12px;margin-top:10px;object-fit:contain;display:block;">`:''}
      <div class="quiz-q" style="margin-top:10px;">${esc(q.q)}</div>
      ${q.choices.map((c,ci)=>`<button class="quiz-opt ${selected===ci?'selected':''}" onclick="selectQuizAnswer(${ci})">${esc(c)}</button>`).join('')}
    </div>
    <div class="flash-nav" style="margin-top:16px;">
      <button class="btn ghost" ${quizIndex===0?'disabled':''} onclick="quizIndex--;renderReviewers()">‹ Prev</button>
      ${quizIndex < quizQuestions.length-1
        ? `<button class="btn" onclick="quizIndex++;renderReviewers()">Next ›</button>`
        : `<button class="btn" onclick="finishQuiz()">Finish Quiz</button>`}
    </div>
  `;
}
function selectQuizAnswer(ci){
  quizAnswers[quizIndex] = ci;
  renderReviewers();
}
function finishQuiz(){
  stopQuizTimer();
  quizStage = 'results';
  renderReviewers();
}

/* ---- Quiz results ---- */
function renderQuizResults(s){
  let correct = 0;
  quizQuestions.forEach((q,i)=>{ if(quizAnswers[i]===q.answer) correct++; });
  const pct = quizQuestions.length ? Math.round(correct/quizQuestions.length*100) : 0;
  let html = `
    <div class="card" style="text-align:center;">
      <h3>Quiz Results</h3>
      <p style="font-size:32px;font-family:'Manrope';font-weight:800;color:var(--accent);margin:10px 0;">${correct}/${quizQuestions.length}</p>
      <p style="color:var(--ink-soft);">${pct}% correct</p>
    </div>
    <div class="section-label">Review</div>
  `;
  quizQuestions.forEach((q,i)=>{
    const userAns = quizAnswers[i];
    const isCorrect = userAns===q.answer;
    html += `<div class="card" style="margin-bottom:10px;">
      <span class="tag ${isCorrect?'':'due'}">${isCorrect?'Correct':(userAns===null?'Skipped':'Incorrect')}</span>
      ${q.image?`<img src="${safeUrl(q.image)}" style="max-width:100%;max-height:180px;border-radius:12px;margin-top:8px;object-fit:contain;display:block;">`:''}
      <div class="quiz-q" style="margin-top:8px;font-size:14px;">${i+1}. ${esc(q.q)}</div>
      ${q.choices.map((c,ci)=>{
        let cls = '';
        if(ci===q.answer) cls='correct';
        else if(ci===userAns) cls='wrong';
        return `<div class="quiz-opt ${cls}" style="cursor:default;">${esc(c)}</div>`;
      }).join('')}
    </div>`;
  });
  html += `
    <div style="display:flex;gap:10px;margin-top:10px;">
      <button class="btn" onclick="quizStage='setup';renderReviewers()">Retake</button>
      <button class="btn ghost" onclick="revBack()">Back to subjects</button>
    </div>
  `;
  return html;
}

/* =========================================================
   HOW-TO (FAQ)
========================================================= */
function renderHowTo(){
  let html = isAdmin ? `<button class="btn" onclick="openHowToAdd()" style="margin-bottom:16px;">+ Add FAQ</button>` : '';
  S().faqs.forEach((f,i)=>{
    html += `<div class="faq-item" id="faq-${i}">
      <div class="faq-q" onclick="toggleFaq(${i})" style="display:flex;justify-content:space-between;align-items:center;">
        <span>${esc(f.q)}</span>
        <div style="display:flex;align-items:center;gap:8px;">
          ${isAdmin?`<button class="icon-btn" onclick="event.stopPropagation();adminEditFaq('${f.id}')" aria-label="Edit">✎</button>
          <button class="icon-btn danger" onclick="event.stopPropagation();quickDeleteFaq('${f.id}')" aria-label="Delete">✕</button>`:''}
          <span>+</span>
        </div>
      </div>
      <div class="faq-a">${nl2br(f.a)}</div>
    </div>`;
  });
  if(S().faqs.length===0) html += `<p style="color:var(--ink-soft);">No FAQs yet.</p>`;
  setPageContent(html);
}
function toggleFaq(i){ document.getElementById('faq-'+i).classList.toggle('open'); }
function openHowToAdd(){
  openModal(`<h3>Add FAQ</h3>
    <div class="form-grid">
      <input id="qa_fq_q" placeholder="Question">
      <textarea id="qa_fq_a" placeholder="Answer" rows="3"></textarea>
      <button class="btn" onclick="quickAddFaq()">Add</button>
    </div>`);
}
async function quickAddFaq(){
  const q = document.getElementById('qa_fq_q').value.trim();
  const a = document.getElementById('qa_fq_a').value.trim();
  if(!q||!a){alert('Fill both fields.');return;}
  await dbAddFaq(currentSchool, q, a);
  await refreshCurrentSchool();
  closeModal();
  renderHowTo();
}
async function quickDeleteFaq(id){
  if(!confirm('Delete this FAQ?')) return;
  await dbDeleteFaq(id);
  await refreshCurrentSchool();
  renderHowTo();
}

/* =========================================================
   RULES AND OTHERS
========================================================= */
function nl2br(s){ return esc(s).replace(/\n/g, '<br>'); }
function rulesCard(icon, title, innerHtml, actionsHtml){
  return `<div class="rules-card">
    <div class="rules-card-head" style="justify-content:space-between;">
      <div style="display:flex;align-items:center;gap:10px;">
        <div class="rules-card-icon"><svg viewBox="0 0 24 24">${icon}</svg></div>
        <h3>${esc(title)}</h3>
      </div>
      ${actionsHtml||''}
    </div>
    ${innerHtml}
  </div>`;
}
const RULES_ICONS = {
  vision: '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  mission: '<path d="M12 2v20M2 12h20" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  preamble: '<path d="M6 2h9l5 5v15H6z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M9 12h6M9 16h6M9 8h2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  values: '<path d="M12 2l2.9 6.3 6.9.9-5 4.8 1.2 6.9L12 17.6 5.9 20.9l1.2-6.9-5-4.8 6.9-.9z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  more: '<path d="M4 4h16v16H4z M4 9h16 M9 4v16" fill="none" stroke="currentColor" stroke-width="1.8"/>'
};

function renderRules(){
  const r = S().rules;
  const coreActions = isAdmin ? `<button class="icon-btn" onclick="openRulesCoreEdit()" aria-label="Edit">✎</button>` : '';
  let html = isAdmin ? `<div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;">
    <button class="btn" onclick="openRulesSectionAdd()">+ Add section</button>
    <button class="btn ghost" onclick="openThemeModal()">🎨 Theme colors</button>
  </div>` : '';
  html += rulesCard(RULES_ICONS.vision, 'Vision', `<p>${nl2br(r.vision)||'Not set yet.'}</p>`, coreActions);
  html += rulesCard(RULES_ICONS.mission, 'Mission', `<p>${nl2br(r.mission)||'Not set yet.'}</p>`, coreActions);
  html += rulesCard(RULES_ICONS.preamble, 'Preamble', `<p>${nl2br(r.preamble)||'Not set yet.'}</p>`, coreActions);
  html += rulesCard(RULES_ICONS.values, 'Core Values', `<div class="core-values">${r.coreValues.map(v=>`<div>${esc(v)}</div>`).join('') || '<p style="color:var(--ink-soft);">Not set yet.</p>'}</div>`, coreActions);

  if(r.guidelines.length===0){
    // Nothing to show here for readers; admins already have the "+ Add section" button
  } else {
    r.guidelines.forEach(g=>{
      let inner;
      if(g.body && g.body.includes('$')){
        const items = g.body.split('$').map(v=>v.trim()).filter(Boolean);
        inner = `<div class="core-values">${items.map(v=>`<div>${esc(v)}</div>`).join('')}</div>`;
      } else {
        inner = `<p>${nl2br(g.body)}</p>`;
      }
      const actions = isAdmin ? `<div style="display:flex;gap:4px;">
        <button class="icon-btn" onclick="adminEditGuideline('${g.id}')" aria-label="Edit">✎</button>
        <button class="icon-btn danger" onclick="quickDeleteGuideline('${g.id}')" aria-label="Delete">✕</button>
      </div>` : '';
      html += rulesCard(RULES_ICONS.more, g.title, inner, actions);
    });
  }
  setPageContent(html);
}
function openRulesCoreEdit(){
  const r = S().rules;
  openModal(`<h3>Edit Vision, Mission, Preamble & Core Values</h3>
    <div class="form-grid">
      <div><label>Vision</label><textarea id="qa_r_vision" rows="2">${esc(r.vision)}</textarea></div>
      <div><label>Mission</label><textarea id="qa_r_mission" rows="2">${esc(r.mission)}</textarea></div>
      <div><label>Preamble</label><textarea id="qa_r_preamble" rows="2">${esc(r.preamble)}</textarea></div>
      <div><label>Core Values (separated by $)</label><input id="qa_r_values" value="${esc(r.coreValues.join(' $ '))}"></div>
      <button class="btn" onclick="quickSaveRulesCore()">Save</button>
    </div>`);
}
async function quickSaveRulesCore(){
  await dbSaveRules(currentSchool, {
    vision: document.getElementById('qa_r_vision').value,
    mission: document.getElementById('qa_r_mission').value,
    preamble: document.getElementById('qa_r_preamble').value,
    core_values: document.getElementById('qa_r_values').value.split('$').map(v=>v.trim()).filter(Boolean)
  });
  await refreshCurrentSchool();
  closeModal();
  renderRules();
}
function openRulesSectionAdd(){
  openModal(`<h3>Add section</h3>
    <div class="form-grid">
      <input id="qa_g_title" placeholder="Section title (e.g. University Hymn, Strategic Goals)">
      <textarea id="qa_g_body" placeholder="Content — or separate items with $ to show as chips" rows="3"></textarea>
      <button class="btn" onclick="quickAddSection()">Add</button>
    </div>`);
}
async function quickAddSection(){
  const title = document.getElementById('qa_g_title').value.trim();
  const body = document.getElementById('qa_g_body').value.trim();
  if(!title||!body){alert('Fill both fields.');return;}
  await dbAddGuideline(currentSchool, title, body);
  await refreshCurrentSchool();
  closeModal();
  renderRules();
}
async function quickDeleteGuideline(id){
  if(!confirm('Delete this section?')) return;
  await dbDeleteGuideline(id);
  await refreshCurrentSchool();
  renderRules();
}

/* =========================================================
   START-UP
========================================================= */
initLanding();
updateSyncDot();

// Web version only: keep the app files available offline. (The Android app already bundles them.)
if('serviceWorker' in navigator && /^https?:$/.test(location.protocol) &&
   !(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())){
  window.addEventListener('load', ()=>{ navigator.serviceWorker.register('sw.js').catch(()=>{}); });
}
