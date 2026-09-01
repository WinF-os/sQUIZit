'use strict';

const APP_VERSION = 'QF_SYS_V.1.2.34';

// Diagnostic only: captures the first uncaught error/rejection anywhere in
// the app so it can be surfaced in the UI (Profile > Backup & Restore) --
// there's no remote devtools access to a user's native install, and an
// uncaught throw partway through this script's top-level init sequence has
// silently killed later, unrelated code before (see README/history for the
// version-popup regression incident). Lets a real error be screenshotted
// instead of guessed at blind.
window.__firstUncaughtError = null;
window.addEventListener('error', (e) => {
  if (!window.__firstUncaughtError) window.__firstUncaughtError = `${e.message} (${e.filename}:${e.lineno})`;
});
window.addEventListener('unhandledrejection', (e) => {
  if (!window.__firstUncaughtError) window.__firstUncaughtError = `Unhandled promise rejection: ${e.reason}`;
});

/* ============ State ============ */

const state = {
  tab: 'home',
  createStep: 'source', // source | configure | manualBuilder | generating | quiz | results
  generationMode: 'ai', // ai | manual | auto
  manualQuestions: [],
  examTitle: '',
  subject: '',
  sourceImages: [], // { dataUrl, mimeType }
  sourceText: '',
  config: {
    types: { multipleChoice: true, trueFalse: false, identification: false, calculation: false, essay: false },
    difficulty: 'medium',
    count: 10,
    timeLimitMinutes: 0, // 0 = no limit
  },
  quiz: null,
  answers: {},
  essayGrades: {},
  quizIndex: 0,
  libraryTab: 'completed',
  librarySearch: '',
  cameraStream: null,
  cameraMode: 'source', // 'source' (document/page scan) | 'identity' (selfie for Student Identity) | 'read' (Read Aloud page scan)
  readImages: [], // { dataUrl, mimeType } -- Read Aloud tab's own capture list, separate from sourceImages
  readText: '',
  readChunks: [],
  readAudioCache: {}, // chunk index -> base64 mp3, fetched from text-to-speech Edge Function on demand
  readChunkIndex: 0,
  readIsPlaying: false,
  readAudioEl: null,
  geminiApiKeys: loadGeminiKeys(),
  studentIdentity: loadStudentIdentity(),
  activeKeyIndex: 0,
  showCorrectAnswers: false,
  currentLibraryId: null, // library entry (if any) the in-progress quiz was resumed/reviewed from -- lets a re-save update it instead of always inserting a duplicate
  legibilityCheckPending: false, // true while an uploaded/captured image is being checked (or its warning modal is open) -- see checkAddedImagesLegibility()
  quizTimerStartedAt: null, // set the moment the first answer is given -- not persisted across a close/reopen, see startQuizTimerIfNeeded()
  creatorId: loadCreatorId(), // may be null until the first Share & Track tap -- see ensureCreatorId()
  activeTrackedQuizId: null, // set while taking a quiz opened via a ?quiz= Share & Track link, so the completion path knows to sync a score back
  pendingTrackedQuizId: null, // a ?quiz= id seen at load time but not yet loaded, because the mandatory first-launch Identity modal is in the way -- see the init block
  pendingClassSessionId: null, // same idea as pendingTrackedQuizId, but for a ?class= Class Sessions link
  digitalId: loadDigitalId(), // may be null until the first "Back Up via Digital ID" tap -- see Profile > Backup & Restore
};

const QUESTION_TYPES = [
  { key: 'multipleChoice', title: 'Multiple Choice', sub: 'Standard 4-option selection.', icon: '☑' },
  { key: 'trueFalse', title: 'True / False', sub: 'Binary response format.', icon: '⇄' },
  { key: 'identification', title: 'Identification', sub: 'One or two word factual answers.', icon: '🔎' },
  { key: 'matching', title: 'Matching Type', sub: 'Match each item on the left to one on the right.', icon: '🔗' },
  { key: 'calculation', title: 'Calculation', sub: 'Numeric, worked-out answers.', icon: '∑' },
  { key: 'essay', title: 'Essay', sub: 'Short written responses, AI-graded.', icon: '✎' },
];

const DIFFICULTIES = [
  { key: 'easy', label: 'Easy', sub: 'Foundational' },
  { key: 'medium', label: 'Medium', sub: 'Standard' },
  { key: 'hard', label: 'Hard', sub: 'Advanced' },
];

const TYPE_LABELS = {
  multipleChoice: 'Multiple Choice',
  trueFalse: 'True / False',
  identification: 'Identification',
  matching: 'Matching Type',
  calculation: 'Calculation',
  essay: 'Essay',
};

const SUGGESTED_TOPICS = ['Big O Notation', 'Graph Theory Basics', 'Sorting Efficiencies'];

// Real, persisted exam library -- was previously 5 hardcoded fake entries
// (Biology/History/etc, dated 2023) that reappeared on every reload no
// matter what the user actually did, because nothing was ever saved to
// localStorage. Loaded once here, saved after every mutation below.
function loadLibraryExams() {
  try {
    return JSON.parse(localStorage.getItem('quizforge-library') || '[]');
  } catch (e) {
    return [];
  }
}
function saveLibraryExams() {
  try {
    localStorage.setItem('quizforge-library', JSON.stringify(LIBRARY_EXAMS));
  } catch (e) { /* storage unavailable/full -- exams still work in-memory this session */ }
}
const LIBRARY_EXAMS = loadLibraryExams();

// Student Identity -- collected on first launch (see the init block near the
// bottom of this file) and editable afterward from Profile > Student
// Identity. Same shape/storage pattern as the library above: one flat
// localStorage key, loaded once, written back on every save.
function loadStudentIdentity() {
  try {
    return JSON.parse(localStorage.getItem('quizforge-student-identity') || 'null');
  } catch (e) {
    return null;
  }
}
function saveStudentIdentity(identity) {
  try {
    localStorage.setItem('quizforge-student-identity', JSON.stringify(identity));
  } catch (e) { /* storage unavailable/full -- identity still works in-memory this session */ }
}

// Creator identity for Share & Track -- there's no login in this app, so a
// lazily-generated random id (same flat-localStorage pattern as Student
// Identity above) is what ties a set of shared quizzes to "you" on the
// Monitoring tab. Generated on first Share & Track tap, not at app load, so
// someone who never shares anything never gets one.
function loadCreatorId() {
  try {
    return localStorage.getItem('quizforge-creator-id');
  } catch (e) {
    return null;
  }
}
function ensureCreatorId() {
  if (state.creatorId) return state.creatorId;
  const id = crypto.randomUUID();
  try { localStorage.setItem('quizforge-creator-id', id); } catch (e) { /* works this session only */ }
  state.creatorId = id;
  return id;
}

// Digital ID -- the id itself only, NEVER the PIN. The PIN is never
// persisted client-side and must be re-entered every time a backup/restore
// happens; unlike creatorId, this is never generated client-side either --
// it always comes back from save-digital-id-backup on first successful
// backup (server-side generation, since this browser has no way to check
// for a collision against digital_identities before writing anyway).
function loadDigitalId() {
  try {
    return localStorage.getItem('quizforge-digital-id');
  } catch (e) {
    return null;
  }
}
function saveDigitalIdLocally(id) {
  try { localStorage.setItem('quizforge-digital-id', id); } catch (e) { /* still usable this session */ }
}

/* ============ Helpers ============ */

const $ = (id) => document.getElementById(id);
const esc = (str) => String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Source photos/uploads get re-encoded down to this cap before ever leaving
// the device -- full camera-resolution JPEGs (several MB each, more once
// base64'd into the generate-quiz request body) were dying mid-upload as a
// bare "Failed to fetch" on weaker mobile connections, especially in the
// packaged Android app.
const MAX_SOURCE_IMAGE_DIM = 1600;
const SOURCE_IMAGE_QUALITY = 0.8;

function resizeImageDataUrl(dataUrl, maxDim = MAX_SOURCE_IMAGE_DIM, quality = SOURCE_IMAGE_QUALITY) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

/* ============ Theme ============ */

function getSystemTheme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// Fisher-Yates shuffle algorithm
function shuffleArray(array) {
  const newArray = [...array];
  for (let i = newArray.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
  }
  return newArray;
}

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.setAttribute('data-theme', theme);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

function initTheme() {
  const stored = localStorage.getItem('quizforge-theme');
  if (stored) applyTheme(stored);
  const current = stored || getSystemTheme();
  $('themeToggle').checked = current === 'dark';
  updateThemeLabel(current);
}

function updateThemeLabel(theme) {
  $('themeIcon').textContent = theme === 'dark' ? '🌙' : '☀️';
  $('themeLabel').textContent = theme === 'dark' ? 'Dark mode' : 'Light mode';
}

$('themeToggle').addEventListener('change', (event) => {
  const next = event.target.checked ? 'dark' : 'light';
  localStorage.setItem('quizforge-theme', next);
  applyTheme(next);
  updateThemeLabel(next);
});

/* ============ Gemini API keys (BYOK, multi-key with quota rotation) ============ */

function loadGeminiKeys() {
  try {
    const stored = JSON.parse(localStorage.getItem('quizforge-gemini-keys') || '[]');
    if (Array.isArray(stored) && stored.length) return stored;
  } catch { /* ignore malformed storage */ }
  const legacy = localStorage.getItem('quizforge-gemini-key');
  if (legacy) {
    const migrated = [{ label: 'Key 1', key: legacy }];
    localStorage.setItem('quizforge-gemini-keys', JSON.stringify(migrated));
    localStorage.removeItem('quizforge-gemini-key');
    return migrated;
  }
  return [];
}

function saveGeminiKeys() {
  localStorage.setItem('quizforge-gemini-keys', JSON.stringify(state.geminiApiKeys));
}

function maskKey(key) {
  return key.length > 12 ? `${key.slice(0, 8)}…${key.slice(-4)}` : key;
}

function refreshGeminiKeyStatus() {
  const keys = state.geminiApiKeys;
  $('geminiKeyStatus').textContent = keys.length
    ? `${keys.length} key${keys.length > 1 ? 's' : ''} saved in this browser.`
    : 'No keys saved yet — AI Generate and essay grading are disabled until you add one.';

  $('geminiKeyList').innerHTML = keys.map((k, i) => `
    <div class="key-row">
      <input type="text" class="text-input js-key-label" data-index="${i}" value="${esc(k.label)}">
      <span class="key-row-masked">${esc(maskKey(k.key))}</span>
      <button type="button" class="link-btn js-remove-key" data-index="${i}">Remove</button>
    </div>
  `).join('');

  $('geminiKeyList').querySelectorAll('.js-key-label').forEach((input) => {
    input.addEventListener('change', () => {
      const idx = Number(input.dataset.index);
      state.geminiApiKeys[idx].label = input.value.trim() || `Key ${idx + 1}`;
      saveGeminiKeys();
    });
  });
  $('geminiKeyList').querySelectorAll('.js-remove-key').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.geminiApiKeys.splice(Number(btn.dataset.index), 1);
      if (state.activeKeyIndex >= state.geminiApiKeys.length) state.activeKeyIndex = 0;
      saveGeminiKeys();
      onGeminiKeyChanged();
    });
  });
}

function onGeminiKeyChanged() {
  refreshGeminiKeyStatus();
  updateContinueGating();
  if (state.createStep === 'configure') updateGenerateGating();
}

// Route through Google's account-chooser page instead of opening AI Studio
// directly -- opening the target URL straight would silently reuse whichever
// Google account happens to already be signed into that browser. Forcing the
// chooser first lets the user pick a specific account (useful when one
// account's Gemini project has been flagged/denied and they want to try a
// different one) instead of guessing which account they're on.
function openGoogleUrlWithAccountChooser(targetUrl) {
  const chooserUrl = `https://accounts.google.com/AccountChooser?continue=${encodeURIComponent(targetUrl)}`;
  window.open(chooserUrl, '_blank', 'noopener');
}

$('btnGetGeminiKey').addEventListener('click', () => {
  openGoogleUrlWithAccountChooser('https://aistudio.google.com/apikey');
});

$('btnPasteGeminiKey').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) $('geminiKeyInput').value = text.trim();
  } catch {
    $('geminiKeyStatus').textContent = 'Could not read clipboard — paste manually instead.';
  }
});

$('btnAddGeminiKey').addEventListener('click', () => {
  const key = $('geminiKeyInput').value.trim();
  if (!key) return;
  state.geminiApiKeys.push({ label: `Key ${state.geminiApiKeys.length + 1}`, key });
  saveGeminiKeys();
  $('geminiKeyInput').value = '';
  onGeminiKeyChanged();
});

// Any error that's specific to the key/project rather than the request itself
// -- quota exhaustion, but also a key's whole GCP project getting suspended
// or otherwise denied (403 PERMISSION_DENIED) or an invalid/revoked key.
// These should fall through to the next saved key instead of failing the
// whole generation on the first bad key.
function isKeyRotationError(message) {
  return /RESOURCE_EXHAUSTED|429|exceeded your current quota|PERMISSION_DENIED|403|API_KEY_INVALID|API key not valid/i.test(message || '');
}

async function callWithKeyRotation(name, body) {
  const keys = state.geminiApiKeys;
  if (!keys.length) throw new Error('Add your Gemini API key in Profile first.');
  for (let i = 0; i < keys.length; i++) {
    const idx = (state.activeKeyIndex + i) % keys.length;
    try {
      const data = await callEdgeFunction(name, { ...body, geminiApiKey: keys[idx].key });
      state.activeKeyIndex = idx;
      return data;
    } catch (err) {
      if (!isKeyRotationError(err.message)) throw err;
    }
  }
  const rotationErr = new Error('None of your saved Gemini keys are working right now (quota limits or access issues).');
  rotationErr.allKeysExhausted = true;
  throw rotationErr;
}

/* ============ Navigation ============ */

function switchTab(tab) {
  state.tab = tab;
  // Drives the Obsidian Orbit skin (see style.css) that dark-themes the
  // shared header/nav chrome only while the Class tab is active, so the
  // live-class experience reads as one unified dark surface top-to-bottom
  // (matching the reference screenshots) instead of a black panel dropped
  // under an otherwise cream/orange header.
  $('appShell').dataset.activeTab = tab;
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.hidden = panel.dataset.tab !== tab;
  });
  document.querySelectorAll('.bottom-nav-item').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.target === tab);
  });
  $('btnHeaderBack').hidden = true;
  window.scrollTo(0, 0);
  if (tab === 'home') renderHome();
  if (tab === 'library') renderLibrary();
  if (tab === 'monitoring') renderMonitoring();
  if (tab === 'class') renderClassTab();
}

document.querySelectorAll('.bottom-nav-item').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.target));
});

// Was just switchTab('create') -- showed whatever create-flow state was
// last active (including, after the Library fixes above, a stale
// currentLibraryId pointing at whatever exam was last resumed/reviewed,
// which would then silently overwrite that unrelated library entry the
// next time anything auto-saved). "Quick Create" should mean a genuinely
// fresh quiz.
$('btnQuickCreate').addEventListener('click', () => { resetCreateFlow(); switchTab('create'); });
$('btnViewAllRecent').addEventListener('click', () => switchTab('library'));
$('btnExploreBank').addEventListener('click', () => switchTab('library'));

/* ============ Home ============ */

function renderHome() {
  // Recent Exams -- derived from the real, persisted library (most recently
  // saved first, since every save unshift()s) instead of a separate static
  // demo array that never reflected anything the user actually did.
  const recent = LIBRARY_EXAMS.slice(0, 3);
  $('recentList').innerHTML = recent.length ? recent.map((exam) => `
    <li class="recent-item">
      <span class="recent-item-icon">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 8-4 4 4 4M15 8l4 4-4 4" /></svg>
      </span>
      <span class="recent-item-body">
        <span class="recent-item-title">${esc(exam.title)}</span>
        <span class="recent-item-meta">${exam.status === 'draft' ? 'Draft' : 'Completed'} &bull; ${esc(exam.date)} &bull; ${exam.questionCount} Questions</span>
      </span>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6" /></svg>
    </li>
  `).join('') : `<li class="empty-note">No exams yet — create your first one to see it here.</li>`;

  const completedCount = LIBRARY_EXAMS.filter((e) => e.status === 'completed').length;
  const draftCount = LIBRARY_EXAMS.filter((e) => e.status === 'draft').length;
  $('homeExamsSummary').textContent = !LIBRARY_EXAMS.length
    ? "You haven't created any exams yet — tap Quick Create to get started."
    : `You have ${completedCount} completed exam${completedCount === 1 ? '' : 's'} and ${draftCount} draft${draftCount === 1 ? '' : 's'} awaiting completion.`;

  $('topicList').innerHTML = SUGGESTED_TOPICS.map((topic) => `
    <li class="topic-item"><span>${esc(topic)}</span><button type="button" class="topic-add-btn" aria-label="Add ${esc(topic)}">+</button></li>
  `).join('');
}

/* ============ Library ============ */

$('btnLibCompleted').addEventListener('click', () => { state.libraryTab = 'completed'; renderLibrary(); });
$('btnLibDrafts').addEventListener('click', () => { state.libraryTab = 'draft'; renderLibrary(); });
$('librarySearchInput').addEventListener('input', (event) => { state.librarySearch = event.target.value; renderLibrary(); });

function renderLibrary() {
  $('btnLibCompleted').classList.toggle('is-active', state.libraryTab === 'completed');
  $('btnLibDrafts').classList.toggle('is-active', state.libraryTab === 'draft');

  const query = state.librarySearch.trim().toLowerCase();
  const filtered = LIBRARY_EXAMS.filter((exam) => {
    if (exam.status !== state.libraryTab) return false;
    if (!query) return true;
    return exam.title.toLowerCase().includes(query) || exam.subject.toLowerCase().includes(query);
  });

  if (!filtered.length) {
    const noneOfThisStatusAtAll = !LIBRARY_EXAMS.some((exam) => exam.status === state.libraryTab);
    const message = state.libraryTab === 'draft'
      ? 'No drafts yet — unfinished exams will appear here.'
      : (noneOfThisStatusAtAll ? 'No completed exams yet — finish a quiz to see it here.' : 'No exams match your search.');
    $('libraryList').innerHTML = `<p class="empty-note">${message}</p>`;
    return;
  }

  const cards = filtered.map((exam, index) => {
    const hasProgress = exam.status === 'draft' && exam.answers && Object.keys(exam.answers).length > 0;
    const primaryLabel = exam.status === 'completed' ? 'Review' : (hasProgress ? 'Continue' : 'Take Quiz');
    const showRetake = exam.status === 'completed' || hasProgress;
    const attempts = exam.history?.length || 0;
    return `
    <article class="exam-card exam-card--tag--${esc(exam.tag)}">
      <span class="exam-tag tag--${esc(exam.tag)}">${esc(exam.subject)}</span>
      <h3 class="exam-card-title">${esc(exam.title)}</h3>
      <p class="exam-card-meta">${exam.questionCount} Questions &bull; ${esc(exam.date)}${attempts ? ` &bull; ${attempts} attempt${attempts === 1 ? '' : 's'}` : ''}</p>
      <p class="exam-card-excerpt">&ldquo;${esc(exam.excerpt)}&rdquo;</p>
      ${attempts ? `<p class="exam-card-history">${exam.history.slice(-3).reverse().map((h) => `${esc(h.date)}: ${h.scorePercent}%`).join(' &middot; ')}</p>` : ''}
      <div class="exam-card-foot">
        <span class="exam-badge">${esc(exam.badge)}</span>
        <div class="exam-card-actions">
          <button type="button" class="link-btn js-open-exam">${primaryLabel}
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6" /></svg>
          </button>
          ${showRetake ? `<button type="button" class="link-btn js-retake-exam">Retake</button>` : ''}
          <button type="button" class="link-btn js-edit-exam">Edit</button>
          <button type="button" class="link-btn js-share-exam">Share File</button>
          <button type="button" class="link-btn js-share-link-exam">Share Link</button>
          <button type="button" class="link-btn js-share-track-exam">Share &amp; Track</button>
        </div>
      </div>
    </article>
    ${index === 1 ? `
      <button type="button" class="library-create-card js-create-new">
        <span class="library-create-icon">+</span>
        <span class="library-create-title">Create New</span>
        <span class="screen-sub">Generate a new exam from your notes or photos.</span>
      </button>
    ` : ''}
  `;
  }).join('');

  $('libraryList').innerHTML = cards;
  // Was: every "Open Exam" button, on every card, blindly switched to the
  // Create tab regardless of which exam was clicked -- clicking any saved
  // exam did the same generic thing as clicking nothing at all. Now each
  // card has its own specific actions: a fresh draft opens straight into
  // the quiz, a partly-answered draft can Continue (resume) or Retake
  // (restart), a completed exam can Review (read-only) or Retake, and
  // every card can be Edited.
  const cardEls = $('libraryList').querySelectorAll('.exam-card');
  filtered.forEach((exam, i) => {
    const card = cardEls[i];
    card.querySelector('.js-open-exam')?.addEventListener('click', () => {
      if (exam.status === 'completed') viewCompletedExam(exam);
      else continueQuizFromLibrary(exam);
    });
    card.querySelector('.js-retake-exam')?.addEventListener('click', () => retakeQuizFromLibrary(exam));
    card.querySelector('.js-edit-exam')?.addEventListener('click', () => editQuizFromLibrary(exam));
    card.querySelector('.js-share-exam')?.addEventListener('click', () => shareQuizAsHtml(exam));
    card.querySelector('.js-share-link-exam')?.addEventListener('click', async (e) => {
      // Uploading takes a real network round-trip (unlike the instant file
      // share above), so this needs its own loading state -- both to give
      // feedback and to stop a double-tap from uploading the same quiz twice.
      const btn = e.currentTarget;
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Uploading…';
      try {
        await shareQuizAsLink(exam);
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    });
    card.querySelector('.js-share-track-exam')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = exam.trackedQuizId ? 'Sharing…' : 'Setting up…';
      try {
        await shareQuizAndTrack(exam);
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    });
  });
  $('libraryList').querySelectorAll('.js-create-new').forEach((btn) => {
    btn.addEventListener('click', () => switchTab('create'));
  });
}

/* ============ Monitoring ============ */

// Every render* function elsewhere in this file is synchronous and reads
// purely local state -- this is the first one that needs a network round
// trip, so it needs its own loading state. monitoringCache holds the last
// fetch's result so the detail modal doesn't need a second request.
let monitoringCache = [];

async function renderMonitoring() {
  const list = $('monitoringList');
  if (!state.creatorId) {
    list.innerHTML = `<p class="empty-note">Nothing shared yet — tap Share &amp; Track on a quiz in your Library.</p>`;
    return;
  }
  list.innerHTML = `<p class="empty-note">Loading…</p>`;
  try {
    const data = await callEdgeFunction('get-monitoring-data', { creatorId: state.creatorId });
    monitoringCache = data.quizzes || [];
    if (!monitoringCache.length) {
      list.innerHTML = `<p class="empty-note">Nothing shared yet — tap Share &amp; Track on a quiz in your Library.</p>`;
      return;
    }
    list.innerHTML = monitoringCache.map((q, i) => `
      <article class="card monitoring-card">
        <h3 class="exam-card-title">${esc(q.examTitle)}</h3>
        <p class="exam-card-meta">${esc(q.subject || 'General')} &bull; ${q.attempts.length} recipient${q.attempts.length === 1 ? '' : 's'}</p>
        <button type="button" class="link-btn js-monitoring-view" data-index="${i}">View Recipients</button>
      </article>
    `).join('');
    list.querySelectorAll('.js-monitoring-view').forEach((btn) => {
      btn.addEventListener('click', () => openMonitoringDetail(monitoringCache[Number(btn.dataset.index)]));
    });
  } catch (e) {
    list.innerHTML = `<p class="empty-note">Couldn't load Monitoring data: ${esc(e.message || e)}</p>`;
  }
}

function openMonitoringDetail(quiz) {
  $('monitoringDetailTitle').textContent = quiz.examTitle;
  $('monitoringDetailSub').textContent = `${quiz.attempts.length} recipient${quiz.attempts.length === 1 ? '' : 's'}`;
  $('monitoringDetailList').innerHTML = quiz.attempts.length
    ? quiz.attempts.map((a) => {
        // Same name-assembly pattern as renderStudentIdentityCard, above.
        const name = [a.recipientGivenName, a.recipientMiddleName, a.recipientSurname].filter(Boolean).join(' ') || 'Unnamed';
        const meta = [a.recipientGradeLevel, a.recipientSchool].filter(Boolean).join(' • ');
        return `<div class="monitoring-attempt-row">
          <div><strong>${esc(name)}</strong>${meta ? `<div class="screen-sub">${esc(meta)}</div>` : ''}</div>
          <div class="monitoring-attempt-score">${a.scorePercent}%</div>
        </div>`;
      }).join('')
    : `<p class="empty-note">No recipients yet.</p>`;
  $('monitoringDetailModal').hidden = false;
}

$('btnMonitoringDetailClose').addEventListener('click', () => { $('monitoringDetailModal').hidden = true; });

/* ============ Class Sessions ============ */

// Live group video calls for when in-person class is suspended (typhoons,
// etc). Video/audio is powered by Jitsi Meet's free public server
// (meet.jit.si) -- no account needed, no time limit, embedded via its
// IFrame API. sQUIZit itself never runs a media server; a "class session"
// is just a durable row (title + a namespaced room name) that a shareable
// ?class=<id> link points at, same architecture as Share & Track's
// tracked_quizzes. state.creatorId/ensureCreatorId() (already built for
// Share & Track) is reused as-is for "whose classes are these."

let myClassesCache = []; // last get-my-classes fetch, so the list doesn't refetch on every interaction
let activeJitsiApi = null; // the live JitsiMeetExternalAPI instance, or null when no call is open

// Loaded lazily on first actual use, not in index.html's <head> -- most app
// visits never touch the Class tab, so there's no reason to make every cold
// start pull in a third-party script it won't use.
let jitsiScriptPromise = null;
function loadJitsiScript() {
  if (window.JitsiMeetExternalAPI) return Promise.resolve();
  if (jitsiScriptPromise) return jitsiScriptPromise;
  jitsiScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://meet.jit.si/external_api.js';
    script.onload = () => resolve();
    script.onerror = () => {
      jitsiScriptPromise = null; // let a later retry actually retry, instead of resolving to a permanently-broken cached failure
      reject(new Error('Could not reach the video call service. Check your connection.'));
    };
    document.head.appendChild(script);
  });
  return jitsiScriptPromise;
}

async function renderClassTab() {
  const list = $('classSessionList');
  if (!state.creatorId) {
    list.innerHTML = `<p class="empty-note">No classes yet — tap Start a Class to begin.</p>`;
    return;
  }
  list.innerHTML = `<p class="empty-note">Loading…</p>`;
  try {
    const data = await callEdgeFunction('get-my-classes', { creatorId: state.creatorId });
    myClassesCache = data.sessions || [];
    if (!myClassesCache.length) {
      list.innerHTML = `<p class="empty-note">No classes yet — tap Start a Class to begin.</p>`;
      return;
    }
    list.innerHTML = myClassesCache.map((s, i) => `
      <article class="card class-session-card">
        <h3 class="exam-card-title">${esc(s.title)}</h3>
        <p class="exam-card-meta">${esc(s.subject || 'General')}</p>
        <div class="exam-card-actions">
          <button type="button" class="link-btn js-class-join" data-index="${i}">Join / Resume</button>
          <button type="button" class="link-btn js-class-share" data-index="${i}">Copy Link</button>
        </div>
      </article>
    `).join('');
    list.querySelectorAll('.js-class-join').forEach((btn) => {
      btn.addEventListener('click', () => openClassCall(myClassesCache[Number(btn.dataset.index)]));
    });
    list.querySelectorAll('.js-class-share').forEach((btn) => {
      btn.addEventListener('click', () => shareClassSessionLink(myClassesCache[Number(btn.dataset.index)]));
    });
  } catch (e) {
    list.innerHTML = `<p class="empty-note">Couldn't load your classes: ${esc(e.message || e)}</p>`;
  }
}

// Durable, reusable link (no expiry, unlike Share Link's 7-day TTL) -- the
// same session gets shared across every day of a multi-day class
// suspension, same reasoning as Share & Track's links.
async function shareClassSessionLink(session) {
  if (!session || !session.id) return;
  const title = session.title || 'Class';
  const url = `${location.origin}${location.pathname}?class=${session.id}`;
  const text = `${title} — join this live class on sQUIZit.`;
  if (navigator.share) {
    try {
      await navigator.share({ title, text, url });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // user backed out of the share sheet -- not a failure
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    alert(`Class link copied to clipboard:\n${url}`);
  } catch (e) {
    alert(`Class link:\n${url}`);
  }
}

// session needs { title, roomName } -- either a fresh row from
// create-class-session, a cached entry from myClassesCache, or the response
// of get-class-session (deep-link join path, see loadClassSessionFromDeepLink
// below). Jitsi's own "prejoin page" (configOverwrite.prejoinPageEnabled)
// handles the camera/mic preview + display-name-confirm step, so there's no
// separate custom "about to join" screen to build here.
async function openClassCall(session) {
  const identity = state.studentIdentity || {};
  const displayName = [identity.givenName, identity.surname].filter(Boolean).join(' ') || 'sQUIZit User';

  // Native Android gets Jitsi's real SDK (via MainActivity's AndroidBridge,
  // see launchJitsiCall) instead of the browser IFrame embed below --
  // screen sharing needs Android's actual MediaProjection API, which no
  // mobile WebView/browser exposes to web content. Everything else (web,
  // PWA, iOS-web) keeps using the IFrame path unchanged.
  if (isNativeApp() && window.AndroidBridge && window.AndroidBridge.launchJitsiCall) {
    window.AndroidBridge.launchJitsiCall(session.roomName, displayName);
    return;
  }

  $('classCallTitle').textContent = session.title || 'Class';
  $('classCallOverlay').hidden = false;
  $('classCallMount').innerHTML = '';
  try {
    await loadJitsiScript();
    activeJitsiApi = new JitsiMeetExternalAPI('meet.jit.si', {
      roomName: session.roomName,
      parentNode: $('classCallMount'),
      width: '100%',
      height: '100%',
      userInfo: { displayName },
      configOverwrite: {
        // Was prejoinPageEnabled: true -- a stale/deprecated key. Jitsi
        // moved this to prejoinConfig.enabled; confirmed against the
        // current jitsi-meet source (interface_config.js's TOOLBAR_BUTTONS
        // is itself deprecated in favor of this same configOverwrite
        // object's toolbarButtons below).
        prejoinConfig: { enabled: true },
        // Replaces the Jitsi fox/wordmark watermark with our own logo.
        // DEFAULT_LOGO_URL (old interfaceConfig key) is deprecated in
        // favor of this configOverwrite key, confirmed against current
        // jitsi-meet source -- it's just an <img src>, so a plain HTTPS
        // URL to our own icon works cross-origin with no special CORS
        // setup needed. Resolved via URL() rather than a string join so
        // it's correct whether this page loaded as /sQUIZit/ or
        // /sQUIZit/index.html.
        defaultLogoUrl: new URL('icons/wordmark.png', location.href).href,
        // meet.jit.si runs a face-landmark/expression-tracking pipeline
        // (visible in devtools as human.esm.js + face-landmarks-worker,
        // a bundled TensorFlow.js model) by default on every call. In
        // environments where it can't get a GPU adapter it logs "No
        // available adapters" and the resulting processed video frame
        // comes out black instead of falling back to the raw camera feed
        // -- confirmed against jitsi-meet's own config.js, which ships
        // this whole block, off by default, specifically so embedders can
        // override it like this. None of it serves a classroom use case.
        faceLandmarks: {
          enableFaceCentering: false,
          enableFaceExpressionsDetection: false,
          enableDisplayFaceExpressions: false,
          enableRTCStats: false,
        },
        // Curated for a classroom, not Jitsi's full default kitchen-sink
        // toolbar: cuts things that don't apply here at all (Salesforce
        // integration, livestreaming/recording -- neither works on the
        // free public server without paid add-ons anyway) or duplicate
        // functionality sQUIZit already provides its own way (invite/embed
        // -- Share & Track already has a link/QR flow). Kept: core AV,
        // chat, raise hand, participants, tile view (see the whole class
        // at once), whiteboard (real teaching value), room lock (there's
        // no lobby by default, so this is the one privacy control worth
        // surfacing), settings, fullscreen, hangup last.
        toolbarButtons: [
          'microphone', 'camera', 'desktop', 'chat', 'raisehand',
          'participants-pane', 'tileview', 'whiteboard', 'security',
          'settings', 'fullscreen', 'hangup',
        ],
      },
    });
    // Fires from Jitsi's own in-call "leave" control -- same cleanup path as
    // the header close button below, so there's exactly one dispose route
    // no matter which way the user leaves.
    activeJitsiApi.addListener('readyToClose', closeClassCall);
  } catch (e) {
    closeClassCall();
    alert(e.message || 'Could not start the video call.');
  }
}

function closeClassCall() {
  if (activeJitsiApi) {
    activeJitsiApi.dispose();
    activeJitsiApi = null;
  }
  $('classCallOverlay').hidden = true;
  $('classCallMount').innerHTML = '';
}

$('btnClassCallClose').addEventListener('click', closeClassCall);

$('btnStartClass').addEventListener('click', () => {
  $('createClassTitle').value = '';
  $('createClassSubject').value = '';
  $('createClassModalError').hidden = true;
  $('createClassModal').hidden = false;
});
$('btnCreateClassClose').addEventListener('click', () => { $('createClassModal').hidden = true; });
$('btnCreateClassSubmit').addEventListener('click', async () => {
  const title = $('createClassTitle').value.trim();
  if (!title) {
    $('createClassModalError').textContent = 'Give this class a title.';
    $('createClassModalError').hidden = false;
    return;
  }
  const creatorId = ensureCreatorId();
  const subject = $('createClassSubject').value.trim() || null;
  const btn = $('btnCreateClassSubmit');
  btn.disabled = true;
  btn.textContent = 'Starting…';
  try {
    const data = await callEdgeFunction('create-class-session', { creatorId, title, subject });
    $('createClassModal').hidden = true;
    const session = { id: data.id, title, subject, roomName: data.roomName, createdAt: new Date().toISOString() };
    myClassesCache.unshift(session);
    renderClassTab();
    openClassCall(session);
  } catch (e) {
    $('createClassModalError').textContent = e.message || 'Could not start this class.';
    $('createClassModalError').hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Start';
  }
});

// Resolves a ?class=<id> deep link -- mirrors loadTrackedQuizFromDeepLink's
// role for ?quiz=, but simpler: no quiz content to load, just enough
// metadata (title/roomName) to open the call directly.
async function loadClassSessionFromDeepLink(id) {
  switchTab('class');
  try {
    const data = await callEdgeFunction('get-class-session', { id });
    openClassCall({ title: data.title, subject: data.subject, roomName: data.roomName });
  } catch (e) {
    alert(`Couldn't join this class: ${e.message || e}. The link may no longer be active.`);
  }
}

/* ============ Create: source step ============ */

function showCreateStep(step) {
  state.createStep = step;
  ['stepSource', 'stepConfigure', 'stepManualBuilder', 'stepGenerating', 'stepQuiz', 'stepResults'].forEach((id) => {
    $(id).hidden = id !== `step${step[0].toUpperCase()}${step.slice(1)}`;
  });
  $('btnHeaderBack').hidden = step === 'source';
  window.scrollTo(0, 0);
  if (step !== 'quiz') stopQuizTimer(); // covers every way of leaving the quiz screen (finish, back, tab switch) in one place
}

// Shared by the on-screen back button and the hardware/gesture Android
// back button (see handleAndroidBack below) -- one step back through the
// Create flow's own linear order. Returns whether it actually moved.
function goBackOneCreateStep() {
  if (state.tab !== 'create') return false;
  const order = state.generationMode === 'manual'
    ? ['source', 'manualBuilder', 'quiz', 'results']
    : ['source', 'configure', 'generating', 'quiz', 'results'];
  const idx = order.indexOf(state.createStep);
  if (idx > 0) { showCreateStep(order[idx - 1]); return true; }
  return false;
}

$('btnHeaderBack').addEventListener('click', goBackOneCreateStep);

// Handles the Android hardware/gesture back button -- called from native
// code (see MainActivity.java's onBackPressed), which hands back-navigation
// entirely to JS instead of Capacitor's default (WebView history back, else
// exit the app). This app is a single-page app with no real browser
// history, so that default would exit on almost every back press,
// including from the camera. Order of what "back" means here: close the
// camera if it's open, then step back through the Create flow, then
// return to the Home tab, then -- once there's nowhere left to go --
// minimize the app instead of exiting, so reopening it resumes exactly
// where it was (the OS already does this for free as long as the Activity
// is only ever backgrounded, never finished).
window.handleAndroidBack = function () {
  if (!$('cameraOverlay').hidden) { closeCamera(); return; }
  const versionPopup = document.getElementById('versionPopup');
  if (versionPopup && versionPopup.classList.contains('is-visible')) { versionPopup.classList.remove('is-visible'); return; }
  if (!$('legibilityModal').hidden) return; // mid-decision -- don't let back silently dismiss it
  if (goBackOneCreateStep()) return;
  if (state.tab !== 'home') { switchTab('home'); return; }
  if (window.AndroidBridge && window.AndroidBridge.minimizeApp) window.AndroidBridge.minimizeApp();
};

/* ============ Create: generation mode ============ */

document.querySelectorAll('#modeToggle .library-toggle-btn').forEach((btn) => {
  btn.addEventListener('click', () => setGenerationMode(btn.dataset.mode));
});

function setGenerationMode(mode) {
  const previousMode = state.generationMode;
  state.generationMode = mode;
  document.querySelectorAll('#modeToggle .library-toggle-btn').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.mode === mode);
  });
  $('smartBlueprintCard').hidden = mode !== 'ai';
  // Topic Idea skips photos/pasted-material entirely -- it reuses the same
  // pastedTextArea/state.sourceText as Paste Text (so generate-quiz gets
  // sent through the exact same path), just always shown instead of
  // toggled, and relabeled since here it's the topic itself, not material
  // to extract from.
  $('sourceContentSection').hidden = mode === 'topic';
  if (mode === 'topic') {
    $('pasteTextBlock').hidden = false;
  } else if (previousMode === 'topic') {
    $('pasteTextBlock').hidden = true;
  }
  $('pasteTextLabel').textContent = mode === 'topic' ? 'Topic or subject idea' : 'Pasted content';
  $('pastedTextArea').placeholder = mode === 'topic'
    ? 'e.g. Photosynthesis in plants, causes of World War II, basic algebra equations…'
    : 'Paste notes, an article, or a summary of the material here…';

  if (mode === 'ai') {
    $('sourceScreenSub').textContent = 'Provide your source material and let AI draft the exam.';
    $('btnContinueToConfigure').textContent = 'Continue to Configuration';
  } else if (mode === 'topic') {
    $('sourceScreenSub').textContent = 'Describe a topic or idea and let AI write the exam from its own knowledge — no source material needed.';
    $('btnContinueToConfigure').textContent = 'Continue to Configuration';
  } else if (mode === 'manual') {
    $('sourceScreenSub').textContent = 'Skip the AI — build every question yourself, no source material required.';
    $('btnContinueToConfigure').textContent = 'Continue to Question Builder';
  } else {
    $('sourceScreenSub').textContent = 'Paste text and get fill-in-the-blank questions instantly, no AI required.';
    $('btnContinueToConfigure').textContent = 'Continue to Configuration';
  }
  updateContinueGating();
}

function resetCreateFlow() {
  state.examTitle = '';
  state.subject = '';
  state.sourceImages = [];
  state.sourceText = '';
  state.manualQuestions = [];
  state.config = { types: { multipleChoice: true, trueFalse: false, identification: false, calculation: false, essay: false }, difficulty: 'medium', count: 10, timeLimitMinutes: 0 };
  state.quiz = null;
  state.answers = {};
  state.essayGrades = {};
  state.quizIndex = 0;
  state.currentLibraryId = null; // starting a genuinely new quiz -- not continuing whatever library entry (if any) was previously being resumed/reviewed
  state.activeTrackedQuizId = null; // same reasoning -- an unrelated new quiz must never carry a stale tracked-quiz association forward
  $('examTitleInput').value = '';
  $('subjectSelect').value = '';
  $('pastedTextArea').value = '';
  $('pasteTextBlock').hidden = true;
  $('manualPromptInput').value = '';
  $('manualExplanationInput').value = '';
  $('timeLimitInput').value = '';
  $('manualTimeLimitInput').value = '';
  $('btnRegenerateQuiz').hidden = true; // all three are edit-only actions -- nothing to regenerate, copy, or delete for a genuinely new quiz
  $('btnSaveAsNewCopy').hidden = true;
  $('btnDeleteQuiz').hidden = true;
  renderSourcePreview();
  setGenerationMode('ai');
  renderManualBuilder();
  updateContinueGating();
  showCreateStep('source');
}

$('examTitleInput').addEventListener('input', (e) => { state.examTitle = e.target.value; updateContinueGating(); });
$('subjectSelect').addEventListener('change', (e) => { state.subject = e.target.value; updateContinueGating(); });

$('btnUploadDocument').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async (event) => {
  const files = Array.from(event.target.files || []);
  const loaded = await Promise.all(files.map(async (file) => ({ dataUrl: await resizeImageDataUrl(await fileToDataUrl(file)), mimeType: 'image/jpeg' })));
  state.sourceImages.push(...loaded);
  event.target.value = '';
  renderSourcePreview();
  updateContinueGating();
  checkAddedImagesLegibility(loaded);
});

$('btnPasteText').addEventListener('click', () => {
  $('pasteTextBlock').hidden = !$('pasteTextBlock').hidden;
});
$('pastedTextArea').addEventListener('input', (e) => { state.sourceText = e.target.value; updateContinueGating(); });

function renderSourcePreview() {
  const row = $('sourcePreviewRow');
  if (!state.sourceImages.length) { row.hidden = true; row.innerHTML = ''; return; }
  row.hidden = false;
  row.innerHTML = state.sourceImages.map((img, i) => `
    <div class="source-preview-thumb">
      <img src="${img.dataUrl}" alt="Source page ${i + 1}">
      <button type="button" class="source-preview-remove js-remove-image" data-index="${i}" aria-label="Remove image">✕</button>
    </div>
  `).join('');
  row.querySelectorAll('.js-remove-image').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.sourceImages.splice(Number(btn.dataset.index), 1);
      renderSourcePreview();
      updateContinueGating();
    });
  });
}

function updateContinueGating() {
  const hasSource = state.sourceImages.length > 0 || state.sourceText.trim().length > 0;
  const missingKey = (state.generationMode === 'ai' || state.generationMode === 'topic') && !state.geminiApiKeys.length;
  const missingTitleOrSubject = !state.examTitle.trim() || !state.subject;
  const note = $('sourceEmptyNote');
  if (missingTitleOrSubject) {
    note.hidden = false;
    note.textContent = 'Enter an Exam Title and select a Subject before continuing.';
  } else if (missingKey) {
    note.hidden = false;
    note.textContent = 'Add your Gemini API key in Profile to use AI Generate.';
  } else {
    note.hidden = true;
  }
  const ok = !missingTitleOrSubject && (state.generationMode === 'manual' ? true : (hasSource && !missingKey));
  $('btnContinueToConfigure').disabled = !ok || state.legibilityCheckPending;
}

$('btnContinueToConfigure').addEventListener('click', () => {
  if (state.generationMode === 'manual') {
    renderManualBuilder();
    showCreateStep('manualBuilder');
  } else {
    renderConfigureScreen();
    showCreateStep('configure');
  }
});

/* ============ Camera capture ============ */

$('btnCameraCapture').addEventListener('click', () => openCamera('source'));
$('btnCameraClose').addEventListener('click', closeCamera);

// mode: 'source' (document/page scan, rear camera) or 'identity' (Student
// Identity selfie, front camera) -- same overlay/video/canvas for both,
// see the shutter handler below for where the captured frame is routed.
async function openCamera(mode) {
  state.cameraMode = mode;
  const isSelfie = mode === 'identity';
  $('cameraOverlayTitle').textContent = isSelfie ? 'Take a Selfie' : 'Camera Capture';
  $('cameraHint').textContent = isSelfie
    ? 'Center your face in the frame, then tap to capture.'
    : 'Frame the page so the text is flat and well lit, then tap to capture.';
  // Mirror only the live preview (the natural "looking in a mirror" feel) --
  // the canvas below always draws the true, unmirrored frame, which is what
  // an ID photo should actually look like.
  $('cameraVideo').style.transform = isSelfie ? 'scaleX(-1)' : 'none';
  $('cameraOverlay').hidden = false;
  $('cameraError').hidden = true;
  $('btnCameraShutter').disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: isSelfie ? 'user' : 'environment' }, audio: false });
    state.cameraStream = stream;
    const video = $('cameraVideo');
    video.srcObject = stream;
    await video.play();
    $('btnCameraShutter').disabled = false;
  } catch {
    $('cameraError').hidden = false;
    $('cameraError').textContent = isSelfie
      ? 'Could not access the camera. Check permissions, or use Upload Photo instead.'
      : 'Could not access the camera. Check permissions, or use Upload Document instead.';
  }
}

function closeCamera() {
  state.cameraStream?.getTracks().forEach((track) => track.stop());
  state.cameraStream = null;
  $('cameraOverlay').hidden = true;
}

$('btnCameraShutter').addEventListener('click', () => {
  const video = $('cameraVideo');
  const scale = Math.min(1, MAX_SOURCE_IMAGE_DIM / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', SOURCE_IMAGE_QUALITY);
  if (state.cameraMode === 'identity') {
    closeCamera();
    applyIdentityPhoto(dataUrl);
    return;
  }
  if (state.cameraMode === 'read') {
    state.readImages.push({ dataUrl, mimeType: 'image/jpeg' });
    closeCamera();
    renderReadPreview();
    return;
  }
  const capturedImage = { dataUrl, mimeType: 'image/jpeg' };
  state.sourceImages.push(capturedImage);
  closeCamera();
  renderSourcePreview();
  updateContinueGating();
  checkAddedImagesLegibility([capturedImage]);
});

/* ============ Read Aloud ============ */
// Photo(s) of a page -> transcribe-page Edge Function (Gemini vision, BYOK
// same as Create's photo flow) -> plain text -> chunked (Azure's REST TTS
// endpoint caps SSML input well under this) -> text-to-speech Edge Function
// per chunk (shared server-side Azure Cognitive Services Speech key, stays
// inside the free F0 500K-chars/month tier) -> played back as a queue so a
// long chapter starts playing after the first chunk instead of waiting on
// the whole thing, with the next chunk prefetched in the background while
// the current one plays.

// Textbook pages are often bilingual (English body text with a Tagalog
// passage, or vice versa), so language is detected per CHUNK, not once for
// the whole page -- an English voice reads Tagalog text in an English
// accent (and the reverse sounds just as wrong), so each chunk gets whichever
// voice actually matches it.
const READ_TTS_VOICE_EN = 'en-US-AndrewNeural';
const READ_TTS_VOICE_FIL = 'fil-PH-BlessicaNeural';
// Common Tagalog function words that essentially never appear in English
// running text -- cheap and reliable without pulling in a language-ID
// library for what's ultimately a two-way choice.
const TAGALOG_SIGNAL_WORDS = new Set([
  'ang', 'ng', 'mga', 'iyon', 'ito', 'siya', 'sila', 'tayo', 'kami', 'ikaw',
  'hindi', 'oo', 'opo', 'naman', 'lang', 'din', 'rin', 'yung', 'kasi', 'kung',
  'dahil', 'para', 'may', 'wala', 'paano', 'saan', 'bakit', 'sino', 'alin',
  'gaano', 'nang', 'niya', 'nila', 'natin', 'namin', 'kanila', 'atin',
  'sana', 'baka', 'lahat', 'bawat', 'dito', 'doon', 'kanina', 'ngayon',
  'bukas', 'kahapon', 'pati', 'bago', 'pagkatapos',
]);

function detectChunkVoice(text) {
  const words = (text.toLowerCase().match(/[a-zà-ÿ']+/g) || []);
  if (!words.length) return READ_TTS_VOICE_EN;
  const hits = words.reduce((n, w) => n + (TAGALOG_SIGNAL_WORDS.has(w) ? 1 : 0), 0);
  return (hits / words.length) >= 0.08 ? READ_TTS_VOICE_FIL : READ_TTS_VOICE_EN;
}

const READ_CHUNK_MAX_BYTES = 3500; // safety margin under Azure's per-request cap

$('btnReadUpload').addEventListener('click', () => $('readFileInput').click());
$('readFileInput').addEventListener('change', async (event) => {
  const files = Array.from(event.target.files || []);
  const loaded = await Promise.all(files.map(async (file) => ({ dataUrl: await resizeImageDataUrl(await fileToDataUrl(file)), mimeType: 'image/jpeg' })));
  state.readImages.push(...loaded);
  event.target.value = '';
  renderReadPreview();
});
$('btnReadCamera').addEventListener('click', () => openCamera('read'));

function renderReadPreview() {
  const row = $('readPreviewRow');
  if (!state.readImages.length) { row.hidden = true; row.innerHTML = ''; }
  else {
    row.hidden = false;
    row.innerHTML = state.readImages.map((img, i) => `
      <div class="source-preview-thumb">
        <img src="${img.dataUrl}" alt="Page ${i + 1}">
        <button type="button" class="source-preview-remove js-remove-read-image" data-index="${i}" aria-label="Remove image">✕</button>
      </div>
    `).join('');
    row.querySelectorAll('.js-remove-read-image').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.readImages.splice(Number(btn.dataset.index), 1);
        renderReadPreview();
      });
    });
  }
  $('btnReadTranscribe').disabled = state.readImages.length === 0;
}

function splitTextIntoChunks(text, maxBytes) {
  const encoder = new TextEncoder();
  const sentences = text.replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]*\s*|[^.!?]+$/g) || [text];
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    const candidate = current ? current + sentence : sentence;
    if (encoder.encode(candidate).length > maxBytes && current) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function beginReadSession(text) {
  state.readText = text;
  state.readChunks = splitTextIntoChunks(text, READ_CHUNK_MAX_BYTES);
  state.readAudioCache = {};
  state.readChunkIndex = 0;
  state.readIsPlaying = false;
  $('readTranscriptArea').value = state.readText;
  $('readPlayerStatus').textContent = `Ready to play — ${state.readChunks.length} part${state.readChunks.length === 1 ? '' : 's'}.`;
  $('btnReadPlayPause').textContent = '▶ Play';
  $('readCaptureSection').hidden = true;
  $('readResultSection').hidden = false;
}

$('btnReadTranscribe').addEventListener('click', async () => {
  if (!state.readImages.length) return;
  if (!state.geminiApiKeys.length) { alert('Add your Gemini API key in Profile first.'); return; }
  $('readCaptureSection').hidden = true;
  $('readLoadingCard').hidden = false;
  $('readLoadingText').textContent = 'Reading the page…';
  try {
    const data = await callWithKeyRotation('transcribe-page', {
      images: state.readImages.map((img) => ({ dataUrl: img.dataUrl, mimeType: img.mimeType })),
    });
    $('readLoadingCard').hidden = true;
    beginReadSession(data.text);
  } catch (err) {
    $('readLoadingCard').hidden = true;
    $('readCaptureSection').hidden = false;
    alert(err.message || 'Could not read that page. Try again.');
  }
});

$('btnReadTypeText').addEventListener('click', () => {
  $('readTypedSection').hidden = false;
  $('readTypedInput').focus();
});

$('btnReadUseTypedText').addEventListener('click', () => {
  const text = $('readTypedInput').value.trim();
  if (!text) { alert('Type or paste some text first.'); return; }
  beginReadSession(text);
});

async function fetchChunkAudio(index) {
  if (state.readAudioCache[index]) return state.readAudioCache[index];
  const text = state.readChunks[index];
  const data = await callEdgeFunction('text-to-speech', { text, voice: detectChunkVoice(text) });
  state.readAudioCache[index] = data.audioContent;
  return data.audioContent;
}

function getReadAudioEl() {
  if (!state.readAudioEl) {
    state.readAudioEl = new Audio();
    state.readAudioEl.addEventListener('ended', () => {
      playReadChunk(state.readChunkIndex + 1);
    });
  }
  return state.readAudioEl;
}

async function playReadChunk(index) {
  if (index >= state.readChunks.length) {
    state.readIsPlaying = false;
    state.readChunkIndex = 0;
    $('btnReadPlayPause').textContent = '▶ Play';
    $('readPlayerStatus').textContent = `Finished — ${state.readChunks.length} part${state.readChunks.length === 1 ? '' : 's'}.`;
    return;
  }
  state.readChunkIndex = index;
  state.readIsPlaying = true;
  $('btnReadPlayPause').textContent = '⏸ Pause';
  $('readPlayerStatus').textContent = `Loading part ${index + 1} of ${state.readChunks.length}…`;
  try {
    const audioContent = await fetchChunkAudio(index);
    if (!state.readIsPlaying || state.readChunkIndex !== index) return; // stopped/paused while loading
    const audio = getReadAudioEl();
    audio.src = `data:audio/mp3;base64,${audioContent}`;
    await audio.play();
    $('readPlayerStatus').textContent = `Playing part ${index + 1} of ${state.readChunks.length}…`;
    if (index + 1 < state.readChunks.length) fetchChunkAudio(index + 1).catch(() => {});
  } catch (err) {
    state.readIsPlaying = false;
    $('btnReadPlayPause').textContent = '▶ Play';
    $('readPlayerStatus').textContent = err.message || 'Could not play audio.';
  }
}

$('btnReadPlayPause').addEventListener('click', () => {
  if (state.readIsPlaying) {
    getReadAudioEl().pause();
    state.readIsPlaying = false;
    $('btnReadPlayPause').textContent = '▶ Play';
    $('readPlayerStatus').textContent = `Paused — part ${state.readChunkIndex + 1} of ${state.readChunks.length}.`;
  } else if (state.readAudioEl && state.readAudioEl.src && state.readAudioEl.currentTime > 0 && !state.readAudioEl.ended) {
    state.readIsPlaying = true;
    $('btnReadPlayPause').textContent = '⏸ Pause';
    getReadAudioEl().play();
    $('readPlayerStatus').textContent = `Playing part ${state.readChunkIndex + 1} of ${state.readChunks.length}…`;
  } else {
    playReadChunk(state.readChunkIndex);
  }
});

$('btnReadStop').addEventListener('click', () => {
  if (state.readAudioEl) { state.readAudioEl.pause(); state.readAudioEl.currentTime = 0; }
  state.readIsPlaying = false;
  state.readChunkIndex = 0;
  $('btnReadPlayPause').textContent = '▶ Play';
  $('readPlayerStatus').textContent = `Ready to play — ${state.readChunks.length} part${state.readChunks.length === 1 ? '' : 's'}.`;
});

$('btnReadStartOver').addEventListener('click', () => {
  if (state.readAudioEl) { state.readAudioEl.pause(); state.readAudioEl.src = ''; }
  state.readImages = [];
  state.readText = '';
  state.readChunks = [];
  state.readAudioCache = {};
  state.readChunkIndex = 0;
  state.readIsPlaying = false;
  renderReadPreview();
  $('readTypedInput').value = '';
  $('readTypedSection').hidden = true;
  $('readResultSection').hidden = true;
  $('readCaptureSection').hidden = false;
});

/* ============ Student Identity ============ */
// Collected on first launch (mandatory, no close button -- see the init
// block near the bottom of this file) and reopened, pre-filled, from
// Profile > Student Identity for edits (closable). Same modal, same save
// path both times. Photo comes from either Upload Photo (gallery) or Take
// Selfie (openCamera('identity') above, front camera) -- both funnel into
// applyIdentityPhoto() so there's one resize/preview path regardless of
// source, exactly like state.sourceImages does for document photos.

let identityDraftPhotoDataUrl = null;

function identityPlaceholderAvatarSvg(size) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" /></svg>`;
}

async function applyIdentityPhoto(rawDataUrl) {
  // Small square-ish avatar -- doesn't need document-scan resolution.
  identityDraftPhotoDataUrl = await resizeImageDataUrl(rawDataUrl, 480, 0.85);
  renderIdentityPhotoPreview();
}

function renderIdentityPhotoPreview() {
  $('identityPhotoPreview').innerHTML = identityDraftPhotoDataUrl
    ? `<img src="${identityDraftPhotoDataUrl}" alt="Student photo">`
    : identityPlaceholderAvatarSvg(30);
}

function openStudentIdentityModal(mandatory) {
  const id = state.studentIdentity || {};
  identityDraftPhotoDataUrl = id.photoDataUrl || null;
  $('identitySurname').value = id.surname || '';
  $('identityGivenName').value = id.givenName || '';
  $('identityMiddleName').value = id.middleName || '';
  $('identityAge').value = id.age || '';
  $('identitySchool').value = id.school || '';
  $('identityGradeLevel').value = id.gradeLevel || '';
  $('identitySection').value = id.section || '';
  $('identityAdviser').value = id.adviser || '';
  $('identityAddress').value = id.address || '';
  $('identityContactNumber').value = id.contactNumber || '';
  $('identityEmail').value = id.email || '';
  $('identityGuardianName').value = id.guardianName || '';
  renderIdentityPhotoPreview();
  $('identityModalError').hidden = true;
  $('identityModalSub').textContent = mandatory
    ? "Welcome! Tell us who you are so your exams and results are labeled correctly."
    : 'Update your details below.';
  $('btnIdentityClose').hidden = mandatory;
  // Always reset to the manual-entry view on open -- a previous "Restore
  // via Digital ID" attempt shouldn't leave that form showing next time.
  $('identityFormBody').hidden = false;
  $('identityRestoreSection').hidden = true;
  $('identityRestoreId').value = '';
  $('identityRestorePin').value = '';
  $('identityRestoreError').hidden = true;
  $('identityModal').hidden = false;
}

function renderStudentIdentityCard() {
  const id = state.studentIdentity;
  const avatar = $('identitySummaryAvatar');
  const hasName = id && (id.surname || id.givenName);
  if (hasName) {
    const fullName = [id.givenName, id.middleName, id.surname].filter(Boolean).join(' ');
    $('identitySummaryName').textContent = fullName || 'Student';
    const metaParts = [id.gradeLevel, id.section, id.school].filter(Boolean);
    $('identitySummaryMeta').textContent = metaParts.length ? metaParts.join(' • ') : 'Tap Edit to complete your profile.';
    avatar.innerHTML = id.photoDataUrl ? `<img src="${id.photoDataUrl}" alt="${esc(fullName)}">` : identityPlaceholderAvatarSvg(22);
  } else {
    $('identitySummaryName').textContent = 'Not set up yet';
    $('identitySummaryMeta').textContent = 'Add your details so your exams are labeled correctly.';
    avatar.innerHTML = identityPlaceholderAvatarSvg(22);
  }
}

$('btnIdentityUploadPhoto').addEventListener('click', () => $('identityPhotoInput').click());
$('identityPhotoInput').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  applyIdentityPhoto(await fileToDataUrl(file));
});
$('btnIdentityTakeSelfie').addEventListener('click', () => openCamera('identity'));

$('btnIdentityClose').addEventListener('click', () => { $('identityModal').hidden = true; });

$('btnIdentitySave').addEventListener('click', () => {
  const surname = $('identitySurname').value.trim();
  const givenName = $('identityGivenName').value.trim();
  if (!surname || !givenName) {
    $('identityModalError').textContent = 'Surname and Name are required.';
    $('identityModalError').hidden = false;
    return;
  }
  state.studentIdentity = {
    surname,
    givenName,
    middleName: $('identityMiddleName').value.trim(),
    age: $('identityAge').value.trim(),
    school: $('identitySchool').value.trim(),
    gradeLevel: $('identityGradeLevel').value.trim(),
    section: $('identitySection').value.trim(),
    adviser: $('identityAdviser').value.trim(),
    address: $('identityAddress').value.trim(),
    contactNumber: $('identityContactNumber').value.trim(),
    email: $('identityEmail').value.trim(),
    guardianName: $('identityGuardianName').value.trim(),
    photoDataUrl: identityDraftPhotoDataUrl || null,
  };
  saveStudentIdentity(state.studentIdentity);
  $('identityModal').hidden = true;
  renderStudentIdentityCard();
  resolvePendingIdentityDeepLink();
});

// A Share & Track or Class Sessions deep link was waiting on the mandatory
// first-launch identity gate -- now that a real identity exists (whether
// from a manual Save above or a Digital ID restore), load it. No-op for
// the ordinary "edit identity from Profile" case, where both are null.
// Factored out so the Digital ID restore path (both inside the identity
// modal and from Profile) can resume a pending deep link too, not just a
// manual save.
function resolvePendingIdentityDeepLink() {
  if (state.pendingTrackedQuizId) {
    const id = state.pendingTrackedQuizId;
    state.pendingTrackedQuizId = null;
    loadTrackedQuizFromDeepLink(id);
  } else if (state.pendingClassSessionId) {
    const id = state.pendingClassSessionId;
    state.pendingClassSessionId = null;
    loadClassSessionFromDeepLink(id);
  }
}

$('btnIdentityShowRestore').addEventListener('click', () => {
  $('identityFormBody').hidden = true;
  $('identityRestoreSection').hidden = false;
});
$('btnIdentityShowManual').addEventListener('click', () => {
  $('identityRestoreSection').hidden = true;
  $('identityFormBody').hidden = false;
});

$('btnIdentityRestoreSubmit').addEventListener('click', async () => {
  const digitalId = $('identityRestoreId').value.trim();
  const pin = $('identityRestorePin').value;
  if (!digitalId || pin.length < 6) {
    $('identityRestoreError').textContent = 'Enter your Digital ID and PIN.';
    $('identityRestoreError').hidden = false;
    return;
  }
  const btn = $('btnIdentityRestoreSubmit');
  btn.disabled = true;
  btn.textContent = 'Restoring…';
  try {
    const data = await callEdgeFunction('restore-digital-id-backup', { digitalId, pin });
    applyBackupPayload(data.payload);
    state.digitalId = digitalId;
    saveDigitalIdLocally(digitalId);
    refreshDigitalIdUi();
    $('identityModal').hidden = true;
    resolvePendingIdentityDeepLink();
  } catch (e) {
    $('identityRestoreError').textContent = e.message || 'Could not restore this backup.';
    $('identityRestoreError').hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Restore My Identity & Library';
  }
});

$('btnEditStudentIdentity').addEventListener('click', () => openStudentIdentityModal(false));

// location.href, not window.open -- popups are unreliable in the native
// Android WebView without an extra Capacitor plugin; a same-tab navigation
// is the safe cross-platform choice.
$('btnInstructorLogin').addEventListener('click', () => { window.location.href = 'instructor.html'; });

/* ============ Image legibility check ============ */

async function checkImageLegibility(image) {
  return callWithKeyRotation('check-image-legibility', { dataUrl: image.dataUrl, mimeType: image.mimeType });
}

function showLegibilityModal(image, reason) {
  return new Promise((resolve) => {
    $('legibilityModalThumb').src = image.dataUrl;
    $('legibilityModalReason').textContent = reason || 'This image may be too unclear to generate accurate questions from.';
    $('legibilityModal').hidden = false;

    function onReupload() { cleanup('reupload'); }
    function onIgnore() { cleanup('ignore'); }
    function cleanup(result) {
      $('legibilityModal').hidden = true;
      $('btnLegibilityReupload').removeEventListener('click', onReupload);
      $('btnLegibilityIgnore').removeEventListener('click', onIgnore);
      resolve(result);
    }
    $('btnLegibilityReupload').addEventListener('click', onReupload);
    $('btnLegibilityIgnore').addEventListener('click', onIgnore);
  });
}

// Checks each newly-added source image in turn against Gemini, pausing
// (Continue to Configuration stays disabled -- see updateContinueGating)
// while a check is running or its warning modal is open, until the user
// removes the flagged image or explicitly ignores the warning. If the
// check itself can't run (no Gemini key yet, offline, API error), it fails
// open -- silently skips checking that image rather than blocking the user
// over a problem unrelated to the image's actual legibility.
async function checkAddedImagesLegibility(images) {
  if (!state.geminiApiKeys.length) return;
  for (const image of images) {
    if (!state.sourceImages.includes(image)) continue; // already removed by the user while an earlier check in this batch was running
    state.legibilityCheckPending = true;
    $('legibilityCheckingNote').hidden = false;
    updateContinueGating();

    let result = null;
    try {
      result = await checkImageLegibility(image);
    } catch (e) { /* couldn't verify -- not the image's fault, let it through */ }

    $('legibilityCheckingNote').hidden = true;
    if (result && !result.legible) {
      const choice = await showLegibilityModal(image, result.reason);
      if (choice === 'reupload') {
        const idx = state.sourceImages.indexOf(image);
        if (idx !== -1) state.sourceImages.splice(idx, 1);
        renderSourcePreview();
      }
    }
    state.legibilityCheckPending = false;
    updateContinueGating();
  }
}

/* ============ Create: configure step ============ */

function renderConfigureScreen() {
  $('typeCard').hidden = state.generationMode === 'auto';
  $('difficultyCard').hidden = state.generationMode === 'auto';
  $('btnGenerateExam').textContent = state.generationMode === 'auto' ? '⚡ Auto-Extract Exam (no AI)' : '✨ Generate Exam';

  $('typeList').innerHTML = QUESTION_TYPES.map((type) => {
    const active = state.config.types[type.key];
    return `
      <button type="button" class="type-option${active ? ' is-active' : ''}" data-key="${type.key}">
        <span class="type-option-icon" aria-hidden="true">${type.icon}</span>
        <span class="type-option-body">
          <span class="type-option-title">${type.title}</span>
          <span class="type-option-sub">${type.sub}</span>
        </span>
        <span class="type-checkbox${active ? ' is-checked' : ''}">${active ? '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>' : ''}</span>
      </button>
    `;
  }).join('');

  $('typeList').querySelectorAll('.type-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      state.config.types[key] = !state.config.types[key];
      renderConfigureScreen();
      updateGenerateGating();
    });
  });

  const difficultyIndex = DIFFICULTIES.findIndex((d) => d.key === state.config.difficulty);
  $('difficultySlider').value = difficultyIndex;
  $('difficultyLabels').innerHTML = DIFFICULTIES.map((d) => `
    <div class="difficulty-label${d.key === state.config.difficulty ? ' is-active' : ''}">
      <span class="difficulty-pill">${d.label.toUpperCase()}</span>
      <span class="difficulty-sub">${d.sub}</span>
    </div>
  `).join('');

  $('countValue').textContent = state.config.count;
  updateGenerateGating();
}

$('difficultySlider').addEventListener('input', (e) => {
  state.config.difficulty = DIFFICULTIES[Number(e.target.value)].key;
  renderConfigureScreen();
});

$('btnCountMinus').addEventListener('click', () => {
  state.config.count = Math.max(5, state.config.count - 1);
  $('countValue').textContent = state.config.count;
});
$('btnCountPlus').addEventListener('click', () => {
  state.config.count = Math.min(50, state.config.count + 1);
  $('countValue').textContent = state.config.count;
});

function updateGenerateGating() {
  const note = $('configureEmptyNote');
  if (state.generationMode === 'auto') {
    const hasText = state.sourceText.trim().length > 0;
    $('btnGenerateExam').disabled = !hasText;
    note.hidden = hasText;
    if (!hasText) note.textContent = 'Paste some text first — Auto-Extract only reads pasted text, not images.';
    return;
  }
  const selectedCount = Object.values(state.config.types).filter(Boolean).length;
  const hasSource = state.sourceImages.length > 0 || state.sourceText.trim().length > 0;
  const missingKey = !state.geminiApiKeys.length;
  const canGenerate = selectedCount > 0 && hasSource && !missingKey;
  $('btnGenerateExam').disabled = !canGenerate;
  if (canGenerate) {
    note.hidden = true;
  } else {
    note.hidden = false;
    note.textContent = missingKey
      ? 'Add your Gemini API key in Profile to use AI Generate.'
      : selectedCount === 0 ? 'Pick at least one question type.' : 'Add source material on the previous screen first.';
  }
}

$('btnGenerateExam').addEventListener('click', () => {
  if (state.generationMode === 'auto') runAutoExtract();
  else runGeneration();
});
$('btnBackToConfigure').addEventListener('click', () => showCreateStep('configure'));

/* ============ Generation ============ */

const GENERATING_MESSAGES = [
  'Reading your source material…',
  'Identifying key concepts…',
  'Drafting questions…',
  'Balancing difficulty…',
  'Finalizing your exam…',
];
let generatingMessageTimer = null;

function typesToList(types) {
  return Object.entries(types).filter(([, enabled]) => enabled).map(([key]) => key);
}

function parseDataUrlMime(dataUrl, fallback) {
  const match = /^data:([^;]+);base64,/.exec(dataUrl);
  return match ? match[1] : fallback;
}

async function callEdgeFunction(name, body) {
  const url = `${SUPABASE_URL}/functions/v1/${name}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Request to ${name} failed.`);
  return data;
}

async function runGeneration() {
  showCreateStep('generating');
  $('generatingErrorCard').hidden = true;
  $('btnBackToConfigure').hidden = true;
  $('generatingSpinner').hidden = false;

  let messageIndex = 0;
  $('generatingMessage').textContent = GENERATING_MESSAGES[0];
  generatingMessageTimer = setInterval(() => {
    messageIndex = (messageIndex + 1) % GENERATING_MESSAGES.length;
    $('generatingMessage').textContent = GENERATING_MESSAGES[messageIndex];
  }, 1600);

  try {
    const data = await callWithKeyRotation('generate-quiz', {
      examTitle: state.examTitle,
      subject: state.subject,
      images: state.sourceImages.map((img) => ({ dataUrl: img.dataUrl, mimeType: parseDataUrlMime(img.dataUrl, img.mimeType) })),
      text: state.sourceText,
      topicMode: state.generationMode === 'topic',
      questionTypes: typesToList(state.config.types),
      difficulty: state.config.difficulty,
      count: state.config.count,
    });

    if (!data?.questions?.length) {
      throw new Error(state.generationMode === 'topic'
        ? 'The AI did not return any questions. Try a clearer or more specific topic.'
        : 'The AI did not return any questions. Try again with clearer source material.');
    }

    data.timeLimitMinutes = Number($('timeLimitInput').value) || 0;
    state.quiz = data;
    clearInterval(generatingMessageTimer);
    saveGeneratedQuizAndReturnToLibrary();
  } catch (err) {
    clearInterval(generatingMessageTimer);
    $('generatingSpinner').hidden = true;
    $('generatingMessage').textContent = '';
    $('generatingErrorCard').hidden = false;
    if (err.allKeysExhausted) {
      $('generatingErrorText').innerHTML = `${esc(err.message)} <a href="#" class="js-goto-profile-link">Add another key</a> or check the failing one(s) at <a href="#" class="js-goto-aistudio-link">aistudio.google.com/apikey</a>.`;
      const link = $('generatingErrorText').querySelector('.js-goto-profile-link');
      link?.addEventListener('click', (e) => { e.preventDefault(); switchTab('profile'); });
      const aistudioLink = $('generatingErrorText').querySelector('.js-goto-aistudio-link');
      aistudioLink?.addEventListener('click', (e) => { e.preventDefault(); openGoogleUrlWithAccountChooser('https://aistudio.google.com/apikey'); });
    } else {
      $('generatingErrorText').textContent = err.message || 'Something went wrong generating the exam.';
    }
    $('btnBackToConfigure').hidden = false;
  }
}

/* ============ Auto-Extract (no AI) ============ */

const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'this', 'that', 'these', 'those', 'it', 'its', 'as', 'by', 'from', 'into', 'than', 'then', 'which', 'who', 'whom', 'their', 'his', 'her', 'they', 'he', 'she', 'we', 'you', 'i']);

function extractSentences(text) {
  return text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 25 && s.length < 240);
}

function pickKeyTerm(sentence) {
  const words = sentence.replace(/[.,!?;:'"()]/g, '').split(' ').filter(Boolean);
  const numberMatch = words.find((w) => /^\d[\d,.]*$/.test(w));
  if (numberMatch) return numberMatch;
  const capMatch = words.find((w, i) => i > 0 && /^[A-Z][a-z]{2,}/.test(w));
  if (capMatch) return capMatch;
  const candidates = words.filter((w) => w.length > 5 && !STOPWORDS.has(w.toLowerCase()));
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0] || null;
}

function runAutoExtract() {
  const sentences = extractSentences(state.sourceText);
  const seen = new Set();
  const questions = [];

  for (const sentence of sentences) {
    if (questions.length >= state.config.count) break;
    const term = pickKeyTerm(sentence);
    if (!term || seen.has(term.toLowerCase())) continue;
    const blanked = sentence.replace(term, '_____');
    if (blanked === sentence) continue;
    seen.add(term.toLowerCase());
    questions.push({
      id: `q${questions.length + 1}`,
      type: 'identification',
      prompt: `Fill in the blank: ${blanked}`,
      correctAnswer: term,
      acceptableAnswers: [term],
      explanation: sentence,
    });
  }

  if (!questions.length) {
    $('configureEmptyNote').hidden = false;
    $('configureEmptyNote').textContent = 'Could not find enough factual sentences to build questions. Try pasting more detailed text, or use Manual Build instead.';
    return;
  }

  state.quiz = { questions, examTitle: state.examTitle, subject: state.subject, difficulty: 'auto', timeLimitMinutes: Number($('timeLimitInput').value) || 0 };
  saveGeneratedQuizAndReturnToLibrary();
}

/* ============ Manual Build (no AI) ============ */

function renderManualTypeFields() {
  const type = $('manualTypeSelect').value;
  const box = $('manualTypeFields');
  if (type === 'multipleChoice') {
    box.innerHTML = `
      <div class="field-block">
        <span class="field-label">Choices (select the correct one)</span>
        ${[0, 1, 2, 3].map((i) => `
          <div class="manual-choice-row">
            <input type="radio" name="manualMcCorrect" value="${i}" id="manualMcCorrect${i}" ${i === 0 ? 'checked' : ''}>
            <input type="text" class="text-input" id="manualChoice${i}" placeholder="Choice ${i + 1}">
          </div>
        `).join('')}
      </div>`;
  } else if (type === 'trueFalse') {
    box.innerHTML = `
      <label class="field-block">
        <span class="field-label">Correct Answer</span>
        <select class="select-input" id="manualTfCorrect">
          <option value="True">True</option>
          <option value="False">False</option>
        </select>
      </label>`;
  } else if (type === 'identification') {
    box.innerHTML = `
      <label class="field-block">
        <span class="field-label">Correct Answer</span>
        <input type="text" class="text-input" id="manualIdCorrect" placeholder="e.g. Mitochondria">
      </label>
      <label class="field-block">
        <span class="field-label">Other Acceptable Answers (comma-separated, optional)</span>
        <input type="text" class="text-input" id="manualIdAlt" placeholder="e.g. mitochondrion">
      </label>`;
  } else if (type === 'matching') {
    box.innerHTML = `
      <div class="field-block">
        <span class="field-label">Matching Pairs (leave a row blank to skip it)</span>
        ${[0, 1, 2, 3].map((i) => `
          <div class="manual-choice-row">
            <input type="text" class="text-input" id="manualMatchLeft${i}" placeholder="Item ${i + 1}">
            <input type="text" class="text-input" id="manualMatchRight${i}" placeholder="Match ${i + 1}">
          </div>
        `).join('')}
      </div>`;
  } else {
    box.innerHTML = `
      <label class="field-block">
        <span class="field-label">Correct Numeric Answer</span>
        <input type="text" inputmode="decimal" class="text-input" id="manualCalcCorrect" placeholder="e.g. 42">
      </label>`;
  }
}

$('manualTypeSelect').addEventListener('change', renderManualTypeFields);

function renderManualBuilder() {
  renderManualTypeFields();
  renderManualQuestionList();
}

function renderManualQuestionList() {
  $('manualQuestionCount').textContent = state.manualQuestions.length;
  $('manualEmptyNote').hidden = state.manualQuestions.length > 0;
  $('manualQuestionList').innerHTML = state.manualQuestions.map((q, i) => `
    <div class="card result-item">
      <p class="result-item-index">${TYPE_LABELS[q.type]}</p>
      <p class="question-prompt">${esc(q.prompt)}</p>
      <button type="button" class="link-btn js-remove-manual" data-index="${i}">Remove</button>
    </div>
  `).join('');
  $('manualQuestionList').querySelectorAll('.js-remove-manual').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.manualQuestions.splice(Number(btn.dataset.index), 1);
      renderManualQuestionList();
    });
  });
  $('btnStartManualExam').disabled = state.manualQuestions.length === 0;
}

$('btnAddManualQuestion').addEventListener('click', () => {
  const type = $('manualTypeSelect').value;
  const prompt = $('manualPromptInput').value.trim();
  const explanation = $('manualExplanationInput').value.trim();
  if (!prompt) { $('manualPromptInput').focus(); return; }

  const question = { id: `q${state.manualQuestions.length + 1}`, type, prompt, explanation };

  if (type === 'multipleChoice') {
    const choices = [0, 1, 2, 3].map((i) => $(`manualChoice${i}`).value.trim());
    if (choices.some((c) => !c)) return;
    const correctIndex = Number(document.querySelector('input[name="manualMcCorrect"]:checked').value);
    question.choices = choices;
    question.correctAnswer = choices[correctIndex];
  } else if (type === 'trueFalse') {
    question.choices = ['True', 'False'];
    question.correctAnswer = $('manualTfCorrect').value;
  } else if (type === 'identification') {
    const correct = $('manualIdCorrect').value.trim();
    if (!correct) return;
    const alt = $('manualIdAlt').value.split(',').map((s) => s.trim()).filter(Boolean);
    question.correctAnswer = correct;
    question.acceptableAnswers = [correct, ...alt];
  } else if (type === 'matching') {
    const pairs = [0, 1, 2, 3]
      .map((i) => ({ left: $(`manualMatchLeft${i}`).value.trim(), right: $(`manualMatchRight${i}`).value.trim() }))
      .filter((p) => p.left && p.right);
    if (pairs.length < 2) return; // a matching exercise needs at least 2 pairs to mean anything
    question.pairs = pairs;
  } else if (type === 'calculation') {
    const correct = $('manualCalcCorrect').value.trim();
    if (!correct || Number.isNaN(parseFloat(correct))) return;
    question.correctAnswer = correct;
  }

  state.manualQuestions.push(question);
  $('manualPromptInput').value = '';
  $('manualExplanationInput').value = '';
  if (type === 'multipleChoice') [0, 1, 2, 3].forEach((i) => { $(`manualChoice${i}`).value = ''; });
  if (type === 'identification') { $('manualIdCorrect').value = ''; $('manualIdAlt').value = ''; }
  if (type === 'matching') [0, 1, 2, 3].forEach((i) => { $(`manualMatchLeft${i}`).value = ''; $(`manualMatchRight${i}`).value = ''; });
  if (type === 'calculation') { $('manualCalcCorrect').value = ''; }
  renderManualQuestionList();
});

$('btnStartManualExam').addEventListener('click', () => {
  state.quiz = { questions: state.manualQuestions, examTitle: state.examTitle, subject: state.subject, difficulty: 'manual', timeLimitMinutes: Number($('manualTimeLimitInput').value) || 0 };
  saveGeneratedQuizAndReturnToLibrary();
});

// "(2)", "(3)", etc. -- same disambiguation convention as a file manager
// offering a name for a duplicated file, so a saved-as-new-copy exam is
// distinguishable from the original at a glance without forcing the user
// to type a new title themselves first.
function uniqueExamTitle(baseTitle, excludeId) {
  const taken = new Set(LIBRARY_EXAMS.filter((e) => e.id !== excludeId).map((e) => e.title));
  if (!taken.has(baseTitle)) return baseTitle;
  let n = 2;
  while (taken.has(`${baseTitle} (${n})`)) n++;
  return `${baseTitle} (${n})`;
}

// Edit-mode only: saves the current edits as a brand new library entry
// instead of overwriting the one being edited, so the original stays
// intact. Title auto-disambiguated ("(2)", "(3)"...) if it would otherwise
// collide with the original or any other existing exam.
$('btnSaveAsNewCopy').addEventListener('click', () => {
  const originalId = state.currentLibraryId;
  state.examTitle = uniqueExamTitle((state.examTitle || 'Untitled Exam').trim() || 'Untitled Exam', originalId);
  state.currentLibraryId = null; // force a fresh insert rather than upserting into the entry being edited
  state.quiz = { questions: state.manualQuestions, examTitle: state.examTitle, subject: state.subject, difficulty: 'manual', timeLimitMinutes: Number($('manualTimeLimitInput').value) || 0 };
  saveGeneratedQuizAndReturnToLibrary();
});

// Edit-mode only: asks Gemini for a fresh set of questions using the
// CURRENT questions' prompts as pseudo-source material (there's no saved
// original source text/images to regenerate from -- only the questions
// themselves ever get saved), landing back in the Manual Builder for
// review/editing rather than auto-saving, so a bad regeneration is never
// silently substituted for a good exam.
$('btnRegenerateQuiz').addEventListener('click', async () => {
  if (!state.manualQuestions.length) { alert('Add or load at least one question first -- regeneration needs something to work from.'); return; }
  if (!state.geminiApiKeys.length) { alert('Add your Gemini API key in Profile first.'); return; }

  const btn = $('btnRegenerateQuiz');
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Regenerating…';

  try {
    const pseudoSourceText = state.manualQuestions
      .map((q) => [q.prompt, q.correctAnswer ? `(answer: ${q.correctAnswer})` : ''].filter(Boolean).join(' '))
      .join('\n');
    const typesPresent = [...new Set(state.manualQuestions.map((q) => q.type))];
    const data = await callWithKeyRotation('generate-quiz', {
      examTitle: state.examTitle,
      subject: state.subject,
      images: [],
      text: pseudoSourceText,
      questionTypes: typesPresent.length ? typesPresent : ['multipleChoice'],
      difficulty: 'medium',
      count: state.manualQuestions.length,
    });
    if (!data?.questions?.length) throw new Error('The AI did not return any questions.');
    state.manualQuestions = data.questions;
    renderManualQuestionList();
  } catch (err) {
    alert(`Could not regenerate: ${err.message || 'something went wrong.'}`);
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
});

/* ============ Quiz runner ============ */

// Countdown timer, shown top-center during the quiz. Deliberately starts
// counting from the moment the FIRST answer is given, not the moment the
// quiz screen opens -- reading the first question shouldn't burn timed
// minutes. Not persisted across a close/reopen (state.quizTimerStartedAt
// lives only in memory): resuming a timed draft in a later session starts
// the countdown fresh rather than trying to track real-world elapsed time
// while the app was closed, which would need its own separate design
// (and arguably isn't what "time limit" means for a resumable draft).
let quizTimerInterval = null;

function stopQuizTimer() {
  if (quizTimerInterval) { clearInterval(quizTimerInterval); quizTimerInterval = null; }
}

function startQuizTimerIfNeeded() {
  if (state.quizTimerStartedAt || !state.quiz || !state.quiz.timeLimitMinutes) return;
  state.quizTimerStartedAt = Date.now();
  stopQuizTimer();
  quizTimerInterval = setInterval(tickQuizTimer, 1000);
  tickQuizTimer();
}

function tickQuizTimer() {
  if (!state.quiz || !state.quiz.timeLimitMinutes || !state.quizTimerStartedAt) return;
  const totalSeconds = state.quiz.timeLimitMinutes * 60;
  const remaining = totalSeconds - Math.floor((Date.now() - state.quizTimerStartedAt) / 1000);
  const timerEl = $('quizTimer');
  if (remaining <= 0) {
    stopQuizTimer();
    timerEl.textContent = "Time's up!";
    timerEl.classList.add('is-low');
    if (!state.isQuizComplete) {
      alert("Time's up! Submitting your answers now.");
      renderResults(true);
      showCreateStep('results');
    }
    return;
  }
  const mm = Math.floor(remaining / 60);
  const ss = remaining % 60;
  timerEl.textContent = `⏱ ${mm}:${String(ss).padStart(2, '0')}`;
  timerEl.classList.toggle('is-low', remaining <= 60);
}

// Live "N/total correct" shown top-right during the quiz -- only objective
// (instantly-gradable) questions the user has actually answered contribute
// to the numerator; essay questions can't be scored without an AI call, so
// they're excluded rather than silently counted as wrong.
function updateLiveQuizScore() {
  const questions = state.quiz.questions;
  const correct = questions.filter((q) => {
    const a = state.answers[q.id];
    return isObjectiveType(q.type) && isAnswered(q, a) && gradeObjectiveQuestion(q, a);
  }).length;
  $('quizLiveScore').textContent = `${correct}/${questions.length}`;
}

// Scratchpad for calculation questions -- a real freehand drawing surface
// to work a problem out on before typing the final answer into the actual
// input below it, not fed into grading at all. Fresh/blank on every
// question render (drawings intentionally don't persist across
// navigation or save -- it's scratch work, not exam content).
const SCRATCHPAD_COLORS = ['#12172B', '#E0455C', '#F07824', '#22B27D'];

function scratchpadHtml() {
  return `
    <div class="scratchpad-card">
      <div class="scratchpad-mode-tabs">
        <button type="button" class="scratchpad-mode-tab is-active" data-mode="draw">✎ Free Write</button>
        <button type="button" class="scratchpad-mode-tab" data-mode="grid">▦ Grid Solve</button>
      </div>

      <div class="scratchpad-pad" data-pad="draw">
        <div class="scratchpad-toolbar">
          <div class="scratchpad-colors">
            ${SCRATCHPAD_COLORS.map((c, i) => `<button type="button" class="scratchpad-swatch${i === 0 ? ' is-active' : ''}" data-color="${c}" style="background:${c}" aria-label="Color"></button>`).join('')}
            <button type="button" class="scratchpad-tool is-active" data-tool="pen" aria-label="Pen">✎</button>
            <button type="button" class="scratchpad-tool" data-tool="eraser" aria-label="Eraser">🧹</button>
            <button type="button" class="scratchpad-tool" data-tool="pan" aria-label="Pan/drag">✋</button>
          </div>
          <input type="range" min="1" max="16" value="3" class="scratchpad-thickness" id="scratchpadThickness" aria-label="Line thickness">
          <div class="scratchpad-actions">
            <button type="button" class="count-btn" id="btnScratchpadZoomOut" aria-label="Zoom out">−</button>
            <button type="button" class="count-btn" id="btnScratchpadZoomExtent" aria-label="Reset zoom">⤢</button>
            <button type="button" class="count-btn" id="btnScratchpadZoomIn" aria-label="Zoom in">+</button>
            <button type="button" class="count-btn" id="btnScratchpadFullscreen" aria-label="Fullscreen">⛶</button>
            <button type="button" class="count-btn" id="btnScratchpadClear" aria-label="Clear">🗑</button>
          </div>
        </div>
        <div class="scratchpad-viewport" id="scratchpadViewport">
          <canvas id="scratchpadCanvas" width="1000" height="600"></canvas>
          <button type="button" class="scratchpad-fs-close" id="btnScratchpadFsClose">✕ Exit fullscreen</button>
        </div>
      </div>

      <div class="scratchpad-pad" data-pad="grid" hidden>
        ${gridPadHtml()}
      </div>
    </div>`;
}

// Grid Solve -- a column-arithmetic pad (one digit/symbol per cell) for
// working a problem out by hand instead of freehand drawing. The "Borrow"
// tool turns press-and-hold on a digit into the classic paper-subtraction
// gesture: the held digit drops by 1 and turns the danger color (it "lent
// out" a unit), and the digit immediately to its right gets a small raised
// 1 pinned to its upper-left (the borrowed ten arriving there) -- holding
// an already-borrowed digit again undoes exactly that, restoring its
// original value so a wrong borrow isn't a dead end.
const GRIDPAD_COLS = 9;
const GRIDPAD_DEFAULT_ROWS = 5;
const GRIDPAD_ALLOWED = /[0-9,.+\-×÷=]/;

function gridPadRowHtml(row) {
  return `<div class="gridpad-row" data-row="${row}">${Array.from({ length: GRIDPAD_COLS }).map((_, col) => `
    <div class="gridpad-cell" data-row="${row}" data-col="${col}">
      <input type="text" class="gridpad-input" maxlength="1" inputmode="text" autocomplete="off" data-row="${row}" data-col="${col}">
    </div>`).join('')}</div>`;
}

function gridPadHtml() {
  const rows = Array.from({ length: GRIDPAD_DEFAULT_ROWS }).map((_, r) => gridPadRowHtml(r)).join('');
  return `
    <div class="gridpad-toolbar" id="gridpadToolbar">
      <div class="scratchpad-colors">
        <button type="button" class="scratchpad-tool is-active" data-gtool="type" aria-label="Type">✎</button>
        <button type="button" class="scratchpad-tool" data-gtool="borrow" aria-label="Borrow">↩</button>
      </div>
      <div class="scratchpad-actions">
        <button type="button" class="count-btn" id="btnGridAddRow" aria-label="Add row">+Row</button>
        <button type="button" class="count-btn" id="btnGridClear" aria-label="Clear grid">🗑</button>
      </div>
    </div>
    <p class="gridpad-hint" id="gridpadHint">Tap a cell to type a digit or symbol. Switch to ↩ Borrow, then press and hold a digit to borrow from it.</p>
    <div class="gridpad-grid" id="gridpadGrid">${rows}</div>`;
}

function setupScratchpad() {
  const canvas = $('scratchpadCanvas');
  const viewport = $('scratchpadViewport');
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  let tool = 'pen';
  let color = SCRATCHPAD_COLORS[0];
  let zoom = 1;
  let drawing = false;
  let lastPanX = 0;
  let lastPanY = 0;

  function canvasPoint(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / rect.width * canvas.width, y: (e.clientY - rect.top) / rect.height * canvas.height };
  }

  // touch-action:none on the canvas (needed so a finger drawing a line
  // doesn't also trigger the browser's native scroll/pinch-zoom) means
  // there was previously no way to move around a zoomed-in canvas by touch
  // at all -- only the +/-/reset buttons above. Pan is a third tool, not a
  // gesture, so it doesn't fight with normal drawing: pointer drag scrolls
  // the viewport instead of drawing only while it's selected.
  canvas.addEventListener('pointerdown', (e) => {
    drawing = true;
    canvas.setPointerCapture(e.pointerId);
    if (tool === 'pan') {
      lastPanX = e.clientX;
      lastPanY = e.clientY;
      return;
    }
    const p = canvasPoint(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    if (tool === 'pan') {
      viewport.scrollLeft -= (e.clientX - lastPanX);
      viewport.scrollTop -= (e.clientY - lastPanY);
      lastPanX = e.clientX;
      lastPanY = e.clientY;
      return;
    }
    const p = canvasPoint(e);
    ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = color;
    ctx.lineWidth = Number($('scratchpadThickness').value) * (tool === 'eraser' ? 3 : 1);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((evt) => canvas.addEventListener(evt, () => { drawing = false; }));

  $('scratchpadViewport').closest('.scratchpad-card').querySelectorAll('.scratchpad-swatch').forEach((btn) => {
    btn.addEventListener('click', () => {
      color = btn.dataset.color;
      tool = 'pen';
      $('scratchpadViewport').closest('.scratchpad-card').querySelectorAll('.scratchpad-swatch, .scratchpad-tool').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      $('scratchpadViewport').closest('.scratchpad-card').querySelector('.scratchpad-tool[data-tool="pen"]').classList.add('is-active');
      canvas.style.cursor = 'crosshair';
    });
  });
  $('scratchpadViewport').closest('.scratchpad-card').querySelectorAll('.scratchpad-tool').forEach((btn) => {
    btn.addEventListener('click', () => {
      tool = btn.dataset.tool;
      $('scratchpadViewport').closest('.scratchpad-card').querySelectorAll('.scratchpad-tool').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      canvas.style.cursor = tool === 'pan' ? 'grab' : 'crosshair';
    });
  });

  function applyZoom() {
    canvas.style.width = `${1000 * zoom}px`;
    canvas.style.height = `${600 * zoom}px`;
  }
  $('btnScratchpadZoomIn').addEventListener('click', () => { zoom = Math.min(3, zoom + 0.25); applyZoom(); });
  $('btnScratchpadZoomOut').addEventListener('click', () => { zoom = Math.max(0.5, zoom - 0.25); applyZoom(); });
  $('btnScratchpadZoomExtent').addEventListener('click', () => { zoom = 1; applyZoom(); viewport.scrollLeft = 0; viewport.scrollTop = 0; });
  $('btnScratchpadClear').addEventListener('click', () => { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); });

  function fitCanvasFullscreen() {
    const availW = window.innerWidth - 24;
    const availH = window.innerHeight - 24;
    const scale = Math.min(availW / canvas.width, availH / canvas.height);
    canvas.style.width = `${canvas.width * scale}px`;
    canvas.style.height = `${canvas.height * scale}px`;
  }
  function setFullscreen(on) {
    viewport.classList.toggle('is-fullscreen', on);
    document.body.classList.toggle('scratchpad-fs-lock', on);
    $('btnScratchpadFullscreen').textContent = on ? '⤡' : '⛶';
    if (on) fitCanvasFullscreen(); else applyZoom();
  }
  $('btnScratchpadFullscreen').addEventListener('click', () => setFullscreen(!viewport.classList.contains('is-fullscreen')));
  $('btnScratchpadFsClose').addEventListener('click', () => setFullscreen(false));
  window.addEventListener('resize', () => { if (viewport.classList.contains('is-fullscreen')) fitCanvasFullscreen(); });

  const card = viewport.closest('.scratchpad-card');
  card.querySelectorAll('.scratchpad-mode-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      card.querySelectorAll('.scratchpad-mode-tab').forEach((t) => t.classList.remove('is-active'));
      tab.classList.add('is-active');
      card.querySelectorAll('.scratchpad-pad').forEach((p) => { p.hidden = p.dataset.pad !== tab.dataset.mode; });
    });
  });

  setupGridPad();
}

function setupGridPad() {
  const grid = $('gridpadGrid');
  const hint = $('gridpadHint');
  let gtool = 'type';

  function cellAt(row, col) { return grid.querySelector(`.gridpad-cell[data-row="${row}"][data-col="${col}"]`); }
  function inputAt(row, col) { const cell = cellAt(row, col); return cell ? cell.querySelector('.gridpad-input') : null; }
  function isDigit(input) { return !!input && /^[0-9]$/.test(input.value); }

  function normalizeChar(ch) {
    if (ch === 'x' || ch === 'X' || ch === '*') return '×';
    if (ch === '/') return '÷';
    return ch;
  }

  function wireCell(cell) {
    const input = cell.querySelector('.gridpad-input');
    input.addEventListener('input', () => {
      let v = normalizeChar(input.value.slice(-1) || '');
      if (v && !GRIDPAD_ALLOWED.test(v)) v = '';
      input.value = v;
      if (v) {
        const next = inputAt(Number(input.dataset.row), Number(input.dataset.col) + 1);
        if (next) next.focus();
      }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !input.value) {
        const prev = inputAt(Number(input.dataset.row), Number(input.dataset.col) - 1);
        if (prev) prev.focus();
      }
    });

    let holdTimer = null;
    function flash() {
      cell.classList.add('gridpad-flash');
      setTimeout(() => cell.classList.remove('gridpad-flash'), 300);
    }
    function toggleBorrow() {
      const row = Number(cell.dataset.row), col = Number(cell.dataset.col);
      const rightCell = cellAt(row, col + 1);
      if (cell.classList.contains('is-borrowed')) {
        input.value = cell.dataset.preborrow || input.value;
        delete cell.dataset.preborrow;
        cell.classList.remove('is-borrowed');
        if (rightCell) rightCell.removeAttribute('data-carry');
        return;
      }
      if (!isDigit(input) || !rightCell || !isDigit(rightCell.querySelector('.gridpad-input'))) { flash(); return; }
      const val = Number(input.value);
      cell.dataset.preborrow = input.value;
      input.value = String(val === 0 ? 9 : val - 1);
      cell.classList.add('is-borrowed');
      rightCell.setAttribute('data-carry', '1');
    }
    cell.addEventListener('pointerdown', () => {
      if (gtool !== 'borrow') return;
      holdTimer = setTimeout(() => { toggleBorrow(); holdTimer = null; }, 500);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((evt) => {
      cell.addEventListener(evt, () => {
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; if (evt === 'pointerup' && gtool === 'borrow') flash(); }
      });
    });
  }

  function applyReadonlyState() {
    // Read-only while in Borrow mode so tapping a digit to hold it down
    // doesn't also pop the on-screen keyboard and fight the long-press.
    grid.querySelectorAll('.gridpad-input').forEach((input) => { input.readOnly = gtool === 'borrow'; });
  }

  grid.querySelectorAll('.gridpad-cell').forEach(wireCell);

  const toolbar = $('gridpadToolbar');
  toolbar.querySelectorAll('[data-gtool]').forEach((btn) => {
    btn.addEventListener('click', () => {
      gtool = btn.dataset.gtool;
      toolbar.querySelectorAll('[data-gtool]').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      hint.textContent = gtool === 'borrow'
        ? 'Press and hold a digit to borrow from it -- hold again to undo.'
        : 'Tap a cell to type a digit or symbol.';
      applyReadonlyState();
    });
  });

  let rowCount = GRIDPAD_DEFAULT_ROWS;
  $('btnGridAddRow').addEventListener('click', () => {
    grid.insertAdjacentHTML('beforeend', gridPadRowHtml(rowCount));
    grid.querySelectorAll(`.gridpad-cell[data-row="${rowCount}"]`).forEach(wireCell);
    applyReadonlyState();
    rowCount++;
  });
  $('btnGridClear').addEventListener('click', () => {
    grid.querySelectorAll('.gridpad-cell').forEach((cell) => {
      cell.classList.remove('is-borrowed');
      cell.removeAttribute('data-carry');
      delete cell.dataset.preborrow;
      cell.querySelector('.gridpad-input').value = '';
    });
  });
}

// Tappable question-number pills -- lets the user skip a hard question and
// come back to it later without paging through every question in between
// via Previous/Next, and makes it obvious at a glance which ones still
// need an answer (filled = answered, outlined = not, solid = current).
function renderQuizNav(total) {
  const row = $('quizNavRow');
  row.innerHTML = state.quiz.questions.map((q, i) => {
    const answered = isAnswered(q, state.answers[q.id]);
    const cls = ['quiz-nav-pill', i === state.quizIndex ? 'is-current' : (answered ? 'is-answered' : '')].filter(Boolean).join(' ');
    return `<button type="button" class="${cls}" data-index="${i}">${i + 1}</button>`;
  }).join('');
  row.querySelectorAll('.quiz-nav-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.quizIndex = Number(btn.dataset.index);
      renderQuizQuestion();
    });
  });
}

function renderQuizQuestion() {
  const question = state.quiz.questions[state.quizIndex];
  const total = state.quiz.questions.length;
  const progress = Math.round(((state.quizIndex + 1) / total) * 100);

  $('quizProgressFill').style.width = `${progress}%`;
  $('quizExamTitle').textContent = state.examTitle || 'Exam';
  $('quizProgressLabel').textContent = `Question ${state.quizIndex + 1} of ${total}`;
  $('questionTypeTag').textContent = TYPE_LABELS[question.type] || question.type;
  $('questionPrompt').textContent = question.prompt;
  updateLiveQuizScore();
  renderQuizNav(total);

  const timerEl = $('quizTimer');
  timerEl.hidden = !state.quiz.timeLimitMinutes;
  if (state.quiz.timeLimitMinutes && !state.quizTimerStartedAt) {
    // Not started yet -- show the full duration as a preview rather than
    // a blank/zeroed timer, so it's clear up front what the limit is.
    timerEl.textContent = `⏱ ${state.quiz.timeLimitMinutes}:00`;
    timerEl.classList.remove('is-low');
  }

  const answer = state.answers[question.id];
  const area = $('questionAnswerArea');
  const hasAnswer = isAnswered(question, answer);
  // "Show correct answer on wrong answers" -- locks the question the moment
  // it's answered wrong (not just displays a note off to the side): the
  // wrong choice can no longer be changed, only the correct one is made
  // clear, right on the question itself.
  const isWrong = hasAnswer && isObjectiveType(question.type) && !gradeObjectiveQuestion(question, answer);
  const locked = state.showCorrectAnswers && isWrong;

  if (question.type === 'multipleChoice' || question.type === 'trueFalse') {
    const options = (question.choices?.length ? question.choices : ['True', 'False']).map((c) => ({ value: c, label: c }));
    area.innerHTML = `<div class="choice-list">${options.map(({ value, label }) => {
      const isSelected = answer === value;
      const isCorrectChoice = locked && value === question.correctAnswer;
      const isWrongChoice = locked && isSelected && value !== question.correctAnswer;
      const cls = ['choice-option', isSelected ? 'is-selected' : '', isCorrectChoice ? 'is-correct' : '', isWrongChoice ? 'is-incorrect' : '', locked ? 'is-locked' : ''].filter(Boolean).join(' ');
      const radioCls = ['choice-radio', isSelected ? 'is-selected' : '', isCorrectChoice ? 'is-correct' : '', isWrongChoice ? 'is-incorrect' : ''].filter(Boolean).join(' ');
      return `<button type="button" class="${cls}" data-choice="${esc(value)}"${locked ? ' disabled' : ''}>
        <span class="${radioCls}"></span><span>${esc(label)}</span>
      </button>`;
    }).join('')}</div>`;
    if (!locked) {
      area.querySelectorAll('.choice-option').forEach((btn) => {
        btn.addEventListener('click', () => {
          state.answers[question.id] = btn.dataset.choice;
          startQuizTimerIfNeeded();
          renderQuizQuestion();
        });
      });
    }
  } else if (question.type === 'identification' || question.type === 'calculation') {
    const inputMode = question.type === 'calculation' ? ' inputmode="decimal"' : '';
    const placeholder = question.type === 'calculation' ? 'Enter a numeric answer' : 'Type your answer';
    const scratchpad = question.type === 'calculation' ? scratchpadHtml() : '';
    area.innerHTML = `${scratchpad}<input type="text"${inputMode} class="text-input${locked ? ' answer-input-locked' : ''}" id="answerInput" placeholder="${placeholder}" value="${esc(answer || '')}"${locked ? ' readonly' : ''}>`;
    if (question.type === 'calculation') setupScratchpad();
    if (!locked) {
      $('answerInput').addEventListener('input', (e) => { state.answers[question.id] = e.target.value; startQuizTimerIfNeeded(); updateLiveQuizScore(); });
      // Instant-choice types (above) lock the moment you click; a typed
      // answer can't grade until you're done typing -- blur (tabbing/
      // clicking away) is the natural "on the spot" moment for these.
      $('answerInput').addEventListener('blur', () => renderQuizQuestion());
    }
  } else if (question.type === 'matching') {
    const pairs = question.pairs || [];
    // Shuffled once per question (cached on the question object itself) so
    // the right-hand options don't visibly reorder themselves after every
    // dropdown change -- shuffled at all so the correct match isn't just
    // "whichever option is in the same row."
    if (!question._matchingOptions) question._matchingOptions = shuffleArray(pairs.map((p) => p.right));
    const rightOptions = question._matchingOptions;
    area.innerHTML = `<div class="matching-list">${pairs.map((pair, i) => {
      const selected = answer && answer[i];
      const pairCorrect = locked && selected === pair.right;
      const pairWrong = locked && selected && selected !== pair.right;
      const rowCls = ['matching-row', pairCorrect ? 'is-correct' : '', pairWrong ? 'is-incorrect' : ''].filter(Boolean).join(' ');
      return `<div class="${rowCls}">
        <span class="matching-left">${esc(pair.left)}</span>
        <select class="select-input matching-select" data-index="${i}"${locked ? ' disabled' : ''}>
          <option value="">Select match…</option>
          ${rightOptions.map((opt) => `<option value="${esc(opt)}"${selected === opt ? ' selected' : ''}>${esc(opt)}</option>`).join('')}
        </select>
      </div>`;
    }).join('')}</div>`;
    if (!locked) {
      area.querySelectorAll('.matching-select').forEach((sel) => {
        sel.addEventListener('change', (e) => {
          const current = state.answers[question.id] || {};
          state.answers[question.id] = { ...current, [Number(e.target.dataset.index)]: e.target.value };
          startQuizTimerIfNeeded();
          renderQuizQuestion();
        });
      });
    }
  } else {
    area.innerHTML = `<textarea class="text-input" id="answerInput" rows="6" placeholder="Write your answer…">${esc(answer || '')}</textarea>`;
    $('answerInput').addEventListener('input', (e) => { state.answers[question.id] = e.target.value; startQuizTimerIfNeeded(); });
  }

  $('btnQuizPrev').disabled = state.quizIndex === 0;
  $('btnQuizNext').textContent = state.quizIndex < total - 1 ? 'Next' : 'Finish exam';

  const toggle = $('showCorrectAnswersToggle');
  toggle.checked = !!state.showCorrectAnswers;
  const existingNote = area.parentNode.querySelector('.correct-answer-note');
  if (existingNote) existingNote.remove();
  if (locked) {
    const note = document.createElement('div');
    note.className = 'result-answer correct-answer-note';
    const answerText = question.type === 'matching'
      ? `<strong>Correct matches:</strong><br>${(question.pairs || []).map((p) => `${esc(p.left)} &rarr; ${esc(p.right)}`).join('<br>')}`
      : `<strong>Correct answer:</strong> ${esc(question.correctAnswer)}`;
    note.innerHTML = answerText + (question.explanation ? `<p class="result-explanation" style="margin-top:6px;">${esc(question.explanation)}</p>` : '');
    area.parentNode.appendChild(note);
  }
}

$('btnQuizPrev').addEventListener('click', () => {
  if (state.quizIndex > 0) { state.quizIndex -= 1; renderQuizQuestion(); }
});
$('btnQuizNext').addEventListener('click', () => {
  if (state.quizIndex < state.quiz.questions.length - 1) {
    state.quizIndex += 1;
    renderQuizQuestion();
  } else {
    // Won't let the exam end with a blank question -- jumps to the first
    // unanswered one (via the same nav pills) instead of finishing, rather
    // than silently scoring skipped questions as wrong.
    const firstUnanswered = state.quiz.questions.findIndex((q) => !isAnswered(q, state.answers[q.id]));
    if (firstUnanswered !== -1) {
      alert(`Question ${firstUnanswered + 1} is still unanswered. Answer every question before finishing.`);
      state.quizIndex = firstUnanswered;
      renderQuizQuestion();
      return;
    }
    renderResults(true);
    showCreateStep('results');
  }
});

// Attached once here (not inside renderResults(), which runs every time the
// results screen is shown -- including after every repeat) so repeating a
// quiz multiple times in one session doesn't stack up duplicate listeners
// that each re-fire the shuffle-and-reset on a single click.
$('btnRepeatQuiz').addEventListener('click', () => {
  if (!state.quiz || !state.quiz.questions) return;
  state.quiz = { ...state.quiz, questions: shuffleArray(state.quiz.questions) };
  state.answers = {};
  state.essayGrades = {};
  state.quizIndex = 0;
  state.isQuizComplete = false; // was never reset here, so a repeat attempt could never be saved as a new completion
  renderQuizQuestion();
  showCreateStep('quiz');
});

/* ============ Grading ============ */

function normalize(str) {
  return String(str ?? '').toLowerCase().trim().replace(/[.,!?;:'"()]/g, '').replace(/\s+/g, ' ');
}

function isObjectiveType(type) {
  return (
    type === 'multipleChoice' ||
    type === 'trueFalse' ||
    type === 'identification' ||
    type === 'matching' ||
    type === 'calculation'
  );
}

// Matching-type answers aren't a single value like every other type -- they're
// an object keyed by pair index (`{0: 'chosen right-side value', 1: ...}`),
// since the question itself holds multiple left/right pairs. "Answered"
// means every pair has a selection; a matching question only locks/grades
// once fully attempted, not after the first pair.
function isAnswered(question, answer) {
  if (question.type === 'matching') {
    const pairs = question.pairs || [];
    return pairs.length > 0 && pairs.every((_, i) => answer && answer[i] !== undefined && answer[i] !== '');
  }
  return answer !== undefined && answer !== null && String(answer).trim() !== '';
}

function gradeObjectiveQuestion(question, answer) {
  if (!isAnswered(question, answer)) return false;
  if (question.type === 'multipleChoice' || question.type === 'trueFalse') {
    return normalize(answer) === normalize(question.correctAnswer);
  }
  if (question.type === 'identification') {
    const accepted = (question.acceptableAnswers?.length ? question.acceptableAnswers : [question.correctAnswer]).map(normalize);
    return accepted.includes(normalize(answer));
  }
  if (question.type === 'calculation') {
    const given = parseFloat(String(answer).replace(/,/g, ''));
    const expected = parseFloat(String(question.correctAnswer).replace(/,/g, ''));
    if (Number.isNaN(given) || Number.isNaN(expected)) return false;
    const tolerance = Math.max(0.01, Math.abs(expected) * 0.01);
    return Math.abs(given - expected) <= tolerance;
  }
  if (question.type === 'matching') {
    // All-or-nothing: every pair has to be matched correctly for this
    // question to count as correct, same single correct/incorrect model
    // every other question type uses -- no partial credit per pair.
    return (question.pairs || []).every((pair, i) => answer[i] === pair.right);
  }
  return false;
}

// Shared by the quiz runner's lock note and the results screen -- matching
// answers are a {pairIndex: rightValue} object, not a plain string like
// every other type, so both display spots need this instead of just
// stringifying question.correctAnswer / the raw answer value.
function formatCorrectAnswerText(question) {
  if (question.type === 'matching') {
    return (question.pairs || []).map((p) => `${p.left} → ${p.right}`).join('; ');
  }
  return question.correctAnswer;
}
function formatUserAnswerText(question, answer) {
  if (question.type === 'matching') {
    if (!isAnswered(question, answer)) return '';
    return (question.pairs || []).map((p, i) => `${p.left} → ${answer[i] || '?'}`).join('; ');
  }
  return answer;
}

// Shared by the live results screen and the completion-save history log
// (see saveCurrentQuizToLibrary) so a saved attempt's score always matches
// what was actually shown on screen -- essay questions count via their
// AI-graded score/100 once available, same weighting as the results screen.
function computeQuizScorePercent(quiz, answers, essayGrades) {
  const questions = quiz.questions || [];
  if (!questions.length) return 0;
  const objectiveQuestions = questions.filter((q) => isObjectiveType(q.type));
  const objectiveCorrect = objectiveQuestions.filter((q) => gradeObjectiveQuestion(q, answers[q.id])).length;
  const essayScores = questions.filter((q) => q.type === 'essay').map((q) => essayGrades[q.id]?.score).filter((s) => typeof s === 'number');
  const totalPoints = objectiveCorrect + essayScores.reduce((sum, s) => sum + s / 100, 0);
  return Math.round((totalPoints / questions.length) * 100);
}

/* ============ Results ============ */

// justFinished=true only for a live "Finish exam" completion -- distinct
// from re-opening an already-saved completed exam via viewCompletedExam(),
// which also calls this function to reuse the same rendering but must NOT
// save a fresh duplicate library entry every time someone reviews it.
async function renderResults(justFinished) {
  const questions = state.quiz.questions;
  const objectiveQuestions = questions.filter((q) => isObjectiveType(q.type));
  const essayQuestions = questions.filter((q) => q.type === 'essay');
  const objectiveCorrect = objectiveQuestions.filter((q) => gradeObjectiveQuestion(q, state.answers[q.id])).length;

  $('resultsExamTitle').textContent = `${state.examTitle || 'Exam'} • Results`;

  function paintScore() {
    const essayScores = essayQuestions.map((q) => state.essayGrades[q.id]?.score).filter((s) => typeof s === 'number');
    const essayAvg = essayScores.length ? essayScores.reduce((a, b) => a + b, 0) / essayScores.length : null;
    const overallPct = computeQuizScorePercent(state.quiz, state.answers, state.essayGrades);
    $('resultsScoreValue').textContent = `${overallPct}%`;

    const ungraded = essayQuestions.some((q) => !state.essayGrades[q.id] && String(state.answers[q.id] || '').trim());
    let summary = `${objectiveCorrect} / ${objectiveQuestions.length} objective correct`;
    if (essayQuestions.length) summary += essayAvg !== null ? ` • essay avg ${Math.round(essayAvg)}%` : ungraded ? ' • grading essays…' : '';
    $('resultsSummary').textContent = summary;
  }

  function paintList() {
    $('resultsList').innerHTML = questions.map((question, index) => {
      const userAnswer = state.answers[question.id];
      const objective = isObjectiveType(question.type);
      const correct = objective ? gradeObjectiveQuestion(question, userAnswer) : null;
      const essayGrade = !objective ? state.essayGrades[question.id] : null;

      const userAnswerText = formatUserAnswerText(question, userAnswer);
      return `
        <div class="card result-item${objective ? (correct ? ' is-correct' : ' is-incorrect') : ''}">
          <p class="result-item-index">Question ${index + 1}</p>
          <p class="question-prompt">${esc(question.prompt)}</p>
          <p class="result-answer"><strong>Your answer:</strong> ${userAnswerText ? esc(String(userAnswerText)) : '<em>No answer</em>'}</p>
          ${objective && !correct ? `<p class="result-answer"><strong>Correct answer:</strong> ${esc(String(formatCorrectAnswerText(question)))}</p>` : ''}
          ${question.explanation ? `<p class="result-explanation">${esc(question.explanation)}</p>` : ''}
          ${!objective ? (essayGrade
            ? `<div class="essay-grade">${typeof essayGrade.score === 'number' ? `<span class="essay-score">${essayGrade.score}/100</span>` : ''}<p class="result-explanation">${esc(essayGrade.feedback)}</p></div>`
            : '<p class="result-explanation">Grading…</p>') : ''}
        </div>
      `;
    }).join('');
  }

  paintScore();
  paintList();

  const ungraded = essayQuestions.filter((q) => !state.essayGrades[q.id] && String(state.answers[q.id] || '').trim());
  if (ungraded.length) {
    await Promise.all(ungraded.map(async (q) => {
      try {
        const result = await callWithKeyRotation('grade-essay', {
          question: q.prompt,
          expectedAnswer: q.expectedAnswer,
          rubric: q.rubric,
          answer: state.answers[q.id],
        });
        state.essayGrades[q.id] = result;
      } catch (err) {
        state.essayGrades[q.id] = { score: null, feedback: `Could not grade automatically: ${err.message}` };
      }
    }));
    paintScore();
    paintList();
  }

  // Real completion save -- previously nothing ever called the old
  // saveQuizToLibrary()/similar at all, so finishing a quiz never actually
  // added anything to the library or Recent Exams no matter how many exams
  // were completed. Guarded by isQuizComplete so essay-grading's own
  // paintScore()/paintList() re-render above (and any future re-render of
  // this same screen) can't save a second duplicate entry.
  if (justFinished && !state.isQuizComplete) {
    state.isQuizComplete = true;
    saveCurrentQuizToLibrary('completed');

    // Best-effort, fire-and-forget: this quiz was opened via a Share & Track
    // link (?quiz=<id>), so sync the score back for the creator's Monitoring
    // tab. Deliberately non-blocking and swallows its own errors -- unlike
    // Share Link, where the network call IS the whole point of the button,
    // this is a side channel off a results screen that already succeeded
    // locally and must never be interrupted by a flaky connection.
    if (state.activeTrackedQuizId) {
      const scorePercent = computeQuizScorePercent(state.quiz, state.answers, state.essayGrades);
      submitTrackedQuizAttempt(state.activeTrackedQuizId, scorePercent).catch((e) => {
        console.error('Share & Track sync failed:', e);
      });
    }
  }
}

function submitTrackedQuizAttempt(trackedQuizId, scorePercent) {
  const id = state.studentIdentity || {};
  return callEdgeFunction('submit-quiz-attempt', {
    trackedQuizId,
    scorePercent,
    identity: {
      surname: id.surname || '',
      givenName: id.givenName || '',
      middleName: id.middleName || '',
      school: id.school || '',
      gradeLevel: id.gradeLevel || '',
      adviser: id.adviser || '',
      contactNumber: id.contactNumber || '',
      email: id.email || '',
    },
  });
}

$('btnCreateAnother').addEventListener('click', resetCreateFlow);

/* ============ Init ============ */

initTheme();
refreshGeminiKeyStatus();
renderHome();
resetCreateFlow();
document.querySelector('.app-header-version').textContent = APP_VERSION;
renderStudentIdentityCard();

// Share & Track deep link -- ?quiz=<trackedQuizId>. Parsed before the
// identity gate below so the intent survives even on a genuine first
// launch; loading is deferred until AFTER the identity modal closes (see
// the tail of the btnIdentitySave handler above) since a submitted attempt
// needs a real identity to attach to, and the modal is non-dismissable on
// first launch.
const deepLinkQuizId = new URLSearchParams(location.search).get('quiz');
state.pendingTrackedQuizId = deepLinkQuizId || null;
if (deepLinkQuizId) history.replaceState(null, '', location.pathname); // don't re-trigger this on a later reload

// Same deal for a Class Sessions join link -- ?class=<sessionId>.
const deepLinkClassId = new URLSearchParams(location.search).get('class');
state.pendingClassSessionId = deepLinkClassId || null;
if (deepLinkClassId) history.replaceState(null, '', location.pathname);

if (!state.studentIdentity) {
  openStudentIdentityModal(true);
} else if (state.pendingTrackedQuizId) {
  const id = state.pendingTrackedQuizId;
  state.pendingTrackedQuizId = null;
  loadTrackedQuizFromDeepLink(id);
} else if (state.pendingClassSessionId) {
  const id = state.pendingClassSessionId;
  state.pendingClassSessionId = null;
  loadClassSessionFromDeepLink(id);
}

// Was two separate, near-duplicate functions (saveQuizToLibrary,
// saveAsDraft) that each built their own newExam object -- consolidated
// into one, since "completed" and "draft" only ever differed by status and
// a couple of extra draft-only fields. Also now persists (see
// saveLibraryExams above) and, for completed exams, captures the actual
// answers/grades so a finished exam can be reviewed later instead of just
// remembered as having existed.
function saveCurrentQuizToLibrary(status) {
  if (!state.quiz || !state.examTitle) return undefined;

  // Upsert, not always-insert: resuming a draft (continueQuizFromLibrary sets
  // state.currentLibraryId) and then triggering another auto-save -- e.g.
  // closing the tab again before finishing -- previously created a second,
  // near-identical duplicate entry every single time, since the old code
  // always unshifted a brand new object. Found via an actual resume-then-
  // reload test, not just reading the code.
  const existing = state.currentLibraryId
    ? LIBRARY_EXAMS.find((e) => e.id === state.currentLibraryId)
    : null;

  // Attempt history -- a real log of every completed attempt's date/score,
  // not just whatever the most recent attempt happened to be. Carried
  // forward from the existing entry (if any) so retaking an exam adds to
  // the log instead of erasing it.
  const priorHistory = existing?.history || [];
  const history = status === 'completed'
    ? [...priorHistory, { date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }), scorePercent: computeQuizScorePercent(state.quiz, state.answers, state.essayGrades) }]
    : priorHistory;

  const newExam = {
    id: existing ? existing.id : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    subject: state.subject || 'General',
    title: state.examTitle,
    examTitle: state.examTitle,
    questionCount: state.quiz.questions ? state.quiz.questions.length : 0,
    date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    excerpt: state.quiz.questions && state.quiz.questions[0]
      ? (state.quiz.questions[0].prompt || 'Exam generated from uploaded material')
      : 'Exam generated from uploaded material',
    status,
    badge: state.quiz.questions ? state.quiz.questions.length.toString() : '0',
    tag: state.subject ? state.subject.toLowerCase().replace(/\s+/g, '-') : 'general',
    quizData: state.quiz,
    // Saved regardless of status now (was completed-only) -- a draft needs
    // its in-progress answers/position saved too, or "Continue Quiz" has
    // nothing real to resume from.
    answers: { ...state.answers },
    essayGrades: { ...state.essayGrades },
    quizIndex: state.quizIndex,
    history,
    // newExam is rebuilt from scratch every save (not spread from existing),
    // so anything not explicitly carried forward here is silently dropped on
    // the next save/edit -- these two must be, or Share & Track's
    // association and a resumed attempt's sync-back would both quietly break.
    trackedQuizId: existing?.trackedQuizId || null, // set by shareQuizAndTrack when THIS exam is the one being shared (creator side)
    trackedSourceQuizId: state.activeTrackedQuizId || existing?.trackedSourceQuizId || null, // set when this exam was opened via a ?quiz= link (recipient side)
  };

  if (existing) {
    LIBRARY_EXAMS.splice(LIBRARY_EXAMS.indexOf(existing), 1);
  }
  LIBRARY_EXAMS.unshift(newExam);
  state.currentLibraryId = newExam.id;
  saveLibraryExams();
  return newExam;
}

// Was: all three creation paths (AI Generate, Manual Build, Auto-Extract)
// jumped straight into live quiz-taking the instant a quiz was ready.
// Now a freshly created exam is only ever saved as a draft and the user
// lands back on the Library, where they choose when to actually take it --
// matches "create it now, take it later" rather than forcing an immediate
// attempt right after generation.
function saveGeneratedQuizAndReturnToLibrary() {
  if (!state.examTitle || !state.examTitle.trim()) state.examTitle = 'Untitled Exam';
  state.answers = {};
  state.essayGrades = {};
  state.quizIndex = 0;
  state.isQuizComplete = false;
  state.currentLibraryId = null; // definitely a brand new quiz, not continuing an existing library entry
  state.activeTrackedQuizId = null; // same -- a freshly generated quiz was never opened via a tracked link
  saveCurrentQuizToLibrary('draft');
  state.libraryTab = 'draft';
  switchTab('library');
  renderLibrary();
  alert('Exam created! Find it in your Library (Drafts) whenever you\'re ready to take it.');
}

// Auto-save draft when user navigates away from quiz
function setupAutoSave() {
  // Was: fired for ANY unfinished quiz sitting in state.quiz, even long
  // after returning to Library/Home once it had been saved as a draft --
  // state.quiz doesn't get cleared just because the screen changed. Scoped
  // to actually being on the quiz-taking screen, which is what "warn during
  // quiz taking" means. Note: no browser lets a page set its own
  // beforeunload dialog text anymore (Chrome/Firefox/Safari all show a
  // fixed generic "Leave site?" message regardless of e.returnValue) --
  // that's a platform restriction, not something fixable here. What IS
  // real: the answer is already saved before the prompt even appears, so a
  // refresh the user goes through with anyway loses nothing.
  window.addEventListener('beforeunload', function(e) {
    if (state.createStep === 'quiz' && state.quiz && state.examTitle && !state.isQuizComplete) {
      saveCurrentQuizToLibrary('draft');
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
  });
}

// Show version popup
// Real check-for-update: fetches the live deployed app.js and compares its
// APP_VERSION against this build's own -- same idea as Winfinity's own
// update system, simplified since sQUIZit's service worker doesn't have
// a SKIP_WAITING message-based lifecycle to hook into (see sw.js). "Update
// Now" instead unregisters the current worker and clears every cache
// before reloading, which forces a fully fresh fetch of everything -- less
// nuanced than Winfinity's approach, but real and reliable rather than a
// placeholder alert.
//
// NONE of that applies inside the packaged Android app, though: the APK
// bundles a snapshot of these files at build time (see README's "Building
// the Android APK") -- there's no live app.js to re-fetch, and reloading
// just reloads the same bundled copy. isNativeApp() below detects that
// context and switches to a different real mechanism: check GitHub's
// latest Release via its API, and if newer, open that release's .apk
// directly. Because it's built with the SAME package ID
// (io.github.winfos.squizit) and a higher version number, Android
// installs it as an UPDATE to the existing app in place -- not a second,
// separate app -- the same way any sideloaded APK update works outside
// the Play Store. The user still has to tap through Android's own
// install/update confirmation dialog; nothing can silently self-install
// without root or an MDM-managed device, Play Store or not.
// NOT verified on a real device -- this repo has no way to run/test an
// actual Android install flow. Confirm on-device before relying on it.
let latestKnownVersion = null;
let latestApkDownloadUrl = null;
let swRegistration = null;
let swReloadedOnce = false;

function isNativeApp() {
  return typeof window.Capacitor !== 'undefined' && !!window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform();
}

// Receiving end of the "open a shared quiz in sQUIZit" flow (see
// shareQuizAsHtml/buildStandaloneQuizHtml above for the sending end, and
// MainActivity.java's intent-filter + onCreate/onNewIntent for how a tapped
// .squizit.html file gets here). Imports it as a new Library draft and
// drops the user straight there, rather than making them retype/reopen
// anything.
window.importSharedQuiz = function (rawJson) {
  let data;
  try { data = JSON.parse(rawJson); } catch (e) { return; }
  if (!data || !Array.isArray(data.questions) || !data.questions.length) return;

  const title = data.examTitle || 'Shared Quiz';
  const newExam = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    subject: data.subject || 'General',
    title,
    examTitle: title,
    questionCount: data.questions.length,
    date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    excerpt: data.questions[0]?.prompt || 'Shared from another sQUIZit user',
    status: 'draft',
    badge: data.questions.length.toString(),
    tag: (data.subject || 'general').toLowerCase().replace(/\s+/g, '-'),
    quizData: { questions: data.questions },
    answers: {},
    essayGrades: {},
    quizIndex: 0,
    history: [],
  };
  LIBRARY_EXAMS.unshift(newExam);
  saveLibraryExams();
  state.libraryTab = 'draft';
  switchTab('library');
  alert(`Imported "${title}" from a shared file — find it in Library (Drafts).`);
};

// Cold start straight from tapping a shared file: MainActivity can't safely
// evaluateJavascript() before this script has finished running, so instead
// it stashes the quiz data natively and this pulls it once, here, after
// window.importSharedQuiz above already exists. The already-running-app
// case (MainActivity.onNewIntent) pushes directly instead -- same pattern
// as window.handleOAuthRedirect further down.
if (isNativeApp() && window.AndroidBridge && window.AndroidBridge.getPendingSharedQuiz) {
  const pendingSharedQuiz = window.AndroidBridge.getPendingSharedQuiz();
  if (pendingSharedQuiz) window.importSharedQuiz(pendingSharedQuiz);
}

function extractVersionNumber(str) {
  const m = String(str || '').match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

async function checkForUpdateNative() {
  try {
    const res = await fetch('https://api.github.com/repos/WinF-os/sQUIZit/releases/latest');
    if (!res.ok) return null;
    const data = await res.json();
    const asset = (data.assets || []).find((a) => a.name.toLowerCase().endsWith('.apk'));
    const remoteVersion = extractVersionNumber(data.tag_name);
    if (!remoteVersion || !asset) return null;
    latestKnownVersion = remoteVersion;
    latestApkDownloadUrl = asset.browser_download_url;
    return remoteVersion;
  } catch (e) {
    return null;
  }
}

// Purely for display -- fetches the live app.js just to read its
// APP_VERSION string. Does NOT decide whether an update exists; that's the
// service worker registration's own job now (checkForUpdateWeb below), same
// division of labor as Winfinity's fetchLatestVersionLabel.
async function fetchLatestVersionLabel() {
  try {
    const res = await fetch('https://winf-os.github.io/sQUIZit/app.js?nocache=' + Date.now());
    if (!res.ok) return null;
    const text = await res.text();
    const match = text.match(/APP_VERSION\s*=\s*'([^']+)'/);
    return match ? match[1] : null;
  } catch (e) {
    return null;
  }
}

// Event-driven, mirrors Winfinity's own SW-lifecycle update check: asks the
// registration itself whether a new worker installed and is sitting in
// `waiting`, instead of the old approach of fetching+regexing app.js and
// string-comparing (which never actually asked the service worker anything,
// and required a separate unregister-everything-and-reload to "apply").
// Resolves to: null on a genuine check failure (offline/unreachable) --
// triggers the "could not check" message; APP_VERSION (unchanged) when the
// check succeeded but nothing new is waiting -- "you're on the latest";
// or the new version's label when an update really is waiting.
function checkForUpdateWeb() {
  if (!swRegistration) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      swRegistration.removeEventListener('updatefound', onUpdateFound);
      clearTimeout(fallbackTimer);
    };
    const finish = async (found) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!found) { resolve(APP_VERSION); return; }
      const label = await fetchLatestVersionLabel();
      latestKnownVersion = label || 'the latest build';
      resolve(latestKnownVersion);
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(null);
    };
    const onUpdateFound = () => {
      const installing = swRegistration.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed') finish(!!swRegistration.waiting);
        else if (installing.state === 'redundant') finish(false);
      });
    };
    swRegistration.addEventListener('updatefound', onUpdateFound);
    const fallbackTimer = setTimeout(() => finish(!!swRegistration.waiting), 8000);
    swRegistration.update().catch(fail);
  });
}

async function checkForUpdate() {
  if (isNativeApp()) return checkForUpdateNative();
  return checkForUpdateWeb();
}

function setUpdateStatusText(msg) {
  const a = document.getElementById('versionPopupStatus');
  const b = document.getElementById('profileUpdateStatus');
  if (a) a.textContent = msg;
  if (b) b.textContent = msg;
}

// Fired from MainActivity's AndroidBridge.downloadAndInstallApk -- Android
// requires a one-time "allow this app to install updates" grant (its own
// security gate for anything outside the Play Store, not something any app
// can skip), so the bridge method opens that exact settings screen and
// calls this instead of downloading, the first time. Tapping Update Now
// again after granting it proceeds normally.
window.onApkInstallPermissionNeeded = function () {
  setUpdateStatusText('Allow sQUIZit to install updates on the screen that just opened, then tap Update Now again.');
};
window.onApkInstallFailed = function (message) {
  setUpdateStatusText(`Update download failed: ${message || 'unknown error'}. Tap Update Now to try again.`);
};

async function applyUpdate() {
  if (isNativeApp()) {
    if (!latestApkDownloadUrl) return;
    // Was: window.open(latestApkDownloadUrl) -- handed off to the phone's
    // browser to download, then relied on the browser/OS to hand the file
    // back for install. Found on-device this reliably gets stuck: modern
    // Android/Play Protect silently scans a downloaded APK from an
    // unrecognized publisher before allowing an install action, and that
    // scan can hang indefinitely for a debug-signed build -- happens the
    // same way in any browser, since it's an OS-level gate, not a
    // browser one. Downloading inside the app and firing Android's package
    // installer intent directly (see downloadAndInstallApk in
    // MainActivity.java) skips that hand-off entirely.
    if (window.AndroidBridge && window.AndroidBridge.downloadAndInstallApk) {
      setUpdateStatusText('Downloading update…');
      window.AndroidBridge.downloadAndInstallApk(latestApkDownloadUrl);
    } else {
      // Fallback for a build that predates this bridge method -- can only
      // happen on a device's very first update *into* a build that has
      // this fix, since native JS only updates by installing a new APK.
      window.open(latestApkDownloadUrl, '_blank', 'noopener');
    }
    return;
  }
  // Ask the already-installed waiting worker to take over (sw.js's message
  // listener calls self.skipWaiting()) instead of the old unregister-
  // everything-and-delete-every-cache approach -- lets the new worker's own
  // activate handler do the (now correctly cache:'reload'-fetched) cache
  // swap, and the controllerchange listener below does the one reload.
  if (swRegistration && swRegistration.waiting) {
    swRegistration.waiting.postMessage('SKIP_WAITING');
    // Safety net in case controllerchange never fires for some reason.
    setTimeout(() => { if (!swReloadedOnce) location.reload(); }, 4000);
  } else {
    // Nothing actually waiting (e.g. called before a check ever ran) --
    // just reload, same blunt fallback as before.
    location.reload();
  }
}

function isAutoUpdateEnabled() {
  // Auto-apply never fires in the native app regardless of this toggle --
  // applyUpdate() there opens an external download, which should only ever
  // happen from an explicit tap, not silently switch the user out to a
  // browser in the background.
  if (isNativeApp()) return false;
  return localStorage.getItem('quizforge-auto-update') !== '0'; // on by default, matching the popup's own default-checked toggle
}

async function showVersionPopup() {
  let popup = document.getElementById('versionPopup');

  if (!popup) {
    const popupHTML = `
      <div class="version-popup" id="versionPopup">
        <div class="version-popup-content">
          <div class="version-popup-header">
            <h2 class="version-popup-title">sQUIZit</h2>
            <span class="version-popup-version">${esc(APP_VERSION)}</span>
          </div>
          <p id="versionPopupStatus">Checking for updates…</p>
          <div class="version-popup-actions">
            <span id="autoUpdateRow">
              <label class="toggle-switch">
                <input type="checkbox" id="autoUpdateToggle">
                <span class="slider"></span>
              </label>
              <span class="toggle-label">Auto-update</span>
            </span>
            <button class="update-btn" id="updateButton" hidden>Update Now</button>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', popupHTML);
    popup = document.getElementById('versionPopup');

    document.getElementById('updateButton').addEventListener('click', applyUpdate);
    document.getElementById('autoUpdateToggle').addEventListener('change', function () {
      localStorage.setItem('quizforge-auto-update', this.checked ? '1' : '0');
    });
    popup.addEventListener('click', function (e) {
      if (e.target === popup) popup.classList.remove('is-visible');
    });

    // Was: this toggle read isAutoUpdateEnabled() to set its own checked
    // state, but that function hardcodes false for the native app (a
    // deliberate rule -- applyUpdate() there opens an external APK
    // download, which should never happen silently, only from an explicit
    // tap). Net effect on-device: turning the toggle on saved fine, but the
    // very next time this popup opened it read back as off again, forever
    // -- looked exactly like the setting not sticking. There's genuinely
    // nothing for this toggle to control in the native app (auto-apply can
    // never fire there either way), so it's hidden there instead of shown
    // in a state that can never be made to stick.
    document.getElementById('autoUpdateRow').hidden = isNativeApp();
  }

  document.getElementById('autoUpdateToggle').checked = localStorage.getItem('quizforge-auto-update') !== '0';
  popup.classList.add('is-visible');

  const statusEl = document.getElementById('versionPopupStatus');
  const updateBtn = document.getElementById('updateButton');
  statusEl.textContent = 'Checking for updates…';
  updateBtn.hidden = true;
  const remoteVersion = await checkForUpdate();
  const currentVersion = isNativeApp() ? extractVersionNumber(APP_VERSION) : APP_VERSION;
  if (!remoteVersion) {
    statusEl.textContent = "Could not check for updates -- you're offline, or GitHub is unreachable.";
  } else if (remoteVersion === currentVersion) {
    statusEl.textContent = "You're on the latest version.";
  } else {
    statusEl.textContent = isNativeApp()
      ? `A new version is available: ${esc(remoteVersion)}. Tap Update Now to download it -- Android will ask you to confirm installing it as an update.`
      : `A new version is available: ${esc(remoteVersion)}.`;
    updateBtn.hidden = false;
    if (isAutoUpdateEnabled()) applyUpdate();
  }
  refreshUpdateBadge();
}

// Background check -- same convention as Winfinity's own "check ~5s after
// load, then every 15 minutes" behavior. Lets auto-update actually apply
// (when the toggle is on) without the user ever opening the popup, and
// keeps the Profile badge current across a long-lived tab. Shared by the
// initial 5s timeout below and the periodic interval set up once the
// service worker registration resolves (see the registration block further
// down this file).
function backgroundCheckForUpdate() {
  return checkForUpdate().then((v) => {
    refreshUpdateBadge();
    if (v && v !== currentComparableVersion() && isAutoUpdateEnabled()) applyUpdate();
  });
}
setTimeout(backgroundCheckForUpdate, 5000);

// Version button -> the real popup (checkForUpdate/applyUpdate above),
// replacing the old placeholder alert entirely. initTheme/renderHome/etc.
// already ran once in the single Init block near the top of this file --
// deliberately NOT repeated here.
const versionButton = document.getElementById('versionButton');
if (versionButton) versionButton.addEventListener('click', showVersionPopup);

// Profile-tab update control -- same real checkForUpdate()/applyUpdate()
// as the header popup above (not a separate implementation), just a second
// place to reach it plus a small notification badge that lights up
// whenever a background or manual check has found a newer version, same
// idea as Winfinity's own Profile-tab update button/badge.
// Native compares bare "1.2.3"-style numbers (extracted from a GitHub
// release tag); web compares the raw APP_VERSION string against itself as
// served live -- these are two different formats, comparing the wrong
// pair silently made the app think an update was always/never available.
function currentComparableVersion() {
  return isNativeApp() ? extractVersionNumber(APP_VERSION) : APP_VERSION;
}

function refreshUpdateBadge() {
  const hasUpdate = !!(latestKnownVersion && latestKnownVersion !== currentComparableVersion());
  const badge = document.getElementById('profileUpdateBadge');
  if (badge) badge.hidden = !hasUpdate;
  const btn = document.getElementById('btnProfileCheckUpdate');
  if (btn) btn.textContent = hasUpdate ? 'Update Now' : 'Check for Updates';
}

document.getElementById('profileVersionText').textContent = APP_VERSION;

document.getElementById('btnProfileCheckUpdate').addEventListener('click', async () => {
  const btn = document.getElementById('btnProfileCheckUpdate');
  const status = document.getElementById('profileUpdateStatus');

  if (latestKnownVersion && latestKnownVersion !== currentComparableVersion()) {
    applyUpdate();
    return;
  }

  btn.disabled = true;
  status.textContent = 'Checking for updates…';
  const remoteVersion = await checkForUpdate();
  btn.disabled = false;
  refreshUpdateBadge();

  if (!remoteVersion) {
    status.textContent = "Could not check for updates -- you're offline, or GitHub is unreachable.";
  } else if (remoteVersion === currentComparableVersion()) {
    status.textContent = "You're on the latest version.";
  } else {
    status.textContent = isNativeApp()
      ? `A new version is available: ${esc(remoteVersion)}. Tap Update Now to download it -- Android will ask you to confirm installing it as an update.`
      : `A new version is available: ${esc(remoteVersion)}. Tap Update Now to install it.`;
    if (isAutoUpdateEnabled()) applyUpdate();
  }
});

// Share the latest version's download link through the OS share sheet --
// native app shares the actual .apk release asset (what the user needs to
// hand the app to someone else); web shares the live site, since there's no
// separate downloadable artifact for the PWA.
document.getElementById('btnShareUpdateLink').addEventListener('click', async () => {
  let url = 'https://winf-os.github.io/sQUIZit/';
  let text = 'sQUIZit -- turn a photo of your notes into an AI-generated practice exam.';

  if (isNativeApp()) {
    if (!latestApkDownloadUrl) await checkForUpdateNative();
    url = latestApkDownloadUrl || 'https://github.com/WinF-os/sQUIZit/releases/latest';
    text = `sQUIZit${latestKnownVersion ? ' v' + latestKnownVersion : ''} for Android -- APK download`;
  }

  if (navigator.share) {
    try {
      await navigator.share({ title: 'sQUIZit', text, url });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // user backed out of the share sheet -- not a failure
    }
  }

  try {
    await navigator.clipboard.writeText(url);
    alert(`Link copied to clipboard:\n${url}`);
  } catch (e) {
    alert(url);
  }
});

setupAutoSave();

if (isNativeApp()) {
  // Native updates work by installing a whole new APK with freshly bundled
  // assets each time (see applyUpdate's native branch) -- a Service Worker
  // has no reason to intercept fetches here at all. Found the hard way: a
  // plain `adb install -r` reinstall does NOT wipe the WebView's own
  // storage, so a Service Worker (and its cached index.html/app.js) left
  // over from an older install kept serving its own stale content forever,
  // completely hiding whatever the newly installed APK actually bundled --
  // looked exactly like a "half the app didn't update" bug. Actively
  // unregister/clear here so any pre-existing one self-heals once a device
  // gets this fix, rather than only registering-but-never-again below.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister()));
  }
  if ('caches' in window) {
    caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
  }
} else if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // updateViaCache: 'none' stops the browser from ever serving sw.js
    // itself from HTTP cache during an update check -- without this, a
    // stale cached copy of sw.js can make every check falsely report
    // "already latest" until that HTTP cache entry happens to expire.
    // Relative path 'sw.js', not '/sw.js' -- this app is served from a
    // subpath (winf-os.github.io/sQUIZit/), and an absolute /sw.js resolves
    // to the ORG's root instead, which 404s -- meaning the service worker
    // never actually registered on the live web deploy at all. Found while
    // porting Winfinity's SW-lifecycle update mechanism, which depends on a
    // genuinely-registered registration object to have anything to check.
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
      swRegistration = reg;
      setInterval(backgroundCheckForUpdate, 15 * 60 * 1000);
    }).catch((error) => {
      console.error('Service worker registration failed:', error);
    });
  });
  // Fires once the new worker actually takes control (after SKIP_WAITING,
  // see applyUpdate above) -- the one-and-only reload the update flow needs.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (swReloadedOnce) return;
    swReloadedOnce = true;
    location.reload();
  });
}

// "Show correct answer on wrong answers" toggle -- the actual display
// logic lives in renderQuizQuestion(), which re-renders on every answer/
// navigation; this listener just needs to update the flag and re-render
// once so the current question reflects the new setting immediately.
$('showCorrectAnswersToggle').addEventListener('change', (e) => {
  state.showCorrectAnswers = e.target.checked;
  if (state.quiz) renderQuizQuestion();
});

// "Save as Draft" was removed -- completion is always auto-saved now (see
// the completion hook in renderResults), so a separate manual save button
// after finishing didn't do anything a completed exam wasn't already doing.
// "Edit Quiz" from the results screen edits whichever library entry this
// completed attempt was just saved into.
$('btnEditQuizFromResults').addEventListener('click', () => {
  const item = LIBRARY_EXAMS.find((e) => e.id === state.currentLibraryId);
  if (item) editQuizFromLibrary(item);
});

// Loads a quiz opened via a Share & Track link (?quiz=<id>, see the Init
// block). Modeled on continueQuizFromLibrary below, but the quiz data comes
// from the tracked_quizzes table via get-tracked-quiz instead of the local
// Library, and it's a brand new attempt (no saved answers/position to
// restore) -- state.activeTrackedQuizId is what makes the completion path
// (renderResults) sync the finished score back.
async function loadTrackedQuizFromDeepLink(trackedQuizId) {
  switchTab('create');
  showCreateStep('generating'); // reuses the existing spinner screen as a loading state
  $('generatingErrorCard').hidden = true;
  $('generatingSpinner').hidden = false;
  try {
    const data = await callEdgeFunction('get-tracked-quiz', { id: trackedQuizId });
    state.quiz = { questions: data.quizData.questions || [] };
    state.subject = data.subject || 'General';
    state.examTitle = data.examTitle || 'Shared Quiz';
    state.answers = {};
    state.essayGrades = {};
    state.quizIndex = 0;
    state.isQuizComplete = false;
    state.quizTimerStartedAt = null;
    state.currentLibraryId = null;
    state.activeTrackedQuizId = trackedQuizId;
    showCreateStep('quiz');
    renderQuizQuestion();
  } catch (e) {
    alert(`Couldn't load this shared quiz: ${e.message || e}. The link may have been removed.`);
    switchTab('home');
  }
}

// Continue a draft exactly where it was left -- restores the saved
// answers/position instead of resetting them. (Originally this called a
// `renderQuiz()` that didn't exist anywhere in the file and reset all
// progress unconditionally; fixed alongside adding a real distinction
// between "continue" and "retake" below, once saveCurrentQuizToLibrary
// started actually persisting in-progress answers for drafts too.)
function continueQuizFromLibrary(item) {
  if (!item || !item.quizData) return;

  // Spread the whole quizData object, not just .questions -- was dropping
  // every other quiz-level property (timeLimitMinutes, difficulty) on
  // every resume, found via an actual test: a saved time limit silently
  // vanished the moment a draft was reopened.
  state.quiz = { ...item.quizData, questions: item.quizData.questions || [] };
  state.subject = item.subject;
  state.examTitle = item.examTitle || item.title;
  state.answers = item.answers ? { ...item.answers } : {};
  state.essayGrades = item.essayGrades ? { ...item.essayGrades } : {};
  state.quizIndex = Math.min(item.quizIndex || 0, (item.quizData.questions || []).length - 1);
  state.isQuizComplete = false;
  state.quizTimerStartedAt = null; // fresh countdown for this session, see comment on that field
  state.currentLibraryId = item.id || null; // lets a later auto-save update this same entry instead of inserting a duplicate
  state.activeTrackedQuizId = item.trackedSourceQuizId || null; // restore so finishing a resumed tracked quiz still syncs its score

  switchTab('create');
  showCreateStep('quiz');
  renderQuizQuestion();
}

// Retake -- a genuinely fresh attempt: clears answers/position and
// reshuffles, same as the in-quiz "Repeat Quiz" button, but reachable
// directly from the Library for a draft or a completed exam without first
// opening it. Still upserts into the SAME library entry (via
// currentLibraryId) so retaking doesn't create a duplicate, and still adds
// a new row to that entry's attempt history once finished.
function retakeQuizFromLibrary(item) {
  if (!item || !item.quizData) return;

  state.quiz = { ...item.quizData, questions: shuffleArray(item.quizData.questions || []) };
  state.subject = item.subject;
  state.examTitle = item.examTitle || item.title;
  state.answers = {};
  state.essayGrades = {};
  state.quizIndex = 0;
  state.isQuizComplete = false;
  state.quizTimerStartedAt = null;
  state.currentLibraryId = item.id || null;
  state.activeTrackedQuizId = item.trackedSourceQuizId || null; // restore so a retake still syncs its score back if this came from a tracked link

  switchTab('create');
  showCreateStep('quiz');
  renderQuizQuestion();
}

// Edit an existing saved exam's questions -- reuses the Manual Builder
// screen (which already has full add/remove support for every question
// type, including the three added this session) rather than building a
// separate inline-edit UI. There's no per-question "modify in place" --
// editing means removing a question and re-adding a corrected version,
// same as building a manual exam from scratch, just pre-loaded with the
// existing questions instead of starting empty. Saving (btnStartManualExam,
// labelled "Save Exam") upserts back into this same library entry via
// currentLibraryId rather than creating a duplicate.
function editQuizFromLibrary(item) {
  if (!item || !item.quizData) return;

  state.manualQuestions = (item.quizData.questions || []).map((q) => ({ ...q }));
  state.examTitle = item.examTitle || item.title;
  state.subject = item.subject;
  state.generationMode = 'manual';
  state.currentLibraryId = item.id || null;

  switchTab('create');
  $('examTitleInput').value = state.examTitle;
  $('subjectSelect').value = state.subject || '';
  $('manualTimeLimitInput').value = item.quizData.timeLimitMinutes || '';
  setGenerationMode('manual');
  $('btnRegenerateQuiz').hidden = false;
  $('btnSaveAsNewCopy').hidden = false;
  $('btnDeleteQuiz').hidden = false;
  renderManualBuilder();
  showCreateStep('manualBuilder');
}

// Edit screen's own delete action (see editQuizFromLibrary above) --
// permanent, so confirm first the same way Backup & Restore's "Restore"
// does elsewhere in this file.
function deleteQuizFromLibrary(item) {
  if (!item) return;
  const title = item.examTitle || item.title || 'this quiz';
  if (!confirm(`Delete "${title}"? This can't be undone.`)) return;
  const idx = LIBRARY_EXAMS.findIndex((e) => e.id === item.id);
  if (idx !== -1) LIBRARY_EXAMS.splice(idx, 1);
  saveLibraryExams();
  state.currentLibraryId = null;
  switchTab('library');
}
$('btnDeleteQuiz').addEventListener('click', () => {
  const item = LIBRARY_EXAMS.find((e) => e.id === state.currentLibraryId);
  deleteQuizFromLibrary(item);
});

// Builds a single, fully self-contained HTML file that can take this exam
// completely offline -- no dependency on sQUIZit itself, no network call,
// no external CSS/JS/fonts (everything inlined). Objective question types
// grade themselves client-side with the same logic as the real app
// (deliberately re-implemented inline, not shared code, since this file
// has to stand entirely on its own once it leaves the app); essay
// questions show the model answer instead of an AI grade, since there's no
// Gemini key or network assumed once shared out.
function buildStandaloneQuizHtml(quiz, examTitle, subject) {
  const questions = quiz.questions || [];
  // "</" is escaped so a question/answer containing the literal text
  // "</script>" can't prematurely close this JSON block once it's embedded
  // in the page below.
  const dataJson = JSON.stringify({ examTitle, subject, questions }).replace(/<\//g, '<\\/');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(examTitle)} — sQUIZit Exam</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 640px; margin: 0 auto; padding: 20px 16px 60px; line-height: 1.5; color: #12172B; background: #FFF8F0; }
  h1 { font-size: 1.3rem; margin-bottom: 4px; }
  .sub { color: #6b7280; font-size: 0.85rem; margin-bottom: 20px; }
  .q { border: 1px solid #F2E4D2; border-radius: 12px; padding: 16px; margin-bottom: 14px; background: #fff; }
  .q-prompt { font-weight: 600; margin-bottom: 10px; }
  .choice { display: block; width: 100%; text-align: left; padding: 10px 14px; margin-bottom: 6px; border: 1.5px solid #F2E4D2; border-radius: 8px; background: none; font-size: 0.92rem; cursor: pointer; font-family: inherit; }
  .choice.sel { border-color: #F07824; background: #FFEAD4; font-weight: 700; }
  .choice.correct { border-color: #22B27D; background: #e8f8f1; }
  .choice.incorrect { border-color: #E0455C; background: #fdecee; }
  input[type=text], textarea { width: 100%; padding: 10px 12px; border: 1.5px solid #F2E4D2; border-radius: 8px; font-size: 0.92rem; box-sizing: border-box; font-family: inherit; }
  select { width: 100%; padding: 8px; border: 1.5px solid #F2E4D2; border-radius: 8px; font-size: 0.9rem; font-family: inherit; }
  .match-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .match-row span { flex: 1; font-weight: 600; font-size: 0.88rem; }
  .match-row select { flex: 1; }
  .ans-note { margin-top: 10px; padding: 10px; background: #FFF3D0; border-radius: 8px; font-size: 0.85rem; }
  #btnSubmit, #btnStartQuiz { width: 100%; padding: 14px; background: #F07824; color: #fff; border: none; border-radius: 999px; font-size: 1rem; font-weight: 700; cursor: pointer; margin-top: 10px; font-family: inherit; }
  #btnSubmit:disabled, #btnStartQuiz:disabled { opacity: 0.6; }
  #btnRetake { width: 100%; padding: 14px; background: none; color: #F07824; border: 1.5px solid #F07824; border-radius: 999px; font-size: 1rem; font-weight: 700; cursor: pointer; margin-top: 10px; font-family: inherit; display: none; }
  #score { text-align: center; padding: 20px; background: #F07824; color: #fff; border-radius: 16px; margin-bottom: 20px; display: none; }
  #score .pct { font-size: 2.2rem; font-weight: 800; }
  .field { display: block; margin-bottom: 14px; font-size: 0.85rem; font-weight: 600; }
  .field input { display: block; width: 100%; margin-top: 6px; font-weight: 400; }
  #takerLine { font-weight: 600; margin-bottom: 4px; }
  @media (prefers-color-scheme: dark) {
    body { background: #16110B; color: #E5E7EB; }
    .q { background: #211810; border-color: #362415; }
    .choice { border-color: #362415; color: #E5E7EB; }
    input, textarea, select { background: #211810; border-color: #362415; color: #E5E7EB; }
    .ans-note { background: #3A2E0A; }
  }
</style>
</head>
<body>
<h1>${esc(examTitle)}</h1>
<p class="sub">${esc(subject || 'General')} &bull; ${questions.length} Questions &bull; Shared from sQUIZit (offline copy, not synced back)</p>

<div id="studentInfoGate" class="q">
  <div class="q-prompt">Before you begin, please fill in:</div>
  <label class="field">School/University<input type="text" id="siSchool" placeholder="Required"></label>
  <label class="field">Full Name<input type="text" id="siName" placeholder="Required"></label>
  <label class="field">Grade<input type="text" id="siGrade" placeholder="Required"></label>
  <label class="field">Section (optional)<input type="text" id="siSection" placeholder="Optional"></label>
  <button id="btnStartQuiz" type="button" disabled>Start Quiz</button>
</div>

<div id="quizContent" style="display:none;">
  <p id="takerLine"></p>
  <div id="score"><div class="pct" id="scorePct"></div><div id="scoreSummary"></div></div>
  <div id="questions"></div>
  <button id="btnSubmit" type="button">Submit Answers</button>
  <button id="btnRetake" type="button">Retake Quiz</button>
</div>
<!-- Read by the sQUIZit Android app when this file is opened via "Open
     with sQUIZit" -- MainActivity extracts this block by id and hands the
     JSON straight to the real app UI instead of this standalone fallback. -->
<script type="application/json" id="squizit-quiz-data">${dataJson}</script>
<script>
(function(){
  var DATA = JSON.parse(document.getElementById('squizit-quiz-data').textContent);
  var questions = DATA.questions;
  var answers = {};
  var submitted = false;

  // Collected once, before the first attempt, so whoever's results this is
  // can be identified -- e.g. by a teacher who shared the file out and is
  // reviewing what comes back. Retaking (see btnRetake below) reuses this
  // instead of asking again, since it's the same person in the same
  // session -- only a fresh open of the file asks again.
  var siSchool = document.getElementById('siSchool');
  var siName = document.getElementById('siName');
  var siGrade = document.getElementById('siGrade');
  var siSection = document.getElementById('siSection');
  var btnStartQuiz = document.getElementById('btnStartQuiz');

  function updateStartEnabled(){
    btnStartQuiz.disabled = !(siSchool.value.trim() && siName.value.trim() && siGrade.value.trim());
  }
  [siSchool, siName, siGrade].forEach(function(inp){ inp.addEventListener('input', updateStartEnabled); });

  btnStartQuiz.addEventListener('click', function(){
    var info = { school: siSchool.value.trim(), name: siName.value.trim(), grade: siGrade.value.trim(), section: siSection.value.trim() };
    document.getElementById('studentInfoGate').style.display = 'none';
    document.getElementById('quizContent').style.display = '';
    document.getElementById('takerLine').textContent = info.name + ' — ' + info.school + ' — Grade ' + info.grade + (info.section ? ' ' + info.section : '');
    window.scrollTo(0,0);
  });

  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function normalize(s){ return String(s==null?'':s).toLowerCase().trim().replace(/[.,!?;:'"()]/g,'').replace(/\\s+/g,' '); }
  function isObjective(t){ return ['multipleChoice','trueFalse','identification','matching','calculation'].indexOf(t) !== -1; }
  function isAnswered(q, a){
    if (q.type === 'matching') { var p = q.pairs||[]; return p.length>0 && p.every(function(_,i){ return a && a[i]!==undefined && a[i]!==''; }); }
    return a !== undefined && a !== null && String(a).trim() !== '';
  }
  function grade(q, a){
    if (!isAnswered(q,a)) return false;
    if (q.type==='multipleChoice'||q.type==='trueFalse') return normalize(a)===normalize(q.correctAnswer);
    if (q.type==='identification') {
      var accepted = (q.acceptableAnswers&&q.acceptableAnswers.length?q.acceptableAnswers:[q.correctAnswer]).map(normalize);
      return accepted.indexOf(normalize(a)) !== -1;
    }
    if (q.type==='calculation') {
      var given = parseFloat(String(a).replace(/,/g,'')), expected = parseFloat(String(q.correctAnswer).replace(/,/g,''));
      if (isNaN(given)||isNaN(expected)) return false;
      var tol = Math.max(0.01, Math.abs(expected)*0.01);
      return Math.abs(given-expected) <= tol;
    }
    if (q.type==='matching') return (q.pairs||[]).every(function(p,i){ return a[i]===p.right; });
    return false;
  }

  var el = document.getElementById('questions');
  el.innerHTML = questions.map(function(q, qi){
    var opts = '';
    if (q.type==='multipleChoice') {
      var choices = (q.choices&&q.choices.length)?q.choices:[];
      opts = '<div class="choices" data-qi="'+qi+'">' + choices.map(function(c){
        return '<button type="button" class="choice" data-choice="'+esc(c)+'">'+esc(c)+'</button>';
      }).join('') + '</div>';
    } else if (q.type==='trueFalse') {
      opts = '<div class="choices" data-qi="'+qi+'">'
        + '<button type="button" class="choice" data-choice="True">True</button>'
        + '<button type="button" class="choice" data-choice="False">False</button></div>';
    } else if (q.type==='matching') {
      opts = '<div class="matching" data-qi="'+qi+'">' + (q.pairs||[]).map(function(p, pi){
        var rightOpts = (q.pairs||[]).map(function(x){return x.right;});
        return '<div class="match-row"><span>'+esc(p.left)+'</span><select data-pi="'+pi+'"><option value="">Select…</option>'
          + rightOpts.map(function(r){ return '<option value="'+esc(r)+'">'+esc(r)+'</option>'; }).join('')
          + '</select></div>';
      }).join('') + '</div>';
    } else if (q.type==='essay') {
      opts = '<textarea rows="4" data-qi="'+qi+'" placeholder="Write your answer…"></textarea>';
    } else {
      opts = '<input type="text" data-qi="'+qi+'" placeholder="'+(q.type==='calculation'?'Enter a numeric answer':'Type your answer')+'">';
    }
    return '<div class="q" id="q'+qi+'"><div class="q-prompt">'+(qi+1)+'. '+esc(q.prompt)+'</div>'+opts+'<div class="ans-note" id="note'+qi+'" style="display:none;"></div></div>';
  }).join('');

  el.querySelectorAll('.choices').forEach(function(box){
    var qi = Number(box.dataset.qi);
    box.querySelectorAll('.choice').forEach(function(btn){
      btn.addEventListener('click', function(){
        if (submitted) return;
        answers[qi] = btn.dataset.choice;
        box.querySelectorAll('.choice').forEach(function(b){ b.classList.toggle('sel', b===btn); });
      });
    });
  });
  el.querySelectorAll('input[type=text], textarea').forEach(function(inp){
    inp.addEventListener('input', function(){ answers[Number(inp.dataset.qi)] = inp.value; });
  });
  el.querySelectorAll('.matching select').forEach(function(sel){
    sel.addEventListener('change', function(){
      var qi = Number(sel.closest('.matching').dataset.qi), pi = Number(sel.dataset.pi);
      answers[qi] = answers[qi] || {};
      answers[qi][pi] = sel.value;
    });
  });

  document.getElementById('btnSubmit').addEventListener('click', function(){
    submitted = true;
    var correctCount = 0, objectiveTotal = 0;
    questions.forEach(function(q, qi){
      var a = answers[qi];
      var note = document.getElementById('note'+qi);
      if (isObjective(q.type)) {
        objectiveTotal++;
        var ok = grade(q, a);
        if (ok) correctCount++;
        note.style.display = 'block';
        note.innerHTML = (ok ? '✅ Correct' : '❌ Correct answer: ' + esc(q.type==='matching' ? (q.pairs||[]).map(function(p){return p.left+' → '+p.right;}).join('; ') : q.correctAnswer))
          + (q.explanation ? '<br>' + esc(q.explanation) : '');
        var box = document.getElementById('q'+qi).querySelector('.choices');
        if (box) box.querySelectorAll('.choice').forEach(function(b){
          if (b.dataset.choice === q.correctAnswer) b.classList.add('correct');
          else if (b.classList.contains('sel')) b.classList.add('incorrect');
          b.disabled = true;
        });
      } else {
        note.style.display = 'block';
        note.innerHTML = 'Essay question — not auto-graded offline.' + (q.expectedAnswer ? '<br><strong>Model answer:</strong> ' + esc(q.expectedAnswer) : '');
      }
    });
    var pct = objectiveTotal ? Math.round((correctCount/objectiveTotal)*100) : 0;
    document.getElementById('score').style.display = 'block';
    document.getElementById('scorePct').textContent = pct + '%';
    document.getElementById('scoreSummary').textContent = correctCount + ' / ' + objectiveTotal + ' objective correct';
    document.getElementById('btnSubmit').disabled = true;
    document.getElementById('btnSubmit').textContent = 'Submitted';
    document.getElementById('btnRetake').style.display = 'block';
    window.scrollTo(0,0);
  });

  document.getElementById('btnRetake').addEventListener('click', function(){
    submitted = false;
    answers = {};
    document.getElementById('score').style.display = 'none';
    el.querySelectorAll('.choice').forEach(function(b){ b.classList.remove('sel','correct','incorrect'); b.disabled = false; });
    el.querySelectorAll('input[type=text], textarea').forEach(function(inp){ inp.value = ''; });
    el.querySelectorAll('.matching select').forEach(function(sel){ sel.value = ''; });
    el.querySelectorAll('.ans-note').forEach(function(n){ n.style.display = 'none'; n.innerHTML = ''; });
    document.getElementById('btnSubmit').disabled = false;
    document.getElementById('btnSubmit').textContent = 'Submit Answers';
    document.getElementById('btnRetake').style.display = 'none';
    window.scrollTo(0,0);
  });
})();
</script>
</body>
</html>`;
}

// Was: Web Share API (navigator.share/canShare with files) for the native
// app too, same as the plain web build. Looked right, but silently did
// nothing on-device -- Capacitor's WebView either doesn't expose
// navigator.canShare({files}) at all or refuses it for file objects, and
// the URL.createObjectURL()+<a download> fallback that ran after it has no
// download manager wired up inside a WebView, so it also did nothing.
// Net effect: tapping Share in the native app produced no error and no
// visible result -- indistinguishable from "broken." Native now goes
// through the real Filesystem+Share Capacitor plugins instead, which drive
// Android's actual ACTION_SEND file-share intent (Messenger, Bluetooth,
// Gmail, etc.) -- the same mechanism every other Android app uses to share
// a file. Plain web (GitHub Pages / desktop) keeps the original Web
// Share-then-download path, which does work in real browsers.
async function shareQuizAsHtml(item) {
  if (!item || !item.quizData) return;
  const title = item.examTitle || item.title || 'Quiz';
  const html = buildStandaloneQuizHtml(item.quizData, title, item.subject);
  // .squizit.html, not plain .html -- lets the sQUIZit Android app (which
  // registers itself as a "text/html" opener, see AndroidManifest.xml) tell
  // its own exported quizzes apart from every other html file on the
  // receiving phone. MainActivity only tries to pull quiz data out of files
  // that end this way; anything else it opens just shows as a normal page.
  const filename = `${title.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'quiz'}.squizit.html`;
  const shareText = `${title} — open this on a phone with sQUIZit installed to take it in the app, or in any browser to take it offline.`;

  if (isNativeApp()) {
    try {
      const { Filesystem, Share } = window.Capacitor.Plugins;
      const written = await Filesystem.writeFile({ path: filename, data: html, directory: 'CACHE', encoding: 'utf8' });
      await Share.share({ title, text: shareText, files: [written.uri], dialogTitle: 'Share Quiz' });
    } catch (e) {
      if (e && (e.message === 'Share canceled' || /cancel/i.test(e.message || ''))) return; // user backed out of the share sheet -- not a failure
      alert(`Couldn't share this quiz: ${e && e.message ? e.message : e}`);
    }
    return;
  }

  const file = new File([html], filename, { type: 'text/html' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title, text: shareText });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // user backed out of the share sheet -- not a failure
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// The file-share above works for Bluetooth/WhatsApp/Gmail/etc, but apps
// like Facebook Messenger only reliably accept plain text/links through the
// system share sheet, not arbitrary file attachments -- Messenger's own
// manifest, not something fixable from this app's side. This uploads the
// same standalone export to Supabase Storage (see supabase/functions/
// share-quiz) and shares a signed, time-limited URL instead, which every
// share target accepts since it's just text.
async function shareQuizAsLink(item) {
  if (!item || !item.quizData) return;
  const title = item.examTitle || item.title || 'Quiz';
  const html = buildStandaloneQuizHtml(item.quizData, title, item.subject);

  let url;
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/share-quiz`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      body: JSON.stringify({ html }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || `Upload failed (${res.status})`);
    url = data.url;
    if (!url) throw new Error('No link returned.');
  } catch (e) {
    alert(`Couldn't create a share link: ${e.message || e}`);
    return;
  }

  const text = `${title} — take this sQUIZit exam. Link works for 7 days.`;
  if (navigator.share) {
    try {
      await navigator.share({ title, text, url });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // user backed out of the share sheet -- not a failure
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    alert(`Link copied to clipboard (works for 7 days):\n${url}`);
  } catch (e) {
    alert(`Share link (works for 7 days):\n${url}`);
  }
}

// A third sharing option, distinct from both Share File and the anonymous
// Share Link above: this link is tied back to this device's creatorId, and
// a recipient's score syncs back to it automatically on finishing -- see
// the Monitoring tab. No expiry (unlike Share Link's 7-day signed URL) --
// meant to be a durable link a teacher can keep reusing.
async function shareQuizAndTrack(item) {
  if (!item || !item.quizData) return;
  const creatorId = ensureCreatorId();
  const title = item.examTitle || item.title || 'Quiz';

  // Reuse the same tracked row on repeat taps (persisted onto the Library
  // entry) instead of minting a new disconnected row every time -- otherwise
  // re-sharing an exam would fragment its recipients across multiple
  // unrelated Monitoring entries.
  if (!item.trackedQuizId) {
    try {
      const data = await callEdgeFunction('create-tracked-quiz', {
        creatorId, examTitle: title, subject: item.subject, quizData: item.quizData,
      });
      item.trackedQuizId = data.id;
      saveLibraryExams();
    } catch (e) {
      alert(`Couldn't set up tracking for this quiz: ${e.message || e}`);
      return;
    }
  }

  const url = `${location.origin}${location.pathname}?quiz=${item.trackedQuizId}`;
  const text = `${title} — take this sQUIZit exam. Your score will be shared with the creator.`;
  if (navigator.share) {
    try {
      await navigator.share({ title, text, url });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // user backed out of the share sheet -- not a failure
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    alert(`Tracked link copied to clipboard:\n${url}`);
  } catch (e) {
    alert(`Tracked share link:\n${url}`);
  }
}

// Open a completed exam read-only, reusing the same results renderer a
// live "Finish exam" uses -- restores the saved answers/grades instead of
// the live in-progress state.
function viewCompletedExam(item) {
  if (!item || !item.quizData) return;

  state.quiz = { ...item.quizData, questions: item.quizData.questions || [] };
  state.subject = item.subject;
  state.examTitle = item.examTitle || item.title;
  state.answers = item.answers ? { ...item.answers } : {};
  state.essayGrades = item.essayGrades ? { ...item.essayGrades } : {};
  state.isQuizComplete = true; // reviewing, not taking -- also stops beforeunload from re-saving this as a fresh draft
  state.currentLibraryId = item.id || null;

  switchTab('create');
  showCreateStep('results');
  renderResults();
}

/* ============ Backup & Restore ============ */
// Local (phone) backup/restore always works, no account needed. Google
// Drive backup follows the exact same Google Identity Services token-flow
// pattern as Winfinity's own Drive backup (raw fetch to the Drive REST API,
// no gapi client library) -- but needs its OWN OAuth client, since a
// client ID is tied to one app's identity/consent screen. Disabled
// entirely (buttons hidden) until config.js's GOOGLE_CLIENT_ID is filled
// in -- see README.md for how to create one.

function driveConfigured() {
  return typeof GOOGLE_CLIENT_ID === 'string' && GOOGLE_CLIENT_ID.trim().length > 0;
}

function buildBackupPayload() {
  return {
    app: 'sQUIZit',
    version: APP_VERSION,
    exportedAt: new Date().toISOString(),
    library: LIBRARY_EXAMS,
    studentIdentity: state.studentIdentity || null,
  };
}

function applyBackupPayload(payload) {
  if (!payload || !Array.isArray(payload.library)) throw new Error('This file doesn\'t look like a sQUIZit backup.');
  LIBRARY_EXAMS.length = 0;
  LIBRARY_EXAMS.push(...payload.library);
  saveLibraryExams();
  if (payload.studentIdentity) {
    state.studentIdentity = payload.studentIdentity;
    saveStudentIdentity(state.studentIdentity);
    renderStudentIdentityCard();
  }
  renderLibrary();
  renderHome();
}

function downloadBackupJSON() {
  const payload = buildBackupPayload();
  const filename = `squizit-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([JSON.stringify(payload, null, 2)], filename, { type: 'application/json' });
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  $('backupStatusText').textContent = `Backed up ${payload.library.length} exam(s) to your device.`;
}

$('btnBackupPhone').addEventListener('click', downloadBackupJSON);

$('btnRestorePhone').addEventListener('click', () => $('restoreFileInput').click());
$('restoreFileInput').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    if (!confirm(`Restore ${payload.library?.length ?? '?'} exam(s) from this backup? This replaces your current library on this device.`)) return;
    applyBackupPayload(payload);
    $('backupStatusText').textContent = `Restored ${payload.library.length} exam(s) from ${esc(file.name)}.`;
  } catch (e) {
    $('backupStatusText').textContent = `Could not restore that file: ${e.message}`;
  }
});

/* ---- Google Drive ---- */

let driveTokenClient = null;
let driveAccessToken = null;
const DRIVE_FILE_ID_KEY = 'quizforge-drive-file-id';

function refreshDriveUi() {
  const configured = driveConfigured();
  $('btnConnectDrive').hidden = !configured;
  if (!configured) {
    $('driveStatus').textContent = 'Not set up yet -- see README.md for how to enable Google Drive backup.';
    $('driveActionsRow').hidden = true;
    return;
  }
  const connected = !!driveAccessToken;
  $('driveActionsRow').hidden = !connected;
  $('btnConnectDrive').hidden = connected;
  $('driveStatus').textContent = connected ? 'Connected.' : 'Not connected.';
}

let driveInitError = null;

function initDrive() {
  if (!driveConfigured() || typeof google === 'undefined' || !google.accounts?.oauth2) return;
  try {
    driveTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email',
      callback: (resp) => {
        if (resp.error) { $('backupStatusText').textContent = `Google sign-in failed: ${resp.error}`; return; }
        driveAccessToken = resp.access_token;
        refreshDriveUi();
        $('backupStatusText').textContent = 'Connected to Google Drive.';
      },
    });
  } catch (e) {
    driveInitError = e.message || String(e);
  }
}

// Google Identity Services (the JS library initDrive()/loadGsiScript() below
// use) refuses to run inside ANY embedded WebView, including this one --
// confirmed on-device: curl on the same device fetches the GIS script fine,
// but the WebView's own fetch() to the identical URL fails every time with
// a generic "Failed to fetch". This isn't a bug fixable with retries; it's
// Google deliberately blocking WebView contexts as an anti-phishing measure.
// So the native app uses a completely different path: open the OAuth
// consent screen in the real system browser (via window.open, the same
// proven external-navigation mechanism already used for the Gemini API key
// link and the native update APK download), then hand the result back in
// through oauth-redirect.html -> the app's custom URL scheme ->
// MainActivity.onNewIntent() -> window.handleOAuthRedirect() below.
let driveOAuthState = null;

function connectDriveNative() {
  driveOAuthState = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: 'https://winf-os.github.io/sQUIZit/oauth-redirect.html',
    response_type: 'token',
    scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email',
    include_granted_scopes: 'true',
    prompt: 'consent',
    state: driveOAuthState,
  });
  $('backupStatusText').textContent = 'Opening Google sign-in in your browser…';
  window.open('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString(), '_blank', 'noopener');
}

// Called from native (MainActivity.onNewIntent -> evaluateJavascript) once
// the system browser hands control back via the custom URL scheme.
window.handleOAuthRedirect = function (fragment) {
  const params = new URLSearchParams(fragment);
  if (params.get('error')) {
    $('backupStatusText').textContent = `Google sign-in failed: ${params.get('error')}`;
    return;
  }
  const token = params.get('access_token');
  if (!token) return;
  if (!driveOAuthState || params.get('state') !== driveOAuthState) {
    $('backupStatusText').textContent = 'Google sign-in response did not match this request -- please try again.';
    return;
  }
  driveOAuthState = null;
  driveAccessToken = token;
  refreshDriveUi();
  $('backupStatusText').textContent = 'Connected to Google Drive.';
};

$('btnConnectDrive').addEventListener('click', () => {
  if (isNativeApp()) { connectDriveNative(); return; }
  if (!driveTokenClient) {
    let diag = driveInitError || window.__firstUncaughtError;
    if (!diag) {
      diag = typeof google === 'undefined'
        ? 'the accounts.google.com/gsi/client script never loaded (window.google is undefined)'
        : (!google.accounts ? 'google.accounts is undefined' : 'google.accounts.oauth2 is undefined');
    }
    $('backupStatusText').textContent = `Google sign-in is still loading -- try again in a moment. (diag: ${diag})`;
    return;
  }
  driveTokenClient.requestAccessToken({ prompt: 'consent' });
});

async function driveErrorDetail(res) {
  try {
    const body = await res.json();
    return body?.error?.message || JSON.stringify(body);
  } catch (e) {
    return '(no error body)';
  }
}

async function saveToDrive() {
  if (!driveAccessToken) return;
  $('backupStatusText').textContent = 'Backing up to Drive…';
  const payload = buildBackupPayload();
  const existingId = localStorage.getItem(DRIVE_FILE_ID_KEY);
  const boundary = 'squizit-backup-boundary';
  const metadata = { name: 'squizit-backup.json', mimeType: 'application/json' };
  const body =
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(payload)}\r\n--${boundary}--`;

  try {
    const url = existingId
      ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart`
      : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;
    const res = await fetch(url, {
      method: existingId ? 'PATCH' : 'POST',
      headers: { Authorization: `Bearer ${driveAccessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    if (!res.ok) throw new Error(`Drive returned HTTP ${res.status}: ${await driveErrorDetail(res)}`);
    const data = await res.json();
    if (data.id) localStorage.setItem(DRIVE_FILE_ID_KEY, data.id);
    $('backupStatusText').textContent = `Backed up ${payload.library.length} exam(s) to Google Drive.`;
  } catch (e) {
    $('backupStatusText').textContent = `Drive backup failed: ${e.message}`;
  }
}
$('btnBackupDrive').addEventListener('click', saveToDrive);

async function restoreFromDrive() {
  if (!driveAccessToken) return;
  const fileId = localStorage.getItem(DRIVE_FILE_ID_KEY);
  if (!fileId) { $('backupStatusText').textContent = 'No Drive backup found yet -- back up first.'; return; }
  $('backupStatusText').textContent = 'Checking Drive backup…';
  try {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${driveAccessToken}` },
    });
    if (!res.ok) throw new Error(`Drive returned HTTP ${res.status}: ${await driveErrorDetail(res)}`);
    const payload = await res.json();
    if (!confirm(`Restore ${payload.library?.length ?? '?'} exam(s) from your Google Drive backup? This replaces your current library on this device.`)) return;
    applyBackupPayload(payload);
    $('backupStatusText').textContent = `Restored ${payload.library.length} exam(s) from Google Drive.`;
  } catch (e) {
    $('backupStatusText').textContent = `Drive restore failed: ${e.message}`;
  }
}
$('btnRestoreDrive').addEventListener('click', restoreFromDrive);

refreshDriveUi();

/* ---- Digital ID ---- */

// A third backup destination for the exact same buildBackupPayload()/
// applyBackupPayload() pair used by the local-file and Drive paths above --
// not a separate identity-only mechanism. Backed by the digital_identities
// table (PIN-gated, since this bundles real PII) via save-digital-id-backup/
// restore-digital-id-backup. See also the "Have a Digital ID? Restore it
// instead" path on the mandatory Student Identity modal, which calls
// restore-digital-id-backup directly and reuses applyBackupPayload the same
// way.

function refreshDigitalIdUi() {
  const id = state.digitalId;
  $('digitalIdCurrentText').textContent = id ? `Your Digital ID: ${id}` : 'Not set up yet.';
  $('btnCopyDigitalId').hidden = !id;
  $('btnDigitalIdBackup').textContent = id ? '🔑 Update Digital ID Backup' : '🔑 Back Up via Digital ID';
}

$('btnCopyDigitalId').addEventListener('click', async () => {
  if (!state.digitalId) return;
  try {
    await navigator.clipboard.writeText(state.digitalId);
    alert(`Digital ID copied to clipboard:\n${state.digitalId}`);
  } catch (e) {
    alert(`Your Digital ID:\n${state.digitalId}`);
  }
});

let digitalIdModalMode = 'backup'; // 'backup' | 'restore'

function openDigitalIdModal(mode) {
  digitalIdModalMode = mode;
  $('digitalIdFieldBlock').hidden = mode === 'backup'; // backup never asks for an id -- it's generated (new) or already known locally (update)
  $('digitalIdModalTitle').textContent = mode === 'backup'
    ? (state.digitalId ? 'Update Digital ID Backup' : 'Back Up via Digital ID')
    : 'Restore via Digital ID';
  $('digitalIdModalSub').textContent = mode === 'backup'
    ? (state.digitalId ? 'Enter your PIN to update this backup.' : 'Choose a PIN (at least 6 characters). Write it down -- there is no PIN recovery.')
    : 'Enter the Digital ID and PIN you backed up with.';
  $('digitalIdInputId').value = '';
  $('digitalIdInputPin').value = '';
  $('digitalIdModalError').hidden = true;
  $('digitalIdModal').hidden = false;
}

$('btnDigitalIdBackup').addEventListener('click', () => openDigitalIdModal('backup'));
$('btnDigitalIdRestore').addEventListener('click', () => openDigitalIdModal('restore'));
$('btnDigitalIdModalClose').addEventListener('click', () => { $('digitalIdModal').hidden = true; });

$('btnDigitalIdModalSubmit').addEventListener('click', async () => {
  const pin = $('digitalIdInputPin').value;
  if (pin.length < 6) {
    $('digitalIdModalError').textContent = 'PIN must be at least 6 characters.';
    $('digitalIdModalError').hidden = false;
    return;
  }
  const btn = $('btnDigitalIdModalSubmit');
  btn.disabled = true;
  btn.textContent = 'Please wait…';
  try {
    if (digitalIdModalMode === 'backup') {
      const data = await callEdgeFunction('save-digital-id-backup', {
        digitalId: state.digitalId || undefined,
        pin,
        payload: buildBackupPayload(),
      });
      state.digitalId = data.digitalId;
      saveDigitalIdLocally(data.digitalId);
      refreshDigitalIdUi();
      $('digitalIdModal').hidden = true;
      $('backupStatusText').textContent = `Backed up to Digital ID ${data.digitalId}.`;
    } else {
      const digitalId = $('digitalIdInputId').value.trim();
      if (!digitalId) {
        $('digitalIdModalError').textContent = 'Enter your Digital ID.';
        $('digitalIdModalError').hidden = false;
        return;
      }
      if (!confirm('Restore your identity and library from this Digital ID? This replaces your current library on this device.')) return;
      const data = await callEdgeFunction('restore-digital-id-backup', { digitalId, pin });
      applyBackupPayload(data.payload);
      state.digitalId = digitalId;
      saveDigitalIdLocally(digitalId);
      refreshDigitalIdUi();
      $('digitalIdModal').hidden = true;
      $('backupStatusText').textContent = `Restored from Digital ID ${digitalId}.`;
    }
  } catch (e) {
    $('digitalIdModalError').textContent = e.message || 'Something went wrong.';
    $('digitalIdModalError').hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Continue';
  }
});

refreshDigitalIdUi();
// The GIS script tag was previously static in index.html -- but a static
// <script src> only fetches ONCE at page load. In the native app that
// single fetch was found to fail outright (confirmed via an on-device diag:
// "window.google is undefined" even after 20s of polling) -- no amount of
// polling for google.accounts.oauth2 to appear can ever help if the one
// network request behind it already failed, since nothing was re-asking
// the browser to actually fetch it again. A retrying dynamic <script src>
// still failed every attempt on a real device, though -- confirmed (via
// adb/curl from that same device) that the device itself could fetch this
// exact URL fine, meaning the WebView's own resource-loading network path
// was what was broken, not connectivity in general. Capacitor's bundled
// CapacitorHttp plugin transparently reroutes window.fetch()/XHR through
// native Android networking (the same path curl uses) -- but that patch
// only covers JS-level fetch/XHR, not raw <script src> tags, which the
// WebView still loads itself. So: fetch the script as text (through the
// native-routed fetch) and execute it locally via a blob URL instead of
// ever asking the WebView to load the remote URL directly as a script.
const GSI_SCRIPT_URL = 'https://accounts.google.com/gsi/client';
const GSI_MAX_ATTEMPTS = 5;
function loadGsiScript(attempt) {
  attempt = attempt || 0;
  if (typeof google !== 'undefined' && google.accounts?.oauth2) { initDrive(); return; }
  if (attempt >= GSI_MAX_ATTEMPTS) {
    driveInitError = `accounts.google.com/gsi/client failed after ${GSI_MAX_ATTEMPTS} attempts -- last reason: ${driveInitError || '(none captured)'}`;
    return;
  }
  const url = attempt === 0 ? GSI_SCRIPT_URL : `${GSI_SCRIPT_URL}?retry=${attempt}-${Date.now()}`;
  fetch(url)
    .then((res) => { if (!res.ok) throw new Error('HTTP ' + res.status); return res.text(); })
    .then((text) => {
      const blobUrl = URL.createObjectURL(new Blob([text], { type: 'application/javascript' }));
      const script = document.createElement('script');
      script.src = blobUrl;
      script.onload = () => {
        URL.revokeObjectURL(blobUrl);
        // onload fires once the script executes, but google.accounts.oauth2
        // can take a beat longer to actually be assigned -- give it a short
        // poll window before treating this attempt as failed and retrying.
        let pollTries = 0;
        const poll = setInterval(() => {
          pollTries++;
          if (typeof google !== 'undefined' && google.accounts?.oauth2) {
            clearInterval(poll);
            initDrive();
          } else if (pollTries >= 10) {
            clearInterval(poll);
            loadGsiScript(attempt + 1);
          }
        }, 300);
      };
      script.onerror = () => {
        URL.revokeObjectURL(blobUrl);
        driveInitError = `accounts.google.com/gsi/client fetched but failed to execute, attempt ${attempt + 1}/${GSI_MAX_ATTEMPTS}`;
        setTimeout(() => loadGsiScript(attempt + 1), 1000 * (attempt + 1));
      };
      document.head.appendChild(script);
    })
    .catch((e) => {
      driveInitError = `accounts.google.com/gsi/client fetch failed (${e.message}), attempt ${attempt + 1}/${GSI_MAX_ATTEMPTS}`;
      setTimeout(() => loadGsiScript(attempt + 1), 1000 * (attempt + 1));
    });
}
// GIS is native-app-broken by design (see connectDriveNative() above) --
// no point burning 5 retries/~15s on a load that can never succeed there.
if (driveConfigured() && !isNativeApp()) loadGsiScript();
