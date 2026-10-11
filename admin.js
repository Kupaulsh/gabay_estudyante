/* =========================================================
   ADMIN AUTH (Supabase Auth + Google, checked against `admins` table)
   No separate admin panel — controls appear inline on each page
   once isAdmin is true.
========================================================= */
/* Three flags:
   - signedInEmail   : someone is signed in with Google
   - isSignedInAdmin : that account is on the admin list (can edit)
   - editMode        : the pencil button is on (green)
   isAdmin is what the pages look at: true only while editing is switched on. */
let isAdmin = false;
let isSignedInAdmin = false;
let editMode = false;
let signedInEmail = '';
let adminEmail = '';

function applyEditState(){
  isAdmin = !!(isSignedInAdmin && editMode);
  updateEditButton();
}
function updateEditButton(){
  const b = document.getElementById('editBtn');
  if(!b) return;
  b.classList.toggle('on', isAdmin);
  b.classList.toggle('off', !isAdmin);
  const msg = isAdmin ? 'Editing is on — tap to stop editing' : 'Editing is off — tap to edit';
  b.title = msg; b.setAttribute('aria-label', msg);
}
function updateAuthUI(){
  const lb = document.getElementById('landingAuthBtn');
  if(lb){
    lb.textContent = signedInEmail ? `Signed in as ${signedInEmail}` : 'Sign in';
    lb.style.textDecoration = signedInEmail ? 'none' : '';
    lb.onclick = signedInEmail ? null : openSignInModal;
  }
}
// The pencil: switch editing on and off without signing out
function toggleEditMode(){
  if(!isSignedInAdmin){
    if(signedInEmail) showToast("This account isn't on the admin list.");
    else openSignInModal();
    return;
  }
  editMode = !editMode;
  applyEditState();
  closeModal();
  if(currentSchool) rerender();
  showToast(editMode ? 'Editing is on' : 'Editing is off');
}

function openSignInModal(){
  sessionStorage.setItem('shAdminPending', '1');
  openModal(`<h3>Admin sign-in</h3>
    <p style="font-size:calc(12.5px * var(--fs));color:var(--ink-soft);">Sign in with the Google account that's on this project's admin list. You only need to do this once — the app remembers you. After that, use the pencil button to turn editing on and off.</p>
    <button class="btn" style="display:flex;align-items:center;justify-content:center;gap:10px;width:100%;margin-bottom:10px;" onclick="signInWithGoogle()">
      <svg width="16" height="16" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.4 29.3 35 24 35c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 8 3l6-6C34.5 5 29.6 3 24 3 12.4 3 3 12.4 3 24s9.4 21 21 21 21-9.4 21-21c0-1.4-.1-2.5-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 16 19 13 24 13c3.1 0 5.8 1.1 8 3l6-6C34.5 6 29.6 4 24 4c-7.7 0-14.3 4.4-17.7 10.7z"/><path fill="#4CAF50" d="M24 45c5.5 0 10.4-1.9 14.2-5.1l-6.6-5.4C29.6 36 26.9 37 24 37c-5.3 0-9.7-3.5-11.3-8.3l-6.6 5.1C9.6 40.5 16.2 45 24 45z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.2 5.6l6.6 5.4C39.9 37.4 43 31.1 43 24c0-1.4-.1-2.5-.4-3.5z"/></svg>
      Sign in with Google
    </button>
    <p id="signInStatus" style="font-size:calc(12px * var(--fs));color:var(--ink-soft);min-height:16px;"></p>`);
}
function setSignInStatus(msg){
  const el = document.getElementById('signInStatus');
  if(el) el.textContent = msg;
}
let signInInFlight = false;
async function signInWithGoogle(){
  if(signInInFlight) return; // ignore accidental double-taps
  signInInFlight = true;
  setSignInStatus('Redirecting to Google…');
  const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

  if(isNative){
    // Native app: open Google sign-in in the in-app browser, then catch the
    // redirect back via the app's custom URL scheme (see capacitor.config.json).
    const {data, error} = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: 'com.gabayestudyante.app://callback', skipBrowserRedirect: true }
    });
    if(error){ setSignInStatus('Sign-in error: ' + error.message); signInInFlight = false; return; }
    window.Capacitor.Plugins.Browser.open({ url: data.url });
  } else {
    const {error} = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + window.location.pathname.replace(/index\.html$/, '') }
    });
    if(error){ setSignInStatus('Sign-in error: ' + error.message); }
    signInInFlight = false;
  }
}
// Native app only: catches the browser redirecting back to com.gabayestudyante.app://callback
let handlingOAuthRedirect = false;
if(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()){
  window.Capacitor.Plugins.App.addListener('appUrlOpen', async ({url})=>{
    if(handlingOAuthRedirect) return; // ignore duplicate fires of the same redirect
    if(url.includes('access_token') || url.includes('code=')){
      handlingOAuthRedirect = true;
      setSignInStatus('Returned from Google, verifying…');
      await window.Capacitor.Plugins.Browser.close();
      try{
        const parsed = new URL(url);
        const authCode = parsed.searchParams.get('code');
        const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ''));
        const accessToken = hashParams.get('access_token');
        const refreshToken = hashParams.get('refresh_token');

        if(authCode){
          setSignInStatus('Exchanging code for session…');
          const {error: exErr} = await supabase.auth.exchangeCodeForSession(authCode);
          if(exErr){ setSignInStatus('Exchange failed: ' + exErr.message); return; }
        } else if(accessToken){
          setSignInStatus('Setting session…');
          const {error: setErr} = await supabase.auth.setSession({access_token: accessToken, refresh_token: refreshToken});
          if(setErr){ setSignInStatus('Set session failed: ' + setErr.message); return; }
        } else {
          setSignInStatus('No code or access_token found in redirect URL: ' + url.slice(0,150));
          return;
        }
        setSignInStatus('Checking admin access…');
        await checkAdminSession(true);
      } catch(e){
        setSignInStatus('Sign-in error: ' + e.message);
      } finally {
        signInInFlight = false;
        handlingOAuthRedirect = false;
      }
    }
  });
}
async function checkAdminSession(forceStatus){
  const pending = forceStatus || sessionStorage.getItem('shAdminPending');
  const cached = lsGet('shAdminCache');
  let session = null;
  try{ const r = await supabase.auth.getSession(); session = r && r.data ? r.data.session : null; }catch(e){}

  if(!session){
    // Offline with no readable session: keep working as the admin who signed in before
    if(cached && cached.email && (!navigator.onLine || netDown)){
      signedInEmail = adminEmail = cached.email; isSignedInAdmin = true;
      applyEditState(); updateAuthUI();
      return;
    }
    signedInEmail = adminEmail = ''; isSignedInAdmin = false; editMode = false;
    applyEditState(); updateAuthUI();
    if(pending) setSignInStatus('No active session found after sign-in — please try again.');
    return;
  }

  signedInEmail = session.user.email;
  let res;
  try{ res = await supabase.rpc('is_admin'); }catch(e){ res = {error:{message:String(e)}}; }

  if(res.error){
    if(isNetworkError(res.error) && cached && cached.email===signedInEmail){
      adminEmail = cached.email; isSignedInAdmin = true;      // offline: trust the last check
    } else if(pending){
      setSignInStatus('Error checking admin status: ' + res.error.message);
    }
    applyEditState(); updateAuthUI();
    return;
  }

  if(res.data){
    lsSet('shAdminCache', {email: signedInEmail});
    isSignedInAdmin = true;
    adminEmail = signedInEmail;
    if(pending){ editMode = true; sessionStorage.removeItem('shAdminPending'); closeModal(); }   // just signed in: start editing
    applyEditState(); updateAuthUI();
    flushQueue();
    if(currentSchool) rerender();
  } else {
    isSignedInAdmin = false; editMode = false;
    lsSet('shAdminCache', null);
    applyEditState(); updateAuthUI();
    if(pending) setSignInStatus(`Signed in as ${signedInEmail}, but this account isn't on the admin list. Add this email to the "admins" table in Supabase, then try again.`);
    if(currentSchool) rerender();
  }
}
async function signOutAdmin(){
  if(PENDING.length && !confirm(`${PENDING.length} change(s) haven't synced yet. They stay saved on this device and will sync after you sign in again. Sign out anyway?`)) return;
  try{ await supabase.auth.signOut(); }catch(e){}
  isSignedInAdmin = false; editMode = false; signedInEmail = adminEmail = '';
  lsSet('shAdminCache', null);
  applyEditState(); updateAuthUI();
  closeModal();
  if(currentSchool) rerender();
  showToast('Signed out');
}

// Fires on load (existing session) and right after the Google redirect comes back.
supabase.auth.onAuthStateChange((event, session)=>{
  if(event === 'SIGNED_IN') setTimeout(checkAdminSession, 0);     // (deferred: avoids calling auth inside its own callback)
  if(event === 'SIGNED_OUT' && signedInEmail){
    isSignedInAdmin = false; editMode = false; signedInEmail = adminEmail = '';
    applyEditState(); updateAuthUI();
    if(currentSchool) rerender();
  }
});
checkAdminSession();

// If Google / Supabase sent us back with an error, show it instead of failing silently
(function showAuthRedirectError(){
  try{
    const q = new URLSearchParams(window.location.search);
    const h = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const msg = h.get('error_description') || q.get('error_description') || h.get('error') || q.get('error');
    if(!msg) return;
    history.replaceState(null, '', window.location.pathname);
    openModal(`<h3>Sign-in didn't finish</h3>
      <p style="font-size:calc(13px * var(--fs));color:var(--ink-soft);word-break:break-word;">${esc(msg.replace(/\+/g,' '))}</p>
      <p style="font-size:calc(12.5px * var(--fs));color:var(--ink-soft);">Check that this site's address is listed under Supabase → Authentication → URL Configuration (Site URL and Redirect URLs), and that your Google email is added as a test user if the Google app is in "Testing" mode.</p>
      <button class="btn" style="width:100%;" onclick="closeModal();openSignInModal()">Try again</button>`);
  }catch(e){}
})();

// Common refresh-then-rerender used after every save/delete
async function adminRefreshAndRerender(){
  await refreshCurrentSchool();
  goPage(currentPage);
}

/* ---- Subjects admin ---- */
function adminSubjects(D){
  let html = `<button class="btn" onclick="adminAddSubject()">+ Add subject</button><div style="height:14px;"></div>`;
  D.subjects.forEach(s=>{
    const schedSummary = s.schedule.length===0 ? 'No schedule set'
      : s.schedule.map(sl=>`${sl.day||'?'} ${sl.time||'TBA'}`).join(' · ');
    html += `<div class="admin-list-item">
      <div class="info">
        <b>${esc(s.name)}</b> <small>${esc(s.code)} · ${esc(schedSummary)}</small>
        <small>${s.syllabus.length} syllabus file(s) · ${s.materials.length} material(s)</small>
      </div>
      <div style="display:flex;gap:6px;">
        <button class="btn sm ghost" onclick="adminEditSubject('${s.id}')">Edit</button>
        <button class="btn sm danger" onclick="adminDeleteSubject('${s.id}')">Delete</button>
      </div>
    </div>`;
  });
  return html;
}
async function adminAddSubject(){
  const newId = await dbAddSubject(currentSchool);
  await refreshCurrentSchool();
  goPage(currentPage);
  if(newId) adminEditSubject(newId);
}
async function adminDeleteSubject(id){
  if(!confirm('Delete this subject and all its content?')) return;
  await dbDeleteSubject(id);
  await refreshCurrentSchool();
  goPage(currentPage);
}
function adminEditSubject(id){
  const D = DATA[currentSchool];
  const s = D.subjects.find(x=>x.id===id);
  let html = `<h3>Edit subject</h3>

  <div class="modal-section">
    <div class="modal-section-title">Details</div>
    <div class="form-grid">
      <div><label>Name</label><input id="f_name" value="${escAttr(s.name)}"></div>
      <div class="two-col">
        <div><label>Code</label><input id="f_code" value="${escAttr(s.code)}"></div>
        <div><label>Color</label><input id="f_color" type="color" value="${safeColor(s.color)}" style="height:40px;padding:4px;"></div>
      </div>
    </div>
    <button class="btn" onclick="adminSaveSubject('${id}')">Save details</button>
  </div>

  <div class="modal-section">
    <div class="modal-section-title">Schedule</div>
    <p style="color:var(--ink-soft);font-size:calc(12.5px * var(--fs));margin-top:-4px;">One entry per class meeting — e.g. "Mon" for lecture and a separate "Wed" for lab.</p>
    <div id="scheduleList">${adminScheduleList(s.schedule, id)}</div>
    <div class="form-grid">
      <div class="two-col">
        <div><label>Day</label>
          <select id="sc_day_${id}">${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d=>`<option>${esc(d)}</option>`).join('')}</select>
        </div>
        <div><label>Time slot</label><input id="sc_time_${id}" placeholder="8:00–10:00 AM"></div>
      </div>
      <div class="two-col">
        <div><label>Professor</label><input id="sc_prof_${id}" placeholder="Professor name"></div>
        <div><label>Room</label><input id="sc_room_${id}" placeholder="Room number"></div>
      </div>
      <button class="btn ghost" onclick="adminAddScheduleSlot('${id}')">+ Add this meeting time</button>
    </div>
  </div>

  <div class="modal-section">
    <div class="modal-section-title">Syllabus files</div>
    <div id="syllabusList">${adminFileList(s.syllabus,'syllabus_files',id)}</div>
    ${adminFileAddForm('syllabus_files', id)}
  </div>

  <div class="modal-section">
    <div class="modal-section-title">Materials (PDF / PPTX / DOCX)</div>
    <div id="materialsList">${adminFileList(s.materials,'materials',id)}</div>
    ${adminFileAddForm('materials', id)}
  </div>

  <div class="modal-section">
    <div class="modal-section-title">PDF Books</div>
    <div id="booksList">${adminBookList(s.books, id)}</div>
    <div class="form-grid">
      <input id="bk_label_${id}" placeholder="Book title">
      <input id="bk_author_${id}" placeholder="Author (optional)">
      <input id="bk_url_${id}" placeholder="Link (Google Drive URL)">
      <button class="btn ghost" onclick="adminAddBook('${id}')">+ Add book</button>
    </div>
  </div>`;
  openModal(html);
}
function adminBookList(books, subjId){
  if(!books || books.length===0) return `<p style="font-size:calc(12.5px * var(--fs));color:var(--ink-soft);">None yet.</p>`;
  return books.map(b=>`<div class="admin-list-item"><div class="info"><b>${esc(b.label)}</b><br><small>${b.author?esc(b.author)+' — ':''}${esc(b.url)}</small></div><button class="btn sm danger" onclick="adminDeleteBook('${subjId}','${b.id}')">Delete</button></div>`).join('');
}
async function adminAddBook(subjId){
  const label = document.getElementById(`bk_label_${subjId}`).value.trim();
  const author = document.getElementById(`bk_author_${subjId}`).value.trim();
  const url = document.getElementById(`bk_url_${subjId}`).value.trim();
  if(!label || !url){ alert('Title and link are required.'); return; }
  await dbAddBook(subjId, label, author, url);
  await refreshCurrentSchool();
  adminEditSubject(subjId);
}
async function adminDeleteBook(subjId, bookId){
  await dbDeleteBook(bookId);
  await refreshCurrentSchool();
  adminEditSubject(subjId);
}
function adminScheduleList(slots, subjId){
  if(slots.length===0) return `<p style="font-size:calc(12.5px * var(--fs));color:var(--ink-soft);">None yet — this subject won't show up on the Schedule page until you add one.</p>`;
  return slots.map(sl=>`<div class="admin-list-item"><div class="info"><b>${esc(sl.day||'?')} · ${esc(sl.time||'TBA')}</b><br><small>${esc(sl.professor||'Professor TBA')} · Room ${esc(sl.room||'TBA')}</small></div><button class="btn sm danger" onclick="adminDeleteScheduleSlot('${subjId}','${sl.id}')">Delete</button></div>`).join('');
}
async function adminAddScheduleSlot(subjId){
  const day = document.getElementById(`sc_day_${subjId}`).value;
  const time = document.getElementById(`sc_time_${subjId}`).value.trim();
  const professor = document.getElementById(`sc_prof_${subjId}`).value.trim();
  const room = document.getElementById(`sc_room_${subjId}`).value.trim();
  await dbAddScheduleSlot(subjId, day, time, room, professor);
  await refreshCurrentSchool();
  adminEditSubject(subjId);
}
async function adminDeleteScheduleSlot(subjId, slotId){
  await dbDeleteScheduleSlot(slotId);
  await refreshCurrentSchool();
  adminEditSubject(subjId);
}
function adminFileList(list, table, subjId){
  if(list.length===0) return `<p style="font-size:calc(12.5px * var(--fs));color:var(--ink-soft);">None yet.</p>`;
  return list.map((f)=>`<div class="admin-list-item"><div class="info"><b>${esc(f.label)}</b><br><small>${esc(f.type||'')} — ${esc(f.url)}</small></div><button class="btn sm danger" onclick="adminDeleteFile('${table}','${f.id}','${subjId}')">Delete</button></div>`).join('');
}
function adminFileAddForm(table, subjId){
  return `<div class="form-grid">
    <input id="${table}_label_${subjId}" placeholder="Label (e.g. Week 1 Syllabus)">
    <div class="two-col">
      <input id="${table}_type_${subjId}" placeholder="Type (PDF, PPTX, DOCX...)">
      <input id="${table}_url_${subjId}" placeholder="Link (Google Drive URL)">
    </div>
    <button class="btn ghost" onclick="adminAddFile('${table}','${subjId}')">+ Add file</button>
  </div>`;
}
async function adminAddFile(table, subjId){
  const label = document.getElementById(`${table}_label_${subjId}`).value.trim();
  const type = document.getElementById(`${table}_type_${subjId}`).value.trim();
  const url = document.getElementById(`${table}_url_${subjId}`).value.trim();
  if(!label || !url){ alert('Label and link are required.'); return; }
  await dbAddFile(table, subjId, label, type, url);
  await refreshCurrentSchool();
  adminEditSubject(subjId);
}
async function adminDeleteFile(table, fileId, subjId){
  await dbDeleteFile(table, fileId);
  await refreshCurrentSchool();
  adminEditSubject(subjId);
}
async function adminSaveSubject(id){
  await dbSaveSubject(id, {
    name: document.getElementById('f_name').value,
    code: document.getElementById('f_code').value,
    color: document.getElementById('f_color').value
  });
  await refreshCurrentSchool();
  goPage(currentPage);
  closeModal();
}

/* ---- Reviewers admin (flashcards + quiz per subject) ---- */
function adminReviewers(D){
  if(D.subjects.length===0) return `<p style="color:var(--ink-soft);">Add subjects first (in the Subjects tab), then add flashcards here (the Mock Quiz is made from them).</p>`;
  let html = '';
  D.subjects.forEach(s=>{
    html += `<div class="admin-list-item">
      <div class="info">
        <b>${esc(s.name)}</b>
        <small>${s.flashcards.length} flashcard(s)</small>
      </div>
      <button class="btn sm ghost" onclick="adminEditReviewer('${s.id}')">Edit</button>
    </div>`;
  });
  return html;
}
function adminEditReviewer(id){
  const D = DATA[currentSchool];
  const s = D.subjects.find(x=>x.id===id);
  const html = `<h3>Reviewers — ${esc(s.name)}</h3>

  <div class="section-label" style="margin-top:0;">Flashcards</div>
  <div id="flashList">${s.flashcards.map((f)=>`<div class="admin-list-item"><div class="info">${f.image?`<img src="${safeUrl(f.image)}" style="width:100%;max-width:160px;border-radius:8px;margin-bottom:6px;display:block;">`:''}<b>Q:</b> ${esc(f.q)}<br><small>A: ${esc(f.a)}</small></div><button class="btn sm danger" onclick="adminDeleteFlash('${id}','${f.id}')">Delete</button></div>`).join('')}</div>
  <div class="form-grid">
    <input id="fc_q" placeholder="Question">
    <input id="fc_a" placeholder="Answer">
    <input id="fc_img" placeholder="Image URL (optional — direct image link)">
    <button class="btn ghost" onclick="adminAddFlash('${id}')">+ Add flashcard</button>
  </div>
  <p class="modal-sub">The Mock Quiz is made from these flashcards automatically.</p>`;
  openModal(html);
}
async function adminAddFlash(subjId){
  const q = document.getElementById('fc_q').value.trim();
  const a = document.getElementById('fc_a').value.trim();
  const img = document.getElementById('fc_img').value.trim();
  if(!q||!a){alert('Fill both fields.');return;}
  await dbAddFlashcard(subjId, q, a, img);
  await refreshCurrentSchool();
  adminEditReviewer(subjId);
}
async function adminDeleteFlash(subjId, flashId){
  await dbDeleteFlashcard(flashId);
  await refreshCurrentSchool();
  adminEditReviewer(subjId);
}
async function adminAddQuiz(subjId){
  const q = document.getElementById('qz_q').value.trim();
  const choices = document.getElementById('qz_choices').value.split('$').map(c=>c.trim()).filter(Boolean);
  const answerText = document.getElementById('qz_answer').value.trim();
  const diff = document.getElementById('qz_diff').value;
  const img = document.getElementById('qz_img').value.trim();
  const answerIdx = choices.indexOf(answerText);
  if(!q||choices.length<2||answerIdx===-1){ alert('Fill all fields; correct answer must exactly match one choice.'); return; }
  await dbAddQuiz(subjId, q, choices, answerIdx, diff, img);
  await refreshCurrentSchool();
  adminEditReviewer(subjId);
}
async function adminDeleteQuiz(subjId, quizId){
  await dbDeleteQuiz(quizId);
  await refreshCurrentSchool();
  adminEditReviewer(subjId);
}

/* ---- Events admin ---- */
function adminEvents(D){
  let html = `<div class="form-grid">
    <input id="ev_title" placeholder="Title">
    <div class="two-col">
      <input id="ev_date" type="date" value="${todayISO()}">
      <select id="ev_type">${typeOptionsHtml('activity','Assignment')}</select>
    </div>
    <select id="ev_subject"><option value="">General (not tied to a subject)</option>${D.subjects.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
    <textarea id="ev_desc" placeholder="Description" rows="2"></textarea>
    <button class="btn" onclick="adminAddEvent()">+ Add to calendar</button>
  </div><div class="section-label">All events</div>`;
  D.events.slice().sort((a,b)=>a.date.localeCompare(b.date)).forEach(e=>{
    const auto = e.sourceActivityId ? ' <small style="color:var(--ink-soft);">(auto, from an Activity)</small>' : '';
    html += `<div class="admin-list-item"><div class="info"><b>${esc(e.title)}</b>${auto}<br><small>${esc(e.date)} · ${esc(e.type)}</small></div>
      <div style="display:flex;gap:6px;">
        <button class="btn sm ghost" onclick="adminEditEvent('${e.id}')">Edit</button>
        <button class="btn sm danger" onclick="adminDeleteEvent('${e.id}')">Delete</button>
      </div></div>`;
  });
  return html;
}
async function adminAddEvent(){
  const title = document.getElementById('ev_title').value.trim();
  if(!title){alert('Title required.');return;}
  await dbAddEvent(currentSchool, {
    title, date: document.getElementById('ev_date').value, type: document.getElementById('ev_type').value,
    subject_id: document.getElementById('ev_subject').value || null,
    description: document.getElementById('ev_desc').value
  });
  await refreshCurrentSchool();
  goPage(currentPage);
}
function adminEditEvent(id){
  const D = DATA[currentSchool];
  const e = D.events.find(x=>x.id===id);
  const html = `<h3>Edit event</h3>
  <div class="form-grid">
    <input id="ev_title_edit" value="${escAttr(e.title)}" placeholder="Title">
    <div class="two-col">
      <input id="ev_date_edit" type="date" value="${esc(e.date)}">
      <select id="ev_type_edit">${typeOptionsHtml('activity', e.type)}</select>
    </div>
    <select id="ev_subject_edit">
      <option value="">General (not tied to a subject)</option>
      ${D.subjects.map(s=>`<option value="${s.id}" ${s.id===e.subjectId?'selected':''}>${esc(s.name)}</option>`).join('')}
    </select>
    <textarea id="ev_desc_edit" placeholder="Description" rows="2">${esc(e.desc||'')}</textarea>
  </div>
  <div class="modal-actions"><button class="btn" onclick="adminSaveEvent('${id}')">Save changes</button></div>`;
  openModal(html);
}
async function adminSaveEvent(id){
  await dbUpdateEvent(id, {
    title: document.getElementById('ev_title_edit').value,
    date: document.getElementById('ev_date_edit').value,
    type: document.getElementById('ev_type_edit').value,
    subject_id: document.getElementById('ev_subject_edit').value || null,
    description: document.getElementById('ev_desc_edit').value
  });
  await refreshCurrentSchool();
  goPage(currentPage);
  closeModal();
}
async function adminDeleteEvent(id){
  await dbDeleteEvent(id);
  await refreshCurrentSchool();
  goPage(currentPage);
}

/* ---- Activities admin ---- */
function adminActivities(D){
  let html = `<button class="btn" onclick="adminAddActivity()">+ Add activity</button>
  <p style="color:var(--ink-soft);font-size:calc(12.5px * var(--fs));margin-top:8px;">Due dates are automatically added to the Calendar too.</p>
  <div class="section-label">All activities</div>
  ${D.activities.length ? `<button class="btn ghost sm" onclick="adminResyncAllActivities()" style="margin-bottom:12px;">↻ Sync all to Calendar</button><p style="color:var(--ink-soft);font-size:calc(11.5px * var(--fs));margin-top:-8px;">Use this once if you have older activities from before dates auto-synced.</p>` : ''}`;
  D.activities.forEach(a=>{
    html += `<div class="admin-list-item"><div class="info"><b>${esc(a.title)}</b><br><small>${esc(a.type)} · starts ${esc(a.start||'TBA')} · due ${esc(a.due||'TBA')}</small></div>
      <div style="display:flex;gap:6px;">
        <button class="btn sm ghost" onclick="adminEditActivity('${a.id}')">Edit</button>
        <button class="btn sm danger" onclick="adminDeleteActivity('${a.id}')">Delete</button>
      </div></div>`;
  });
  return html;
}
async function adminAddActivity(){
  const newId = await dbAddActivity(currentSchool, {
    title: 'New Activity', type: 'Assignment', start_date: todayISO(), due_date: todayISO(),
    instructions: '', tags: []
  });
  await refreshCurrentSchool();
  goPage(currentPage);
  if(newId) adminEditActivity(newId);
}
function adminEditActivity(id){
  const D = DATA[currentSchool];
  const a = D.activities.find(x=>x.id===id);
  const html = `<h3>Edit activity</h3>
  <div class="form-grid">
    <input id="ac_title_edit" value="${escAttr(a.title)}" placeholder="Title">
    <select id="ac_subject_edit">
      <option value="">General (not tied to a subject)</option>
      ${D.subjects.map(s=>`<option value="${s.id}" ${s.id===a.subjectId?'selected':''}>${esc(s.name)}</option>`).join('')}
    </select>
    ${typeFieldHtml('activity','ac_type_edit', a.type)}
    <div class="two-col dates">
      <div><label>Start</label><input id="ac_start_edit" type="date" value="${esc(a.start||'')}"></div>
      <div><label>Due</label><input id="ac_due_edit" type="date" value="${esc(a.due||'')}"></div>
    </div>
    <textarea id="ac_instr_edit" placeholder="Instructions" rows="3">${esc(a.instructions||'')}</textarea>
    <div><label>Tags</label>${tagEditorHtml('ac_tags_edit')}</div>
    <input id="ac_img_edit" value="${escAttr(a.image||'')}" placeholder="Image URL (optional — direct image link)">
  </div>
  <p class="modal-sub" style="margin-top:0;">Saving updates the matching Calendar entry too.</p>
  <div class="modal-actions"><button class="btn" onclick="adminSaveActivity('${id}')">Save changes</button></div>`;
  tagDraft = (a.tags||[]).slice();
  openModal(html);
  renderTagChips('ac_tags_edit');
}
async function adminSaveActivity(id){
  const subjectId = document.getElementById('ac_subject_edit').value || null;
  const title = document.getElementById('ac_title_edit').value;
  const type = document.getElementById('ac_type_edit').value;
  const start = document.getElementById('ac_start_edit').value;
  const due = document.getElementById('ac_due_edit').value;
  const instructions = document.getElementById('ac_instr_edit').value;
  const tags = tagValues('ac_tags_edit');
  await dbUpdateActivity(id, {
    title, subject_id: subjectId, type, start_date: start, due_date: due,
    instructions, tags,
    image_url: document.getElementById('ac_img_edit').value.trim()
  });
  await dbSyncActivityCalendarEvents(currentSchool, id, subjectId, title, type, start, due, instructions);
  await refreshCurrentSchool();
  goPage(currentPage);
  closeModal();
}
async function adminDeleteActivity(id){
  await dbDeleteActivity(id);
  await refreshCurrentSchool();
  goPage(currentPage);
}
async function adminResyncAllActivities(){
  const D = DATA[currentSchool];
  for(const a of D.activities){
    await dbSyncActivityCalendarEvents(currentSchool, a.id, a.subjectId, a.title, a.type, a.start, a.due, a.instructions);
  }
  await refreshCurrentSchool();
  goPage(currentPage);
  alert('Calendar synced for all activities.');
}

/* ---- FAQ admin ---- */
function adminFaqs(D){
  let html = `<div class="form-grid">
    <input id="fq_q" placeholder="Question">
    <textarea id="fq_a" placeholder="Answer" rows="2"></textarea>
    <button class="btn" onclick="adminAddFaq()">+ Add FAQ</button>
  </div><div class="section-label">All FAQs</div>`;
  D.faqs.forEach((f)=>{
    html += `<div class="admin-list-item"><div class="info"><b>${esc(f.q)}</b><br><small>${esc(f.a)}</small></div>
      <div style="display:flex;gap:6px;">
        <button class="btn sm ghost" onclick="adminEditFaq('${f.id}')">Edit</button>
        <button class="btn sm danger" onclick="adminDeleteFaq('${f.id}')">Delete</button>
      </div></div>`;
  });
  return html;
}
async function adminAddFaq(){
  const q = document.getElementById('fq_q').value.trim();
  const a = document.getElementById('fq_a').value.trim();
  if(!q||!a){alert('Fill both fields.');return;}
  await dbAddFaq(currentSchool, q, a);
  await refreshCurrentSchool();
  goPage(currentPage);
}
function adminEditFaq(id){
  const D = DATA[currentSchool];
  const f = D.faqs.find(x=>x.id===id);
  openModal(`<h3>Edit FAQ</h3>
    <div class="form-grid">
      <input id="fq_q_edit" value="${escAttr(f.q)}" placeholder="Question">
      <textarea id="fq_a_edit" placeholder="Answer" rows="3">${esc(f.a)}</textarea>
    </div>
    <div class="modal-actions"><button class="btn" onclick="adminSaveFaq('${id}')">Save changes</button></div>`);
}
async function adminSaveFaq(id){
  const q = document.getElementById('fq_q_edit').value.trim();
  const a = document.getElementById('fq_a_edit').value.trim();
  if(!q||!a){alert('Fill both fields.');return;}
  await dbUpdateFaq(id, q, a);
  await refreshCurrentSchool();
  goPage(currentPage);
  closeModal();
}
async function adminDeleteFaq(id){
  await dbDeleteFaq(id);
  await refreshCurrentSchool();
  goPage(currentPage);
}

/* ---- Rules admin ---- */
function adminRules(D){
  const r = D.rules;
  let html = `<div class="form-grid">
    <div><label>Vision</label><textarea id="r_vision" rows="2">${esc(r.vision)}</textarea></div>
    <div><label>Mission</label><textarea id="r_mission" rows="2">${esc(r.mission)}</textarea></div>
    <div><label>Preamble</label><textarea id="r_preamble" rows="2">${esc(r.preamble)}</textarea></div>
    <div><label>Core Values (separated by $)</label><input id="r_values" value="${escAttr(r.coreValues.join(' $ '))}"></div>
    <button class="btn" onclick="adminSaveRules()">Save</button>
  </div>
  <div class="section-label">More sections</div>
  <p style="color:var(--ink-soft);font-size:calc(12.5px * var(--fs));margin-top:-6px;">Add anything else that doesn't fit above — university hymn, strategic goals, rules & regulations, dress code, whatever you need. Each one shows up as its own block on the Rules and Others page.</p>`;
  if(r.guidelines.length===0){
    html += `<p style="color:var(--ink-soft);font-size:calc(12.5px * var(--fs));">None yet.</p>`;
  }
  r.guidelines.forEach((g)=>{
    html += `<div class="admin-list-item"><div class="info"><b>${esc(g.title)}</b><br><small>${esc(g.body)}</small></div>
      <div style="display:flex;gap:6px;">
        <button class="btn sm ghost" onclick="adminEditGuideline('${g.id}')">Edit</button>
        <button class="btn sm danger" onclick="adminDeleteGuideline('${g.id}')">Delete</button>
      </div></div>`;
  });
  html += `<div class="form-grid">
    <input id="g_title" placeholder="Section title (e.g. University Hymn, Strategic Goals, Dress Code)">
    <textarea id="g_body" placeholder="Content for this section — or separate short items with $ to display them as chips, like Core Values (e.g. Item 1 $ Item 2 $ Item 3)" rows="3"></textarea>
    <button class="btn ghost" onclick="adminAddGuideline()">+ Add section</button>
  </div>`;
  return html;
}
async function adminSaveRules(){
  await dbSaveRules(currentSchool, {
    vision: document.getElementById('r_vision').value,
    mission: document.getElementById('r_mission').value,
    preamble: document.getElementById('r_preamble').value,
    core_values: document.getElementById('r_values').value.split('$').map(v=>v.trim()).filter(Boolean)
  });
  await refreshCurrentSchool();
  goPage(currentPage);
}
async function adminAddGuideline(){
  const title = document.getElementById('g_title').value.trim();
  const body = document.getElementById('g_body').value.trim();
  if(!title||!body){alert('Fill both fields.');return;}
  await dbAddGuideline(currentSchool, title, body);
  await refreshCurrentSchool();
  goPage(currentPage);
}
function adminEditGuideline(id){
  const D = DATA[currentSchool];
  const g = D.rules.guidelines.find(x=>x.id===id);
  openModal(`<h3>Edit section</h3>
    <div class="form-grid">
      <input id="g_title_edit" value="${escAttr(g.title)}" placeholder="Section title">
      <textarea id="g_body_edit" placeholder="Content" rows="4">${esc(g.body)}</textarea>
    </div>
    <div class="modal-actions"><button class="btn" onclick="adminSaveGuideline('${id}')">Save changes</button></div>`);
}
async function adminSaveGuideline(id){
  const title = document.getElementById('g_title_edit').value.trim();
  const body = document.getElementById('g_body_edit').value.trim();
  if(!title||!body){alert('Fill both fields.');return;}
  await dbUpdateGuideline(id, title, body);
  await refreshCurrentSchool();
  goPage(currentPage);
  closeModal();
}
async function adminDeleteGuideline(id){
  await dbDeleteGuideline(id);
  await refreshCurrentSchool();
  goPage(currentPage);
}

/* ---- Theme admin ---- */
function openThemeModal(){
  const D = DATA[currentSchool];
  openModal(`
    <h3>Colors for ${esc(D.fullName)}</h3>
    <p style="color:var(--ink-soft);font-size:calc(12.5px * var(--fs));">These apply site-wide whenever someone is viewing this school. Changes save immediately and preview here too.</p>
    <div class="two-col" style="margin-top:16px;max-width:320px;">
      <div>
        <label>Accent color</label>
        <input id="th_accent" type="color" value="${esc(D.accentColor)}" style="height:44px;">
      </div>
      <div>
        <label>Background color</label>
        <input id="th_bg" type="color" value="${esc(D.bgColor)}" style="height:44px;">
      </div>
    </div>
    <button class="btn" style="margin-top:18px;" onclick="adminSaveTheme()">Save colors</button>
    <button class="btn ghost" style="margin-top:18px;" onclick="adminResetTheme()">Reset to default</button>
  `);
}
async function adminSaveTheme(){
  const accent = document.getElementById('th_accent').value;
  const bg = document.getElementById('th_bg').value;
  await dbSaveTheme(currentSchool, accent, bg);
  await refreshCurrentSchool();
  applyTheme(currentSchool);
  closeModal();
  goPage(currentPage);
}
async function adminResetTheme(){
  await dbSaveTheme(currentSchool, '#2F6F5E', '#F6F5F0');
  await refreshCurrentSchool();
  applyTheme(currentSchool);
  closeModal();
  goPage(currentPage);
}

function escAttr(s){ return esc(s); }
