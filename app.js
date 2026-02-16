// --- Storage helpers ---
const Storage = {
  get(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  },
  set(key, val) {
    localStorage.setItem(key, JSON.stringify(val));
  }
};

// --- State ---
let currentWorkout = null;
let currentSession = {};  // { exerciseId: { sets: [{ weight, reps, done }] } }
let timerInterval = null;
let timerSeconds = 0;
let workoutStartTime = null;

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
  showScreen('home');
  currentWorkout = null;
});

// --- Home screen ---
function renderHome() {
  const grid = $('#workout-grid');
  const history = Storage.get('workoutHistory') || [];
  grid.innerHTML = WORKOUTS.map(w => {
    const type = w.id.replace(/[0-9]/g, '');
    const lastEntry = history.filter(h => h.workoutId === w.id).sort((a, b) => b.timestamp - a.timestamp)[0];
    const lastText = lastEntry ? `Last: ${formatDate(lastEntry.timestamp)}` : 'Not started yet';
    return `<div class="workout-card" data-id="${w.id}" data-type="${type}">
      <div class="card-name">${w.name}</div>
      <div class="card-count">${w.exercises.length} exercises</div>
      <div class="card-last">${lastText}</div>
    </div>`;
  }).join('');

  grid.querySelectorAll('.workout-card').forEach(card => {
    card.addEventListener('click', () => startWorkout(card.dataset.id));
  });
}

// --- Start Workout ---
function startWorkout(workoutId) {
  currentWorkout = WORKOUTS.find(w => w.id === workoutId);
  currentSession = {};
  workoutStartTime = Date.now();
  $('#workout-title').textContent = currentWorkout.name;
  renderWorkout();
  showScreen('workout');
  $('#bottom-nav').style.display = 'none';
}

$('#finish-btn').addEventListener('click', finishWorkout);

function finishWorkout() {
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
    prs
  });
}

function showWorkoutSummary({ name, exerciseCount, totalSets, totalVolume, duration, prs }) {
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
    <button class="summary-done">Done</button>
  </div>`;

  document.body.appendChild(overlay);

  overlay.querySelector('.summary-done').addEventListener('click', () => {
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
    const lastSession = getLastSession(w.id, ex.order);
    if (!currentSession[ex.order]) {
      // Pre-fill with last session's weights AND reps
      currentSession[ex.order] = {
        sets: Array.from({ length: numSets }, (_, i) => ({
          weight: (lastSession && lastSession.sets[i]?.weight) || '',
          reps: (lastSession && lastSession.sets[i]?.reps) || '',
          done: false
        }))
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
            <span>Set</span><span>Weight (kg)</span><span>Reps</span><span></span>
          </div>
          ${session.sets.map((s, i) => `
            <div class="set-row">
              <div class="set-num">${i + 1}</div>
              <div class="weight-stepper">
                <button class="step-btn step-down" data-ex="${ex.order}" data-set="${i}" data-field="weight" data-step="-2.5">&minus;</button>
                <input class="set-input" type="number" inputmode="decimal" placeholder="kg"
                  value="${s.weight}" data-ex="${ex.order}" data-set="${i}" data-field="weight">
                <button class="step-btn step-up" data-ex="${ex.order}" data-set="${i}" data-field="weight" data-step="2.5">+</button>
              </div>
              <input class="set-input reps-input" type="number" inputmode="numeric" placeholder="reps"
                value="${s.reps}" data-ex="${ex.order}" data-set="${i}" data-field="reps">
              <button class="set-check ${s.done ? 'checked' : ''}"
                data-ex="${ex.order}" data-set="${i}">&#10003;</button>
            </div>
          `).join('')}
        </div>
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
      currentSession[ex].sets[parseInt(set)][field] = e.target.value;
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
      // Update the input next to this button
      const input = btn.parentElement.querySelector('.set-input');
      input.value = newVal;
    });
  });

  content.querySelectorAll('.set-check').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const { ex, set } = e.currentTarget.dataset;
      const s = currentSession[ex].sets[parseInt(set)];
      s.done = !s.done;
      e.currentTarget.classList.toggle('checked', s.done);

      // PR check when marking done
      if (s.done) {
        const weight = parseFloat(s.weight) || 0;
        if (weight > 0) {
          const exercise = w.exercises.find(e => e.order === ex);
          if (exercise) {
            const currentPR = getPRForExercise(exercise.name);
            if (weight > currentPR) {
              showPRBanner(exercise.name, weight);
            }
          }
        }
      }

      // Check if all sets done
      const card = e.currentTarget.closest('.exercise-card');
      const allDone = currentSession[ex].sets.every(s => s.done);
      card.classList.toggle('completed', allDone);
      if (allDone) {
        const orderEl = card.querySelector('.exercise-order');
        orderEl.innerHTML = '&#10003;';
      }
    });
  });

  content.querySelectorAll('.rest-trigger').forEach(btn => {
    btn.addEventListener('click', () => {
      startTimer(parseInt(btn.dataset.rest));
    });
  });
}

// --- Rest Timer ---
let timerDoneVibrated = false;

function startTimer(seconds) {
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
  const isOver = timerSeconds <= 0;
  $('#timer-display').style.color = isOver ? '#e53935' : 'var(--text)';
  $('#rest-timer').classList.toggle('timer-over', isOver);
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

      html += `<div class="history-entry" data-entry-id="${entry.id}">
        <div class="history-entry-header">
          <span class="history-entry-name">${entry.workoutName}</span>
          <span class="history-entry-badge" style="background:${colors[type] || 'var(--accent)'}">${type.toUpperCase()}</span>
        </div>
        <div class="history-entry-stats">${exerciseCount} exercises &middot; ${totalSets} sets logged</div>
        <div class="history-detail">`;

      Object.values(entry.exercises).forEach(ex => {
        const setsStr = ex.sets.map(s => `${s.weight || '?'}kg x ${s.reps || '?'}`).join(', ');
        html += `<div class="history-exercise-row">
          <span class="history-exercise-name">${ex.name}</span>
          <span class="history-exercise-sets">${setsStr}</span>
        </div>`;
      });

      html += `<button class="delete-session" data-delete-id="${entry.id}">Delete Session</button>
        </div>
      </div>`;
    });
    html += '</div>';
  });

  container.innerHTML = html;

  // Toggle expand
  container.querySelectorAll('.history-entry').forEach(entry => {
    entry.addEventListener('click', (e) => {
      if (e.target.classList.contains('delete-session')) return;
      entry.classList.toggle('expanded');
    });
  });

  // Delete
  container.querySelectorAll('.delete-session').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      confirmAction('Delete this workout session?', 'This cannot be undone.', () => {
        const id = btn.dataset.deleteId;
        const history = Storage.get('workoutHistory') || [];
        Storage.set('workoutHistory', history.filter(h => h.id !== id));
        renderHistory();
        renderHome();
      });
    });
  });
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

  // Filter chips - workout type
  const activeFilter = filters.dataset.active || 'all';
  filters.innerHTML = ['all', 'push', 'pull', 'legs'].map(f =>
    `<button class="filter-chip ${f === activeFilter ? 'active' : ''}" data-filter="${f}">${f === 'all' ? 'All' : f.toUpperCase()}</button>`
  ).join('');

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
      // Check if this exercise belongs to a workout of this type
      const belongsToType = WORKOUTS.some(w =>
        w.id.includes(activeFilter) && w.exercises.some(e => e.name === name)
      );
      if (belongsToType) filteredExercises.set(name, data);
    }
  });

  let html = '';
  filteredExercises.forEach((sessions, name) => {
    // Sort by date
    sessions.sort((a, b) => a.date - b.date);

    // Get max weight for each session
    const dataPoints = sessions.map(s => {
      const maxWeight = Math.max(...s.sets.map(set => parseFloat(set.weight) || 0));
      const bestSet = s.sets.reduce((best, set) => {
        const w = parseFloat(set.weight) || 0;
        return w > (parseFloat(best.weight) || 0) ? set : best;
      }, s.sets[0]);
      return {
        date: s.date,
        maxWeight,
        bestSet
      };
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
        <span>Sessions: <strong>${dataPoints.length}</strong></span>
        ${improvement !== 0 ? `<span style="color:${improvement > 0 ? '#43a047' : '#e53935'}">${improvement > 0 ? '+' : ''}${improvement}kg</span>` : ''}
      </div>
    </div>`;
  });

  container.innerHTML = html || '<div class="progress-empty"><p>No weight data logged for this filter.</p></div>';
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

// --- Init ---
renderHome();

// Register service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
