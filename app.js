// --- Supabase config ---
const SUPABASE_URL = 'https://lmjnsdavcmtlfzeiosxi.supabase.co';
const SUPABASE_KEY = 'sb_publishable_NLPLhx3GfeV6IcZC-UBTtQ_uHkmjlFR';

// --- Helpers ---
async function hashPin(pin) {
  const data = new TextEncoder().encode(pin);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function mergeHistory(local, cloud) {
  const map = new Map();
  // Local first so local-only fields (duration, notes) are preserved
  local.forEach(entry => map.set(entry.id, entry));
  cloud.forEach(row => {
    if (!map.has(row.id)) {
      map.set(row.id, {
        id: row.id,
        workoutId: row.workout_id,
        workoutName: row.workout_name,
        timestamp: row.timestamp,
        exercises: row.exercises
      });
    }
  });
  return Array.from(map.values()).sort((a, b) => b.timestamp - a.timestamp);
}

// --- Storage helpers (IndexedDB + Supabase cloud sync) ---
const Storage = (() => {
  const DB_NAME = 'gym-tracker-db';
  const STORE = 'data';
  let _db = null;
  const _cache = {};
  let _syncEnabled = false;
  let _userId = null;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idbGet(store, key) {
    return new Promise((resolve, reject) => {
      const r = store.get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  function idbGetAllKeys(store) {
    return new Promise((resolve, reject) => {
      const r = store.getAllKeys();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  function sbFetch(path, opts = {}) {
    return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...opts,
      headers: {
        'apikey': SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': opts.prefer || '',
        ...opts.headers
      }
    });
  }

  return {
    async init() {
      try {
        _db = await openDB();
        const tx = _db.transaction(STORE, 'readonly');
        const store = tx.objectStore(STORE);
        const keys = await idbGetAllKeys(store);
        for (const key of keys) {
          _cache[key] = await idbGet(store, key);
        }
        // Migrate from localStorage if IndexedDB was empty
        if (keys.length === 0) {
          for (const lsKey of ['workoutHistory', 'theme']) {
            try {
              const val = JSON.parse(localStorage.getItem(lsKey));
              if (val != null) {
                _cache[lsKey] = val;
                this.set(lsKey, val);
              }
            } catch {}
          }
          localStorage.removeItem('workoutHistory');
          localStorage.removeItem('theme');
        }
      } catch {
        _db = null;
        for (const key of ['workoutHistory', 'theme']) {
          try {
            const val = JSON.parse(localStorage.getItem(key));
            if (val != null) _cache[key] = val;
          } catch {}
        }
      }

      // Check for existing user auth and enable sync
      const auth = _cache['userAuth'];
      if (auth && SUPABASE_URL && SUPABASE_KEY) {
        _userId = auth.userId;
        _syncEnabled = true;
        this.pullFromCloud().catch(() => {});
      }
    },

    get(key) {
      return _cache[key] ?? null;
    },

    set(key, val) {
      _cache[key] = val;
      if (_db) {
        const tx = _db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(val, key);
      } else {
        try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
      }
      if (_syncEnabled && key === 'workoutHistory') {
        this.pushToCloud(val).catch(() => {});
      }
    },

    // --- Cloud sync methods ---
    async createUser(name, pin) {
      const hashedPin = await hashPin(pin);
      const res = await sbFetch('users', {
        method: 'POST',
        prefer: 'return=representation',
        body: JSON.stringify({ name, pin: hashedPin })
      });
      if (!res.ok) {
        const err = await res.json();
        if (err.code === '23505') throw new Error('Name already taken');
        throw new Error('Failed to create profile');
      }
      const [user] = await res.json();
      _userId = user.id;
      _syncEnabled = true;
      this.set('userAuth', { userId: user.id, name });
      // Push any existing local data to cloud
      const history = _cache['workoutHistory'];
      if (history && history.length > 0) {
        await this.pushToCloud(history).catch(() => {});
      }
      return user;
    },

    async signIn(name, pin) {
      const hashedPin = await hashPin(pin);
      const res = await sbFetch(`users?name=eq.${encodeURIComponent(name)}&select=*`);
      if (!res.ok) throw new Error('Connection failed');
      const users = await res.json();
      if (!users.length) throw new Error('User not found');
      if (users[0].pin !== hashedPin) throw new Error('Incorrect PIN');
      _userId = users[0].id;
      _syncEnabled = true;
      this.set('userAuth', { userId: users[0].id, name });
      await this.pullFromCloud();
      return users[0];
    },

    signOut() {
      _syncEnabled = false;
      _userId = null;
      this.set('userAuth', null);
      this.set('workoutHistory', []);
    },

    getCurrentUser() {
      const auth = _cache['userAuth'];
      return auth ? { id: auth.userId, name: auth.name } : null;
    },

    isSyncEnabled() {
      return _syncEnabled;
    },

    async pullFromCloud() {
      if (!_syncEnabled || !_userId) return;
      try {
        const res = await sbFetch(`workout_history?user_id=eq.${_userId}&order=timestamp.desc`);
        if (!res.ok) return;
        const cloud = await res.json();
        const local = _cache['workoutHistory'] || [];
        const merged = mergeHistory(local, cloud);
        _cache['workoutHistory'] = merged;
        if (_db) {
          const tx = _db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put(merged, 'workoutHistory');
        }
      } catch {}
    },

    async pushToCloud(history) {
      if (!_syncEnabled || !_userId || !history.length) return;
      try {
        const payload = history.map(e => ({
          id: e.id,
          user_id: _userId,
          workout_id: e.workoutId,
          workout_name: e.workoutName,
          timestamp: e.timestamp,
          exercises: e.exercises
        }));
        await sbFetch('workout_history', {
          method: 'POST',
          prefer: 'resolution=merge-duplicates',
          body: JSON.stringify(payload)
        });
      } catch {}
    },

    async deleteFromCloud(entryId) {
      if (!_syncEnabled || !_userId) return;
      try {
        await sbFetch(`workout_history?id=eq.${entryId}&user_id=eq.${_userId}`, {
          method: 'DELETE'
        });
      } catch {}
    }
  };
})();

// --- State ---
let currentWorkout = null;
let currentSession = {};  // { exerciseId: { sets: [{ weight, reps, done }] } }
let timerInterval = null;
let timerSeconds = 0;
let workoutStartTime = null;
let workoutTimerInterval = null;

// --- Get all workouts (built-in + custom) ---
function getAllWorkouts() {
  const custom = Storage.get('customWorkouts') || [];
  return [...WORKOUTS, ...custom];
}

// --- DOM refs ---
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// --- Navigation ---
function showScreen(name) {
  $$('.screen').forEach(s => s.classList.remove('active'));
  $(`#screen-${name}`).classList.add('active');
  $$('.nav-btn').forEach(b => b.classList.remove('active'));
  const navBtn = $(`.nav-btn[data-screen="${name}"]`);
  if (navBtn) navBtn.classList.add('active');

  if (name === 'history') renderHistory();
  if (name === 'progress') renderProgress();
}

$$('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const screen = btn.dataset.screen;
    if (screen === 'workout') return;
    showScreen(screen);
  });
});

$('#back-btn').addEventListener('click', () => {
  stopWorkoutTimer();
  showScreen('home');
  currentWorkout = null;
  $('#bottom-nav').style.display = 'flex';
});

// --- Next workout suggestion ---
function getNextSuggestedWorkout() {
  const history = Storage.get('workoutHistory') || [];
  if (history.length === 0) return WORKOUTS[0].id;
  const sorted = [...history].sort((a, b) => b.timestamp - a.timestamp);
  const lastId = sorted[0].workoutId;
  const cycle = ['push1', 'pull1', 'legs1', 'push2', 'pull2', 'legs2'];
  const idx = cycle.indexOf(lastId);
  return cycle[(idx + 1) % cycle.length];
}

// --- Home screen ---
function renderHome() {
  renderDashboard();
  const grid = $('#workout-grid');
  const history = Storage.get('workoutHistory') || [];
  const suggestedId = getNextSuggestedWorkout();
  const allWorkouts = getAllWorkouts();
  grid.innerHTML = allWorkouts.map(w => {
    const type = w.id.replace(/[0-9]/g, '');
    const isSuggested = w.id === suggestedId;
    const lastEntry = history.filter(h => h.workoutId === w.id).sort((a, b) => b.timestamp - a.timestamp)[0];
    const lastText = lastEntry ? `Last: ${formatDate(lastEntry.timestamp)}` : 'Not started yet';
    return `<div class="workout-card ${isSuggested ? 'suggested' : ''}" data-id="${w.id}" data-type="${type}">
      ${isSuggested ? '<div class="card-suggested">UP NEXT</div>' : ''}
      <div class="card-name">${w.name}</div>
      <div class="card-count">${w.exercises.length} exercises</div>
      <div class="card-last">${lastText}</div>
    </div>`;
  }).join('');

  // Add "+" card for custom workout
  grid.innerHTML += `<div class="workout-card add-workout-card" data-id="__add__">
    <div class="add-workout-icon">+</div>
    <div class="card-name">Custom</div>
    <div class="card-count">Create new workout</div>
  </div>`;

  grid.querySelectorAll('.workout-card').forEach(card => {
    let pressTimer;
    card.addEventListener('click', () => {
      if (card.dataset.id === '__add__') return showCustomWorkoutEditor();
      startWorkout(card.dataset.id);
    });
    // Long press to edit custom workouts
    if (card.dataset.id.startsWith('custom_')) {
      card.addEventListener('touchstart', () => {
        pressTimer = setTimeout(() => {
          pressTimer = 'fired';
          showCustomWorkoutEditor(card.dataset.id);
        }, 600);
      }, { passive: true });
      card.addEventListener('touchend', (e) => {
        if (pressTimer === 'fired') { e.preventDefault(); pressTimer = null; return; }
        clearTimeout(pressTimer);
      });
      card.addEventListener('touchmove', () => clearTimeout(pressTimer), { passive: true });
    }
  });
}

// --- Start Workout ---
function startWorkout(workoutId) {
  currentWorkout = getAllWorkouts().find(w => w.id === workoutId);
  currentSession = {};
  workoutStartTime = Date.now();
  $('#workout-title').textContent = currentWorkout.name;
  renderWorkout();
  showScreen('workout');
  $('#bottom-nav').style.display = 'none';
  startWorkoutTimer();
}

// --- Workout Timer ---
function startWorkoutTimer() {
  stopWorkoutTimer();
  const el = $('#workout-timer');
  el.textContent = '0:00';
  workoutTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - workoutStartTime) / 1000);
    const h = Math.floor(elapsed / 3600);
    const m = Math.floor((elapsed % 3600) / 60);
    const s = elapsed % 60;
    el.textContent = h > 0
      ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
      : `${m}:${s.toString().padStart(2, '0')}`;
  }, 1000);
}

function stopWorkoutTimer() {
  if (workoutTimerInterval) {
    clearInterval(workoutTimerInterval);
    workoutTimerInterval = null;
  }
  const el = $('#workout-timer');
  if (el) el.textContent = '';
}

$('#finish-btn').addEventListener('click', finishWorkout);

function finishWorkout() {
  stopWorkoutTimer();
  const hasData = Object.values(currentSession).some(ex =>
    ex.sets.some(s => s.done)
  );
  if (!hasData) {
    showScreen('home');
    $('#bottom-nav').style.display = 'flex';
    return;
  }

  // Collect PRs before saving (so we compare against prior history)
  const prs = [];
  currentWorkout.exercises.forEach(ex => {
    const session = currentSession[ex.order];
    if (!session) return;
    const bestWeight = Math.max(...session.sets.filter(s => s.done).map(s => parseFloat(s.weight) || 0));
    if (bestWeight > 0) {
      const prevPR = getPRForExercise(ex.name);
      if (bestWeight > prevPR) {
        prs.push({ name: ex.name, weight: bestWeight, prevPR });
      }
    }
  });

  // Save to history
  const history = Storage.get('workoutHistory') || [];
  const entry = {
    id: Date.now().toString(36),
    workoutId: currentWorkout.id,
    workoutName: currentWorkout.name,
    timestamp: Date.now(),
    duration: workoutStartTime ? Math.floor((Date.now() - workoutStartTime) / 60000) : 0,
    exercises: {}
  };

  let totalSets = 0;
  let totalVolume = 0;
  let exerciseCount = 0;

  currentWorkout.exercises.forEach(ex => {
    const key = ex.order;
    const session = currentSession[key];
    if (session) {
      const doneSets = session.sets.filter(s => s.done);
      if (doneSets.length > 0) {
        entry.exercises[key] = { name: ex.name, sets: doneSets };
        exerciseCount++;
        totalSets += doneSets.length;
        doneSets.forEach(s => {
          totalVolume += (parseFloat(s.weight) || 0) * (parseInt(s.reps) || 0);
        });
      }
    }
  });

  // Compare vs last same workout
  const lastSame = history.filter(h => h.workoutId === currentWorkout.id).sort((a, b) => b.timestamp - a.timestamp)[0];
  let comparison = null;
  if (lastSame) {
    const lastVolume = Object.values(lastSame.exercises).reduce((sum, ex) =>
      sum + ex.sets.reduce((s, set) => s + (parseFloat(set.weight) || 0) * (parseInt(set.reps) || 0), 0), 0);
    const lastSets = Object.values(lastSame.exercises).reduce((sum, ex) => sum + ex.sets.length, 0);
    const lastDuration = lastSame.duration || 0;
    comparison = {
      volumeChange: totalVolume - lastVolume,
      setsChange: totalSets - lastSets,
      lastDate: lastSame.timestamp
    };
  }

  history.push(entry);
  Storage.set('workoutHistory', history);

  // Show summary
  const duration = workoutStartTime ? Math.floor((Date.now() - workoutStartTime) / 60000) : 0;
  showWorkoutSummary({
    name: currentWorkout.name,
    exerciseCount,
    totalSets,
    totalVolume,
    duration,
    prs,
    comparison
  });
}

// --- Confetti ---
function launchConfetti() {
  const canvas = $('#confetti-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const colors = ['#e53935', '#43a047', '#1e88e5', '#ffd700', '#ff6f00', '#8e24aa'];
  const particles = [];
  for (let i = 0; i < 80; i++) {
    particles.push({
      x: canvas.width / 2 + (Math.random() - 0.5) * 200,
      y: canvas.height / 2,
      vx: (Math.random() - 0.5) * 12,
      vy: Math.random() * -14 - 4,
      w: Math.random() * 8 + 4,
      h: Math.random() * 6 + 3,
      color: colors[Math.floor(Math.random() * colors.length)],
      rotation: Math.random() * 360,
      rotSpeed: (Math.random() - 0.5) * 12,
      gravity: 0.3 + Math.random() * 0.1,
      opacity: 1
    });
  }

  let frame = 0;
  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;
    particles.forEach(p => {
      p.x += p.vx;
      p.vy += p.gravity;
      p.y += p.vy;
      p.rotation += p.rotSpeed;
      if (frame > 40) p.opacity -= 0.02;
      if (p.opacity <= 0) return;
      alive = true;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation * Math.PI / 180);
      ctx.globalAlpha = Math.max(0, p.opacity);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    });
    frame++;
    if (alive && frame < 120) requestAnimationFrame(animate);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  requestAnimationFrame(animate);
}

function showWorkoutSummary({ name, exerciseCount, totalSets, totalVolume, duration, prs, comparison }) {
  const overlay = document.createElement('div');
  overlay.className = 'summary-overlay';

  const durationStr = duration >= 60 ? `${Math.floor(duration / 60)}h ${duration % 60}m` : `${duration}m`;
  const volumeStr = totalVolume >= 1000 ? `${(totalVolume / 1000).toFixed(1)}t` : `${Math.round(totalVolume)}kg`;

  let prsHtml = '';
  if (prs.length > 0) {
    prsHtml = `<div class="summary-prs">
      <div class="summary-prs-title">&#127942; Personal Records</div>
      ${prs.map(pr => `<div class="summary-pr-row">
        <span>${pr.name}</span>
        <span class="summary-pr-weight">${pr.weight}kg</span>
      </div>`).join('')}
    </div>`;
  }

  let compHtml = '';
  if (comparison) {
    const volSign = comparison.volumeChange > 0 ? '+' : '';
    const volClass = comparison.volumeChange > 0 ? 'up' : comparison.volumeChange < 0 ? 'down' : 'same';
    const volStr = Math.abs(comparison.volumeChange) >= 1000
      ? `${volSign}${(comparison.volumeChange / 1000).toFixed(1)}t`
      : `${volSign}${Math.round(comparison.volumeChange)}kg`;
    const setsSign = comparison.setsChange > 0 ? '+' : '';
    const setsClass = comparison.setsChange > 0 ? 'up' : comparison.setsChange < 0 ? 'down' : 'same';
    const lastDateStr = formatDate(comparison.lastDate);
    compHtml = `<div class="summary-comparison">
      <div class="summary-comparison-title">vs Last Time (${lastDateStr})</div>
      <div class="summary-comparison-rows">
        <div class="summary-comp-row">
          <span class="summary-comp-label">Volume</span>
          <span class="summary-comp-val ${volClass}">${volStr}</span>
        </div>
        <div class="summary-comp-row">
          <span class="summary-comp-label">Sets</span>
          <span class="summary-comp-val ${setsClass}">${setsSign}${comparison.setsChange}</span>
        </div>
      </div>
    </div>`;
  }

  overlay.innerHTML = `<div class="summary-card">
    <div class="summary-emoji">&#128170;</div>
    <h2>${name} Complete</h2>
    <div class="summary-stats">
      <div class="summary-stat">
        <div class="summary-stat-val">${durationStr}</div>
        <div class="summary-stat-label">Duration</div>
      </div>
      <div class="summary-stat">
        <div class="summary-stat-val">${exerciseCount}</div>
        <div class="summary-stat-label">Exercises</div>
      </div>
      <div class="summary-stat">
        <div class="summary-stat-val">${totalSets}</div>
        <div class="summary-stat-label">Sets</div>
      </div>
      <div class="summary-stat">
        <div class="summary-stat-val">${volumeStr}</div>
        <div class="summary-stat-label">Volume</div>
      </div>
    </div>
    ${prsHtml}
    ${compHtml}
    <textarea class="summary-notes" placeholder="Session notes (optional)..." rows="2" maxlength="200"></textarea>
    <div class="summary-actions">
      <button class="summary-share">Share</button>
      <button class="summary-done">Done</button>
    </div>
  </div>`;

  // Launch confetti
  launchConfetti();

  document.body.appendChild(overlay);

  // Share button
  overlay.querySelector('.summary-share').addEventListener('click', async () => {
    const text = `${name} Complete!\n${durationStr} | ${exerciseCount} exercises | ${totalSets} sets | ${volumeStr} volume${prs.length > 0 ? '\n\nPRs:\n' + prs.map(pr => `${pr.name}: ${pr.weight}kg`).join('\n') : ''}`;
    if (navigator.share) {
      try { await navigator.share({ title: `${name} Complete`, text }); } catch {}
    } else {
      try {
        await navigator.clipboard.writeText(text);
        const btn = overlay.querySelector('.summary-share');
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = 'Share', 1500);
      } catch {}
    }
  });

  overlay.querySelector('.summary-done').addEventListener('click', () => {
    const notes = overlay.querySelector('.summary-notes').value.trim();
    if (notes) {
      const history = Storage.get('workoutHistory') || [];
      const latest = history[history.length - 1];
      if (latest) {
        latest.notes = notes;
        Storage.set('workoutHistory', history);
      }
    }
    overlay.remove();
    showScreen('home');
    $('#bottom-nav').style.display = 'flex';
    renderHome();
  });
}

// --- Render Workout ---
function renderWorkout() {
  const w = currentWorkout;
  let html = '';

  // Progress bar
  const totalExercises = w.exercises.length;
  html += `<div class="workout-progress">
    <div class="workout-progress-bar"><div class="workout-progress-fill" id="progress-fill"></div></div>
    <span class="workout-progress-text" id="progress-text">0/${totalExercises} exercises</span>
  </div>`;

  // Warmup
  html += '<p class="section-label">Warm-up / Mobility</p>';
  html += '<div class="warmup-list">';
  w.warmup.forEach((item, i) => {
    html += `<div class="warmup-item" data-warmup="${i}">
      <span class="wi-name">${item.name}</span>
      <span class="wi-detail">${item.sets}</span>
    </div>`;
  });
  html += '</div>';

  // Exercises
  html += '<p class="section-label" style="margin-top:20px">Working Sets</p>';
  w.exercises.forEach(ex => {
    const numSets = parseSetsCount(ex.setsConfig);
    const repRanges = parseRepRanges(ex.setsConfig);
    const lastSession = getLastSession(w.id, ex.order);
    if (!currentSession[ex.order]) {
      // Pre-fill with last session's weights AND reps
      currentSession[ex.order] = {
        sets: Array.from({ length: numSets }, (_, i) => {
          let weight = (lastSession && lastSession.sets[i]?.weight) || '';
          const reps = (lastSession && lastSession.sets[i]?.reps) || '';
          // Smart weight suggestion: +2.5kg if hit top of rep range last time
          if (weight && lastSession?.sets[i]) {
            const lastReps = parseInt(lastSession.sets[i].reps) || 0;
            const range = repRanges[i];
            if (range && lastReps >= range.max) {
              weight = ((parseFloat(weight) || 0) + 2.5).toString();
            }
          }
          return { weight, reps, done: false };
        })
      };
    }
    const session = currentSession[ex.order];
    const allDone = session.sets.every(s => s.done);
    const expanded = !allDone;

    // Build "last time" summary
    let lastTimeHtml = '';
    if (lastSession) {
      const dateStr = formatDate(lastSession.date);
      const setsStr = lastSession.sets.map(s => `${s.weight || '?'}kg &times; ${s.reps || '?'}`).join(' &nbsp;/&nbsp; ');
      lastTimeHtml = `<div class="last-session"><span class="last-session-label">Last (${dateStr}):</span> ${setsStr}</div>`;
    }

    html += `<div class="exercise-card ${expanded ? 'expanded' : ''} ${allDone ? 'completed' : ''}" data-exercise="${ex.order}">
      <div class="exercise-header">
        <div class="exercise-order">${allDone ? '&#10003;' : ex.order}</div>
        <div class="exercise-info">
          <div class="exercise-name">${ex.name}</div>
          <div class="exercise-meta">
            <span>${ex.setsConfig}</span>
            <span>Tempo: ${ex.tempo}</span>
            <span>Rest: ${ex.rest}</span>
          </div>
        </div>
        <div class="exercise-chevron">&#9656;</div>
      </div>
      <div class="exercise-body">
        ${lastTimeHtml}
        ${ex.notes ? `<div class="exercise-notes"><strong>Coach:</strong> ${ex.notes}</div>` : ''}
        <div class="sets-table">
          <div class="sets-header">
            <span>Set</span><span>Weight (kg)</span><span></span><span>Reps</span><span></span>
          </div>
          ${session.sets.map((s, i) => {
            const lastW = lastSession?.sets[i]?.weight;
            const curW = parseFloat(s.weight) || 0;
            const lastWNum = parseFloat(lastW) || 0;
            let overloadClass = '';
            let overloadIcon = '';
            if (curW > 0 && lastWNum > 0) {
              if (curW > lastWNum) { overloadClass = 'overload-up'; overloadIcon = '&#9650;'; }
              else if (curW < lastWNum) { overloadClass = 'overload-down'; overloadIcon = '&#9660;'; }
              else { overloadClass = 'overload-same'; overloadIcon = '='; }
            }
            return `<div class="set-row">
              <div class="set-num">${i + 1}</div>
              <div class="weight-stepper">
                <button class="step-btn step-down" data-ex="${ex.order}" data-set="${i}" data-field="weight" data-step="-2.5">&minus;</button>
                <input class="set-input" type="number" inputmode="decimal" placeholder="kg"
                  value="${s.weight}" data-ex="${ex.order}" data-set="${i}" data-field="weight"
                  data-last-weight="${lastW || ''}">
                <button class="step-btn step-up" data-ex="${ex.order}" data-set="${i}" data-field="weight" data-step="2.5">+</button>
              </div>
              <span class="overload-indicator ${overloadClass}" data-ex="${ex.order}" data-set="${i}">${overloadIcon}</span>
              <input class="set-input reps-input" type="number" inputmode="numeric"
                placeholder="${repRanges[i] ? (repRanges[i].min === repRanges[i].max ? repRanges[i].min : repRanges[i].min + '-' + repRanges[i].max) : 'reps'}"
                value="${s.reps}" data-ex="${ex.order}" data-set="${i}" data-field="reps"
                data-min="${repRanges[i]?.min || ''}" data-max="${repRanges[i]?.max || ''}">
              <button class="set-check ${s.done ? 'checked' : ''}"
                data-ex="${ex.order}" data-set="${i}">&#10003;</button>
            </div>`;
          }).join('')}
        </div>
        <div class="warmup-calc-toggle" data-ex="${ex.order}">&#128293; Warm-up sets</div>
        <div class="warmup-calc-result hidden" data-warmup-ex="${ex.order}"></div>
        ${ex.rest !== '-' && ex.rest !== 'ALAN' ? `
          <button class="rest-trigger" data-rest="${parseRestSeconds(ex.rest)}">
            &#9202; Start Rest Timer (${ex.rest})
          </button>
        ` : ''}
      </div>
    </div>`;
  });

  const content = $('#workout-content');
  content.innerHTML = html;

  // Event listeners
  content.querySelectorAll('.warmup-item').forEach(item => {
    item.addEventListener('click', () => item.classList.toggle('done'));
  });

  content.querySelectorAll('.exercise-header').forEach(header => {
    header.addEventListener('click', () => {
      header.closest('.exercise-card').classList.toggle('expanded');
    });
  });

  content.querySelectorAll('.set-input').forEach(input => {
    input.addEventListener('input', (e) => {
      const { ex, set, field } = e.target.dataset;
      const setIdx = parseInt(set);
      currentSession[ex].sets[setIdx][field] = e.target.value;

      // Auto-fill weight: first set fills empty remaining sets
      if (field === 'weight' && setIdx === 0 && e.target.value) {
        currentSession[ex].sets.forEach((s, idx) => {
          if (idx > 0 && !s.weight) {
            s.weight = e.target.value;
            const inp = content.querySelector(`.set-input[data-ex="${ex}"][data-set="${idx}"][data-field="weight"]`);
            if (inp) inp.value = e.target.value;
            updateOverloadIndicator(content, ex, idx, e.target.value);
          }
        });
      }

      // Update overload indicator
      if (field === 'weight') {
        updateOverloadIndicator(content, ex, setIdx, e.target.value);
      }

      // Rep range indicator
      if (field === 'reps') {
        const min = parseInt(e.target.dataset.min);
        const max = parseInt(e.target.dataset.max);
        const val = parseInt(e.target.value);
        e.target.classList.remove('reps-in-range', 'reps-out-range');
        if (val && !isNaN(min) && !isNaN(max)) {
          e.target.classList.add(val >= min && val <= max ? 'reps-in-range' : 'reps-out-range');
        }
      }
    });
  });

  content.querySelectorAll('.step-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const { ex, set, field, step } = btn.dataset;
      const setIdx = parseInt(set);
      const current = parseFloat(currentSession[ex].sets[setIdx][field]) || 0;
      const newVal = Math.max(0, current + parseFloat(step));
      currentSession[ex].sets[setIdx][field] = newVal.toString();
      const input = btn.parentElement.querySelector('.set-input');
      input.value = newVal;

      // Update overload indicator
      if (field === 'weight') {
        updateOverloadIndicator(content, ex, setIdx, newVal.toString());
      }

      // Auto-fill weight from first set
      if (field === 'weight' && setIdx === 0) {
        currentSession[ex].sets.forEach((s, idx) => {
          if (idx > 0 && !s.weight) {
            s.weight = newVal.toString();
            const inp = content.querySelector(`.set-input[data-ex="${ex}"][data-set="${idx}"][data-field="weight"]`);
            if (inp) inp.value = newVal;
            updateOverloadIndicator(content, ex, idx, newVal.toString());
          }
        });
      }
    });
  });

  content.querySelectorAll('.set-check').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const { ex, set } = e.currentTarget.dataset;
      const s = currentSession[ex].sets[parseInt(set)];
      s.done = !s.done;
      e.currentTarget.classList.toggle('checked', s.done);

      if (s.done) {
        // Haptic feedback
        if (navigator.vibrate) navigator.vibrate(10);
        // Checkmark bounce animation
        e.currentTarget.classList.add('check-bounce');
        setTimeout(() => e.currentTarget.classList.remove('check-bounce'), 400);
        // Row flash
        const row = e.currentTarget.closest('.set-row');
        if (row) { row.classList.add('set-flash'); setTimeout(() => row.classList.remove('set-flash'), 500); }
      }

      // PR check + auto-rest when marking done
      if (s.done) {
        const exercise = w.exercises.find(e => e.order === ex);

        // PR check
        const weight = parseFloat(s.weight) || 0;
        if (weight > 0 && exercise) {
          const currentPR = getPRForExercise(exercise.name);
          if (weight > currentPR) {
            showPRBanner(exercise.name, weight);
          }
        }

        // Auto-start rest timer
        if (exercise && exercise.rest !== '-' && exercise.rest !== 'ALAN') {
          startTimer(parseRestSeconds(exercise.rest));
        }
      }

      // Check if all sets done
      const card = e.currentTarget.closest('.exercise-card');
      const allDone = currentSession[ex].sets.every(s => s.done);
      card.classList.toggle('completed', allDone);
      if (allDone) {
        const orderEl = card.querySelector('.exercise-order');
        orderEl.innerHTML = '&#10003;';
        // Auto-advance: collapse done exercise, expand next
        card.classList.remove('expanded');
        const nextCard = card.nextElementSibling;
        if (nextCard && nextCard.classList.contains('exercise-card') && !nextCard.classList.contains('completed')) {
          nextCard.classList.add('expanded');
          setTimeout(() => nextCard.scrollIntoView({ behavior: 'smooth', block: 'center' }), 200);
        }
      }
      updateWorkoutProgress();
    });
  });

  // One-tap set rows: tap anywhere on row to toggle set
  content.querySelectorAll('.set-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' || e.target.closest('.weight-stepper') || e.target.closest('.set-check')) return;
      const checkBtn = row.querySelector('.set-check');
      if (checkBtn) checkBtn.click();
    });
  });

  content.querySelectorAll('.rest-trigger').forEach(btn => {
    btn.addEventListener('click', () => {
      startTimer(parseInt(btn.dataset.rest));
    });
  });

  // Warm-up calc toggles
  content.querySelectorAll('.warmup-calc-toggle').forEach(toggle => {
    toggle.addEventListener('click', () => {
      const ex = toggle.dataset.ex;
      const resultEl = content.querySelector(`.warmup-calc-result[data-warmup-ex="${ex}"]`);
      if (!resultEl.classList.contains('hidden')) {
        resultEl.classList.add('hidden');
        return;
      }
      // Get first set weight as working weight
      const firstWeight = parseFloat(currentSession[ex]?.sets[0]?.weight) || 0;
      if (firstWeight <= 20) {
        resultEl.innerHTML = '<div class="warmup-empty">Enter a working weight first</div>';
      } else {
        const sets = calcWarmupSets(firstWeight);
        resultEl.innerHTML = sets.map(s =>
          `<div class="warmup-set-row"><span>${s.weight}kg</span><span>&times; ${s.reps}</span></div>`
        ).join('') + `<div class="warmup-set-row working"><span>${firstWeight}kg</span><span>Working sets</span></div>`;
      }
      resultEl.classList.remove('hidden');
    });
  });
}

// --- Workout Progress ---
function updateWorkoutProgress() {
  if (!currentWorkout) return;
  const total = currentWorkout.exercises.length;
  let done = 0;
  currentWorkout.exercises.forEach(ex => {
    const session = currentSession[ex.order];
    if (session && session.sets.every(s => s.done)) done++;
  });
  const fill = $('#progress-fill');
  const text = $('#progress-text');
  if (fill) fill.style.width = `${(done / total) * 100}%`;
  if (text) text.textContent = `${done}/${total} exercises`;
}

// --- Overload Indicator ---
function updateOverloadIndicator(container, ex, setIdx, value) {
  const indicator = container.querySelector(`.overload-indicator[data-ex="${ex}"][data-set="${setIdx}"]`);
  if (!indicator) return;
  const input = container.querySelector(`.set-input[data-ex="${ex}"][data-set="${setIdx}"][data-field="weight"]`);
  const lastW = parseFloat(input?.dataset.lastWeight) || 0;
  const curW = parseFloat(value) || 0;
  indicator.className = 'overload-indicator';
  if (curW > 0 && lastW > 0) {
    if (curW > lastW) { indicator.classList.add('overload-up'); indicator.innerHTML = '&#9650;'; }
    else if (curW < lastW) { indicator.classList.add('overload-down'); indicator.innerHTML = '&#9660;'; }
    else { indicator.classList.add('overload-same'); indicator.innerHTML = '='; }
  } else {
    indicator.innerHTML = '';
  }
}

// --- Warm-up Set Calculator ---
function calcWarmupSets(workingWeight) {
  if (workingWeight <= 20) return [];
  const bar = 20;
  const sets = [];
  // Pyramid: 50% x 10, 70% x 5, 85% x 3, then working
  const percents = [0.5, 0.7, 0.85];
  const reps = [10, 5, 3];
  percents.forEach((pct, i) => {
    const w = Math.round(workingWeight * pct / 2.5) * 2.5;
    if (w > bar) sets.push({ weight: w, reps: reps[i] });
  });
  // Always start with bar if not already included
  if (sets.length === 0 || sets[0].weight > bar) {
    sets.unshift({ weight: bar, reps: 10 });
  }
  return sets;
}

// --- Rest Timer ---
let timerDoneVibrated = false;

function startTimer(seconds) {
  if (timerInterval) clearInterval(timerInterval);
  timerSeconds = seconds;
  timerDoneVibrated = false;
  updateTimerDisplay();
  $('#rest-timer').classList.remove('hidden');
  $('#timer-label').textContent = 'Rest';

  if (navigator.vibrate) navigator.vibrate(100);

  timerInterval = setInterval(() => {
    timerSeconds--;
    updateTimerDisplay();
    if (timerSeconds === 0 && !timerDoneVibrated) {
      timerDoneVibrated = true;
      $('#timer-label').textContent = 'Go!';
      if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);
    }
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  $('#rest-timer').classList.add('hidden');
}

function updateTimerDisplay() {
  const m = Math.floor(Math.abs(timerSeconds) / 60);
  const s = Math.abs(timerSeconds) % 60;
  const prefix = timerSeconds < 0 ? '+' : '';
  $('#timer-display').textContent = `${prefix}${m}:${s.toString().padStart(2, '0')}`;
  $('#rest-timer').classList.toggle('timer-over', timerSeconds <= 0);
}

$('#timer-skip').addEventListener('click', stopTimer);

// --- History ---
function renderHistory() {
  const history = Storage.get('workoutHistory') || [];
  const container = $('#history-content');

  if (history.length === 0) {
    container.innerHTML = `<div class="history-empty">
      <p style="font-size:32px">&#127947;</p>
      <p>No workouts logged yet.<br>Get after it!</p>
    </div>`;
    return;
  }

  // Group by date
  const grouped = {};
  history.sort((a, b) => b.timestamp - a.timestamp).forEach(entry => {
    const dateKey = new Date(entry.timestamp).toLocaleDateString('en-AU', {
      weekday: 'long', day: 'numeric', month: 'short', year: 'numeric'
    });
    if (!grouped[dateKey]) grouped[dateKey] = [];
    grouped[dateKey].push(entry);
  });

  let html = '';
  Object.entries(grouped).forEach(([date, entries]) => {
    html += `<div class="history-day">
      <div class="history-date">${date}</div>`;
    entries.forEach(entry => {
      const type = entry.workoutId.replace(/[0-9]/g, '');
      const colors = { push: 'var(--push)', pull: 'var(--pull)', legs: 'var(--legs)' };
      const exerciseCount = Object.keys(entry.exercises).length;
      const totalSets = Object.values(entry.exercises).reduce((sum, ex) => sum + ex.sets.length, 0);

      html += `<div class="swipe-container">
        <div class="swipe-delete-bg" data-delete-id="${entry.id}">Delete</div>
        <div class="history-entry" data-entry-id="${entry.id}">
          <div class="history-entry-header">
            <span class="history-entry-name">${entry.workoutName}</span>
            <span class="history-entry-badge" style="background:${colors[type] || 'var(--accent)'}">${type.toUpperCase()}</span>
          </div>
          <div class="history-entry-stats">${entry.duration ? entry.duration + 'm &middot; ' : ''}${exerciseCount} exercises &middot; ${totalSets} sets logged</div>
          ${entry.notes ? `<div class="history-entry-notes">${entry.notes}</div>` : ''}
          <div class="history-detail">`;

      Object.values(entry.exercises).forEach(ex => {
        const setsStr = ex.sets.map(s => `${s.weight || '?'}kg x ${s.reps || '?'}`).join(', ');
        html += `<div class="history-exercise-row">
          <span class="history-exercise-name">${ex.name}</span>
          <span class="history-exercise-sets">${setsStr}</span>
        </div>`;
      });

      html += `</div>
        </div>
      </div>`;
    });
    html += '</div>';
  });

  container.innerHTML = html;

  // Toggle expand
  container.querySelectorAll('.history-entry').forEach(entry => {
    entry.addEventListener('click', (e) => {
      // Close swipe if open
      const curTransform = entry.style.transform;
      if (curTransform && curTransform.includes('-80')) {
        entry.style.transition = 'transform 0.3s ease';
        entry.style.transform = 'translateX(0)';
        return;
      }
      entry.classList.toggle('expanded');
    });
  });

  // Swipe-to-delete on history entries
  container.querySelectorAll('.swipe-container').forEach(wrap => {
    const entry = wrap.querySelector('.history-entry');
    let startX = 0, currentX = 0, swiping = false;

    wrap.addEventListener('touchstart', (e) => {
      startX = e.touches[0].clientX;
      currentX = startX;
      swiping = false;
      entry.style.transition = 'none';
      // Close all other swiped entries
      container.querySelectorAll('.swipe-container .history-entry').forEach(other => {
        if (other !== entry) {
          other.style.transition = 'transform 0.3s ease';
          other.style.transform = 'translateX(0)';
        }
      });
    }, { passive: true });

    wrap.addEventListener('touchmove', (e) => {
      currentX = e.touches[0].clientX;
      const dx = currentX - startX;
      if (dx < -10) {
        swiping = true;
        entry.style.transform = `translateX(${Math.max(dx, -80)}px)`;
      }
    }, { passive: true });

    wrap.addEventListener('touchend', () => {
      entry.style.transition = 'transform 0.3s ease';
      if (swiping && (currentX - startX) < -60) {
        entry.style.transform = 'translateX(-80px)';
      } else {
        entry.style.transform = 'translateX(0)';
      }
    });
  });

  // Delete via swipe reveal
  container.querySelectorAll('.swipe-delete-bg').forEach(bg => {
    bg.addEventListener('click', () => {
      const id = bg.dataset.deleteId;
      confirmAction('Delete this workout session?', 'This cannot be undone.', () => {
        Storage.deleteFromCloud(id);
        const history = Storage.get('workoutHistory') || [];
        Storage.set('workoutHistory', history.filter(h => h.id !== id));
        renderHistory();
        renderHome();
      });
    });
  });
}

// --- 1RM Estimate (Epley formula) ---
function calc1RM(weight, reps) {
  if (reps <= 0 || weight <= 0) return 0;
  if (reps === 1) return weight;
  return Math.round(weight * (1 + reps / 30) * 10) / 10;
}

// --- Progress ---
function renderProgress() {
  const history = Storage.get('workoutHistory') || [];
  const container = $('#progress-content');
  const filters = $('#progress-filters');

  if (history.length === 0) {
    filters.innerHTML = '';
    container.innerHTML = `<div class="progress-empty">
      <p style="font-size:32px">&#128200;</p>
      <p>Complete some workouts to see your progress here.</p>
    </div>`;
    return;
  }

  // Build exercise list from all history
  const allExercises = new Map();
  history.forEach(entry => {
    Object.values(entry.exercises).forEach(ex => {
      if (!allExercises.has(ex.name)) allExercises.set(ex.name, []);
      allExercises.get(ex.name).push({
        date: entry.timestamp,
        sets: ex.sets
      });
    });
  });

  // View mode: charts, prs, bodyweight
  const activeView = filters.dataset.view || 'charts';
  const activeFilter = filters.dataset.active || 'all';

  // View tabs
  let filtersHtml = `<div class="progress-tabs">
    ${['charts', 'prs', 'bodyweight'].map(v =>
      `<button class="progress-tab ${v === activeView ? 'active' : ''}" data-view="${v}">${v === 'prs' ? 'PRs' : v === 'bodyweight' ? 'Body Weight' : 'Charts'}</button>`
    ).join('')}
  </div>`;

  // Type filter chips (only for charts and prs views)
  if (activeView !== 'bodyweight') {
    filtersHtml += `<div class="progress-chips">` + ['all', 'push', 'pull', 'legs'].map(f =>
      `<button class="filter-chip ${f === activeFilter ? 'active' : ''}" data-filter="${f}">${f === 'all' ? 'All' : f.toUpperCase()}</button>`
    ).join('') + '</div>';
  }

  filters.innerHTML = filtersHtml;

  filters.querySelectorAll('.progress-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      filters.dataset.view = tab.dataset.view;
      renderProgress();
    });
  });

  filters.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      filters.dataset.active = chip.dataset.filter;
      renderProgress();
    });
  });

  // Filter exercises by type
  const filteredExercises = new Map();
  allExercises.forEach((data, name) => {
    if (activeFilter === 'all') {
      filteredExercises.set(name, data);
    } else {
      const belongsToType = getAllWorkouts().some(w =>
        w.id.includes(activeFilter) && w.exercises.some(e => e.name === name)
      );
      if (belongsToType) filteredExercises.set(name, data);
    }
  });

  // --- Body Weight View ---
  if (activeView === 'bodyweight') {
    renderBodyWeightView(container);
    return;
  }

  // --- PRs View ---
  if (activeView === 'prs') {
    let html = '';
    const prList = [];
    filteredExercises.forEach((sessions, name) => {
      let bestWeight = 0, bestReps = 0, bestSet = null, best1RM = 0;
      sessions.forEach(s => {
        s.sets.forEach(set => {
          const w = parseFloat(set.weight) || 0;
          const r = parseInt(set.reps) || 0;
          if (w > bestWeight) { bestWeight = w; bestReps = r; bestSet = set; }
          const est = calc1RM(w, r);
          if (est > best1RM) best1RM = est;
        });
      });
      if (bestWeight > 0) {
        prList.push({ name, bestWeight, bestReps, best1RM, sessions: sessions.length });
      }
    });

    prList.sort((a, b) => b.best1RM - a.best1RM);

    html = prList.map((pr, i) => `<div class="pr-board-row">
      <div class="pr-board-rank">${i + 1}</div>
      <div class="pr-board-info">
        <div class="pr-board-name">${pr.name}</div>
        <div class="pr-board-detail">${pr.sessions} sessions</div>
      </div>
      <div class="pr-board-stats">
        <div class="pr-board-weight">${pr.bestWeight}kg <span>&times; ${pr.bestReps}</span></div>
        <div class="pr-board-1rm">Est. 1RM: ${pr.best1RM}kg</div>
      </div>
    </div>`).join('');

    container.innerHTML = html || '<div class="progress-empty"><p>No weight data logged.</p></div>';
    return;
  }

  // --- Charts View ---
  let html = '';
  filteredExercises.forEach((sessions, name) => {
    sessions.sort((a, b) => a.date - b.date);

    const dataPoints = sessions.map(s => {
      const maxWeight = Math.max(...s.sets.map(set => parseFloat(set.weight) || 0));
      const bestSet = s.sets.reduce((best, set) => {
        const w = parseFloat(set.weight) || 0;
        return w > (parseFloat(best.weight) || 0) ? set : best;
      }, s.sets[0]);
      const est1RM = calc1RM(parseFloat(bestSet.weight) || 0, parseInt(bestSet.reps) || 0);
      return { date: s.date, maxWeight, bestSet, est1RM };
    }).filter(d => d.maxWeight > 0);

    if (dataPoints.length === 0) return;

    const maxW = Math.max(...dataPoints.map(d => d.maxWeight));
    const latest = dataPoints[dataPoints.length - 1];
    const first = dataPoints[0];
    const improvement = dataPoints.length > 1 ? latest.maxWeight - first.maxWeight : 0;

    html += `<div class="progress-exercise">
      <div class="progress-exercise-name">${name}</div>
      <div class="progress-chart">
        ${dataPoints.slice(-10).map(d => {
          const pct = maxW > 0 ? (d.maxWeight / maxW) * 100 : 0;
          const dateStr = new Date(d.date).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
          return `<div class="progress-bar-wrap">
            <div class="progress-bar" style="height:${Math.max(pct, 5)}%">
              <span class="progress-bar-value">${d.maxWeight}</span>
            </div>
            <span class="progress-bar-label">${dateStr}</span>
          </div>`;
        }).join('')}
      </div>
      <div class="progress-best">
        <span>Best: <strong>${maxW}kg</strong></span>
        <span>1RM: <strong>${latest.est1RM}kg</strong></span>
        ${improvement !== 0 ? `<span style="color:${improvement > 0 ? '#43a047' : '#e53935'}">${improvement > 0 ? '+' : ''}${improvement}kg</span>` : ''}
      </div>
    </div>`;
  });

  container.innerHTML = html || '<div class="progress-empty"><p>No weight data logged for this filter.</p></div>';
}

// --- Body Weight View ---
function renderBodyWeightView(container) {
  const entries = Storage.get('bodyWeight') || [];
  const today = new Date().toISOString().split('T')[0];
  const todayEntry = entries.find(e => e.date === today);

  let html = `<div class="bw-input-section">
    <div class="bw-input-row">
      <input type="number" id="bw-input" class="set-input" inputmode="decimal" placeholder="kg" value="${todayEntry?.weight || ''}">
      <button class="bw-save-btn" id="bw-save">Log Weight</button>
    </div>
  </div>`;

  if (entries.length > 0) {
    const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));
    const latest = sorted[sorted.length - 1];
    const earliest = sorted[0];
    const change = sorted.length > 1 ? (parseFloat(latest.weight) - parseFloat(earliest.weight)).toFixed(1) : 0;
    const weights = sorted.map(e => parseFloat(e.weight));
    const minW = Math.min(...weights);
    const maxW = Math.max(...weights);
    const range = maxW - minW || 1;

    html += `<div class="bw-stats">
      <div class="bw-stat"><div class="bw-stat-val">${latest.weight}kg</div><div class="bw-stat-label">Current</div></div>
      <div class="bw-stat"><div class="bw-stat-val">${minW}kg</div><div class="bw-stat-label">Low</div></div>
      <div class="bw-stat"><div class="bw-stat-val">${maxW}kg</div><div class="bw-stat-label">High</div></div>
      <div class="bw-stat"><div class="bw-stat-val" style="color:${parseFloat(change) > 0 ? '#e53935' : parseFloat(change) < 0 ? '#43a047' : 'var(--text)'}">${parseFloat(change) > 0 ? '+' : ''}${change}kg</div><div class="bw-stat-label">Change</div></div>
    </div>`;

    // Simple line chart via SVG
    const chartW = 300, chartH = 120, padX = 5, padY = 10;
    const recent = sorted.slice(-30);
    if (recent.length > 1) {
      const pts = recent.map((e, i) => {
        const x = padX + (i / (recent.length - 1)) * (chartW - 2 * padX);
        const y = padY + (1 - (parseFloat(e.weight) - minW) / range) * (chartH - 2 * padY);
        return `${x},${y}`;
      });
      html += `<div class="bw-chart-wrap">
        <svg viewBox="0 0 ${chartW} ${chartH}" class="bw-chart">
          <polyline points="${pts.join(' ')}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          ${recent.map((e, i) => {
            const x = padX + (i / (recent.length - 1)) * (chartW - 2 * padX);
            const y = padY + (1 - (parseFloat(e.weight) - minW) / range) * (chartH - 2 * padY);
            return `<circle cx="${x}" cy="${y}" r="3" fill="var(--accent)"/>`;
          }).join('')}
        </svg>
        <div class="bw-chart-labels">
          <span>${recent[0].date.slice(5)}</span>
          <span>${recent[recent.length - 1].date.slice(5)}</span>
        </div>
      </div>`;
    }

    // Recent entries list
    html += `<div class="bw-history">`;
    sorted.slice().reverse().slice(0, 10).forEach(e => {
      html += `<div class="bw-history-row">
        <span>${new Date(e.date + 'T00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', weekday: 'short' })}</span>
        <span>${e.weight}kg</span>
      </div>`;
    });
    html += `</div>`;
  }

  container.innerHTML = html;

  // Save body weight
  const saveBtn = container.querySelector('#bw-save');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      const val = parseFloat(container.querySelector('#bw-input').value);
      if (!val || val < 20 || val > 300) return;
      const entries = Storage.get('bodyWeight') || [];
      const idx = entries.findIndex(e => e.date === today);
      if (idx >= 0) entries[idx].weight = val;
      else entries.push({ date: today, weight: val });
      Storage.set('bodyWeight', entries);
      renderBodyWeightView(container);
    });
  }
}

// --- Helpers ---
function parseSetsCount(config) {
  // Parse things like "2 x 10-12, 1 x 15-20" => 3 sets
  // "3x 12-15" => 3 sets
  // "Pump Set + 3 x 8-12" => 4 sets
  let total = 0;
  const hasPump = config.toLowerCase().includes('pump');
  if (hasPump) total += 1;

  const matches = config.match(/(\d+)\s*x/gi);
  if (matches) {
    matches.forEach(m => {
      const num = parseInt(m);
      if (!isNaN(num)) total += num;
    });
  }

  return Math.max(total, 1);
}

function parseRepRanges(config) {
  const ranges = [];
  const hasPump = config.toLowerCase().includes('pump');
  if (hasPump) ranges.push({ min: 15, max: 25 });
  const cleaned = config.replace(/pump\s*set\s*\+/i, '').trim();
  cleaned.split(',').forEach(part => {
    const m = part.match(/(\d+)\s*x\s*(\d+)(?:\s*-\s*(\d+))?/i);
    if (m) {
      const count = parseInt(m[1]);
      const min = parseInt(m[2]);
      const max = m[3] ? parseInt(m[3]) : min;
      for (let i = 0; i < count; i++) ranges.push({ min, max });
    }
  });
  return ranges;
}

function parseRestSeconds(rest) {
  if (!rest || rest === '-' || rest === 'ALAN' || rest === 'x') return 90;
  const str = rest.toLowerCase().trim();
  // "1-2 mins" -> use 90s, "45s" -> 45, "60s" -> 60, "1min" -> 60
  if (str.includes('2-3')) return 150;
  if (str.includes('1-2')) return 90;
  if (str.match(/^(\d+)\s*s$/)) return parseInt(str);
  if (str.match(/^(\d+)\s*min/)) return parseInt(str) * 60;
  return 90;
}

function getLastSession(workoutId, exerciseOrder) {
  const history = Storage.get('workoutHistory') || [];
  const last = history
    .filter(h => h.workoutId === workoutId)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
  if (!last || !last.exercises[exerciseOrder]) return null;
  return {
    date: last.timestamp,
    sets: last.exercises[exerciseOrder].sets
  };
}

function formatDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diff = Math.floor((now - d) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return `${diff} days ago`;
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

// --- PR Detection ---
function getPRForExercise(exerciseName) {
  const history = Storage.get('workoutHistory') || [];
  let bestWeight = 0;
  history.forEach(entry => {
    Object.values(entry.exercises).forEach(ex => {
      if (ex.name === exerciseName) {
        ex.sets.forEach(s => {
          const w = parseFloat(s.weight) || 0;
          if (w > bestWeight) bestWeight = w;
        });
      }
    });
  });
  return bestWeight;
}

function showPRBanner(exerciseName, weight) {
  const banner = document.createElement('div');
  banner.className = 'pr-banner';
  banner.innerHTML = `<div class="pr-icon">&#127942;</div><div class="pr-text"><strong>NEW PR!</strong><br>${exerciseName}<br>${weight}kg</div>`;
  document.body.appendChild(banner);
  if (navigator.vibrate) navigator.vibrate([100, 50, 100, 50, 200]);
  setTimeout(() => {
    banner.classList.add('pr-fade');
    setTimeout(() => banner.remove(), 500);
  }, 2500);
}

function confirmAction(title, message, onConfirm) {
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';
  overlay.innerHTML = `<div class="confirm-card">
    <h3>${title}</h3>
    <p>${message}</p>
    <div class="confirm-actions">
      <button class="confirm-cancel">Cancel</button>
      <button class="confirm-ok">Delete</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  overlay.querySelector('.confirm-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('.confirm-ok').addEventListener('click', () => {
    onConfirm();
    overlay.remove();
  });
}

// --- Dashboard ---
const WORKOUT_MUSCLES = {
  push: ['chest', 'shoulders', 'triceps'],
  pull: ['back', 'biceps'],
  legs: ['quads', 'hamstrings', 'glutes', 'core']
};

function getWeekBounds() {
  const now = new Date();
  const day = now.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() + mondayOffset);
  return { start: monday.getTime(), end: monday.getTime() + 7 * 86400000 - 1 };
}

function calcVolume(workouts) {
  let total = 0;
  workouts.forEach(w => {
    Object.values(w.exercises).forEach(ex => {
      ex.sets.forEach(s => {
        total += (parseFloat(s.weight) || 0) * (parseInt(s.reps) || 0);
      });
    });
  });
  return total;
}

function getWeeklyStats(history) {
  const { start, end } = getWeekBounds();
  const thisWeek = history.filter(h => h.timestamp >= start && h.timestamp <= end);
  const lastWeek = history.filter(h => h.timestamp >= start - 7 * 86400000 && h.timestamp < start);
  const thisVolume = calcVolume(thisWeek);
  const lastVolume = calcVolume(lastWeek);
  const volumeChange = lastVolume > 0 ? Math.round((thisVolume - lastVolume) / lastVolume * 100) : 0;
  return { count: thisWeek.length, target: 4, thisVolume, lastVolume, volumeChange };
}

function getCurrentStreak(history) {
  if (history.length === 0) return 0;
  const days = new Set();
  history.forEach(h => {
    const d = new Date(h.timestamp);
    days.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
  });
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let check = new Date(today);
  const todayKey = `${check.getFullYear()}-${check.getMonth()}-${check.getDate()}`;
  if (!days.has(todayKey)) check.setDate(check.getDate() - 1);
  let streak = 0;
  while (true) {
    const key = `${check.getFullYear()}-${check.getMonth()}-${check.getDate()}`;
    if (days.has(key)) { streak++; check.setDate(check.getDate() - 1); }
    else break;
  }
  return streak;
}

function getMuscleActivity(history) {
  const cutoff = Date.now() - 7 * 86400000;
  const recent = history.filter(h => h.timestamp >= cutoff);
  const activity = {};
  ['chest', 'shoulders', 'triceps', 'back', 'biceps', 'quads', 'hamstrings', 'glutes', 'core'].forEach(m => activity[m] = 0);
  recent.forEach(w => {
    const type = w.workoutId.replace(/[0-9]/g, '');
    (WORKOUT_MUSCLES[type] || []).forEach(m => activity[m]++);
  });
  return activity;
}

function getCalendarData(history) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = today.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const thisMon = new Date(today);
  thisMon.setDate(thisMon.getDate() + mondayOffset);
  const startMon = new Date(thisMon);
  startMon.setDate(startMon.getDate() - 11 * 7);
  const dayMap = {};
  history.forEach(h => {
    const d = new Date(h.timestamp);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    dayMap[key] = (dayMap[key] || 0) + 1;
  });
  const weeks = [];
  const current = new Date(startMon);
  for (let w = 0; w < 12; w++) {
    const week = [];
    for (let d = 0; d < 7; d++) {
      const key = `${current.getFullYear()}-${current.getMonth()}-${current.getDate()}`;
      week.push({ count: dayMap[key] || 0, future: current > today });
      current.setDate(current.getDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}

function renderDashboard() {
  const dashboard = $('#dashboard');
  if (!dashboard) return;
  const history = Storage.get('workoutHistory') || [];

  // Onboarding for new users
  if (history.length === 0) {
    dashboard.innerHTML = `<div class="onboarding">
      <div class="onboarding-emoji">&#128170;</div>
      <h2>Ready to Train?</h2>
      <p class="onboarding-subtitle">Pick a workout below to get started. Your stats, PRs, and progress will appear here after your first session.</p>
      <div class="onboarding-steps">
        <div class="onboarding-step">
          <div class="onboarding-step-num">1</div>
          <div class="onboarding-step-text">Tap a workout card below</div>
        </div>
        <div class="onboarding-step">
          <div class="onboarding-step-num">2</div>
          <div class="onboarding-step-text">Log your weights and reps</div>
        </div>
        <div class="onboarding-step">
          <div class="onboarding-step-num">3</div>
          <div class="onboarding-step-text">Hit Finish to save and track progress</div>
        </div>
      </div>
    </div>
    <div class="dash-grid-label">Start a Workout</div>`;
    return;
  }

  const stats = getWeeklyStats(history);
  const streak = getCurrentStreak(history);
  const muscles = getMuscleActivity(history);
  const calendar = getCalendarData(history);
  const sorted = [...history].sort((a, b) => b.timestamp - a.timestamp);
  const last = sorted[0];

  let html = '';

  // Stats row
  const pct = Math.min(stats.count / stats.target, 1);
  const circ = 2 * Math.PI * 32;
  const offset = circ - pct * circ;
  const volStr = stats.thisVolume >= 1000 ? `${(stats.thisVolume / 1000).toFixed(1)}t` : `${Math.round(stats.thisVolume)}kg`;
  const changeHtml = stats.volumeChange !== 0 && stats.lastVolume > 0
    ? `<span class="dash-change ${stats.volumeChange > 0 ? 'up' : 'down'}">${stats.volumeChange > 0 ? '+' : ''}${stats.volumeChange}%</span>`
    : '';

  html += `<div class="dash-stats">
    <div class="dash-stat">
      <div class="dash-ring-wrap">
        <svg viewBox="0 0 72 72" class="dash-ring">
          <circle cx="36" cy="36" r="32" fill="none" stroke="var(--surface3)" stroke-width="5"/>
          <circle cx="36" cy="36" r="32" fill="none" stroke="var(--accent)" stroke-width="5"
            stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"
            stroke-linecap="round" transform="rotate(-90 36 36)"/>
        </svg>
        <div class="dash-ring-text">${stats.count}<span>/${stats.target}</span></div>
      </div>
      <div class="dash-stat-label">This Week</div>
    </div>
    <div class="dash-stat">
      <div class="dash-stat-val">${volStr}</div>
      ${changeHtml}
      <div class="dash-stat-label">Volume</div>
    </div>
    <div class="dash-stat">
      <div class="dash-stat-val">${streak}<span class="dash-fire">&#128293;</span></div>
      <div class="dash-stat-label">Streak</div>
    </div>
  </div>`;

  // Last workout card
  if (last) {
    const type = last.workoutId.replace(/[0-9]/g, '');
    const ago = formatDate(last.timestamp);
    const exCount = Object.keys(last.exercises).length;
    const setCount = Object.values(last.exercises).reduce((sum, ex) => sum + ex.sets.length, 0);
    html += `<div class="dash-last" data-type="${type}">
      <div class="dash-last-top">
        <span class="dash-last-badge">${type.toUpperCase()}</span>
        <span class="dash-last-ago">${ago}</span>
      </div>
      <div class="dash-last-name">${last.workoutName}</div>
      <div class="dash-last-meta">${exCount} exercises &middot; ${setCount} sets</div>
    </div>`;
  }

  // Muscle activity bars
  const displayGroups = [
    { key: 'chest', label: 'Chest', color: 'var(--push)' },
    { key: 'back', label: 'Back', color: 'var(--pull)' },
    { key: 'shoulders', label: 'Shoulders', color: 'var(--push)' },
    { key: 'arms', label: 'Arms', color: 'var(--accent)', calc: () => Math.max(muscles.biceps || 0, muscles.triceps || 0) },
    { key: 'quads', label: 'Quads', color: 'var(--legs)' },
    { key: 'hamstrings', label: 'Hams', color: 'var(--legs)' },
    { key: 'glutes', label: 'Glutes', color: 'var(--legs)' },
    { key: 'core', label: 'Core', color: 'var(--legs)' },
  ];
  const maxMuscle = Math.max(...displayGroups.map(g => g.calc ? g.calc() : (muscles[g.key] || 0)), 1);

  html += `<div class="dash-section">
    <div class="dash-section-title">Muscles <span>7 days</span></div>
    <div class="muscle-bars">`;
  displayGroups.forEach(g => {
    const count = g.calc ? g.calc() : (muscles[g.key] || 0);
    const barPct = (count / maxMuscle) * 100;
    html += `<div class="muscle-bar">
      <span class="muscle-name">${g.label}</span>
      <div class="muscle-track">
        <div class="muscle-fill" style="width:${count > 0 ? Math.max(barPct, 8) : 0}%;background:${g.color}"></div>
      </div>
      <span class="muscle-count">${count || '-'}</span>
    </div>`;
  });
  html += `</div></div>`;

  // Calendar heatmap
  html += `<div class="dash-section">
    <div class="dash-section-title">Activity <span>12 weeks</span></div>
    <div class="cal-heatmap">
      <div class="cal-labels">
        <span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span><span>S</span>
      </div>
      <div class="cal-grid">`;
  calendar.forEach(week => {
    html += `<div class="cal-week">`;
    week.forEach(day => {
      const level = day.future ? 'future' : day.count === 0 ? 'l0' : day.count === 1 ? 'l1' : 'l2';
      html += `<div class="cal-day ${level}"></div>`;
    });
    html += `</div>`;
  });
  html += `</div></div></div>`;

  // Section label before workout grid
  html += `<div class="dash-grid-label">Start a Workout</div>`;

  dashboard.innerHTML = html;
}

// --- Plate Calculator ---
function updatePlateCalc() {
  const target = parseFloat($('#plate-target').value) || 0;
  const result = $('#plate-result');
  if (target < 20) {
    result.innerHTML = '<div class="plate-empty">Enter a weight (min 20kg bar)</div>';
    return;
  }
  if (target === 20) {
    result.innerHTML = '<div class="plate-empty">Just the bar!</div>';
    return;
  }
  const perSide = (target - 20) / 2;
  const plates = [25, 20, 15, 10, 5, 2.5, 1.25];
  let remaining = perSide;
  const needed = [];
  plates.forEach(p => {
    const count = Math.floor(remaining / p + 0.001);
    if (count > 0) {
      needed.push({ weight: p, count });
      remaining -= count * p;
    }
  });
  if (remaining > 0.01) {
    result.innerHTML = `<div class="plate-empty">Can't make exactly ${target}kg with standard plates</div>`;
    return;
  }
  result.innerHTML = `<div class="plate-side">Each side (${perSide}kg):</div>` +
    needed.map(p => `<div class="plate-row"><span class="plate-weight">${p.weight}kg</span><span class="plate-count">&times; ${p.count}</span></div>`).join('');
}

$('#plate-btn').addEventListener('click', () => {
  $('#plate-calc').classList.remove('hidden');
  $('#plate-target').value = '';
  $('#plate-result').innerHTML = '<div class="plate-empty">Enter a weight (min 20kg bar)</div>';
  setTimeout(() => $('#plate-target').focus(), 100);
});
$('#plate-close').addEventListener('click', () => $('#plate-calc').classList.add('hidden'));
$('#plate-target').addEventListener('input', updatePlateCalc);
$('#plate-down').addEventListener('click', () => {
  const input = $('#plate-target');
  input.value = Math.max(20, (parseFloat(input.value) || 20) - 2.5);
  updatePlateCalc();
});
$('#plate-up').addEventListener('click', () => {
  const input = $('#plate-target');
  input.value = (parseFloat(input.value) || 17.5) + 2.5;
  updatePlateCalc();
});

// --- Data Export/Import ---
function exportData() {
  const history = Storage.get('workoutHistory') || [];
  const data = JSON.stringify(history, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `gym-tracker-backup-${new Date().toISOString().split('T')[0]}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function importData() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (!Array.isArray(data)) throw new Error('Invalid');
        const current = (Storage.get('workoutHistory') || []).length;
        confirmAction('Import Data?', `Replace your ${current} sessions with ${data.length} imported sessions?`, () => {
          Storage.set('workoutHistory', data);
          renderHome();
        });
      } catch {
        alert('Invalid backup file');
      }
    };
    reader.readAsText(file);
  });
  input.click();
}

$('#export-btn').addEventListener('click', exportData);
$('#import-btn').addEventListener('click', importData);

// --- App Sync ---
$('#sync-btn').addEventListener('click', async () => {
  const btn = $('#sync-btn');
  btn.textContent = 'Syncing...';
  btn.disabled = true;
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        await reg.unregister();
      }
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
    window.location.reload(true);
  } catch {
    window.location.reload(true);
  }
});

// --- Theme ---
function initTheme() {
  const saved = Storage.get('theme') || 'dark';
  applyTheme(saved);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  // Force repaint — some mobile WebKit won't update CSS vars without this
  void document.documentElement.offsetHeight;
  document.body.style.backgroundColor = theme === 'light' ? '#f5f5f5' : '#111111';
  // Update meta theme-color for mobile browser chrome
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) {
    metaTheme.content = theme === 'light' ? '#f5f5f5' : '#111111';
  }
  // Update toggle icon
  const icon = $('#theme-icon');
  if (icon) icon.textContent = theme === 'dark' ? '\u263E' : '\u2600';
  Storage.set('theme', theme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

$('#theme-toggle').addEventListener('click', toggleTheme);

// --- Identity Screen ---
function showIdentityError(msg) {
  $('#identity-error').textContent = msg;
}

function setIdentityLoading(loading) {
  ['identity-create', 'identity-signin', 'identity-skip'].forEach(id => {
    $(`#${id}`).disabled = loading;
  });
}

$('#identity-create').addEventListener('click', async () => {
  const name = $('#identity-name').value.trim();
  const pin = $('#identity-pin').value;
  showIdentityError('');
  if (!name) return showIdentityError('Enter your name');
  if (pin.length !== 4 || !/^\d{4}$/.test(pin)) return showIdentityError('PIN must be exactly 4 digits');
  setIdentityLoading(true);
  try {
    await Storage.createUser(name, pin);
    enterApp();
  } catch (err) {
    showIdentityError(err.message);
    setIdentityLoading(false);
  }
});

$('#identity-signin').addEventListener('click', async () => {
  const name = $('#identity-name').value.trim();
  const pin = $('#identity-pin').value;
  showIdentityError('');
  if (!name) return showIdentityError('Enter your name');
  if (pin.length !== 4 || !/^\d{4}$/.test(pin)) return showIdentityError('Enter your 4-digit PIN');
  setIdentityLoading(true);
  try {
    await Storage.signIn(name, pin);
    enterApp();
  } catch (err) {
    showIdentityError(err.message);
    setIdentityLoading(false);
  }
});

$('#identity-skip').addEventListener('click', () => {
  Storage.set('identitySkipped', true);
  enterApp();
});

// --- Cloud Sync Settings ---
function updateSyncStatus() {
  const user = Storage.getCurrentUser();
  const desc = $('#cloud-sync-desc');
  const btn = $('#signout-btn');
  if (user) {
    desc.textContent = `Signed in as ${user.name}`;
    btn.style.display = '';
  } else {
    desc.textContent = 'Not signed in';
    btn.style.display = 'none';
  }
}

$('#signout-btn').addEventListener('click', () => {
  confirmAction('Sign Out?', 'Your local data will be cleared. Make sure you have a backup.', () => {
    Storage.signOut();
    updateSyncStatus();
    renderHome();
  });
});

// --- Init ---
function enterApp() {
  $$('.screen').forEach(s => s.classList.remove('active'));
  $('#screen-home').classList.add('active');
  $('#bottom-nav').style.display = 'flex';
  initTheme();
  renderHome();
  updateSyncStatus();
}

Storage.init().then(() => {
  initTheme();
  const user = Storage.getCurrentUser();
  const skipped = Storage.get('identitySkipped');
  const hasSupabase = SUPABASE_URL && SUPABASE_KEY;

  if (!user && !skipped && hasSupabase) {
    // Show identity screen
    $$('.screen').forEach(s => s.classList.remove('active'));
    $('#screen-identity').classList.add('active');
    $('#bottom-nav').style.display = 'none';
  } else {
    $('#screen-home').classList.add('active');
    renderHome();
    updateSyncStatus();
  }
});

// --- Custom Workout Editor ---
function showCustomWorkoutEditor(editId) {
  const existing = editId ? (Storage.get('customWorkouts') || []).find(w => w.id === editId) : null;
  const overlay = document.createElement('div');
  overlay.className = 'custom-workout-overlay';

  const colors = [
    { name: 'Red', val: '#e53935' },
    { name: 'Blue', val: '#1e88e5' },
    { name: 'Green', val: '#43a047' },
    { name: 'Purple', val: '#8e24aa' },
    { name: 'Orange', val: '#f4511e' },
    { name: 'Teal', val: '#00897b' }
  ];

  let exercises = existing ? existing.exercises.map(e => ({ ...e })) : [{ name: '', setsConfig: '3 x 10-12', tempo: '3011', rest: '1-2 mins', notes: '' }];

  function render() {
    overlay.innerHTML = `<div class="custom-workout-card">
      <div class="custom-workout-header">
        <h3>${existing ? 'Edit' : 'New'} Workout</h3>
        <button class="icon-btn custom-close">&times;</button>
      </div>
      <input type="text" class="identity-input" id="cw-name" placeholder="Workout name" value="${existing?.name || ''}" maxlength="30">
      <div class="cw-colors">
        ${colors.map(c => `<button class="cw-color ${(existing?.color || '#e53935') === c.val ? 'active' : ''}" data-color="${c.val}" style="background:${c.val}"></button>`).join('')}
      </div>
      <div class="cw-exercises" id="cw-exercises">
        ${exercises.map((ex, i) => `<div class="cw-exercise" data-idx="${i}">
          <div class="cw-exercise-header">
            <span class="cw-exercise-num">${String.fromCharCode(65 + i)}</span>
            <input type="text" class="cw-ex-input" placeholder="Exercise name" value="${ex.name}" data-idx="${i}" data-field="name">
            ${exercises.length > 1 ? `<button class="cw-remove-ex" data-idx="${i}">&times;</button>` : ''}
          </div>
          <div class="cw-exercise-details">
            <input type="text" class="cw-ex-input small" placeholder="3 x 10-12" value="${ex.setsConfig}" data-idx="${i}" data-field="setsConfig">
            <input type="text" class="cw-ex-input small" placeholder="Tempo" value="${ex.tempo}" data-idx="${i}" data-field="tempo">
            <input type="text" class="cw-ex-input small" placeholder="Rest" value="${ex.rest}" data-idx="${i}" data-field="rest">
          </div>
        </div>`).join('')}
      </div>
      <button class="cw-add-exercise" id="cw-add-ex">+ Add Exercise</button>
      <div class="cw-actions">
        ${existing ? '<button class="cw-delete">Delete Workout</button>' : ''}
        <button class="cw-save">Save</button>
      </div>
    </div>`;

    // Event listeners
    overlay.querySelector('.custom-close').addEventListener('click', () => overlay.remove());

    overlay.querySelectorAll('.cw-color').forEach(btn => {
      btn.addEventListener('click', () => {
        overlay.querySelectorAll('.cw-color').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    overlay.querySelectorAll('.cw-ex-input').forEach(input => {
      input.addEventListener('input', () => {
        const idx = parseInt(input.dataset.idx);
        exercises[idx][input.dataset.field] = input.value;
      });
    });

    overlay.querySelectorAll('.cw-remove-ex').forEach(btn => {
      btn.addEventListener('click', () => {
        exercises.splice(parseInt(btn.dataset.idx), 1);
        render();
      });
    });

    overlay.querySelector('#cw-add-ex').addEventListener('click', () => {
      exercises.push({ name: '', setsConfig: '3 x 10-12', tempo: '3011', rest: '1-2 mins', notes: '' });
      render();
    });

    const deleteBtn = overlay.querySelector('.cw-delete');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => {
        confirmAction('Delete this workout?', 'This cannot be undone.', () => {
          const custom = (Storage.get('customWorkouts') || []).filter(w => w.id !== editId);
          Storage.set('customWorkouts', custom);
          overlay.remove();
          renderHome();
        });
      });
    }

    overlay.querySelector('.cw-save').addEventListener('click', () => {
      const name = overlay.querySelector('#cw-name').value.trim();
      if (!name) return;
      const validExercises = exercises.filter(e => e.name.trim());
      if (validExercises.length === 0) return;
      const color = overlay.querySelector('.cw-color.active')?.dataset.color || '#e53935';

      const workout = {
        id: existing?.id || 'custom_' + Date.now().toString(36),
        name,
        color,
        icon: 'custom',
        warmup: [],
        exercises: validExercises.map((e, i) => ({
          order: String.fromCharCode(65 + i),
          name: e.name.trim(),
          setsConfig: e.setsConfig || '3 x 10',
          tempo: e.tempo || '3011',
          rest: e.rest || '1-2 mins',
          notes: e.notes || ''
        }))
      };

      const custom = Storage.get('customWorkouts') || [];
      const idx = custom.findIndex(w => w.id === workout.id);
      if (idx >= 0) custom[idx] = workout;
      else custom.push(workout);
      Storage.set('customWorkouts', custom);
      overlay.remove();
      renderHome();
    });
  }

  render();
  document.body.appendChild(overlay);
}

// --- Swipe back from workout ---
(function() {
  let touchStartX = 0;
  let touchStartY = 0;
  const ws = document.getElementById('screen-workout');

  ws.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  ws.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = Math.abs(e.changedTouches[0].clientY - touchStartY);
    // Swipe right from left edge, mostly horizontal
    if (touchStartX < 40 && dx > 80 && dy < 100) {
      stopWorkoutTimer();
      showScreen('home');
      currentWorkout = null;
      $('#bottom-nav').style.display = 'flex';
    }
  }, { passive: true });
})();

// Register service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
