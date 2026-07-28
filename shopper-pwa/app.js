// ═══════════════════════════════════════════════════════════
// GhostAudit / Wizoria — Shopper PWA
// ═══════════════════════════════════════════════════════════

const API_BASE = 'https://primary-production-4b93e.up.railway.app/webhook';
const APP_VERSION = 'v8'; // bump this on every real code change — visible on screen bottom-right,
// so it's possible to confirm at a glance whether a new deploy actually reached the device,
// instead of asking "did you upload it?" every time.
document.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('app-version');
  if (el) el.textContent = APP_VERSION;
});
// also set it immediately in case DOMContentLoaded already fired by the time this script runs
if (document.readyState !== 'loading') {
  const el = document.getElementById('app-version');
  if (el) el.textContent = APP_VERSION;
}

// ─── STATE ────────────────────────────────────────────────
const State = {
  token: localStorage.getItem('ga_token') || null,
  user: JSON.parse(localStorage.getItem('ga_user') || 'null'),
  objects: [],
  tasks: [],
  currentObject: null,
  currentTask: null,       // full task object incl. requirements arrays
  currentSubmissionId: null,
  hubProgress: {},          // { [key]: true } local tracking of what's done this session
  currentReq: null,         // currently open photo/audio requirement
  photoFiles: {},           // { [requirementId]: [File, File...] } collected before "Готово"
  quest: null,              // { questionnaireId, criteria: [...], answers: {}, idx: 0, visibleList: [...] }
};

function saveAuth(token, user) {
  State.token = token;
  State.user = user;
  localStorage.setItem('ga_token', token);
  localStorage.setItem('ga_user', JSON.stringify(user));
}

// ─── SESSION PERSISTENCE ──────────────────────────────────
// iOS/WKWebView can reload the page when returning from the native camera (a documented
// platform quirk, not something we can prevent) — this wipes anything held only in memory,
// which is exactly what was happening to State.currentSubmissionId. Persisting the active
// task/submission to localStorage lets the app recover automatically instead of losing the
// in-progress task entirely.
function saveSession() {
  if (State.currentObject && State.currentTask && State.currentSubmissionId) {
    localStorage.setItem('ga_session', JSON.stringify({
      object: State.currentObject,
      task: State.currentTask,
      submissionId: State.currentSubmissionId,
      hubProgress: State.hubProgress
    }));
  }
}

function clearSession() {
  localStorage.removeItem('ga_session');
}

function restoreSession() {
  try {
    const raw = localStorage.getItem('ga_session');
    if (!raw) return false;
    const s = JSON.parse(raw);
    if (!s.object || !s.task || !s.submissionId) return false;
    State.currentObject = s.object;
    State.currentTask = s.task;
    State.currentSubmissionId = s.submissionId;
    State.hubProgress = s.hubProgress || {};
    Router.show('hub');
    renderHub();
    return true;
  } catch (e) {
    return false;
  }
}

function doLogout() {
  if (!confirm('Вийти з акаунту ' + (State.user?.first_name || '') + '?')) return;
  localStorage.removeItem('ga_token');
  localStorage.removeItem('ga_user');
  clearSession();
  State.token = null;
  State.user = null;
  document.getElementById('login-input').value = '';
  document.getElementById('password-input').value = '';
  Router.show('login');
}

// ─── API HELPER ───────────────────────────────────────────
async function api(path, { method = 'GET', body = null, isForm = false } = {}) {
  const headers = {};
  if (State.token) headers['Authorization'] = 'Bearer ' + State.token;
  if (!isForm && body) headers['Content-Type'] = 'application/json';

  const res = await fetch(API_BASE + path, {
    method,
    headers,
    body: isForm ? body : (body ? JSON.stringify(body) : undefined)
  });

  let data;
  try { data = await res.json(); } catch (e) { data = { success: false, error: 'Некоректна відповідь сервера' }; }
  return { status: res.status, data };
}

// ─── ROUTER ───────────────────────────────────────────────
const Router = {
  show(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('screen-' + name).classList.add('active');
    window.scrollTo(0, 0);
  }
};

// ─── ONLINE / OFFLINE BANNER ──────────────────────────────
function updateOnlineBanner() {
  document.getElementById('online-banner').classList.toggle('show', !navigator.onLine);
}
window.addEventListener('online', updateOnlineBanner);
window.addEventListener('offline', updateOnlineBanner);

// ─── LOGIN ────────────────────────────────────────────────
function setErr(id, msg) {
  const err = document.getElementById('err-' + id);
  const input = document.getElementById(id + '-input');
  if (msg) { err.textContent = msg; err.classList.add('show'); input?.classList.add('is-err'); }
  else { err.textContent = ''; err.classList.remove('show'); input?.classList.remove('is-err'); }
}

async function doLogin() {
  const login = document.getElementById('login-input').value.trim();
  const password = document.getElementById('password-input').value;
  const alertEl = document.getElementById('login-alert');
  alertEl.classList.remove('show');

  let ok = true;
  if (!login) { setErr('login', "Обов'язкове поле"); ok = false; } else setErr('login', null);
  if (!password) { setErr('password', "Обов'язкове поле"); ok = false; } else setErr('password', null);
  if (!ok) return;

  const btn = document.getElementById('btn-login');
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-spin"></span>';

  try {
    const { data } = await api('/ga/auth/login', { method: 'POST', body: { login, password } });
    if (data.success && data.token) {
      saveAuth(data.token, data.user);
      Router.show('objects');
      Objects.load();
    } else {
      alertEl.textContent = data.error || 'Не вдалося увійти';
      alertEl.classList.add('show');
    }
  } catch (e) {
    alertEl.textContent = "Немає з'єднання з сервером";
    alertEl.classList.add('show');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Увійти';
  }
}
document.getElementById('btn-login').addEventListener('click', doLogin);
document.getElementById('password-input').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

// ─── SCREEN: OBJECTS ──────────────────────────────────────
const Objects = {
  async load() {
    document.getElementById('user-avatar').textContent = (State.user?.first_name || '?')[0].toUpperCase();
    const list = document.getElementById('objects-list');
    const empty = document.getElementById('objects-empty');
    list.innerHTML = '<div class="card-sub" style="text-align:center;padding:20px 0">Завантаження…</div>';
    empty.style.display = 'none';
    try {
      const { data } = await api('/ga/shopper/objects');
      if (!data.success) {
        list.innerHTML = `<div class="fm-alert show err">${escapeHtml(data.error || "Не вдалося завантажити об'єкти")}</div>
          <button class="fm-btn outline sm" style="margin-top:10px" onclick="doLogout()">Вийти з акаунту</button>`;
        return;
      }
      State.objects = data.objects;
      this.render();
    } catch (e) {
      list.innerHTML = `<div class="fm-alert show err">Немає з'єднання з сервером: ${escapeHtml(e.message)}</div>`;
    }
  },
  render() {
    const list = document.getElementById('objects-list');
    const empty = document.getElementById('objects-empty');
    list.innerHTML = '';
    if (State.objects.length === 0) { empty.style.display = 'block'; return; }
    empty.style.display = 'none';

    State.objects.forEach(o => {
      const card = document.createElement('div');
      card.className = 'card' + (o.all_done ? ' done' : (o.remaining_tasks > 0 ? ' highlight' : ''));
      const badge = o.all_done
        ? `<span class="badge success">Здано</span>`
        : `<span class="badge accent">${o.remaining_tasks} завд.</span>`;
      card.innerHTML = `
        <div class="card-row">
          <div class="card-title">${escapeHtml(o.object_name)}</div>
          ${badge}
        </div>
        <div class="card-sub">${escapeHtml(o.city || o.address || '')}</div>
      `;
      if (!o.all_done) {
        card.addEventListener('click', () => Tasks.open(o));
      }
      list.appendChild(card);
    });
  }
};

// ─── SCREEN: TASKS ────────────────────────────────────────
const Tasks = {
  async open(obj) {
    State.currentObject = obj;
    document.getElementById('tasks-object-name').textContent = obj.object_name;
    Router.show('tasks');
    const list = document.getElementById('tasks-list');
    list.innerHTML = '<div class="card-sub" style="text-align:center;padding:20px 0">Завантаження…</div>';
    try {
      const { data } = await api('/ga/shopper/tasks?object_id=' + obj.object_id);
      if (!data.success) {
        list.innerHTML = `<div class="fm-alert show err">${escapeHtml(data.error || 'Не вдалося завантажити завдання')}</div>`;
        return;
      }
      State.tasks = data.tasks;
      if (data.object_progress) {
        document.getElementById('tasks-progress').textContent =
          `${data.object_progress.completed_tasks}/${data.object_progress.total_tasks} виконано`;
      }
      this.render();
    } catch (e) {
      list.innerHTML = `<div class="fm-alert show err">Немає з'єднання з сервером: ${escapeHtml(e.message)}</div>`;
    }
  },
  render() {
    const list = document.getElementById('tasks-list');
    const empty = document.getElementById('tasks-empty');
    list.innerHTML = '';
    if (State.tasks.length === 0) { empty.style.display = 'block'; return; }
    empty.style.display = 'none';

    State.tasks.forEach(t => {
      const isDone = t.status === 'submitted';
      const card = document.createElement('div');
      card.className = 'card' + (isDone ? ' done' : '');

      const reqRows = [];
      t.photo_requirements.forEach(r => reqRows.push(reqRowHtml('photo', r.title, `${r.required_count} фото`)));
      t.audio_requirements.forEach(r => reqRows.push(reqRowHtml('audio', r.title, `Мін. ${r.min_duration_sec} сек`)));
      t.questionnaires.forEach(r => reqRows.push(reqRowHtml('quest', r.title, `${r.criteria_count} питань`)));

      card.innerHTML = `
        <div style="margin-bottom:${reqRows.length ? '8px' : '0'}">${reqRows.join('')}</div>
        ${isDone
          ? `<span class="badge success">Здано</span>`
          : `<button class="fm-btn sm" type="button">${t.status === 'in_progress' ? 'Продовжити' : 'Виконати'} <i class="ti ti-arrow-right" aria-hidden="true"></i></button>`}
      `;
      if (!isDone) {
        card.querySelector('button').addEventListener('click', (e) => { e.stopPropagation(); Task.open(t); });
      }
      list.appendChild(card);
    });
  }
};

function reqRowHtml(kind, title, sub) {
  const icons = { photo: 'ti-camera', audio: 'ti-microphone', quest: 'ti-clipboard-check' };
  return `
    <div class="req-row">
      <div class="req-icon ${kind}"><i class="ti ${icons[kind]}" aria-hidden="true"></i></div>
      <div class="req-info"><div class="t">${escapeHtml(title)}</div><div class="s">${escapeHtml(sub)}</div></div>
    </div>
  `;
}

// ─── TASK FLOW (geo → hub → photo/audio/quest → submit) ──
const Task = {
  async open(task) {
    State.currentTask = task;
    State.hubProgress = {};
    State.photoFiles = {};
    State.currentSubmissionId = null; // always clear first — never let a stale id from a
    // previously opened task leak into this one if something below fails to set a fresh one

    if (task.status === 'in_progress') {
      // resume — a submission already exists for this task from a previous geo-check.
      // ga-shopper-tasks now returns submission_id for exactly this reason (was missing
      // before, which caused every subsequent photo/audio/answers call to fail validation).
      if (!task.submission_id) {
        Router.show('hub');
        renderHub(); // renders with no working buttons — see the guard inside renderHub itself
        document.getElementById('hub-alert').textContent = 'Не вдалося знайти submission для цього завдання. Поверніться до списку завдань і спробуйте ще раз.';
        document.getElementById('hub-alert').className = 'fm-alert show err';
        return;
      }
      State.currentSubmissionId = task.submission_id;
      saveSession();
      Router.show('hub');
      renderHub();
    } else {
      Router.show('geo');
      resetGeoScreen();
    }
  }
};

// ─── SCREEN: GEO ──────────────────────────────────────────
function resetGeoScreen() {
  document.getElementById('geo-object-name').textContent = State.currentObject.object_name;
  document.getElementById('geo-method').textContent = '—';
  document.getElementById('geo-accuracy').textContent = '—';
  document.getElementById('geo-distance').textContent = '—';
  document.getElementById('geo-time').textContent = '—';
  document.getElementById('geo-alert').classList.remove('show');
  const btn = document.getElementById('btn-geo-confirm');
  btn.disabled = false;
  btn.textContent = 'Визначити місцезнаходження';
}

document.getElementById('btn-geo-confirm').addEventListener('click', async () => {
  const btn = document.getElementById('btn-geo-confirm');
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-spin"></span>';
  document.getElementById('geo-alert').classList.remove('show');

  if (!('geolocation' in navigator)) {
    showGeoError("Геолокація не підтримується цим браузером");
    return;
  }

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const accuracy = Math.round(pos.coords.accuracy);
      const method = accuracy <= 30 ? 'gps' : (accuracy <= 100 ? 'wifi' : 'cell');

      document.getElementById('geo-method').textContent = method.toUpperCase();
      document.getElementById('geo-accuracy').textContent = `±${accuracy} м`;
      document.getElementById('geo-time').textContent = new Date().toLocaleTimeString('uk-UA');

      const { data } = await api('/ga/shopper/geo-check', {
        method: 'POST',
        body: { task_id: State.currentTask.task_id, lat, lng, method, accuracy_m: accuracy }
      });

      if (data.success) {
        State.currentSubmissionId = data.submission_id;
        saveSession();
        document.getElementById('geo-distance').textContent = `~${data.distance_to_object_m} м`;
        document.getElementById('geo-distance').classList.add('ok');
        Router.show('hub');
        renderHub();
      } else if (data.reason === 'too_far') {
        document.getElementById('geo-distance').textContent = `~${data.distance_to_object_m} м`;
        showGeoError(`Ви задалеко від об'єкту (потрібно бути ближче ${data.geo_radius_m} м). Підійдіть ближче і спробуйте ще раз.`, 'warn');
      } else {
        showGeoError(data.error || 'Сталася помилка');
      }
    },
    (err) => showGeoError('Не вдалося визначити місцезнаходження: ' + err.message),
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
});

function showGeoError(msg, cls = 'err') {
  const alertEl = document.getElementById('geo-alert');
  alertEl.textContent = msg;
  alertEl.className = 'fm-alert show ' + cls;
  const btn = document.getElementById('btn-geo-confirm');
  btn.disabled = false;
  btn.textContent = 'Спробувати ще раз';
}

// ─── SCREEN: HUB (checklist for current task) ────────────
function hubKey(kind, id) { return kind + '-' + id; }

function renderHub() {
  const t = State.currentTask;
  document.getElementById('hub-object-name').textContent = State.currentObject.object_name;
  document.getElementById('hub-alert').classList.remove('show');
  const list = document.getElementById('hub-list');
  list.innerHTML = '';

  const blocked = !State.currentSubmissionId;
  const guard = (fn) => blocked ? (() => {}) : fn;

  t.photo_requirements.forEach(r => {
    const key = hubKey('photo', r.id);
    const done = !!State.hubProgress[key];
    list.appendChild(hubRow('photo', r.title, `${r.required_count} фото`, done, guard(() => Photo.open(r)), blocked));
  });
  t.audio_requirements.forEach(r => {
    const key = hubKey('audio', r.id);
    const done = !!State.hubProgress[key];
    list.appendChild(hubRow('audio', r.title, `Мін. ${r.min_duration_sec} сек`, done, guard(() => Audio.open(r)), blocked));
  });
  t.questionnaires.forEach(r => {
    const key = hubKey('quest', r.questionnaire_id);
    const done = !!State.hubProgress[key];
    list.appendChild(hubRow('quest', r.title, `${r.criteria_count} питань`, done, guard(() => Quest.open(r)), blocked));
  });

  document.getElementById('btn-hub-submit').disabled = blocked;
}

function hubRow(kind, title, sub, done, onClick, blocked = false) {
  const icons = { photo: 'ti-camera', audio: 'ti-microphone', quest: 'ti-clipboard-check' };
  const card = document.createElement('div');
  card.className = 'card' + (done ? '' : ' highlight');
  card.innerHTML = `
    <div style="display:flex;gap:9px;align-items:center;margin-bottom:${done ? '0' : '8px'}">
      <div class="req-icon ${kind}"><i class="ti ${icons[kind]}" aria-hidden="true"></i></div>
      <div class="req-info"><div class="t">${escapeHtml(title)}</div><div class="s">${escapeHtml(sub)}</div></div>
      <span class="badge ${done ? 'success' : 'accent'}">${done ? 'Готово' : 'Нове'}</span>
    </div>
    ${done ? '' : `<button class="fm-btn sm" type="button" ${blocked ? 'disabled' : ''}>Виконати <i class="ti ti-arrow-right" aria-hidden="true"></i></button>`}
  `;
  if (!done) card.querySelector('button').addEventListener('click', onClick);
  return card;
}

document.getElementById('btn-hub-submit').addEventListener('click', async () => {
  const btn = document.getElementById('btn-hub-submit');
  const alertEl = document.getElementById('hub-alert');
  alertEl.classList.remove('show');
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-spin"></span>';

  const { data } = await api('/ga/shopper/submit', {
    method: 'POST',
    body: { submission_id: State.currentSubmissionId }
  });

  btn.disabled = false;
  btn.innerHTML = 'Відправити на перевірку';

  if (data.success) {
    clearSession();
    Router.show('success');
  } else if (data.missing) {
    const parts = [];
    if (data.missing.photos.length) parts.push(`фото (${data.missing.photos.length})`);
    if (data.missing.audio.length) parts.push(`аудіо (${data.missing.audio.length})`);
    if (data.missing.criteria.length) parts.push(`анкета (${data.missing.criteria.length} питань)`);
    alertEl.textContent = `Не все заповнено: ${parts.join(', ')}. Заповніть пункти позначені «Нове» вище.`;
    alertEl.className = 'fm-alert show warn';
  } else {
    alertEl.textContent = data.error || 'Сталася помилка';
    alertEl.className = 'fm-alert show err';
  }
});

// ─── SCREEN: PHOTO ────────────────────────────────────────
const Photo = {
  open(requirement) {
    State.currentReq = requirement;
    State.photoFiles[requirement.id] = State.photoFiles[requirement.id] || [];
    document.getElementById('photo-title').textContent = requirement.title;
    document.getElementById('photo-count').textContent = `Потрібно ${requirement.required_count} фото`;
    document.getElementById('photo-desc').textContent = requirement.description || '';
    document.getElementById('photo-comment').value = '';
    document.getElementById('photo-alert').classList.remove('show');
    this.renderGrid();
    Router.show('photo');
  },
  renderGrid() {
    const grid = document.getElementById('photo-grid');
    const req = State.currentReq;
    const files = State.photoFiles[req.id] || [];
    grid.innerHTML = '';
    for (let i = 0; i < req.required_count; i++) {
      const slot = document.createElement('div');
      const file = files[i];
      if (file) {
        slot.className = 'photo-slot filled';
        slot.innerHTML = `<img src="${URL.createObjectURL(file)}" alt=""><span class="check"><i class="ti ti-check" aria-hidden="true"></i></span>`;
      } else {
        slot.className = 'photo-slot empty';
        slot.innerHTML = `<i class="ti ti-camera" style="font-size:20px" aria-hidden="true"></i><span class="lbl">фото ${i + 1}</span>`;
        slot.addEventListener('click', () => this.captureSlot(i));
      }
      grid.appendChild(slot);
    }
  },
  captureSlot(index) {
    const input = document.getElementById('photo-file-input');
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      State.photoFiles[State.currentReq.id][index] = file;
      this.renderGrid();
      input.value = '';
    };
    input.click();
  },
  async save() {
    const req = State.currentReq;
    const files = (State.photoFiles[req.id] || []).filter(Boolean);
    const alertEl = document.getElementById('photo-alert');
    if (files.length < req.required_count) {
      alertEl.textContent = `Потрібно ще ${req.required_count - files.length} фото`;
      alertEl.className = 'fm-alert show warn';
      return;
    }
    const btn = document.getElementById('btn-photo-back');
    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spin"></span>';

    const comment = document.getElementById('photo-comment').value.trim();
    let allOk = true;
    for (const file of files) {
      const fd = new FormData();
      fd.append('submission_id', State.currentSubmissionId);
      fd.append('photo_requirement_id', req.id);
      if (comment) fd.append('comment', comment);
      fd.append('file', file);
      const { data } = await api('/ga/shopper/submit-photo', { method: 'POST', body: fd, isForm: true });
      if (!data.success) { allOk = false; alertEl.textContent = data.error || 'Помилка завантаження'; alertEl.className = 'fm-alert show err'; break; }
    }

    btn.disabled = false;
    btn.innerHTML = 'Готово <i class="ti ti-arrow-right" aria-hidden="true"></i>';

    if (allOk) {
      State.hubProgress[hubKey('photo', req.id)] = true;
      saveSession();
      Router.show('hub');
      renderHub();
    }
  }
};
document.getElementById('btn-photo-back').addEventListener('click', () => Photo.save());

// ─── SCREEN: AUDIO ────────────────────────────────────────
const Audio = {
  mediaRecorder: null,
  chunks: [],
  blob: null,
  duration: 0,
  recStart: null,
  timerInterval: null,
  wakeLock: null,

  open(requirement) {
    State.currentReq = requirement;
    this.blob = null;
    this.duration = 0;
    document.getElementById('audio-title').textContent = requirement.title;
    document.getElementById('audio-min').textContent = `Мін. ${requirement.min_duration_sec} сек`;
    document.getElementById('audio-instr').textContent = requirement.instruction || '';
    document.getElementById('rec-timer').textContent = `00:00 / мін. ${String(requirement.min_duration_sec).padStart(2, '0')} сек`;
    document.getElementById('audio-playback').style.display = 'none';
    document.getElementById('wake-note').style.display = 'none';
    document.getElementById('audio-alert').classList.remove('show');
    document.getElementById('btn-audio-save').disabled = true;
    document.getElementById('rec-circle').classList.remove('recording');
    document.getElementById('rec-hint').textContent = 'Натисніть для запису';
    Router.show('audio');
  },

  async toggle() {
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.chunks = [];
      const mimeType = MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4'
                     : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      this.mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      this.mediaRecorder.ondataavailable = e => { if (e.data.size > 0) this.chunks.push(e.data); };
      this.mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        clearInterval(this.timerInterval);
        if (this.wakeLock) { try { await this.wakeLock.release(); } catch (_) {} this.wakeLock = null; }
        document.getElementById('wake-note').style.display = 'none';
        this.blob = new Blob(this.chunks, { type: mimeType || 'audio/webm' });
        this.duration = Math.round((Date.now() - this.recStart) / 1000);
        const audioEl = document.getElementById('audio-playback');
        audioEl.src = URL.createObjectURL(this.blob);
        audioEl.style.display = 'block';
        document.getElementById('rec-circle').classList.remove('recording');
        document.getElementById('rec-hint').textContent = 'Натисніть щоб перезаписати';
        const min = State.currentReq.min_duration_sec;
        document.getElementById('btn-audio-save').disabled = this.duration < min;
        const alertEl = document.getElementById('audio-alert');
        if (this.duration < min) {
          alertEl.textContent = `Занадто коротко (мін. ${min} сек). Перезапишіть.`;
          alertEl.className = 'fm-alert show warn';
        } else {
          alertEl.classList.remove('show');
        }
      };
      this.recStart = Date.now();
      this.mediaRecorder.start(250);
      if ('wakeLock' in navigator) {
        try { this.wakeLock = await navigator.wakeLock.request('screen'); document.getElementById('wake-note').style.display = 'flex'; } catch (_) {}
      }
      document.getElementById('rec-circle').classList.add('recording');
      document.getElementById('rec-hint').textContent = 'Натисніть щоб зупинити';
      let secs = 0;
      const min = State.currentReq.min_duration_sec;
      this.timerInterval = setInterval(() => {
        secs++;
        document.getElementById('rec-timer').textContent = `${String(secs).padStart(2, '0')} / мін. ${String(min).padStart(2, '0')} сек`;
      }, 1000);
    } catch (e) {
      document.getElementById('audio-alert').textContent = 'Немає доступу до мікрофону: ' + e.message;
      document.getElementById('audio-alert').className = 'fm-alert show err';
    }
  },

  async save() {
    const req = State.currentReq;
    const btn = document.getElementById('btn-audio-save');
    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spin"></span>';

    const fd = new FormData();
    fd.append('submission_id', State.currentSubmissionId);
    fd.append('audio_requirement_id', req.id);
    fd.append('duration_sec', this.duration);
    fd.append('file', this.blob, 'audio.' + (this.blob.type.includes('mp4') ? 'mp4' : 'webm'));

    const { data } = await api('/ga/shopper/submit-audio', { method: 'POST', body: fd, isForm: true });
    btn.disabled = false;
    btn.innerHTML = 'Зберегти <i class="ti ti-arrow-right" aria-hidden="true"></i>';

    if (data.success) {
      State.hubProgress[hubKey('audio', req.id)] = true;
      saveSession();
      Router.show('hub');
      renderHub();
    } else {
      const alertEl = document.getElementById('audio-alert');
      alertEl.textContent = data.error || 'Помилка завантаження';
      alertEl.className = 'fm-alert show err';
    }
  }
};
document.getElementById('rec-circle').addEventListener('click', () => Audio.toggle());
document.getElementById('btn-audio-save').addEventListener('click', () => Audio.save());
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && Audio.mediaRecorder && Audio.mediaRecorder.state === 'recording' && 'wakeLock' in navigator) {
    try { Audio.wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
  }
});

// ─── SCREEN: QUESTIONNAIRE ────────────────────────────────
const Quest = {
  async open(questionnaireRef) {
    // task-details gives us the full criteria list (task list summary doesn't include it)
    const { data } = await api('/ga/shopper/task-details?task_id=' + State.currentTask.task_id);
    if (!data.success) return;
    const questionnaire = data.questionnaires.find(q => q.questionnaire_id === questionnaireRef.questionnaire_id);
    if (!questionnaire) return;

    await api('/ga/shopper/questionnaire-open', { method: 'POST', body: { submission_id: State.currentSubmissionId } });

    State.quest = {
      questionnaireId: questionnaire.questionnaire_id,
      sectionTitle: questionnaire.title,
      criteria: questionnaire.criteria,
      answers: {},
      idx: 0
    };
    Router.show('quest');
    this.renderCurrent();
  },

  visibleCriteria() {
    const { criteria, answers } = State.quest;
    return criteria.filter(c => {
      if (c.parent_criterion_id === null || c.parent_criterion_id === undefined) return true;
      return answers[c.parent_criterion_id] === c.condition_value;
    });
  },

  renderCurrent() {
    const visible = this.visibleCriteria();
    const q = State.quest;
    if (q.idx >= visible.length) { this.finish(); return; }
    const c = visible[q.idx];

    document.getElementById('q-progress-txt').textContent = `${q.idx + 1}/${visible.length}`;
    document.getElementById('q-progress-fill').style.width = `${Math.round(((q.idx) / visible.length) * 100)}%`;
    document.getElementById('q-section-label').textContent = q.sectionTitle;
    document.getElementById('q-alert').classList.remove('show');

    const body = document.getElementById('q-body');
    const btn = document.getElementById('btn-q-next');
    btn.disabled = true;

    const scaleMatch = /^scale_(\d+)_(\d+)$/.exec(c.answer_type || '');

    if (c.answer_type === 'yes_no') {
      body.innerHTML = `<div class="q-question">${escapeHtml(c.question_text)}</div>
        <div class="yn-row">
          <div class="yn-btn" data-val="yes"><i class="ti ti-check" aria-hidden="true"></i> Так</div>
          <div class="yn-btn" data-val="no">Ні</div>
        </div>`;
      body.querySelectorAll('.yn-btn').forEach(b => b.addEventListener('click', () => {
        body.querySelectorAll('.yn-btn').forEach(x => x.classList.remove('selected'));
        b.classList.add('selected');
        q.answers[c.id] = b.dataset.val;
        btn.disabled = false;
      }));
    } else if (scaleMatch) {
      const min = parseInt(scaleMatch[1], 10), max = parseInt(scaleMatch[2], 10);
      let opts = '';
      for (let n = min; n <= max; n++) opts += `<div class="scale-btn" data-val="${n}">${n}</div>`;
      body.innerHTML = `<div class="q-question">${escapeHtml(c.question_text)}</div><div class="scale-row">${opts}</div>`;
      body.querySelectorAll('.scale-btn').forEach(b => b.addEventListener('click', () => {
        body.querySelectorAll('.scale-btn').forEach(x => x.classList.remove('selected'));
        b.classList.add('selected');
        q.answers[c.id] = b.dataset.val;
        btn.disabled = false;
      }));
    } else {
      body.innerHTML = `<div class="q-question">${escapeHtml(c.question_text)}</div>
        <textarea class="fm-input" style="height:90px" id="q-text-input" placeholder="Ваша відповідь..."></textarea>`;
      const ta = document.getElementById('q-text-input');
      ta.addEventListener('input', () => {
        q.answers[c.id] = ta.value.trim();
        btn.disabled = ta.value.trim() === '';
      });
    }
    btn.textContent = '';
    btn.innerHTML = (q.idx === visible.length - 1) ? 'Завершити <i class="ti ti-check" aria-hidden="true"></i>' : 'Далі <i class="ti ti-arrow-right" aria-hidden="true"></i>';
  },

  next() {
    State.quest.idx++;
    this.renderCurrent();
  },

  async finish() {
    const btn = document.getElementById('btn-q-next');
    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spin"></span>';

    const answers = Object.entries(State.quest.answers).map(([criterion_id, answer_value]) => ({
      criterion_id: Number(criterion_id), answer_value
    }));

    const { data } = await api('/ga/shopper/submit-answers', {
      method: 'POST',
      body: { submission_id: State.currentSubmissionId, answers }
    });

    if (data.success) {
      State.hubProgress[hubKey('quest', State.quest.questionnaireId)] = true;
      saveSession();
      Router.show('hub');
      renderHub();
    } else {
      Router.show('hub');
      renderHub();
      const alertEl = document.getElementById('hub-alert');
      alertEl.textContent = data.error || 'Не вдалося зберегти анкету';
      alertEl.className = 'fm-alert show err';
    }
  }
};
document.getElementById('btn-q-next').addEventListener('click', () => {
  const visible = Quest.visibleCriteria();
  if (State.quest.idx >= visible.length - 1) Quest.finish();
  else Quest.next();
});

// ─── UTILS ────────────────────────────────────────────────
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── SERVICE WORKER ───────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
    reg.update(); // check for a newer sw.js immediately instead of waiting
    // NOTE: deliberately NOT auto-reloading on activation anymore — an earlier version of
    // this did `window.location.reload()` here, which could fire mid-task (e.g. right as
    // the SW installs for the first time in a fresh/private context) and silently wipe
    // in-memory state like State.currentSubmissionId. That's worse than a stale cache.
    // Instead, just let the already-fixed network-first fetch handler keep things current;
    // no forced reload is needed for updates to take effect on next natural navigation.
  }).catch(e => console.warn('SW registration failed', e));
}

// ─── INIT ─────────────────────────────────────────────────
updateOnlineBanner();
if (State.token && State.user) {
  document.getElementById('user-avatar').textContent = (State.user?.first_name || '?')[0].toUpperCase();
  const resumed = restoreSession();
  if (!resumed) {
    Router.show('objects');
    Objects.load();
  }
}
