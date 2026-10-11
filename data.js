/* =========================================================
   DATA LAYER (Supabase-backed, offline-first)

   - Reads: every successful load is cached in localStorage. If the
     network is down, the cached copy is used.
   - Writes: go straight to Supabase when online. When offline (or the
     request fails because of the network) they are put in a queue
     (saved in localStorage), shown immediately in the app, and sent
     automatically, in order, as soon as the connection is back.
   - Sync dot (top bar): red = offline, yellow = saving, green = online.
========================================================= */

function uid(){
  if(window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c=>{
    const r = Math.random()*16|0; return (c==='x' ? r : (r&3|8)).toString(16);
  });
}
function todayISO(){ return new Date().toISOString().slice(0,10); }

/* ---- localStorage helpers (never throw) ---- */
function lsGet(k, fallback){
  try{ const v = localStorage.getItem(k); return v==null ? (fallback===undefined?null:fallback) : JSON.parse(v); }
  catch(e){ return fallback===undefined ? null : fallback; }
}
function lsSet(k, v){
  try{
    if(v===null || v===undefined) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v));
    return true;
  }catch(e){ return false; }
}

/* ---- Error classification ---- */
function isNetworkError(err){
  if(!err) return false;
  if(err.status===0) return true;
  return /failed to fetch|networkerror|network request failed|load failed|fetch failed|err_internet|timed out|timeout|offline/i.test(String(err.message || err));
}
function isAuthError(err){
  return !!err && (err.code==='42501' || err.status===401 || err.status===403 ||
    /row-level security|jwt|not authorized|permission denied/i.test(String(err.message || '')));
}

/* =========================================================
   CONNECTION STATE + SYNC DOT
========================================================= */
let netDown = false;       // last request failed because of the network
let flushing = false;      // queue is being sent
let activeWrites = 0;      // direct writes in flight
let PENDING = lsGet('shPendingOps', []) || [];   // queued changes waiting to be sent

function syncState(){
  if(!navigator.onLine || netDown) return 'offline';
  if(flushing || activeWrites>0 || PENDING.length) return 'saving';
  return 'online';
}
function syncLabel(){
  const st = syncState(), n = PENDING.length;
  const plural = n===1 ? 'change' : 'changes';
  if(st==='offline') return n ? `Offline · ${n} ${plural} will sync when you're back online` : 'Offline · changes you make will sync later';
  if(st==='saving') return n ? `Saving · ${n} ${plural} waiting` : 'Saving…';
  return 'Online · all changes saved';
}
function updateSyncDot(){
  const el = document.getElementById('syncDot');
  if(!el) return;
  const label = syncLabel();
  el.className = 'sync-dot ' + syncState();
  el.title = label;
  el.setAttribute('aria-label', label);
}
function setNet(ok){
  const wasDown = netDown;
  netDown = !ok;
  updateSyncDot();
  if(ok && wasDown) onBackOnline();
}
function onBackOnline(){
  flushQueue().then(()=>{ if(typeof afterReconnect === 'function') afterReconnect(); });
}
async function probeAndSync(){
  try{
    const {error} = await supabase.from('schools').select('id').limit(1);
    if(error && isNetworkError(error)){ setNet(false); return false; }
    setNet(true);
  }catch(e){ setNet(false); return false; }
  await flushQueue();
  return true;
}
window.addEventListener('online', ()=>{ probeAndSync(); });
window.addEventListener('offline', ()=>{ netDown = true; updateSyncDot(); });
document.addEventListener('visibilitychange', ()=>{ if(!document.hidden && (netDown || PENDING.length)) probeAndSync(); });
setInterval(()=>{ if(!document.hidden && (netDown || PENDING.length)) probeAndSync(); }, 15000);

/* =========================================================
   WRITE QUEUE
========================================================= */
const NO_ID_TABLES = new Set(['rules','schools']);                 // primary key is not a generated "id"
const CREATED_TABLES = new Set(['subjects','semesters','item_types']); // have created_at (used for ordering)

function savePending(){ lsSet('shPendingOps', PENDING); updateSyncDot(); }
function enqueue(op){ PENDING.push(op); savePending(); }
function discardPending(){ PENDING = []; savePending(); }

function applyMatch(q, match){
  (match || []).forEach(([c, v])=>{ q = (v===null) ? q.is(c, null) : q.eq(c, v); });
  return q;
}
async function execOp(op){
  try{
    const t = supabase.from(op.table);
    let q;
    if(op.type==='insert') q = t.insert(op.row);
    else if(op.type==='upsert') q = t.upsert(op.row);
    else if(op.type==='update') q = applyMatch(t.update(op.fields), op.match);
    else if(op.type==='delete') q = applyMatch(t.delete(), op.match);
    const res = await q;
    return {error: (res && res.error) ? res.error : null};
  }catch(e){
    return {error: {message: String((e && e.message) || e)}};
  }
}

// Every change goes through here. Returns {data, error, queued}.
async function mutate(table, type, o){
  o = o || {};
  const op = {qid: uid(), table, type};
  if(type==='insert' || type==='upsert'){
    op.row = Object.assign({}, o.row);
    if(type==='insert' && !NO_ID_TABLES.has(table) && !op.row.id) op.row.id = uid();
    if(type==='insert' && CREATED_TABLES.has(table) && !op.row.created_at) op.row.created_at = new Date().toISOString();
  }
  if(type==='update') op.fields = Object.assign({}, o.fields);
  if(type==='update' || type==='delete') op.match = o.match || [];
  // Remember what the values were when this edit was made, so a later sync can tell
  // whether somebody else changed the same thing in the meantime.
  if(type==='update'){
    const b = o.base || baseValues(table, op.match, op.fields);
    if(b) op.base = b;
  } else if(type==='upsert' && table==='rules'){
    const f = Object.assign({}, op.row); delete f.school_id;
    const b = baseValues(table, [['school_id', op.row.school_id]], f);
    if(b) op.base = b;
  }

  // Older changes still waiting, or we know we are offline: go to the back of the queue so order is kept.
  if(PENDING.length || netDown || !navigator.onLine){
    enqueue(op);
    if(navigator.onLine && !netDown) await flushQueue();
    return {data: op.row || null, error: null, queued: PENDING.some(p=>p.qid===op.qid)};
  }

  activeWrites++; updateSyncDot();
  let res;
  try{ res = await execOp(op); } finally { activeWrites--; }
  if(res.error && isNetworkError(res.error)){
    setNet(false);
    enqueue(op);
    return {data: op.row || null, error: null, queued: true};
  }
  updateSyncDot();
  if(res.error) return {data: null, error: res.error};
  return {data: op.row || null, error: null, queued: false};
}

let authWarned = false;
async function flushQueue(){
  if(flushing || !PENDING.length) return;
  if(!navigator.onLine){ updateSyncDot(); return; }
  flushing = true; updateSyncDot();
  try{
    while(PENDING.length){
      const op = PENDING[0];
      let run = op, found = [];
      if(op.base && (op.type==='update' || op.type==='upsert')){
        const r = await resolveConflicts(op);
        if(r.error){
          if(isNetworkError(r.error)){ setNet(false); break; }
          if(isAuthError(r.error)){
            if(!authWarned && typeof showToast === 'function'){ authWarned = true; showToast('Sign in again to sync your saved changes.'); }
            break;
          }
          // couldn't check: fall back to sending the edit as it is
        } else {
          found = r.conflicts;
          if(r.skip){ PENDING.shift(); savePending(); recordConflicts(op, r, found); continue; }
          run = r.op;
        }
      }
      const {error} = await execOp(run);
      if(error && isNetworkError(error)){ setNet(false); break; }
      if(error && isAuthError(error)){
        // Not signed in (or not an admin) right now: keep the changes safe until the next sign-in.
        if(!authWarned && typeof showToast === 'function'){ authWarned = true; showToast('Sign in again to sync your saved changes.'); }
        break;
      }
      PENDING.shift();
      savePending();
      if(!error && found.length) recordConflicts(op, {cur: run.__cur}, found);
      if(error){
        console.error('Dropped a change that the server rejected:', op, error);
        if(typeof showToast === 'function') showToast("A change couldn't be saved: " + error.message);
      }
    }
    if(!PENDING.length){ authWarned = false; if(netDown) setNet(true); }
  } finally {
    flushing = false; updateSyncDot();
    announceConflicts();
  }
}

/* =========================================================
   EDIT CONFLICTS
   Two admins changed the same thing while one of them was offline.
   - Fields only one person changed are merged automatically.
   - If both changed the same field, the other admin's version is kept (nothing
     is lost) and your version is saved in a list so you can choose "Use mine".
========================================================= */
function cNorm(v){ return v===null || v===undefined ? '' : (typeof v==='object' ? JSON.stringify(v) : String(v)); }
function cSame(a, b){ return cNorm(a)===cNorm(b); }
function conflictsList(){ const l = lsGet('shConflicts', []); return Array.isArray(l) ? l : []; }

function findLocalRows(table, match){
  for(const sid in RAW){
    const st = RAW[sid];
    if(!st) continue;
    if(table==='schools'){ if(st.school && opMatches(st.school, match)) return [st.school]; continue; }
    const rows = (st[table] || []).filter(r=>opMatches(r, match));
    if(rows.length) return rows;
  }
  return [];
}
function baseValues(table, match, fields){
  if(!match || !match.length) return null;
  const rows = findLocalRows(table, match);
  if(rows.length!==1) return null;
  const b = {};
  Object.keys(fields).forEach(k=>{ b[k] = rows[0][k]===undefined ? null : rows[0][k]; });
  return b;
}
function conflictLabel(row){
  return String((row && (row.title || row.name || row.question || row.label || row.full_name)) || '').slice(0, 60);
}
// Compare an offline edit with what the server has now
async function resolveConflicts(op){
  const isUp = op.type==='upsert';
  const match = isUp ? [['school_id', op.row.school_id]] : op.match;
  const mine = isUp ? Object.assign({}, op.row) : op.fields;
  if(isUp) delete mine.school_id;
  let res;
  try{ res = await applyMatch(supabase.from(op.table).select('*'), match).limit(2); }
  catch(e){ return {error: {message: String((e && e.message) || e)}}; }
  if(res.error) return {error: res.error};
  const rows = res.data || [];
  if(!rows.length){
    if(isUp) return {op, conflicts: []};               // nothing on the server yet: just send it
    return {skip:true, deleted:true, conflicts:[{deleted:true}]};
  }
  if(rows.length>1) return {op, conflicts: []};
  const cur = rows[0], merged = {}, conflicts = [];
  Object.keys(mine).forEach(k=>{
    const base = op.base[k];
    if(cSame(cur[k], mine[k])) return;                 // already the same on the server
    if(cSame(cur[k], base)) merged[k] = mine[k];       // nobody else touched it: apply mine
    else conflicts.push({field:k, mine:mine[k], theirs:cur[k]});
  });
  if(!Object.keys(merged).length) return {skip:true, cur, conflicts};
  const run = isUp ? Object.assign({}, op, {row: Object.assign({school_id: op.row.school_id}, merged)})
                   : Object.assign({}, op, {fields: merged});
  run.__cur = cur;
  return {op: run, cur, conflicts};
}
function recordConflicts(op, r, found){
  if(!found || !found.length) return;
  const list = conflictsList();
  const cur = r && r.cur;
  const match = op.type==='upsert' ? [['school_id', op.row.school_id]] : op.match;
  found.forEach(c=>{
    list.push({id: uid(), t: Date.now(), table: op.table, match, label: conflictLabel(cur),
      field: c.field, mine: c.mine, theirs: c.theirs, deleted: !!c.deleted});
  });
  lsSet('shConflicts', list.slice(-50));
  conflictsNew += found.length;
}
let conflictsNew = 0;
function announceConflicts(){
  if(!conflictsNew) return;
  const n = conflictsNew; conflictsNew = 0;
  if(typeof onConflictsFound === 'function') onConflictsFound(n);
}

/* =========================================================
   LOCAL STORE  (a flat copy of the tables, cached per school)
========================================================= */
const CHILD_TABLES = ['schedule_slots','syllabus_files','materials','flashcards','quiz_questions','pdf_books'];
function emptyStore(){
  return {school:null, semestersOk:false, semesters:[], subjects:[], schedule_slots:[], syllabus_files:[],
    materials:[], flashcards:[], quiz_questions:[], pdf_books:[], events:[], activities:[],
    faqs:[], rules:[], guidelines:[], item_types:[]};
}
let RAW = {};   // schoolId -> flat store (all semesters)

function opMatches(row, match){
  return (match || []).every(([c, v])=> v===null ? row[c]==null : row[c]===v);
}
// Apply one queued change to a store (used to show unsynced changes on top of the cached copy)
function applyOpToStore(store, op, schoolId){
  if(op.table==='schools'){
    if(op.type==='update' && store.school && opMatches(store.school, op.match)) Object.assign(store.school, op.fields);
    return;
  }
  if(op.row && op.row.school_id && op.row.school_id!==schoolId) return;   // belongs to another school
  const rows = store[op.table] || (store[op.table] = []);
  if(op.type==='insert'){
    if(!rows.some(r=>r.id===op.row.id)) rows.push(Object.assign({}, op.row));
  } else if(op.type==='upsert'){
    const key = op.table==='rules' ? 'school_id' : 'id';
    const i = rows.findIndex(r=>r[key]===op.row[key]);
    if(i>=0) Object.assign(rows[i], op.row); else rows.push(Object.assign({}, op.row));
  } else if(op.type==='update'){
    rows.forEach(r=>{ if(opMatches(r, op.match)) Object.assign(r, op.fields); });
  } else if(op.type==='delete'){
    const gone = rows.filter(r=>opMatches(r, op.match)).map(r=>r.id);
    store[op.table] = rows.filter(r=>!opMatches(r, op.match));
    if(op.table==='subjects'){
      CHILD_TABLES.forEach(t=>{ store[t] = (store[t]||[]).filter(r=>!gone.includes(r.subject_id)); });
      ['events','activities'].forEach(t=>{ (store[t]||[]).forEach(r=>{ if(gone.includes(r.subject_id)) r.subject_id = null; }); });
    }
    if(op.table==='activities'){
      store.events = (store.events||[]).filter(r=>!gone.includes(r.source_activity_id));
    }
  }
}
function overlayPending(store, schoolId){
  if(!PENDING.length) return store;
  const copy = JSON.parse(JSON.stringify(store));
  PENDING.forEach(op=>applyOpToStore(copy, op, schoolId));
  return copy;
}

async function fetchStore(schoolId){
  let r;
  try{
    r = await Promise.all([
      supabase.from('schools').select('*').eq('id', schoolId).maybeSingle(),
      supabase.from('subjects')
        .select('*, schedule_slots(*), syllabus_files(*), materials(*), flashcards(*), quiz_questions(*), pdf_books(*)')
        .eq('school_id', schoolId)
        .order('created_at', {ascending:true}),
      supabase.from('events').select('*').eq('school_id', schoolId),
      supabase.from('activities').select('*').eq('school_id', schoolId),
      supabase.from('faqs').select('*').eq('school_id', schoolId),
      supabase.from('rules').select('*').eq('school_id', schoolId).maybeSingle(),
      supabase.from('guidelines').select('*').eq('school_id', schoolId),
      // Optional tables: if a migration hasn't been run yet these just error quietly and the app works without them.
      supabase.from('item_types').select('*').eq('school_id', schoolId).order('created_at', {ascending:true}),
      supabase.from('semesters').select('*').eq('school_id', schoolId).order('created_at', {ascending:true})
    ]);
  }catch(e){ return null; }
  if(r.some(x=>x && x.error && isNetworkError(x.error))) return null;

  const [schoolRes, subjectsRes, eventsRes, activitiesRes, faqsRes, rulesRes, guidelinesRes, typesRes, semRes] = r;
  [schoolRes, subjectsRes, eventsRes, activitiesRes, faqsRes, rulesRes, guidelinesRes].forEach(x=>{
    if(x.error) console.error('Supabase load error:', x.error);
  });

  const store = emptyStore();
  store.school = schoolRes.data || null;
  store.semestersOk = !semRes.error;
  store.semesters = semRes.error ? [] : (semRes.data || []);
  (subjectsRes.data || []).forEach(s=>{
    const base = Object.assign({}, s);
    CHILD_TABLES.forEach(t=>{
      (s[t] || []).forEach(row=>store[t].push(row));
      delete base[t];
    });
    store.subjects.push(base);
  });
  store.events = eventsRes.data || [];
  store.activities = activitiesRes.data || [];
  store.faqs = faqsRes.data || [];
  store.rules = rulesRes.data ? [rulesRes.data] : [];
  store.guidelines = guidelinesRes.data || [];
  store.item_types = typesRes.error ? [] : (typesRes.data || []);
  return store;
}

// Newest data if we can reach Supabase, otherwise the last cached copy (plus any unsynced changes)
async function loadSchoolStore(schoolId){
  await flushQueue();
  let store = await fetchStore(schoolId);
  if(store){
    setNet(true);
    lsSet('shStore_'+schoolId, store);
  } else {
    setNet(false);
    store = lsGet('shStore_'+schoolId);
    if(!store){ store = emptyStore(); store.offlineEmpty = true; }
  }
  return overlayPending(store, schoolId);
}

/* ---- School list (landing page) ---- */
const DEFAULT_SCHOOLS = [
  {id:'pccm', full_name:'PCCM · BSOA – BS in Office Administration'},
  {id:'tup',  full_name:'TUP-Manila · BET – Electronics Technology'}
];
function sortSchools(list){
  const rank = id=>{ const i = DEFAULT_SCHOOLS.findIndex(s=>s.id===id); return i<0 ? 99 : i; };
  return list.slice().sort((a,b)=> rank(a.id)-rank(b.id) || String(a.id).localeCompare(String(b.id)));
}
function overlaySchools(list){
  const out = list.map(s=>Object.assign({}, s));
  PENDING.forEach(op=>{
    if(op.table!=='schools') return;
    if(op.type==='insert' && !out.some(s=>s.id===op.row.id)) out.push({id:op.row.id, full_name:op.row.full_name});
    if(op.type==='update') out.forEach(s=>{ if(opMatches(s, op.match)) Object.assign(s, op.fields); });
  });
  return sortSchools(out);
}
let SCHOOLS = overlaySchools(lsGet('shSchools') || DEFAULT_SCHOOLS);
async function loadSchools(){
  let list = lsGet('shSchools') || DEFAULT_SCHOOLS;
  try{
    const {data, error} = await supabase.from('schools').select('id, full_name');
    if(error && isNetworkError(error)) setNet(false);
    else if(!error && data && data.length){ list = data; lsSet('shSchools', data); }
  }catch(e){ setNet(false); }
  SCHOOLS = overlaySchools(list);
  return SCHOOLS;
}

/* ---- Semesters ---- */
let currentSemesterId = null;
function semesterKey(school){ return 'shSemester_' + school; }
function resolveSemesterId(school, store){
  const sems = store.semesters || [];
  if(!sems.length) return null;
  const saved = lsGet(semesterKey(school));
  if(saved && sems.some(s=>s.id===saved)) return saved;
  return sems[sems.length-1].id;      // newest semester by default
}
function rememberSemester(school, id){ lsSet(semesterKey(school), id); }
function semFields(){ return currentSemesterId ? {semester_id: currentSemesterId} : {}; }

/* Calendar entries now use the activity types. Entries that came from an activity take that
   activity's type; older entries saved with the old Event/Due/Project types keep their colors
   (Event -> Assignment green, Due -> Activity red, Project -> Project orange). */
const LEGACY_EVENT_TYPES = {event:'Assignment', due:'Activity', project:'Project'};
function calendarType(e, actById){
  const src = e.source_activity_id && actById[e.source_activity_id];
  if(src && src.type) return src.type;
  return LEGACY_EVENT_TYPES[e.type] || e.type || 'Assignment';
}

/* ---- Turn the flat store into the shape the UI uses (only the chosen semester) ---- */
function shapeSchoolData(store, semesterId){
  const sems = store.semesters || [];
  const firstId = sems[0] ? sems[0].id : null;
  // Rows without a semester (older data) belong to the first semester
  const inSem = r => !sems.length || (r.semester_id || firstId) === semesterId;

  const subjectsRows = store.subjects.filter(inSem);
  const ids = new Set(subjectsRows.map(s=>s.id));
  const kids = t => (store[t] || []).filter(r=>ids.has(r.subject_id));
  const typesRows = store.item_types || [];
  const mapType = t => ({id:t.id, key:t.type_key, label:t.label, color:t.color});
  const rules = store.rules[0];
  const actById = {};
  (store.activities || []).forEach(a=>{ actById[a.id] = a; });
  const known = (SCHOOLS || []).find(s=>s.id===(store.school && store.school.id));

  return {
    fullName: (store.school && store.school.full_name) || (known && known.full_name) || '',
    accentColor: (store.school && store.school.accent_color) || '#2F6F5E',
    bgColor: (store.school && store.school.bg_color) || '#F6F5F0',
    offlineEmpty: !!store.offlineEmpty,
    semestersOk: !!store.semestersOk,
    semesters: sems.map(s=>({id:s.id, name:s.name})),
    semesterId: semesterId,
    types: {
      event: typesRows.filter(t=>t.kind==='event').map(mapType),
      activity: typesRows.filter(t=>t.kind==='activity').map(mapType)
    },
    subjects: subjectsRows.map(s => ({
      id: s.id, code: s.code, name: s.name, color: s.color,
      schedule: kids('schedule_slots').filter(x=>x.subject_id===s.id).map(sl => ({id:sl.id, day:sl.day, time:sl.time, room:sl.room, professor:sl.professor})),
      syllabus: kids('syllabus_files').filter(x=>x.subject_id===s.id).map(f => ({id:f.id, label:f.label, type:f.type, url:f.url})),
      materials: kids('materials').filter(x=>x.subject_id===s.id).map(f => ({id:f.id, label:f.label, type:f.type, url:f.url})),
      flashcards: kids('flashcards').filter(x=>x.subject_id===s.id).map(f => ({id:f.id, q:f.question, a:f.answer, image:f.image_url})),
      quiz: kids('quiz_questions').filter(x=>x.subject_id===s.id).map(q => ({id:q.id, q:q.question, choices:q.choices, answer:q.correct_index, difficulty:q.difficulty, image:q.image_url})),
      books: kids('pdf_books').filter(x=>x.subject_id===s.id).map(b => ({id:b.id, label:b.label, author:b.author, url:b.url}))
    })),
    events: (store.events || []).filter(inSem).map(e => ({id:e.id, date:e.date, title:e.title, type:calendarType(e, actById), desc:e.description, subjectId:e.subject_id, sourceActivityId:e.source_activity_id})),
    activities: (store.activities || []).filter(inSem).map(a => ({id:a.id, title:a.title, subjectId:a.subject_id, type:a.type, start:a.start_date, due:a.due_date, instructions:a.instructions, tags:a.tags || [], image:a.image_url})),
    faqs: (store.faqs || []).map(f => ({id:f.id, q:f.question, a:f.answer})),
    rules: {
      vision: (rules && rules.vision) || '',
      mission: (rules && rules.mission) || '',
      preamble: (rules && rules.preamble) || '',
      coreValues: (rules && rules.core_values) || [],
      guidelines: (store.guidelines || []).map(g => ({id:g.id, title:g.title, body:g.body}))
    }
  };
}

/* ---- Load everything for one school, shaped for the UI ---- */
async function loadSchoolData(schoolId){
  const store = await loadSchoolStore(schoolId);
  RAW[schoolId] = store;
  currentSemesterId = resolveSemesterId(schoolId, store);
  const data = shapeSchoolData(store, currentSemesterId);
  if(!data.fullName){
    const s = (SCHOOLS || []).find(x=>x.id===schoolId);
    data.fullName = s ? s.full_name : schoolId.toUpperCase();
  }
  return data;
}
// Switch semester without reloading anything
function reshapeForSemester(schoolId, semesterId){
  currentSemesterId = semesterId;
  rememberSemester(schoolId, semesterId);
  return shapeSchoolData(RAW[schoolId], semesterId);
}

/* =========================================================
   WRITE FUNCTIONS
========================================================= */

/* ---- Schools ---- */
async function dbAddSchool(id, fullName){
  const {error} = await mutate('schools', 'insert', {row: {id, full_name: fullName}});
  if(error){ alert('Could not add school: ' + error.message); return false; }
  return true;
}

/* ---- Semesters ---- */
// hasAny=false means this is the first time semesters are used for this school:
// everything that already exists is labelled "Semester 1" first.
async function dbAddSemester(schoolId, name, hasAny){
  if(!hasAny){
    const first = await mutate('semesters', 'insert', {row: {school_id: schoolId, name: 'Semester 1'}});
    if(first.error){ alert('Could not add semester: ' + first.error.message); return null; }
    for(const t of ['subjects','events','activities']){
      const r = await mutate(t, 'update', {fields: {semester_id: first.data.id}, match: [['school_id', schoolId], ['semester_id', null]]});
      if(r.error) console.error('Could not label existing ' + t + ':', r.error);
    }
  }
  const sem = await mutate('semesters', 'insert', {row: {school_id: schoolId, name}});
  if(sem.error){ alert('Could not add semester: ' + sem.error.message); return null; }
  return sem.data.id;
}

/* ---- Theme (per-school accent + background color) ---- */
async function dbSaveTheme(schoolId, accentColor, bgColor){
  const {error} = await mutate('schools', 'update', {fields: {accent_color: accentColor, bg_color: bgColor}, match: [['id', schoolId]]});
  if(error) alert('Could not save theme: ' + error.message);
}

/* ---- Subjects ---- */
async function dbAddSubject(schoolId){
  const {data, error} = await mutate('subjects', 'insert', {row: Object.assign({
    school_id: schoolId, code:'NEW', name:'New Subject', color:'#2F6F5E'
  }, semFields())});
  if(error){ alert('Could not add subject: ' + error.message); return null; }
  return data.id;
}
async function dbSaveSubject(id, fields){
  const {error} = await mutate('subjects', 'update', {fields, match: [['id', id]]});
  if(error) alert('Could not save subject: ' + error.message);
}
async function dbDeleteSubject(id){
  const {error} = await mutate('subjects', 'delete', {match: [['id', id]]});
  if(error) alert('Could not delete subject: ' + error.message);
}

/* ---- Schedule slots (a subject can have more than one) ---- */
async function dbAddScheduleSlot(subjectId, day, time, room, professor){
  const {error} = await mutate('schedule_slots', 'insert', {row: {subject_id: subjectId, day, time, room, professor}});
  if(error) alert('Could not add schedule slot: ' + error.message);
}
async function dbDeleteScheduleSlot(id){
  const {error} = await mutate('schedule_slots', 'delete', {match: [['id', id]]});
  if(error) alert('Could not delete schedule slot: ' + error.message);
}

/* ---- Syllabus / Materials (same shape, different table) ---- */
async function dbAddFile(table, subjectId, label, type, url){
  const {error} = await mutate(table, 'insert', {row: {subject_id: subjectId, label, type, url}});
  if(error) alert('Could not add file: ' + error.message);
}
async function dbDeleteFile(table, id){
  const {error} = await mutate(table, 'delete', {match: [['id', id]]});
  if(error) alert('Could not delete file: ' + error.message);
}

/* ---- PDF Books ---- */
async function dbAddBook(subjectId, label, author, url){
  const {error} = await mutate('pdf_books', 'insert', {row: {subject_id: subjectId, label, author: author||'', url}});
  if(error) alert('Could not add book: ' + error.message);
}
async function dbDeleteBook(id){
  const {error} = await mutate('pdf_books', 'delete', {match: [['id', id]]});
  if(error) alert('Could not delete book: ' + error.message);
}

/* ---- Flashcards ---- */
async function dbAddFlashcard(subjectId, q, a, imageUrl){
  const {error} = await mutate('flashcards', 'insert', {row: {subject_id: subjectId, question: q, answer: a, image_url: imageUrl || ''}});
  if(error) alert('Could not add flashcard: ' + error.message);
}
async function dbUpdateFlashcard(id, fields){
  const {error} = await mutate('flashcards', 'update', {fields, match: [['id', id]]});
  if(error) alert('Could not update flashcard: ' + error.message);
}
async function dbDeleteFlashcard(id){
  const {error} = await mutate('flashcards', 'delete', {match: [['id', id]]});
  if(error) alert('Could not delete flashcard: ' + error.message);
}

/* ---- Quiz questions ---- */
async function dbAddQuiz(subjectId, question, choices, correctIndex, difficulty, imageUrl){
  const {error} = await mutate('quiz_questions', 'insert', {row: {
    subject_id: subjectId, question, choices, correct_index: correctIndex, difficulty, image_url: imageUrl || ''
  }});
  if(error) alert('Could not add quiz question: ' + error.message);
}
async function dbDeleteQuiz(id){
  const {error} = await mutate('quiz_questions', 'delete', {match: [['id', id]]});
  if(error) alert('Could not delete quiz question: ' + error.message);
}

/* ---- Events ---- */
async function dbAddEvent(schoolId, fields){
  const {error} = await mutate('events', 'insert', {row: Object.assign({school_id: schoolId}, semFields(), fields)});
  if(error) alert('Could not add event: ' + error.message);
}
async function dbUpdateEvent(id, fields){
  const {error} = await mutate('events', 'update', {fields, match: [['id', id]]});
  if(error) alert('Could not update event: ' + error.message);
}
async function dbDeleteEvent(id){
  const {error} = await mutate('events', 'delete', {match: [['id', id]]});
  if(error) alert('Could not delete event: ' + error.message);
}

/* ---- Activities ---- */
async function dbAddActivity(schoolId, fields){
  const {data, error} = await mutate('activities', 'insert', {row: Object.assign({school_id: schoolId}, semFields(), fields)});
  if(error){ alert('Could not add activity: ' + error.message); return null; }
  return data.id;
}
async function dbUpdateActivity(id, fields){
  const {error} = await mutate('activities', 'update', {fields, match: [['id', id]]});
  if(error) alert('Could not update activity: ' + error.message);
}
async function dbDeleteActivity(id){
  const {error} = await mutate('activities', 'delete', {match: [['id', id]]});
  if(error) alert('Could not delete activity: ' + error.message);
}

// Keeps the calendar in sync with an activity's due date only (no separate "Starts" entry).
// Wipes any calendar events this activity previously generated, then recreates them.
async function dbSyncActivityCalendarEvents(schoolId, activityId, subjectId, title, type, start, due, instructions){
  await mutate('events', 'delete', {match: [['source_activity_id', activityId]]});
  if(due){
    const row = Object.assign({school_id: schoolId}, semFields(), {
      subject_id: subjectId || null, date: due, title,
      type: type,
      description: instructions || '', source_activity_id: activityId
    });
    const {error} = await mutate('events', 'insert', {row});
    if(error) console.error('Could not sync calendar event for activity:', error);
  }
}

/* ---- FAQs ---- */
async function dbAddFaq(schoolId, question, answer){
  const {error} = await mutate('faqs', 'insert', {row: {school_id: schoolId, question, answer}});
  if(error) alert('Could not add FAQ: ' + error.message);
}
async function dbUpdateFaq(id, question, answer){
  const {error} = await mutate('faqs', 'update', {fields: {question, answer}, match: [['id', id]]});
  if(error) alert('Could not update FAQ: ' + error.message);
}
async function dbDeleteFaq(id){
  const {error} = await mutate('faqs', 'delete', {match: [['id', id]]});
  if(error) alert('Could not delete FAQ: ' + error.message);
}

/* ---- Rules ---- */
async function dbSaveRules(schoolId, fields){
  const {error} = await mutate('rules', 'upsert', {row: Object.assign({school_id: schoolId}, fields)});
  if(error) alert('Could not save rules: ' + error.message);
}
async function dbAddGuideline(schoolId, title, body){
  const {error} = await mutate('guidelines', 'insert', {row: {school_id: schoolId, title, body}});
  if(error) alert('Could not add guideline: ' + error.message);
}
async function dbUpdateGuideline(id, title, body){
  const {error} = await mutate('guidelines', 'update', {fields: {title, body}, match: [['id', id]]});
  if(error) alert('Could not update guideline: ' + error.message);
}
async function dbDeleteGuideline(id){
  const {error} = await mutate('guidelines', 'delete', {match: [['id', id]]});
  if(error) alert('Could not delete guideline: ' + error.message);
}

/* ---- Custom types (calendar event types + activity types) ---- */
async function dbAddType(schoolId, kind, label, color){
  const {error} = await mutate('item_types', 'insert', {row: {school_id: schoolId, kind, type_key: label, label, color}});
  if(error){ alert('Could not add type: ' + error.message + '\n\nIf this says the table does not exist, run migration_item_types.sql in the Supabase SQL Editor first.'); return false; }
  return true;
}
async function dbUpdateType(id, fields){
  const {error} = await mutate('item_types', 'update', {fields, match: [['id', id]]});
  if(error) alert('Could not update type: ' + error.message);
}
async function dbDeleteType(id){
  const {error} = await mutate('item_types', 'delete', {match: [['id', id]]});
  if(error) alert('Could not remove type: ' + error.message);
}
