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
  return `background:${c}26;color:${isDarkTheme() ? shade(c,0.45) : shade(c,-0.4)};`;
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
  if(isDarkTheme()) document.documentElement.style.removeProperty('--bg');
  else document.documentElement.style.setProperty('--bg', d.bgColor || '#F6F5F0');
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

  const nConf = conflictsList().length;
  const conflictBox = nConf
    ? `<div class="modal-section"><div class="modal-section-title">Edit conflicts</div>
        <p class="acct-sync">${nConf} of your offline edit${nConf===1?'':'s'} clashed with another admin’s change.</p>
        <button class="btn ghost sm" onclick="openConflicts()">Review ${nConf===1?'it':'them'}</button></div>`
    : '';

  openModal(`<h3>Account</h3>
    <div class="modal-section">${who}</div>
    <div class="modal-section">${displayPrefsHtml()}</div>
    ${conflictBox}
    <div class="modal-section"><div class="modal-section-title">School</div>
      <div class="pick-list">${schools}</div>${addSchool}</div>
    <div class="modal-section"><div class="modal-section-title">Semester</div>
      <div class="pick-list">${semList}</div>${addSem}</div>
    ${sync}
    ${email ? `<div class="modal-actions"><button class="btn danger" onclick="signOutAdmin()">Sign out</button></div>` : ''}`);
}
/* ---- Display preferences: text size + light/dark mode (icons and numbers only) ---- */
function displayPrefsHtml(){
  const dark = isDarkTheme();
  return `<div class="pref-row">
    <div class="stepper" role="group" aria-label="Text size">
      <button onclick="changeFont(-1)" aria-label="Smaller text">−</button>
      <span id="fsVal">${currentFontSize()}</span>
      <button onclick="changeFont(1)" aria-label="Larger text">+</button>
    </div>
    <div class="mode-toggle" role="group" aria-label="Color mode">
      <button id="modeLight" class="${dark?'':'on'}" onclick="setTheme('light')" aria-label="Light mode">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5.3 5.3l1.7 1.7M17 17l1.7 1.7M18.7 5.3L17 7M7 17l-1.7 1.7"/></svg></button>
      <button id="modeDark" class="${dark?'on':''}" onclick="setTheme('dark')" aria-label="Dark mode">
        <svg viewBox="0 0 24 24"><path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7z"/></svg></button>
    </div>
  </div>`;
}
function changeFont(delta){
  setFontSize(currentFontSize() + delta);
  const el = document.getElementById('fsVal');
  if(el) el.textContent = currentFontSize();
  syncTopbarSpacer();
}
function setTheme(mode){
  applyThemeMode(mode);
  const l = document.getElementById('modeLight'), d = document.getElementById('modeDark');
  if(l) l.classList.toggle('on', mode!=='dark');
  if(d) d.classList.toggle('on', mode==='dark');
  if(currentSchool) applyTheme(currentSchool);
  if(currentSchool && S() && !S().offlineEmpty) rerender();
}

/* ---- Edit conflicts (two admins changed the same thing while one was offline) ---- */
const CONFLICT_TABLES = {subjects:'Subject', activities:'Activity', events:'Calendar entry', flashcards:'Flashcard',
  faqs:'FAQ', guidelines:'Guideline', schedule_slots:'Class schedule', rules:'Rules', schools:'School theme',
  item_types:'Type', semesters:'Semester', syllabus_files:'Syllabus file', materials:'Material', pdf_books:'Book'};
function fmtConflictVal(v){
  if(v===null || v===undefined || v==='') return '(empty)';
  let t = typeof v==='object' ? JSON.stringify(v) : String(v);
  return t.length>90 ? t.slice(0,90)+'…' : t;
}
function openConflicts(){
  const list = conflictsList();
  if(!list.length){ closeModal(); return; }
  const rows = list.map(c=>{
    const what = (CONFLICT_TABLES[c.table]||c.table) + (c.label ? ` “${esc(c.label)}”` : '');
    if(c.deleted){
      return `<div class="conflict-row"><b>${what}</b>
        <p>Another admin deleted this while you were offline, so your edit wasn’t applied.</p>
        <div class="row"><button class="btn ghost sm" onclick="conflictDismiss('${c.id}')">OK</button></div></div>`;
    }
    return `<div class="conflict-row"><b>${what}</b> · ${esc(String(c.field).replace(/_/g,' '))}
      <div class="conflict-vals">
        <div><small>Other admin (kept)</small><span>${esc(fmtConflictVal(c.theirs))}</span></div>
        <div><small>Yours (not applied)</small><span>${esc(fmtConflictVal(c.mine))}</span></div>
      </div>
      <div class="row"><button class="btn sm" onclick="conflictUseMine('${c.id}')">Use mine</button>
        <button class="btn ghost sm" onclick="conflictDismiss('${c.id}')">Keep theirs</button></div></div>`;
  }).join('');
  openModal(`<h3>Edit conflicts</h3>
    <p class="modal-sub">These edits were made offline, but someone else had already changed the same thing. Their version was kept so nothing was lost. Choose which one you want.</p>
    ${rows}
    <div class="modal-actions"><button class="btn ghost" onclick="conflictDismissAll()">Keep all of theirs</button></div>`);
}
function conflictDismiss(id){
  lsSet('shConflicts', conflictsList().filter(c=>c.id!==id));
  conflictsChanged();
}
function conflictDismissAll(){
  lsSet('shConflicts', []);
  conflictsChanged();
}
async function conflictUseMine(id){
  const c = conflictsList().find(x=>x.id===id);
  if(!c) return;
  const key = {}; key[c.field] = c.mine;
  const base = {}; base[c.field] = c.theirs;
  const r = await mutate(c.table, 'update', {fields:key, match:c.match, base});
  if(r.error){ alert('Could not apply your version: ' + r.error.message); return; }
  conflictDismiss(id);
  await refreshCurrentSchool();
  rerender();
}
function conflictsChanged(){
  if(conflictsList().length) openConflicts();
  else { closeModal(); showToast('All conflicts reviewed'); }
}
// Called by the data layer after a sync that found clashes
function onConflictsFound(n){
  showToast(`${n} offline edit${n===1?'':'s'} clashed with another admin’s. Theirs were kept — see Account → Edit conflicts.`, 7000);
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
  {id:'reviewers', label:'Reviewers', title:'Reviewers', sub:'Flashcards, mock quizzes, a Pomodoro timer, and your progress.',
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
    html += `<p style="color:var(--ink-soft);font-size:calc(13px * var(--fs));">Nothing due soon.</p>`;
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
      ${subj?`<p style="font-size:calc(12px * var(--fs));">${esc(subj.name)}</p>`:''}
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
    html += `<p style="color:var(--ink-soft);font-size:calc(13px * var(--fs));">No schedule set yet.</p>`;
  } else {
    s.schedule.forEach(sl=>{
      html += `<p style="color:var(--ink-soft);font-size:calc(13px * var(--fs));margin:0 0 4px;">${esc(sl.day||'')} · ${esc(sl.time||'TBA')} · ${esc(sl.professor||'Professor TBA')} · Room ${esc(sl.room||'TBA')}</p>`;
    });
  }
  html += `<div class="section-label">Syllabus</div>`;
  if(s.syllabus.length===0) html += `<p style="font-size:calc(13px * var(--fs));color:var(--ink-soft);">No syllabus uploaded yet.</p>`;
  s.syllabus.forEach(f=> html += fileRow(f));
  html += `<div class="section-label">Materials</div>`;
  if(s.materials.length===0) html += `<p style="font-size:calc(13px * var(--fs));color:var(--ink-soft);">No materials uploaded yet.</p>`;
  s.materials.forEach(f=> html += fileRow(f));
  html += `<div class="section-label">PDF Books</div>`;
  if(!s.books || s.books.length===0) html += `<p style="font-size:calc(13px * var(--fs));color:var(--ink-soft);">No books added yet.</p>`;
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
    ${a.image?`<img class="act-img" loading="lazy" decoding="async" src="${safeUrl(a.image)}" alt="">`:''}
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
    if(doneActs.length===0) html += `<p style="color:var(--ink-soft);font-size:calc(13px * var(--fs));">Nothing completed yet.</p>`;
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
    <p style="color:var(--ink-soft);font-size:calc(13px * var(--fs));">${esc(subj?subj.name:'General')} · <span class="tag" style="${tagStyle(info.color)}margin:0;">${esc(info.label)}</span></p>
    <p><b>Starts:</b> ${esc(a.start||'TBA')} &nbsp; <b>Due:</b> ${esc(a.due||'TBA')}</p>
    ${a.image?`<img src="${safeUrl(a.image)}" style="max-width:100%;max-height:220px;object-fit:contain;border-radius:12px;margin:10px 0;display:block;">`:''}
    <p>${nl2br(a.instructions)}</p>
    <div>${(a.tags||[]).map(t=>`<span class="tag">#${esc(t)}</span>`).join('')}</div>`, subj?safeColor(subj.color):null);
}

/* =========================================================
   REVIEWERS
   Subject → Semester (or All Semester) → Lesson (or All Lesson) → study or edit.
   - Study (editing off): Flashcards (tap, flip, ✓ / ✕) and Mock Quiz, each with an
     optional timer. Results are saved to History Progress.
   - Edit (pencil on): the same places show the LIST of flashcards / quiz questions.
     Select cards → transfer them to another semester + lesson, set a quiz group, or delete.
   - Every quiz question is a flashcard (question, answer and image travel together).
   - Pomodoro Timer and History Progress live in study.js.
========================================================= */
let revMode = 'flashcards';   // 'flashcards' | 'quiz' | 'pomodoro' | 'history'
let revKey = null;            // chosen subject (merged across semesters)
let revSem = null;            // null = not chosen yet, semester id, or 'all'
let revLesson = null;         // null = not chosen yet, lesson number, or 'all'
let studyStage = 'setup';     // 'setup' | 'active' | 'results'
let revTimed = false, revMinutes = 10;
let selMode = false, selIds = new Set();

// Flashcard round
let fc = null;                // {ids, pos, flipped, right, wrong, missed, practice, saved, timedOut, secondsLeft}
let flashTimerId = null;

// Mock quiz round
let quizQuestions = [], quizIndex = 0, quizAnswers = [], quizTimerId = null, quizSecondsLeft = 0, quizSkipped = 0;

function shuffle(a){
  a = a.slice();
  for(let i=a.length-1;i>0;i--){ const j = Math.floor(Math.random()*(i+1)); [a[i],a[j]] = [a[j],a[i]]; }
  return a;
}
function normAns(x){ return String(x||'').trim().toLowerCase().replace(/\s+/g,' '); }

/* ---- helpers ---- */
function revSubjects(){ return S().reviewerSubjects || []; }
function revSubject(){ return revSubjects().find(s=>s.key===revKey) || null; }
function revSemesters(){ return S().allSemesters || []; }
function revHasSem(){ return revSemesters().length>0; }
function revExt(){ return !!S().cardsExt; }
function semNameOf(id){ const m = revSemesters().find(x=>x.id===id); return m ? m.name : ''; }
function scopeChosen(){ return !!revKey && revSem!==null && revLesson!==null; }
function inScope(c, sem, lesson){
  return (sem==='all' || sem===null || c.semesterId===sem) && (lesson==='all' || lesson===null || c.lesson===lesson);
}
function scopeCards(s){ return s.cards.filter(c=>inScope(c, revSem, revLesson)); }
function lessonsOf(s, sem){
  return [...new Set(s.cards.filter(c=>sem==='all'||c.semesterId===sem).map(c=>c.lesson))].sort((a,b)=>a-b);
}
function scopeLabel(){
  const parts = [];
  if(revHasSem()) parts.push(revSem==='all' ? 'All Semester' : semNameOf(revSem));
  if(revExt() && revSem!=='all') parts.push(revLesson==='all' ? 'All Lesson' : 'Lesson ' + revLesson);
  return parts.join(' · ');
}
function noun(n, one, many){ return n + ' ' + (n===1 ? one : many); }
function groupsOf(s){
  const g = {};
  s.cards.forEach(c=>{ if(c.group) g[c.group] = (g[c.group]||0) + 1; });
  return g;
}

/* ---- navigation ---- */
function stopRevTimers(){
  if(quizTimerId){ clearInterval(quizTimerId); quizTimerId = null; }
  if(flashTimerId){ clearInterval(flashTimerId); flashTimerId = null; }
}
function clearSel(){ selMode = false; selIds = new Set(); }
function revSetMode(m){
  revMode = m; fc = null; studyStage = 'setup'; stopRevTimers(); clearSel();
  if(m==='flashcards' || m==='quiz'){ revKey = null; revSem = null; revLesson = null; }
  renderReviewers();
}
function revOpenSubject(i){
  const sub = revSubjects()[i]; if(!sub) return;
  revKey = sub.key; revLesson = null; studyStage = 'setup'; clearSel(); fc = null; stopRevTimers();
  revSem = revHasSem() ? null : 'all';
  if(revSem==='all') revLesson = 'all';
  renderReviewers();
}
function revPickSem(id){
  revSem = id; clearSel(); studyStage = 'setup';
  revLesson = (id==='all' || !revExt()) ? 'all' : null;
  renderReviewers();
}
function revPickLesson(n){
  revLesson = n; clearSel(); studyStage = 'setup';
  renderReviewers();
}
function revBack(){
  stopRevTimers(); fc = null; studyStage = 'setup'; clearSel();
  if(revLesson!==null && revSem!=='all' && revExt() && revHasSem()){ revLesson = null; }
  else if(revSem!==null && revHasSem()){ revSem = null; revLesson = null; }
  else { revKey = null; revSem = null; revLesson = null; }
  renderReviewers();
}

/* ---- Add / edit one card ---- */
function openReviewerAdd(){
  const s = revSubject();
  const preset = {};
  if(s && revSem && revSem!=='all') preset.semesterId = revSem;
  if(s && revLesson && revLesson!=='all') preset.lesson = revLesson;
  openFlashcardModal(null, null, preset);
}
function groupOptionsHtml(s, selected){
  const g = groupsOf(s), nums = Object.keys(g).map(Number).sort((a,b)=>a-b);
  const next = (nums.length ? nums[nums.length-1] : 0) + 1;
  let h = `<option value="0" ${!selected?'selected':''}>No group</option>`;
  nums.forEach(n=>{ h += `<option value="${n}" ${selected===n?'selected':''}>Group ${n} (${g[n]})</option>`; });
  if(selected && !g[selected]) h += `<option value="${selected}" selected>Group ${selected}</option>`;
  h += `<option value="${next}">New group ${next}</option>`;
  return h;
}
function openFlashcardModal(cardId, notice, preset){
  preset = preset || {};
  if(revSubjects().length===0){ alert('Add a subject first (Schedule page).'); return; }
  const isQ = revMode==='quiz';
  const s = revSubject();
  const card = (s && cardId) ? s.cards.find(c=>c.id===cardId) : null;
  const ext = revExt();
  const subjectField = s
    ? `<div><span class="modal-subject" style="--subj:${safeColor(s.color)};">${esc(s.name)}</span><input type="hidden" id="fc_subject" value="${esc(s.key)}"></div>`
    : `<div><label>Subject</label><select id="fc_subject">${revSubjects().map(x=>`<option value="${esc(x.key)}">${esc(x.name)}</option>`).join('')}</select></div>`;
  const semSel = card ? card.semesterId : (preset.semesterId || S().semesterId);
  const lesson = card ? card.lesson : (preset.lesson || 1);
  const placeField = (ext ? `<div class="two-col">
      ${revHasSem() ? `<div><label>Semester</label><select id="fc_sem">${revSemesters().map(m=>`<option value="${m.id}" ${m.id===semSel?'selected':''}>${esc(m.name)}</option>`).join('')}</select></div>` : ''}
      <div><label>Lesson</label><input id="fc_lesson" type="number" min="1" max="999" inputmode="numeric" value="${lesson}"></div>
    </div>
    ${s ? `<div><label>Quiz group <small style="color:var(--ink-soft);">(answers only mix inside a group)</small></label><select id="fc_group">${groupOptionsHtml(s, card?card.group:0)}</select></div>` : ''}` : '');
  openModal(`<h3>${card ? (isQ?'Edit question':'Edit card') : (isQ?'Add question':'Add card')}</h3>
    ${notice?`<div class="modal-notice">${esc(notice)}</div>`:''}
    ${!ext ? `<p class="modal-sub" style="margin:0 0 10px;">Run <b>migration_reviewers.sql</b> in Supabase to turn on lessons, semesters and quiz groups.</p>`:''}
    <div class="form-grid">
      ${subjectField}
      <div><label>Question</label><textarea id="fc_q" rows="3" placeholder="The question (front of the card)">${esc(card?card.q:'')}</textarea></div>
      <div><label>Answer</label><textarea id="fc_a" rows="3" placeholder="The answer (back of the card)">${esc(card?card.a:'')}</textarea></div>
      <div><label>Image link (optional)</label><input id="fc_img" value="${esc(card?card.image:'')}" placeholder="Direct image link — shows with the question"></div>
      ${placeField}
    </div>
    <div class="modal-actions">
      ${card
        ? `<button class="btn" onclick="saveFlashcard('${card.id}')">Save changes</button>`
        : `<button class="btn" onclick="saveFlashcard(null,false)">${isQ?'Add question':'Add card'}</button>
           <button class="btn ghost" onclick="saveFlashcard(null,true)">Add &amp; next</button>`}
    </div>`);
  setTimeout(()=>{ const q = document.getElementById('fc_q'); if(q) q.focus(); }, 60);
}
function readPlace(s){
  const out = {};
  const semEl = document.getElementById('fc_sem'), lsEl = document.getElementById('fc_lesson'), gEl = document.getElementById('fc_group');
  if(semEl) out.semester_id = semEl.value;
  if(lsEl) out.lesson = Math.max(1, parseInt(lsEl.value, 10) || 1);
  if(gEl) out.quiz_group = parseInt(gEl.value, 10) || 0;
  return out;
}
function subjectRowFor(s, semesterId){
  const r = s.rows.find(x=>x.semesterId===semesterId) || s.rows[0];
  return r.id;
}
async function saveFlashcard(cardId, addAnother){
  const key = document.getElementById('fc_subject').value;
  const s = revSubjects().find(x=>x.key===key);
  const q = document.getElementById('fc_q').value.trim();
  const a = document.getElementById('fc_a').value.trim();
  const img = document.getElementById('fc_img').value.trim();
  if(!q || !a){ alert('Fill in both the question and the answer.'); return; }
  const place = readPlace(s);
  if(cardId){
    await dbUpdateFlashcard(cardId, Object.assign({question:q, answer:a, image_url:img}, place));
  } else {
    await dbAddFlashcard(subjectRowFor(s, place.semester_id), q, a, img, place);
  }
  await refreshCurrentSchool();
  if(addAnother){
    rerender();
    openFlashcardModal(null, (revMode==='quiz'?'Question':'Card')+' added. Add another, or close when you’re done.',
      {semesterId: place.semester_id, lesson: place.lesson});
  } else {
    closeModal();
    rerender();
  }
}
async function deleteFlashcard(id){
  if(!confirm('Delete this flashcard? Its quiz question goes with it.')) return;
  await dbDeleteFlashcard(id);
  await refreshCurrentSchool();
  selIds.delete(id);
  renderReviewers();
}
async function setCardGroup(id, val){
  await dbUpdateFlashcard(id, {quiz_group: parseInt(val, 10) || 0});
  await refreshCurrentSchool();
  renderReviewers();
}

/* ---- Select / transfer / group / delete (edit mode) ---- */
function toggleSelMode(){ selMode = !selMode; selIds = new Set(); renderReviewers(); }
function toggleSel(id){ if(selIds.has(id)) selIds.delete(id); else selIds.add(id); renderReviewers(); }
function selectAllShown(){
  const s = revSubject(); if(!s) return;
  const all = scopeCards(s);
  if(selIds.size===all.length) selIds = new Set(); else selIds = new Set(all.map(c=>c.id));
  renderReviewers();
}
function lessonOptionsHtml(s, sem, chosen){
  const list = lessonsOf(s, sem);
  const next = (list.length ? list[list.length-1] : 0) + 1;
  let h = list.map(n=>`<option value="${n}" ${n===chosen?'selected':''}>Lesson ${n}</option>`).join('');
  h += `<option value="${next}" ${!list.length||chosen===next?'selected':''}>New lesson ${next}</option>`;
  return h;
}
function openTransfer(){
  const s = revSubject();
  if(!s || !selIds.size){ showToast('Select some cards first'); return; }
  const sem = (revSem && revSem!=='all') ? revSem : (S().semesterId || (revSemesters()[0]||{}).id);
  openModal(`<h3>Transfer ${noun(selIds.size, 'card', 'cards')}</h3>
    <p class="modal-sub">The questions, answers and images move together — the mock quiz follows the flashcards.</p>
    <div class="form-grid">
      ${revHasSem() ? `<div><label>Semester</label><select id="tr_sem" onchange="refreshTransferLessons()">${revSemesters().map(m=>`<option value="${m.id}" ${m.id===sem?'selected':''}>${esc(m.name)}</option>`).join('')}</select></div>` : ''}
      <div><label>Lesson</label><select id="tr_lesson">${lessonOptionsHtml(s, sem, null)}</select></div>
    </div>
    <div class="modal-actions"><button class="btn" onclick="doTransfer()">Transfer</button></div>`);
}
function refreshTransferLessons(){
  const s = revSubject(), sem = document.getElementById('tr_sem').value;
  document.getElementById('tr_lesson').innerHTML = lessonOptionsHtml(s, sem, null);
}
async function doTransfer(){
  const semEl = document.getElementById('tr_sem');
  const lesson = parseInt(document.getElementById('tr_lesson').value, 10) || 1;
  const fields = {lesson};
  if(semEl) fields.semester_id = semEl.value;
  const ids = [...selIds];
  for(const id of ids) await dbUpdateFlashcard(id, fields);
  await refreshCurrentSchool();
  closeModal(); clearSel();
  showToast(`Moved ${noun(ids.length, 'card', 'cards')}` + (semEl ? ' to ' + semNameOf(semEl.value) : '') + ` · Lesson ${lesson}`);
  renderReviewers();
}
function openBulkGroup(){
  const s = revSubject();
  if(!s || !selIds.size){ showToast('Select some questions first'); return; }
  openModal(`<h3>Group ${noun(selIds.size, 'question', 'questions')}</h3>
    <p class="modal-sub">Questions in a group only get their wrong choices from the same group. “No group” mixes with everything (always 4 choices).</p>
    <div class="form-grid"><select id="bg_group">${groupOptionsHtml(s, 0)}</select></div>
    <div class="modal-actions"><button class="btn" onclick="doBulkGroup()">Apply</button></div>`);
}
async function doBulkGroup(){
  const g = parseInt(document.getElementById('bg_group').value, 10) || 0;
  const ids = [...selIds];
  for(const id of ids) await dbUpdateFlashcard(id, {quiz_group: g});
  await refreshCurrentSchool();
  closeModal(); clearSel();
  renderReviewers();
}
async function bulkDelete(){
  if(!selIds.size) return;
  if(!confirm(`Delete ${noun(selIds.size, 'card', 'cards')}? Their quiz questions go too.`)) return;
  const ids = [...selIds];
  for(const id of ids) await dbDeleteFlashcard(id);
  await refreshCurrentSchool();
  clearSel();
  renderReviewers();
}

/* ---- Paste-in format (notebook button) ---- */
const AI_PROMPT = 'Turn the notes below into flashcards. Reply with ONLY lines in this exact format, one flashcard per line:\n' +
  'Group Number && Question && Answer && Image Link\n' +
  'Rules: Group Number is a whole number (put questions whose answers belong together in the same number, or use 0 if unsure). ' +
  'Leave Image Link empty if there is none. Do not add any other text, numbering or bullets.\n\nNotes:\n';
function openFormatBox(){
  if(revSubjects().length===0){ alert('Add a subject first (Schedule page).'); return; }
  const s = revSubject();
  const sem = (revSem && revSem!=='all') ? revSem : (S().semesterId || (revSemesters()[0]||{}).id);
  const lesson = (revLesson && revLesson!=='all') ? revLesson : 1;
  const ext = revExt();
  openModal(`<h3>Paste cards</h3>
    <div class="format-box">
      <p>Write one card per line and separate the parts with <b>&amp;&amp;</b>:</p>
      <code>Group Number &amp;&amp; Question &amp;&amp; Answer &amp;&amp; Image Link</code>
      <ul>
        <li><b>Group Number</b> – questions with the same number get their multiple-choice answers from each other. Use <b>0</b> or leave it empty for no group.</li>
        <li><b>Image Link</b> – optional. Leave it out if there is no picture.</li>
      </ul>
      <pre>1 &amp;&amp; Capital of France? &amp;&amp; Paris
1 &amp;&amp; Capital of Italy? &amp;&amp; Rome &amp;&amp; https://site.com/rome.jpg
0 &amp;&amp; Who wrote Noli Me Tangere? &amp;&amp; José Rizal</pre>
      <p class="modal-sub" style="margin:8px 0 0;">Using AI or your notes? Copy the prompt, paste it with your notes into the AI, then paste its answer below.</p>
      <button class="btn ghost sm" onclick="copyAiPrompt()">Copy AI prompt</button>
    </div>
    <div class="form-grid" style="margin-top:12px;">
      ${s ? `<div><span class="modal-subject" style="--subj:${safeColor(s.color)};">${esc(s.name)}</span><input type="hidden" id="im_subject" value="${esc(s.key)}"></div>`
          : `<div><label>Subject</label><select id="im_subject">${revSubjects().map(x=>`<option value="${esc(x.key)}">${esc(x.name)}</option>`).join('')}</select></div>`}
      ${ext ? `<div class="two-col">
        ${revHasSem() ? `<div><label>Semester</label><select id="im_sem">${revSemesters().map(m=>`<option value="${m.id}" ${m.id===sem?'selected':''}>${esc(m.name)}</option>`).join('')}</select></div>` : ''}
        <div><label>Lesson</label><input id="im_lesson" type="number" min="1" max="999" inputmode="numeric" value="${lesson}"></div></div>` : ''}
      <textarea id="im_text" rows="7" placeholder="Paste your lines here"></textarea>
      <div id="im_result" class="modal-sub" style="margin:0;"></div>
    </div>
    <div class="modal-actions"><button class="btn" onclick="doImport()">Create cards</button></div>`);
}
function copyAiPrompt(){
  const done = ()=>showToast('Prompt copied');
  try{ navigator.clipboard.writeText(AI_PROMPT).then(done, ()=>fallbackCopy()); }catch(e){ fallbackCopy(); }
  function fallbackCopy(){
    const ta = document.createElement('textarea'); ta.value = AI_PROMPT; document.body.appendChild(ta); ta.select();
    try{ document.execCommand('copy'); done(); }catch(e){ showToast('Could not copy'); }
    ta.remove();
  }
}
// "1 && Question && Answer && link"  (also "Question && Answer")
function parseImportText(text){
  const cards = [], bad = [];
  String(text||'').split(/\r?\n/).forEach((raw, i)=>{
    let line = raw.trim().replace(/^[-*•]\s+/, '');
    if(!line || line.startsWith('#')) return;
    const p = line.split('&&').map(x=>x.trim());
    let group = 0, q, a, img = '';
    if(p.length===2){ [q, a] = p; }
    else if(p.length>=3 && (p[0]==='' || /^\d+$/.test(p[0]))){ group = parseInt(p[0], 10) || 0; q = p[1]; a = p[2]; img = p[3] || ''; }
    else if(p.length===3 && /^https?:\/\//i.test(p[2])){ q = p[0]; a = p[1]; img = p[2]; }
    else { bad.push(i+1); return; }
    if(!q || !a){ bad.push(i+1); return; }
    cards.push({q, a, img, group});
  });
  return {cards, bad};
}
async function doImport(){
  const key = document.getElementById('im_subject').value;
  const s = revSubjects().find(x=>x.key===key);
  const {cards, bad} = parseImportText(document.getElementById('im_text').value);
  const res = document.getElementById('im_result');
  if(!cards.length){ res.textContent = bad.length ? `Couldn't read line${bad.length===1?'':'s'} ${bad.slice(0,8).join(', ')}. Use: Group Number && Question && Answer && Image Link` : 'Paste at least one line first.'; return; }
  const semEl = document.getElementById('im_sem'), lsEl = document.getElementById('im_lesson');
  const semId = semEl ? semEl.value : null;
  const lesson = lsEl ? Math.max(1, parseInt(lsEl.value, 10) || 1) : 1;
  const row = subjectRowFor(s, semId);
  let made = 0;
  for(const c of cards){
    const extra = {}; if(semId) extra.semester_id = semId; if(lsEl) extra.lesson = lesson; extra.quiz_group = c.group;
    const ok = await dbAddFlashcard(row, c.q, c.a, c.img, extra, true);
    if(ok) made++;
  }
  await refreshCurrentSchool();
  closeModal();
  showToast(`Created ${noun(made, 'card', 'cards')}` + (bad.length ? ` · skipped ${noun(bad.length, 'line', 'lines')}` : '') + ' — they are in the mock quiz too');
  rerender();
}

/* ---- Flashcard round ---- */
function startFlash(onlyIds){
  const s = revSubject(); if(!s) return;
  const pool = scopeCards(s).filter(c=>!onlyIds || onlyIds.includes(c.id));
  fc = {ids: shuffle(pool.map(c=>c.id)), pos:0, flipped:false, right:0, wrong:0, missed:[], practice:!!onlyIds, saved:false, timedOut:false, secondsLeft:0};
  studyStage = 'active';
  if(revTimed){
    fc.secondsLeft = revMinutes*60;
    flashTimerId = setInterval(()=>{
      if(!fc){ clearInterval(flashTimerId); flashTimerId = null; return; }
      fc.secondsLeft--;
      if(fc.secondsLeft<=0){
        fc.secondsLeft = 0; clearInterval(flashTimerId); flashTimerId = null;
        const left = fc.ids.length - fc.pos;
        if(left>0){ fc.wrong += left; fc.timedOut = left; fc.pos = fc.ids.length; }
        finishFlash(); renderReviewers();
        return;
      }
      const el = document.getElementById('flashTimerDisplay');
      if(el) el.textContent = formatQuizTime(fc.secondsLeft);
    }, 1000);
  }
  renderReviewers();
}
function flashFlip(){ if(fc){ fc.flipped = !fc.flipped; renderReviewers(); } }
function flashJudge(ok){
  if(!fc || !fc.flipped) return;
  const id = fc.ids[fc.pos];
  if(ok) fc.right++; else { fc.wrong++; fc.missed.push(id); }
  fc.pos++; fc.flipped = false;
  if(fc.pos>=fc.ids.length){ if(flashTimerId){ clearInterval(flashTimerId); flashTimerId = null; } finishFlash(); }
  renderReviewers();
}
function finishFlash(){
  if(!fc || fc.saved) return;
  fc.saved = true;
  if(!fc.practice && (fc.right+fc.wrong)>0){
    const s = revSubject();
    histAdd({kind:'flash', subjectId:revKey, subject:s?s.name:'', scope:scopeLabel(), correct:fc.right, wrong:fc.wrong, total:fc.right+fc.wrong});
  }
}

function resultBox(title, right, wrong, note){
  const total = right+wrong, pct = total ? Math.round(right/total*100) : 0;
  return `<div class="result-box">
    <div class="result-ring" style="--p:${pct}"><span>${pct}%</span></div>
    <h3>${esc(title)}</h3>
    <div class="result-stats">
      <div class="rs good"><b>${right}</b><span>Correct</span></div>
      <div class="rs bad"><b>${wrong}</b><span>Wrong</span></div>
    </div>
    ${note ? `<p class="result-note">${esc(note)}</p>` : ''}
  </div>`;
}

function renderFlashRound(s){
  let html = `<button class="btn ghost sm" onclick="revBack()" style="margin-bottom:16px;">‹ Back</button>
    <div class="section-label" style="margin-top:0;">${esc(s.name)}${scopeLabel() ? ' · ' + esc(scopeLabel()) : ''}</div>`;
  while(fc.pos<fc.ids.length && !s.cards.some(c=>c.id===fc.ids[fc.pos])) fc.pos++;
  if(fc.pos>=fc.ids.length){
    finishFlash();
    const total = fc.right+fc.wrong;
    let note = total===0 ? 'Nothing to review.' : (fc.practice ? 'Practice rounds are not added to your history.' : 'Saved to your history progress.');
    if(fc.timedOut) note = `Time’s up — ${noun(fc.timedOut, 'card', 'cards')} not answered counted as wrong. ` + note;
    html += resultBox(fc.practice ? 'Practice finished' : (fc.timedOut ? 'Time’s up' : 'Round complete'), fc.right, fc.wrong, note);
    html += `<div class="result-actions">
      <button class="btn" onclick="startFlash()">Study again</button>
      ${fc.missed.length ? `<button class="btn ghost" onclick="startFlash(fc.missed.slice())">Practice missed (${fc.missed.length})</button>` : ''}
      <button class="btn ghost" onclick="revBack()">Back</button>
    </div>`;
    return html;
  }
  const c = s.cards.find(x=>x.id===fc.ids[fc.pos]);
  const total = fc.ids.length;
  const imgHtml = c.image ? `<img loading="lazy" decoding="async" src="${safeUrl(c.image)}" alt="" style="max-width:100%;max-height:180px;border-radius:12px;margin-bottom:14px;object-fit:contain;">` : '';
  html += `<div class="flash-progress"><span>${fc.pos+1} / ${total}</span><div class="bar"><i style="width:${Math.round(fc.pos/total*100)}%"></i></div>
      ${revTimed?`<span id="flashTimerDisplay" class="tag due" style="font-family:'Manrope';font-weight:700;margin:0;">${formatQuizTime(fc.secondsLeft)}</span>`:''}</div>
    <div class="flash-card ${fc.flipped?'is-flipped':''}" onclick="flashFlip()">
      <div style="display:flex;flex-direction:column;align-items:center;">${fc.flipped ? '' : imgHtml}<div>${esc(fc.flipped ? c.a : c.q)}</div></div>
    </div>`;
  if(!fc.flipped){
    html += `<p class="flash-hint">Tap the card to see the answer</p>`;
  } else {
    html += `<div class="flash-judge">
      <button class="judge wrong" onclick="flashJudge(false)" aria-label="I missed it"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      <button class="judge right" onclick="flashJudge(true)" aria-label="I got it"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></button>
    </div>`;
  }
  return html;
}

/* ---- Study setup (timer choice) ---- */
function renderStudySetup(s, count, title, extraNote){
  return `
    <button class="btn ghost sm" onclick="revBack()" style="margin-bottom:16px;">‹ Back</button>
    <div class="card">
      <h3>${esc(s.name)} — ${title}</h3>
      <p style="color:var(--ink-soft);font-size:calc(13px * var(--fs));margin-bottom:4px;">${esc(scopeLabel())}</p>
      <p style="color:var(--ink-soft);font-size:calc(13px * var(--fs));">${noun(count, revMode==='quiz'?'question':'card', revMode==='quiz'?'questions':'cards')} ready.${extraNote||''}</p>
      ${count===0 ? `<p style="color:var(--ink-soft);margin-top:12px;">${revMode==='quiz' ? 'Add at least 2 flashcards with different answers here to unlock the mock quiz.' : 'No flashcards here yet.'}</p>` : `
      <div class="section-label" style="margin-top:18px;">Timer</div>
      <div class="quiz-setup-options">
        <button class="quiz-setup-opt ${!revTimed?'active':''}" onclick="revTimed=false;renderReviewers()">No Timer</button>
        <button class="quiz-setup-opt ${revTimed?'active':''}" onclick="revTimed=true;renderReviewers()">Timer</button>
      </div>
      ${revTimed?`
        <div class="section-label">Minutes</div>
        <input type="number" min="1" max="180" value="${revMinutes}" style="max-width:130px;" onchange="revMinutes=Math.max(1,parseInt(this.value)||10)">
      `:''}
      <button class="btn" style="margin-top:20px;display:block;width:100%;" onclick="${revMode==='quiz' ? 'startQuiz()' : 'startFlash()'}">${revMode==='quiz' ? 'Start Quiz' : 'Start'}</button>
      `}
    </div>`;
}

/* =========================================================
   MAIN RENDER
========================================================= */
function renderReviewers(){
  const study = revMode==='flashcards' || revMode==='quiz';
  const addLabel = revMode==='quiz' ? '+ Add question' : '+ Add card';
  const icoTimer = `<svg viewBox="0 0 24 24"><circle cx="12" cy="13.5" r="7.5"/><path d="M12 9.5v4l2.5 1.5M9.5 2.5h5M12 2.5v3.5"/></svg>`;
  const icoProg = `<svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>`;
  let html = `<div class="rev-tabs">
    <button class="rev-tab ${revMode==='flashcards'?'active':''}" onclick="revSetMode('flashcards')">Flashcards</button>
    ${(isAdmin && study) ? `<button class="rev-add" onclick="openReviewerAdd()">${addLabel}</button>` : ''}
    <button class="rev-tab ${revMode==='quiz'?'active':''}" onclick="revSetMode('quiz')">Mock Quiz</button>
  </div>
  <div class="rev-tools">
    <button class="rev-tool ${revMode==='pomodoro'?'active':''}" onclick="revSetMode('pomodoro')">${icoTimer}<span>Pomodoro Timer</span></button>
    <button class="rev-tool ${revMode==='history'?'active':''}" onclick="revSetMode('history')">${icoProg}<span>History Progress</span></button>
  </div>`;

  if(revMode==='pomodoro'){ setPageContent(html + pomodoroHtml()); return; }
  if(revMode==='history'){ setPageContent(html + historyHtml()); return; }

  if(revSubjects().length===0){
    setPageContent(html + `<p style="color:var(--ink-soft);">No subjects yet.</p>`);
    return;
  }
  // a subject that no longer exists (e.g. after switching school)
  if(revKey && !revSubject()){ revKey = null; revSem = null; revLesson = null; }

  const icoNote = `<svg viewBox="0 0 24 24"><path d="M6 3h11a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6zM6 3v18M10 8h5M10 12h5"/></svg>`;
  if(isAdmin){
    html += `<div class="edit-tools">
      ${scopeChosen() ? `<button class="tool-btn ${selMode?'on':''}" onclick="toggleSelMode()" aria-label="Select cards"><svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12.5l3 3 5-6"/></svg><span>${selMode?'Done':'Select'}</span></button>` : ''}
      <button class="tool-btn" onclick="openFormatBox()" aria-label="Paste format">${icoNote}<span>Format</span></button>
    </div>`;
  }

  const s = revSubject();
  if(!s){ setPageContent(html + renderRevSubjectList()); return; }
  if(revSem===null){ setPageContent(html + renderSemesterList(s)); return; }
  if(revLesson===null){ setPageContent(html + renderLessonList(s)); return; }

  // ---- scope chosen ----
  if(isAdmin){
    setPageContent(html + (revMode==='quiz' ? renderQuizEditList(s) : renderCardEditList(s)));
    return;
  }
  const cards = scopeCards(s);
  if(revMode==='flashcards'){
    if(studyStage==='active' && fc) html += renderFlashRound(s);
    else html += renderStudySetup(s, cards.length, 'Flashcards');
  } else {
    if(studyStage==='setup'){
      const built = buildQuiz(s, cards);
      html += renderStudySetup(s, built.questions.length, 'Mock Quiz',
        built.skipped ? ` ${noun(built.skipped, 'card', 'cards')} can’t be a question yet (a group needs at least 2 different answers).` : '');
    }
    else if(studyStage==='active') html += renderQuizActive(s);
    else html += renderQuizResults(s);
  }
  setPageContent(html);
}

/* ---- navigation lists ---- */
function navRow(onclick, colorOrNull, title, sub){
  return `<div class="hub-row ${colorOrNull?'colored':''}" ${colorOrNull?`style="--c:${safeColor(colorOrNull)}"`:''} onclick="${onclick}">
    <div class="hub-text"><h4>${title}</h4><p>${sub}</p></div><span class="hub-arrow">›</span></div>`;
}
function renderRevSubjectList(){
  let html = `<div class="section-label">${isAdmin ? 'Choose a subject to manage' : (revMode==='flashcards' ? 'Choose a subject to review' : 'Choose a subject to test yourself')}</div><div class="hub-list">`;
  revSubjects().forEach((s, i)=>{
    const last = (!isAdmin) ? histLast(s.key, revMode==='flashcards' ? 'flash' : 'quiz') : null;
    let line = noun(s.cards.length, revMode==='quiz'?'question':'flashcard', revMode==='quiz'?'questions':'flashcards');
    if(last!==null) line += ` · last ${last}%`;
    html += navRow(`revOpenSubject(${i})`, s.color, esc(s.name), line);
  });
  return html + `</div>`;
}
function backBtn(){ return `<button class="btn ghost sm" onclick="revBack()" style="margin-bottom:16px;">‹ Back</button>`; }
function renderSemesterList(s){
  let html = backBtn() + `<div class="section-label" style="margin-top:0;">${esc(s.name)}</div><div class="hub-list">`;
  revSemesters().forEach(m=>{
    const n = s.cards.filter(c=>c.semesterId===m.id).length;
    html += navRow(`revPickSem('${m.id}')`, null, esc(m.name), noun(n, revMode==='quiz'?'question':'card', revMode==='quiz'?'questions':'cards'));
  });
  html += navRow(`revPickSem('all')`, null, 'All Semester', noun(s.cards.length, revMode==='quiz'?'question':'card', revMode==='quiz'?'questions':'cards') + ' from every semester');
  return html + `</div>`;
}
function renderLessonList(s){
  const lessons = lessonsOf(s, revSem);
  const inSem = s.cards.filter(c=>c.semesterId===revSem);
  const what = n => noun(n, revMode==='quiz'?'question':'card', revMode==='quiz'?'questions':'cards');
  let html = backBtn() + `<div class="section-label" style="margin-top:0;">${esc(s.name)} · ${esc(semNameOf(revSem))}</div><div class="hub-list">`;
  lessons.forEach(n=>{ html += navRow(`revPickLesson(${n})`, null, 'Lesson ' + n, what(inSem.filter(c=>c.lesson===n).length)); });
  html += navRow(`revPickLesson('all')`, null, 'All Lesson', what(inSem.length) + ' in this semester');
  html += `</div>`;
  if(!lessons.length) html += `<p style="color:var(--ink-soft);margin-top:14px;">No lessons yet in this semester.${isAdmin ? ' Add a card to start Lesson 1.' : ''}</p>`;
  if(isAdmin){
    const next = (lessons.length ? lessons[lessons.length-1] : 0) + 1;
    html += `<button class="btn ghost sm" style="margin-top:14px;" onclick="openFlashcardModal(null,null,{semesterId:'${revSem}',lesson:${next}})">+ New lesson ${next}</button>`;
  }
  return html;
}

/* ---- edit lists ---- */
function selBar(s, cards, quiz){
  const ico = {
    transfer: `<svg viewBox="0 0 24 24"><path d="M4 8h14M14 4l4 4-4 4M20 16H6M10 12l-4 4 4 4"/></svg>`,
    group: `<svg viewBox="0 0 24 24"><circle cx="8" cy="8" r="3.2"/><circle cx="16.5" cy="9" r="2.6"/><path d="M2.5 19c.4-3 2.6-4.8 5.5-4.8s5.1 1.8 5.5 4.8M14.5 14.6c2.7-.5 5.4.9 6 4.4"/></svg>`,
    del: `<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg>`
  };
  if(!selMode) return '';
  return `<div class="sel-bar">
    <button class="link-quiet" onclick="selectAllShown()">${selIds.size===cards.length && cards.length ? 'Clear all' : 'Select all'}</button>
    <span>${selIds.size} selected</span>
    <div class="sel-actions">
      <button onclick="openTransfer()" aria-label="Transfer" title="Transfer to a semester + lesson" ${selIds.size?'':'disabled'}>${ico.transfer}</button>
      ${quiz && revExt() ? `<button onclick="openBulkGroup()" aria-label="Group" title="Set quiz group" ${selIds.size?'':'disabled'}>${ico.group}</button>` : ''}
      <button class="danger" onclick="bulkDelete()" aria-label="Delete" title="Delete" ${selIds.size?'':'disabled'}>${ico.del}</button>
    </div>
  </div>`;
}
function whereTag(c){
  const bits = [];
  if(revSem==='all' && revHasSem()) bits.push(semNameOf(c.semesterId));
  if(revExt() && revLesson==='all') bits.push('Lesson ' + c.lesson);
  return bits.length ? `<span class="where-tag">${esc(bits.join(' · '))}</span>` : '';
}
function cardRowShell(c, inner, actions){
  const on = selIds.has(c.id);
  return `<div class="card-row ${selMode?'selectable':''} ${on?'selected':''}" ${selMode?`onclick="toggleSel('${c.id}')"`:''}>
    ${selMode ? `<span class="sel-box ${on?'on':''}"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>` : ''}
    <div class="card-row-body">${inner}</div>
    ${selMode ? '' : `<div class="card-row-actions">${actions}</div>`}
  </div>`;
}
function renderCardEditList(s){
  const cards = scopeCards(s);
  let html = backBtn() + `<div class="section-label" style="margin-top:0;">${esc(s.name)}${scopeLabel() ? ' · ' + esc(scopeLabel()) : ''}</div>`;
  html += selBar(s, cards, false);
  if(!cards.length) return html + `<p style="color:var(--ink-soft);">No flashcards here yet. Use + Add card, or the Format button to paste many at once.</p>`;
  html += `<div class="card-list">` + cards.map(c=>cardRowShell(c, `
      ${whereTag(c)}${c.group ? `<span class="group-chip">Group ${c.group}</span>` : ''}
      <div class="cr-q">${esc(c.q)}</div>
      <div class="cr-a">${esc(c.a)}</div>
      ${c.image ? `<img class="cr-img" loading="lazy" decoding="async" src="${safeUrl(c.image)}" alt="">` : ''}`,
    `<button class="icon-btn" onclick="event.stopPropagation();openFlashcardModal('${c.id}')" aria-label="Edit">✎</button>
     <button class="icon-btn danger" onclick="event.stopPropagation();deleteFlashcard('${c.id}')" aria-label="Delete">✕</button>`)).join('') + `</div>`;
  return html;
}
function choiceCount(s, c){
  const all = s.cards.filter(x=>x.q && x.a);
  const pool = new Set();
  const mates = c.group ? all.filter(x=>x.group===c.group && x.id!==c.id) : all.filter(x=>x.id!==c.id);
  mates.forEach(x=>{ const k = normAns(x.a); if(k && k!==normAns(c.a)) pool.add(k); });
  return Math.min(4, pool.size + 1);
}
function renderQuizEditList(s){
  const cards = scopeCards(s);
  const g = groupsOf(s), nums = Object.keys(g).map(Number).sort((a,b)=>a-b);
  let html = backBtn() + `<div class="section-label" style="margin-top:0;">${esc(s.name)}${scopeLabel() ? ' · ' + esc(scopeLabel()) : ''}</div>`;
  if(revExt()){
    html += `<p class="modal-sub" style="margin:0 0 10px;">Put questions in a group so their multiple-choice answers only come from that group. No group = answers come from everything (4 choices).</p>
      <div class="group-summary">${nums.length ? nums.map(n=>`<span class="group-chip">Group ${n} · ${g[n]}</span>`).join('') : '<span style="color:var(--ink-soft);font-size:calc(12.5px * var(--fs));">No groups yet — pick “New group” on a question, or use Select → group icon.</span>'}</div>`;
  }
  html += selBar(s, cards, true);
  if(!cards.length) return html + `<p style="color:var(--ink-soft);">No questions here yet. Questions are your flashcards — add one with + Add question.</p>`;
  html += `<div class="card-list">` + cards.map(c=>{
    const n = choiceCount(s, c);
    const warn = n<2;
    return cardRowShell(c, `
      ${whereTag(c)}
      <div class="cr-q">${esc(c.q)}</div>
      ${c.image ? `<img class="cr-img" loading="lazy" decoding="async" src="${safeUrl(c.image)}" alt="">` : ''}
      <div class="cr-a">✓ ${esc(c.a)}</div>
      <div class="cr-meta ${warn?'warn':''}">${warn ? 'Needs at least 2 different answers in its group' : n + ' choices'}</div>
      ${revExt() && !selMode ? `<select class="group-select" onclick="event.stopPropagation()" onchange="setCardGroup('${c.id}', this.value)">${groupOptionsHtml(s, c.group)}</select>` : (c.group ? `<span class="group-chip">Group ${c.group}</span>` : '')}`,
    `<button class="icon-btn" onclick="event.stopPropagation();openFlashcardModal('${c.id}')" aria-label="Edit">✎</button>
     <button class="icon-btn danger" onclick="event.stopPropagation();deleteFlashcard('${c.id}')" aria-label="Delete">✕</button>`);
  }).join('') + `</div>`;
  return html;
}

/* =========================================================
   MOCK QUIZ (made from flashcards)
   - Same answer text (any capitals / spacing) never appears twice in one question.
   - A question with a group takes its other choices only from that group
     (2–4 choices, depending on how many different answers the group has).
   - A question with no group gets 4 choices picked at random.
========================================================= */
function buildQuiz(s, cards){
  const all = s.cards.filter(c=>c.q && c.a);
  const others = [];
  revSubjects().forEach(o=>{ if(o.key!==s.key) o.cards.forEach(c=>{ if(c.a) others.push(c.a); }); });
  const out = []; let skipped = 0;
  (cards || all).filter(c=>c.q && c.a).forEach(c=>{
    const seen = new Set([normAns(c.a)]);
    const wrong = [];
    const take = list=>{
      for(const a of shuffle(list)){
        if(wrong.length>=3) break;
        const k = normAns(a);
        if(!k || seen.has(k)) continue;
        seen.add(k); wrong.push(a);
      }
    };
    if(c.group){
      take(all.filter(o=>o.group===c.group && o.id!==c.id).map(o=>o.a));
    } else {
      take(all.filter(o=>o.id!==c.id).map(o=>o.a));
      if(wrong.length<3) take(others);
    }
    if(!wrong.length){ skipped++; return; }
    const choices = shuffle([c.a].concat(wrong));
    out.push({id:c.id, q:c.q, choices, answer:choices.indexOf(c.a), image:c.image});
  });
  return {questions: shuffle(out), skipped};
}

function startQuiz(){
  const s = revSubject(); if(!s) return;
  const built = buildQuiz(s, scopeCards(s));
  quizQuestions = built.questions; quizSkipped = built.skipped;
  if(!quizQuestions.length){ renderReviewers(); return; }
  quizIndex = 0;
  quizAnswers = new Array(quizQuestions.length).fill(null);
  studyStage = 'active';
  if(revTimed){
    quizSecondsLeft = revMinutes*60;
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

function renderQuizActive(s){
  const q = quizQuestions[quizIndex];
  const selected = quizAnswers[quizIndex];
  return `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
      <span style="font-size:calc(12.5px * var(--fs));color:var(--ink-soft);">Question ${quizIndex+1} of ${quizQuestions.length}</span>
      ${revTimed?`<span id="quizTimerDisplay" class="tag due" style="font-family:'Manrope';font-weight:700;">${formatQuizTime(quizSecondsLeft)}</span>`:''}
    </div>
    <div class="card">
      ${q.image?`<img loading="lazy" decoding="async" src="${safeUrl(q.image)}" alt="" style="max-width:100%;max-height:220px;border-radius:12px;margin-bottom:10px;object-fit:contain;display:block;">`:''}
      <div class="quiz-q">${esc(q.q)}</div>
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
  if(studyStage!=='active') return;
  studyStage = 'results';
  let correct = 0;
  quizQuestions.forEach((q,i)=>{ if(quizAnswers[i]===q.answer) correct++; });
  const s = revSubject();
  histAdd({kind:'quiz', subjectId:revKey, subject:s?s.name:'', scope:scopeLabel(), correct, wrong:quizQuestions.length-correct, total:quizQuestions.length});
  renderReviewers();
}

function renderQuizResults(s){
  let correct = 0;
  quizQuestions.forEach((q,i)=>{ if(quizAnswers[i]===q.answer) correct++; });
  const wrong = quizQuestions.length - correct;
  let html = resultBox('Quiz results', correct, wrong, 'Saved to your history progress.') + `<div class="section-label">Review</div>`;
  quizQuestions.forEach((q,i)=>{
    const userAns = quizAnswers[i];
    const isCorrect = userAns===q.answer;
    html += `<div class="card" style="margin-bottom:10px;">
      <span class="tag ${isCorrect?'':'due'}">${isCorrect?'Correct':(userAns===null?'Skipped':'Incorrect')}</span>
      ${q.image?`<img loading="lazy" decoding="async" src="${safeUrl(q.image)}" alt="" style="max-width:100%;max-height:180px;border-radius:12px;margin-top:8px;object-fit:contain;display:block;">`:''}
      <div class="quiz-q" style="margin-top:8px;font-size:calc(14px * var(--fs));">${i+1}. ${esc(q.q)}</div>
      ${q.choices.map((c,ci)=>{
        let cls = '';
        if(ci===q.answer) cls='correct';
        else if(ci===userAns) cls='wrong';
        return `<div class="quiz-opt ${cls}" style="cursor:default;">${esc(c)}</div>`;
      }).join('')}
    </div>`;
  });
  html += `
    <div class="result-actions">
      <button class="btn" onclick="startQuiz()">Retake</button>
      <button class="btn ghost" onclick="revBack()">Back</button>
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
  navigator.serviceWorker.addEventListener('message', e=>{
    if(e.data==='updated') showToast('A new version is ready — close and reopen the app to use it.', 6000);
  });
}
