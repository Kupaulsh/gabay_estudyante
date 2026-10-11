/* =========================================================
   LOCAL NOTIFICATIONS (native Android app only)
   - Due-date reminders: 8:00 AM the day before an activity is due
   - Class reminders: 10 minutes before each scheduled class, weekly
   Uses @capacitor/local-notifications. No server/Firebase involved —
   everything is computed and scheduled on-device from data already loaded.
========================================================= */

const NOTIF_ID_BASE_ACTIVITY = 100000; // 100000–189999 reserved for due-date reminders
const NOTIF_ID_BASE_CLASS    = 200000; // 200000–289999 reserved for class reminders
const NOTIF_ID_RANGE = 90000;
const ACT_SOUND = 'alarm.wav';      // activity reminders
const CLASS_SOUND = 'alarm2.wav';   // schedule (class) reminders — a different rhythm
// Android needs the same file names inside android/app/src/main/res/raw/

function isNativeApp(){
  return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}
function getLocalNotifications(){
  return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications) || null;
}

// Deterministic string -> integer id within a given range, so re-scheduling
// the same activity/class always reuses the same notification id instead of duplicating.
function hashToNotifId(str, base){
  let hash = 0;
  for(let i=0;i<str.length;i++){ hash = (hash*31 + str.charCodeAt(i)) >>> 0; }
  return base + (hash % NOTIF_ID_RANGE);
}

async function initNotifications(){
  if(!isNativeApp()) return;
  const LN = getLocalNotifications();
  if(!LN) return;
  try{
    const perm = await LN.checkPermissions();
    if(perm.display !== 'granted'){
      await LN.requestPermissions();
    }
  }catch(e){ console.error('Notification permission error:', e); }
  try{
    await LN.createChannel({id:'activity-alarm', name:'Activity reminders', description:'Due-date reminders', importance:5, visibility:1, vibration:true, sound:ACT_SOUND});
    await LN.createChannel({id:'class-alarm', name:'Class reminders', description:'Class starting soon', importance:5, visibility:1, vibration:true, sound:CLASS_SOUND});
  }catch(e){ console.error('Notification channel error:', e); }
  if(!notifActionsReady){
    notifActionsReady = true;
    try{
      await LN.registerActionTypes({types:[
        {id:'ACT_REMINDER', actions:[{id:'completed', title:'Completed'}, {id:'notyet', title:'Not Yet'}, {id:'ohno', title:'Oh No'}]}
      ]});
      await LN.addListener('localNotificationActionPerformed', onActivityNotifAction);
    }catch(e){ console.error('Notification action error:', e); }
  }
}
let notifActionsReady = false;

// Buttons on an activity reminder: Completed marks it done, Not Yet leaves it, Oh No opens it.
async function onActivityNotifAction(ev){
  try{
    const n = ev && ev.notification;
    if(!n || n.actionTypeId!=='ACT_REMINDER' || !n.extra) return;
    const id = n.extra.activityId, school = n.extra.school;
    if(ev.actionId==='completed'){
      if(id && !getCompletedSet().has(id)) toggleCompletedFlag(id);
      if(typeof currentPage!=='undefined' && currentPage==='activities') renderActivities();
      if(typeof showToast==='function') showToast('Marked as completed');
    } else if(ev.actionId==='ohno'){
      if(school && school!==currentSchool) await enterApp(school);
      if(currentSchool && S() && S().activities.some(a=>a.id===id)){ goPage('activities'); openActivity(id); }
    }
  }catch(e){ console.error('Notification action failed:', e); }
}

// Weekday numbers expected by Capacitor's schedule.on.weekday: Sunday=1 ... Saturday=7
const NOTIF_WEEKDAY = {Sun:1, Mon:2, Tue:3, Wed:4, Thu:5, Fri:6, Sat:7};

async function scheduleAllNotifications(){
  if(!isNativeApp()) return;
  const LN = getLocalNotifications();
  if(!LN || !currentSchool || !S()) return;

  try{
    // Clear out anything we previously scheduled for this app before rescheduling fresh,
    // so edited/deleted activities and schedule changes don't leave stale reminders behind.
    const pending = await LN.getPending();
    const ours = (pending.notifications || [])
      .filter(n => n.id >= NOTIF_ID_BASE_ACTIVITY && n.id < NOTIF_ID_BASE_CLASS + NOTIF_ID_RANGE)
      .map(n => ({id: n.id}));
    if(ours.length) await LN.cancel({notifications: ours});

    const toSchedule = [];
    const now = new Date();

    // --- Due-date reminders: 8:00 AM the day before due ---
    S().activities.forEach(a=>{
      if(!a.due) return;
      if(typeof getCompletedSet === 'function' && getCompletedSet().has(a.id)) return; // already done
      const due = new Date(a.due + 'T00:00:00');
      const reminderAt = new Date(due.getTime() - 24*60*60*1000);
      reminderAt.setHours(8,0,0,0);
      if(reminderAt <= now) return; // don't schedule reminders in the past
      toSchedule.push({
        id: hashToNotifId(a.id, NOTIF_ID_BASE_ACTIVITY),
        title: `Due tomorrow: ${a.title}`,
        body: `${a.type} — due ${a.due}`,
        schedule: { at: reminderAt, allowWhileIdle:true },
        channelId: 'activity-alarm', sound: ACT_SOUND,
        actionTypeId: 'ACT_REMINDER', extra: {activityId: a.id, school: currentSchool},
        smallIcon: 'ic_stat_icon_config_sample'
      });
    });

    // --- Class reminders: 10 minutes before each scheduled slot, repeating weekly ---
    S().subjects.forEach(s=>{
      (s.schedule||[]).forEach(sl=>{
        if(!sl.day || !sl.time) return;
        const weekday = NOTIF_WEEKDAY[sl.day];
        if(!weekday) return;
        const startMin = parseTimeStart(sl.time);
        if(startMin >= 24*60) return; // couldn't parse a real time
        let notifyMin = startMin - 10;
        if(notifyMin < 0) notifyMin += 24*60; // class starts right after midnight edge case
        const hour = Math.floor(notifyMin/60), minute = notifyMin%60;
        toSchedule.push({
          id: hashToNotifId((sl.id||'') + s.id, NOTIF_ID_BASE_CLASS),
          title: `Starting soon: ${s.name}`,
          body: `Starts ${sl.time} · Room ${sl.room||'TBA'}`,
          schedule: { on: {weekday, hour, minute}, allowWhileIdle:true },
          channelId: 'class-alarm', sound: CLASS_SOUND,
          smallIcon: 'ic_stat_icon_config_sample'
        });
      });
    });

    if(toSchedule.length){
      await LN.schedule({ notifications: toSchedule });
    }
  }catch(e){
    console.error('Could not schedule notifications:', e);
  }
}
