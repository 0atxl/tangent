import { inject as injectVercelAnalytics } from '@vercel/analytics';
import './styles/tokens.css';
import './styles/main.css';
import './styles/wiki-reader.css';

import { LANGUAGES, getLanguage } from './data/languages.js';
import {
  DIFFICULTY_TIERS,
  PACKS,
  formatUtcDate,
  generateTieredChallenge,
  getDailyForDate,
  getRecentDays,
  makePairKey,
  setLiveDailyOverride,
  setLiveTrendingPool
} from './data/packs.js';
import {
  clearActiveGame,
  getActiveGame,
  getClientId,
  getDailyHistory,
  getNickname,
  getPersonalBests,
  getPrefs,
  getStreak,
  saveActiveGame,
  saveDailyResult,
  savePersonalBest,
  setNickname,
  updatePrefs
} from './lib/storage.js';
import { cycleTheme, getEffectiveTheme, initThemeSync } from './lib/theme.js';
import {
  isSoundEnabled,
  playBack,
  playCountdown,
  playShuffle,
  playStep,
  playTap,
  playThud,
  playWin,
  toggleSound
} from './lib/sound.js';
import {
  cancelActivePrefetches,
  fetchBacklinkHint,
  fetchWikiArticle,
  fetchWikiSummary,
  getCachedWikiSummary,
  isAbortError,
  normTitle,
  prefetchWikiArticle,
  searchWikiTitles
} from './lib/wikipedia.js';
import { createHovercard } from './lib/hovercard.js';
import { openPauseGate } from './lib/pauseGate.js';
import { launchBrandConfetti, openJokePaywall } from './lib/paywall.js';
import {
  buildRouteSVG,
  buildShareText,
  downloadShareCardPNG,
  formatTime
} from './lib/shareCard.js';
import {
  createRoom,
  fetchGlobalRecord,
  fetchLiveDaily,
  getRoomState,
  joinRoom,
  startRoom,
  submitScore,
  syncRoomProgress
} from './lib/apiClient.js';

const $ = (id) => document.getElementById(id);

const PACK_ART = {
  pop: '<rect x="3" y="6" width="18" height="14" rx="2.5"/><path d="M3 10h18M8 6l2 4M14 6l2 4M10 13.5l5 2.5-5 2.5z"/>',
  science: '<ellipse cx="12" cy="12" rx="9" ry="3.8"/><ellipse cx="12" cy="12" rx="9" ry="3.8" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="9" ry="3.8" transform="rotate(120 12 12)"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/>',
  india: '<path d="M5 20h14M7 20v-7a5 5 0 0 1 10 0v7"/><path d="M12 4v4M9 11c0-1.5 1.3-3 3-3s3 1.5 3 3"/><circle cx="12" cy="15" r="2"/>',
  anime: '<path d="M12 3l2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6z"/><circle cx="18.5" cy="5.5" r="1.5"/>',
  myth: '<path d="M13 3L5 14h6l-1 7 9-11h-6z"/>',
  hi: '<text x="12" y="17.5" font-size="16" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none" font-family="serif">अ</text>',
  gu: '<text x="12" y="17.5" font-size="16" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none" font-family="serif">અ</text>'
};

const app = {
  clientId: getClientId(),
  activeTab: 'daily',
  selectedTier: 'medium',
  customTier: 'medium',
  roomTier: 'medium',
  customLang: 'en',
  roomLang: 'en',
  roomMode: 'clicks',
  tocCollapsed: false,
  asideCollapsed: false,
  game: null,
  timerInterval: null,
  navSeq: 0,
  navAbort: null,
  navLoading: false,
  pauseGateOpen: false,
  closePauseGate: null,
  launchingDaily: false,
  liveDailyFetches: new Map(),
  historyGuardActive: false,
  lastPersistAt: 0,
  room: null,
  roomPollInterval: null,
  countdownInterval: null,
  hovercard: null,
  toastTimer: null,
  tocScrollCancel: null
};

// ==================== Toast Helper ====================
function showToast(msg) {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(app.toastTimer);
  app.toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ==================== Dialog Light-Dismiss Fallback (Safari) ====================
function installDialogLightDismissFallback() {
  if ('closedBy' in HTMLDialogElement.prototype) return;
  const isOutside = (e, dialog) => {
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  document.querySelectorAll('dialog[closedby="any"]').forEach((dialog) => {
    let pressedOutside = false;
    dialog.addEventListener('pointerdown', (e) => {
      pressedOutside = isOutside(e, dialog);
    });
    dialog.addEventListener('pointerup', (e) => {
      if (pressedOutside && isOutside(e, dialog)) dialog.close();
    });
  });
}

// ==================== Header Chrome & Toggles ====================
function renderThemeButton() {
  const theme = getEffectiveTheme();
  const icon = $('themeIcon');
  const label = $('themeLabel');
  if (!icon || !label) return;

  if (theme === 'light') {
    label.textContent = 'Light';
    icon.innerHTML = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>';
  } else if (theme === 'dark') {
    label.textContent = 'Dark';
    icon.innerHTML = '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>';
  } else {
    label.textContent = 'OLED';
    icon.innerHTML = '<circle cx="12" cy="12" r="9" fill="currentColor"/><path d="M12 3a9 9 0 0 1 0 18z" fill="var(--bg)" stroke="none"/>';
  }
}

function renderSoundButton() {
  const on = isSoundEnabled();
  const icon = $('soundIcon');
  if (!icon) return;
  icon.innerHTML = on
    ? '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9.5 9.5 0 0 1 0 14"/>'
    : '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>';
}

function renderVipAndContrast() {
  const prefs = getPrefs();
  const isVip = Boolean(prefs.vipPaidZero);
  $('vipBadge').classList.toggle('hide', !isVip);
  $('proBtn')?.classList.toggle('hide', isVip);
  $('footerProBtn')?.classList.toggle('hide', isVip);
  $('contrastToggleBtn').textContent = `High Contrast: ${prefs.highContrast ? 'On' : 'Off'}`;
  if (prefs.highContrast) document.documentElement.dataset.contrast = 'high';
  else delete document.documentElement.dataset.contrast;
}

// ==================== Confirmation Modal & Active Challenge Leave Guard ====================
function isActiveChallengeRunning() {
  const gameVisible = !$('viewGame')?.classList.contains('hide');
  return Boolean(gameVisible && app.game && !app.game.finished);
}

function openConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm = () => {},
  onCancel = () => {}
}) {
  const dialog = $('confirmDialog');
  const body = $('confirmDialogBody');
  if (!dialog || !body) {
    onConfirm();
    return;
  }
  if (dialog.open) return;

  body.innerHTML = `
    <h2 id="confirmTitle" class="confirm-dialog-title">${escapeHtml(title)}</h2>
    <p class="confirm-dialog-msg">${escapeHtml(message)}</p>
    <form method="dialog" class="confirm-dialog-actions">
      <button type="submit" class="btn" value="cancel" autofocus>${escapeHtml(cancelLabel)}</button>
      <button type="submit" class="btn ${destructive ? 'btn-danger' : 'btn-primary'}" value="confirm">${escapeHtml(confirmLabel)}</button>
    </form>
  `;

  dialog.addEventListener(
    'close',
    () => {
      const choice = dialog.returnValue;
      dialog.returnValue = '';
      if (choice === 'confirm') {
        playTap();
        onConfirm();
      } else {
        playTap();
        onCancel();
      }
    },
    { once: true }
  );

  dialog.showModal();
}

function confirmLeaveChallenge(actionLabel, onConfirm) {
  if (!isActiveChallengeRunning()) {
    onConfirm();
    return;
  }
  const g = app.game;
  const msg = g.roomCode
    ? `You are in Live Race Room ${g.roomCode} (${g.start} → ${g.target}). Leaving now will pull you out of the active race.`
    : `Your run (${g.start} → ${g.target}) is automatically saved, so you can continue later from Home — or stay right here.`;

  openConfirmDialog({
    title: 'Leave current challenge?',
    message: msg,
    confirmLabel: actionLabel || 'Leave Challenge',
    cancelLabel: 'Stay in Challenge',
    destructive: Boolean(g.roomCode),
    onConfirm
  });
}

function pushGameHistoryGuard() {
  try {
    if (!history.state?.tangentGuard) {
      history.pushState({ tangentGuard: true }, '', window.location.href);
    }
    app.historyGuardActive = true;
  } catch {
    // Ignore restricted history API contexts
  }
}

// ==================== Navigation Views ====================
function showView(name) {
  ['viewHome', 'viewCustom', 'viewRoom', 'viewGame', 'viewWin'].forEach((id) => {
    $(id).classList.toggle('hide', id !== name);
  });

  if (name !== 'viewGame') {
    stopTimer();
    app.tocScrollCancel?.();
    app.tocScrollCancel = null;
    app.closePauseGate?.();
    app.closePauseGate = null;
    app.pauseGateOpen = false;
    const confirmDialog = $('confirmDialog');
    if (confirmDialog?.open) confirmDialog.close();
    app.hovercard?.hide();
    app.navAbort?.abort();
    app.navAbort = null;
    app.navLoading = false;
    app.historyGuardActive = false;
    cancelActivePrefetches();
  }

  window.scrollTo({ top: 0, behavior: 'instant' });
}

function suspendActiveGameToBackground() {
  const g = app.game;
  if (!g || g.finished || g.roomCode) return;
  g.accumulatedMs = getElapsedMs();
  g.paused = true;
  persistActiveGame(false);
}

function setActiveTab(tab, { skipConfirm = false } = {}) {
  if (!skipConfirm && isActiveChallengeRunning()) {
    const label =
      tab === 'daily'
        ? 'Leave to Home'
        : tab === 'packs'
        ? 'Leave to Packs'
        : tab === 'room'
        ? 'Leave to Live Room'
        : 'Leave to Custom';
    confirmLeaveChallenge(label, () => setActiveTab(tab, { skipConfirm: true }));
    return;
  }

  if (!$('viewGame').classList.contains('hide')) {
    if (app.game?.roomCode && !app.game.finished) {
      app.game.finished = true;
      if (tab !== 'room') {
        stopRoomPolling();
        app.room = null;
        if (window.location.pathname.startsWith('/room/')) {
          history.replaceState({}, '', '/');
        }
      }
    } else {
      suspendActiveGameToBackground();
      clearChallengeUrl();
    }
  }

  app.activeTab = tab;
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  if (tab === 'daily') {
    document.title = 'Tangent — Daily Wikipedia Link-Racing Puzzle Game';
    showView('viewHome');
    renderHome();
  } else if (tab === 'packs') {
    document.title = 'Curated Packs — Tangent';
    showView('viewHome');
    renderHome();
    requestAnimationFrame(() => {
      $('tierSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  } else if (tab === 'custom') {
    document.title = 'Custom Challenge — Tangent';
    showView('viewCustom');
  } else if (tab === 'room') {
    document.title = '10-Player Live Room — Tangent';
    showView('viewRoom');
    renderRoomView();
  }
}

// ==================== UTC Daily Countdown ====================
function startUtcCountdown() {
  function update() {
    const now = new Date();
    const nextUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0);
    const diff = Math.max(0, nextUtc - now.getTime());
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    const el = $('countdownText');
    if (el) el.textContent = `${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  }
  update();
  setInterval(update, 1000);
}

// ==================== Home: Daily, Streak Strip, Tier Selector & Packs ====================
function renderHomeResumeBanner() {
  const banner = $('homeResumeBanner');
  if (!banner) return;
  const saved = getActiveGame();
  if (!saved) {
    banner.classList.add('hide');
    banner.replaceChildren();
    return;
  }

  const currentArticle = saved.path[saved.path.length - 1] || saved.start;
  const score = (saved.moves?.length || 0) + (saved.hints || 0) + (saved.extraPenalties || 0);
  const dateStr = saved.dailyDate || saved.startedDate || formatUtcDate();

  banner.classList.remove('hide');
  banner.innerHTML = `
    <div class="resume-banner-info">
      <div class="resume-banner-kicker">In-Progress · ${escapeHtml(saved.titleLabel || 'Tangent')} · ${escapeHtml(dateStr)}</div>
      <div class="resume-banner-pair">${escapeHtml(saved.start)} → ${escapeHtml(saved.target)}</div>
      <div class="resume-banner-meta">On <strong>${escapeHtml(currentArticle)}</strong> · ${score} click${score === 1 ? '' : 's'} · ${formatTime(saved.accumulatedMs || 0)}</div>
    </div>
    <div class="resume-banner-actions">
      <button type="button" class="btn btn-primary btn-sm" id="homeContinueBtn">Continue</button>
      <button type="button" class="btn btn-ghost btn-sm" id="homeDiscardBtn">Discard</button>
    </div>
  `;

  $('homeContinueBtn')?.addEventListener('click', () => {
    playTap();
    resumeSavedGame(saved);
  });

  $('homeDiscardBtn')?.addEventListener('click', () => {
    playTap();
    clearActiveGame();
    clearChallengeUrl();
    renderHome();
    showToast('Saved challenge discarded');
  });
}

function fetchAndCacheLiveDaily(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return Promise.resolve(null);
  if (app.liveDailyFetches.has(dateStr)) return app.liveDailyFetches.get(dateStr);
  const req = fetchLiveDaily(dateStr)
    .then((live) => {
      if (!live || live.fallback) {
        app.liveDailyFetches.delete(dateStr);
        return null;
      }
      if (dateStr === formatUtcDate() && Array.isArray(live.trending) && live.trending.length) {
        setLiveTrendingPool(live.trending);
      }
      if (live.start && live.target) {
        setLiveDailyOverride(live.date || dateStr, live);
        return live;
      }
      app.liveDailyFetches.delete(dateStr);
      return null;
    })
    .catch(() => {
      app.liveDailyFetches.delete(dateStr);
      return null;
    });
  app.liveDailyFetches.set(dateStr, req);
  return req;
}

async function ensureLiveDaily(dateStr, timeoutMs = 1500) {
  const req = fetchAndCacheLiveDaily(dateStr);
  if (!timeoutMs) return req;
  return Promise.race([req, new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))]);
}

async function launchDailyByDate(dateStr = formatUtcDate()) {
  if (app.launchingDaily) return;

  const startFresh = async () => {
    if (app.launchingDaily) return;
    app.launchingDaily = true;
    try {
      await ensureLiveDaily(dateStr, 1500);
      const d = getDailyForDate(dateStr);
      const tMeta = DIFFICULTY_TIERS[d.tier] || DIFFICULTY_TIERS.medium;
      startSoloGame({
        start: d.start,
        target: d.target,
        lang: d.lang,
        par: d.par,
        tier: d.tier,
        titleLabel: `Daily #${d.dayNum}`,
        dailyDate: d.date,
        ...tMeta.rules
      });
    } finally {
      app.launchingDaily = false;
    }
  };

  const saved = getActiveGame();
  if (saved && saved.dailyDate === dateStr) {
    openResumePrompt(saved, { onDiscard: startFresh });
    return;
  }
  await startFresh();
}

function renderHome() {
  renderHomeResumeBanner();

  const daily = getDailyForDate();
  const dailyHist = getDailyHistory();
  const todayResult = dailyHist[daily.date];
  const savedActive = getActiveGame();
  const hasTodayInProgress = Boolean(savedActive && savedActive.dailyDate === daily.date);
  const streak = getStreak();
  const prefs = getPrefs();
  const activeTier = DIFFICULTY_TIERS[app.selectedTier] || DIFFICULTY_TIERS.medium;

  // Politely pre-warm Today's Daily start article in cache so Play Daily opens instantly
  prefetchWikiArticle(daily.start, daily.lang);

  $('dailyBannerLabel').textContent = `TODAY'S TANGENT #${daily.dayNum} · ${daily.date}`;
  $('dailyParChip').textContent = `PAR ${daily.par} · ${(daily.tier || 'medium').toUpperCase()}`;
  $('dailyStart').textContent = daily.start;
  $('dailyTarget').textContent = daily.target;

  $('playDailyBtn').textContent = hasTodayInProgress
    ? 'Continue Daily'
    : todayResult
    ? `Replay Daily (Best: ${todayResult.score})`
    : 'Play Daily';

  const metaEl = $('dailyMeta');
  metaEl.innerHTML = todayResult
    ? `<span>Solved today in <strong>${todayResult.score} clicks</strong> (${formatTime(todayResult.elapsedMs)})</span>`
    : `<span>Same puzzle for everyone today</span>`;

  fetchGlobalRecord(daily.pairKey).then((rec) => {
    if (!rec || rec.offline) return;
    const parts = [];
    if (todayResult) parts.push(`<span>Your best: <strong>${todayResult.score}</strong></span>`);
    if (rec.best !== null) parts.push(`<span>Global record: <strong>${rec.best} clicks</strong> by ${escapeHtml(rec.holder || 'Player')}</span>`);
    if (rec.plays > 0) parts.push(`<span>${rec.plays} run${rec.plays === 1 ? '' : 's'}</span>`);
    if (parts.length) metaEl.innerHTML = parts.join(' · ');
  });

  // Weekday Streak Strip (last 6 days + Archive tile)
  $('streakCaption').textContent =
    streak.count > 0
      ? `${streak.count}-day streak${streak.max > streak.count ? ` · Best ${streak.max}` : ''}`
      : `You're starting a new streak`;

  const recent = getRecentDays(6);
  const strip = $('weekdayStrip');
  strip.innerHTML =
    recent
      .map((d) => {
        const res = dailyHist[d.date];
        const cls = ['day-tile', d.isToday ? 'today' : '', res ? 'solved' : ''].filter(Boolean).join(' ');
        const iconContent = res ? `${res.score}` : '→';
        const pairStart = res?.path?.length >= 2 ? res.path[0] : d.start;
        const pairTarget = res?.path?.length >= 2 ? res.path[res.path.length - 1] : d.target;
        return `
          <button type="button" class="${cls}" data-daily-date="${d.date}" title="Tangent #${d.dayNum}: ${escapeHtml(pairStart)} → ${escapeHtml(pairTarget)}">
            <span class="day-tile-icon tabular">${iconContent}</span>
            <span class="day-tile-label">${d.label}</span>
          </button>
        `;
      })
      .join('') +
    `
      <button type="button" class="day-tile" id="openArchiveTile" title="Browse past dailies">
        <span class="day-tile-icon">
          <svg class="icon-svg" style="width:15px;height:15px;" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M8 2v4M16 2v4M3 10h18"/></svg>
        </span>
        <span class="day-tile-label">Archive</span>
      </button>
    `;

  strip.querySelectorAll('[data-daily-date]').forEach((btn) => {
    btn.addEventListener('click', () => {
      playTap();
      launchDailyByDate(btn.dataset.dailyDate);
    });
  });

  $('openArchiveTile')?.addEventListener('click', openArchiveModal);
  $('miniTutorial').classList.toggle('hide', Boolean(prefs.tutorialDone));

  // Render Tier Showcase state
  document.querySelectorAll('[data-tier]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tier === activeTier.id);
  });
  $('tierRuleDesc').textContent = activeTier.tagline;
  $('rollTierBtn').textContent = `Roll ${activeTier.name} Challenge`;
  $('packsTierSub').innerHTML = `Playing at <span class="tier-badge-chip ${activeTier.id}">${escapeHtml(activeTier.name)}</span> tier · ${escapeHtml(activeTier.tagline)}`;

  // Curated Packs Grid
  const pbs = getPersonalBests();
  $('packsGrid').innerHTML = PACKS.map((pack) => {
    const solvedCount = pack.pairs.filter(([a, b]) => Boolean(pbs[makePairKey(a, b, pack.lang)])).length;
    const tierPairs = pack.pairs.filter((p) => (p[3] || 'medium') === activeTier.id);
    const matchCount = tierPairs.length || pack.pairs.length;
    return `
      <div class="pack-card">
        <div class="pack-banner ${pack.accent}">
          ${pack.lang !== 'en' ? `<span class="pack-lang-chip">${pack.lang}</span>` : ''}
          <svg class="pack-art" viewBox="0 0 24 24" aria-hidden="true">${PACK_ART[pack.icon] || PACK_ART.pop}</svg>
        </div>
        <div class="pack-body">
          <h3 class="pack-name">${escapeHtml(pack.name)}</h3>
          <p class="pack-desc">${escapeHtml(pack.subtitle)}</p>
          <div class="pack-footer">
            <span class="pack-count tabular">${solvedCount}/${pack.pairs.length} solved · ${matchCount} ${activeTier.name}</span>
            <button type="button" class="btn btn-sm" data-pack-id="${pack.id}">Play ${activeTier.name}</button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  $('packsGrid').querySelectorAll('[data-pack-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      playShuffle();
      const pack = PACKS.find((p) => p.id === btn.dataset.packId);
      if (!pack) return;
      const pbsNow = getPersonalBests();
      const tierFiltered = pack.pairs.filter((p) => (p[3] || 'medium') === activeTier.id);
      const basePool = tierFiltered.length ? tierFiltered : pack.pairs;
      const unsolved = basePool.filter(([a, b]) => !pbsNow[makePairKey(a, b, pack.lang)]);
      const pool = unsolved.length ? unsolved : basePool;
      const [start, target, par] = pool[Math.floor(Math.random() * pool.length)];
      startSoloGame({
        start,
        target,
        lang: pack.lang,
        par: par || activeTier.par,
        tier: activeTier.id,
        titleLabel: `${pack.name} (${activeTier.name})`,
        packId: pack.id,
        ...activeTier.rules
      });
    });
  });
}

function openArchiveModal() {
  playTap();
  const dialog = $('archiveDialog');
  const grid = $('archiveGrid');
  const hist = getDailyHistory();
  const days = getRecentDays(24);

  grid.innerHTML = days
    .map((d) => {
      const r = hist[d.date];
      const pairStart = r?.path?.length >= 2 ? r.path[0] : d.start;
      const pairTarget = r?.path?.length >= 2 ? r.path[r.path.length - 1] : d.target;
      return `
        <button type="button" class="archive-item ${r ? 'solved' : ''}" data-arch-date="${d.date}">
          <small>#${d.dayNum} · ${d.date}</small>
          <strong>${escapeHtml(pairStart)} → ${escapeHtml(pairTarget)}</strong>
          <small style="margin-top:5px;color:${r ? 'var(--pop-mint)' : 'var(--muted)'};font-weight:700;">
            ${r ? `Solved · ${r.score} clicks` : `Par ${d.par} · ${(d.tier || 'medium').toUpperCase()}`}
          </small>
        </button>
      `;
    })
    .join('');

  grid.querySelectorAll('[data-arch-date]').forEach((btn) => {
    btn.addEventListener('click', () => {
      playTap();
      dialog.close();
      launchDailyByDate(btn.dataset.archDate);
    });
  });

  dialog.showModal();
}

// ==================== Searchable 15-Language Dropdown & Autocomplete ====================
function mountLanguagePicker(containerId, getVal, onSelect) {
  const wrap = $(containerId);
  if (!wrap) return;

  let open = false;
  let filter = '';

  function render() {
    const current = getLanguage(getVal());
    const filtered = LANGUAGES.filter(
      (l) =>
        l.name.toLowerCase().includes(filter.toLowerCase()) ||
        l.native.toLowerCase().includes(filter.toLowerCase()) ||
        l.code.toLowerCase().includes(filter.toLowerCase())
    );

    wrap.innerHTML = `
      <button type="button" class="lang-trigger" aria-expanded="${open}">
        <span>${escapeHtml(current.native)} <span style="color:var(--muted);font-weight:500;">(${escapeHtml(current.name)})</span></span>
        <span class="lang-code">${current.code} ▾</span>
      </button>
      ${
        open
          ? `
        <div class="lang-dropdown">
          <input type="search" class="lang-search" placeholder="Search language (German, French, Hindi…)" value="${escapeHtml(filter)}" aria-label="Search Wikipedia language">
          <div class="lang-list">
            ${
              filtered.length
                ? filtered
                    .map(
                      (l) => `
                  <button type="button" class="lang-option ${l.code === current.code ? 'active' : ''}" data-lang-code="${l.code}">
                    <span><strong>${escapeHtml(l.native)}</strong> · ${escapeHtml(l.name)}</span>
                    <span class="lang-code">${l.code}</span>
                  </button>`
                    )
                    .join('')
                : '<div style="padding:10px;font-size:0.85rem;color:var(--muted);">No matching language</div>'
            }
          </div>
        </div>`
          : ''
      }
    `;

    wrap.querySelector('.lang-trigger').addEventListener('click', (e) => {
      e.stopPropagation();
      playTap();
      open = !open;
      filter = '';
      render();
      if (open) wrap.querySelector('.lang-search')?.focus();
    });

    if (open) {
      const searchEl = wrap.querySelector('.lang-search');
      searchEl.addEventListener('click', (e) => e.stopPropagation());
      searchEl.addEventListener('input', (e) => {
        filter = e.target.value;
        const pos = e.target.selectionStart;
        render();
        const nextInput = wrap.querySelector('.lang-search');
        if (nextInput) {
          nextInput.focus();
          nextInput.setSelectionRange(pos, pos);
        }
      });

      wrap.querySelectorAll('[data-lang-code]').forEach((opt) => {
        opt.addEventListener('click', (e) => {
          e.stopPropagation();
          playTap();
          onSelect(opt.dataset.langCode);
          open = false;
          filter = '';
          render();
        });
      });
    }
  }

  document.addEventListener('click', (e) => {
    if (open && !wrap.contains(e.target)) {
      open = false;
      render();
    }
  });

  render();
  return render;
}

function attachWikiAutocomplete(inputId, listId, getLang) {
  const input = $(inputId);
  const list = $(listId);
  if (!input || !list) return;

  let timer = null;
  let seq = 0;

  function hide() {
    list.classList.add('hide');
    list.innerHTML = '';
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const val = input.value.trim();
    if (val.length < 2) {
      hide();
      return;
    }
    const reqId = ++seq;
    timer = setTimeout(async () => {
      const hits = await searchWikiTitles(val, getLang());
      if (reqId !== seq) return;
      if (!hits.length) {
        hide();
        return;
      }
      list.innerHTML = hits
        .map((h) => `<li><button type="button" class="ac-item" data-val="${escapeHtml(h.title)}">${escapeHtml(h.title)}</button></li>`)
        .join('');
      list.classList.remove('hide');
      list.querySelectorAll('.ac-item').forEach((btn) => {
        btn.addEventListener('click', () => {
          playTap();
          input.value = btn.dataset.val;
          hide();
        });
      });
    }, 220);
  });

  document.addEventListener('click', (e) => {
    if (e.target !== input && !list.contains(e.target)) hide();
  });
}

// ==================== 3-Column Collapsible Side Rails ====================
function syncRailLayoutClasses() {
  const layout = $('readerLayout');
  const tocRail = $('tocRail');
  const asideRail = $('asideRail');
  if (!layout || !tocRail || !asideRail) return;

  tocRail.classList.toggle('is-collapsed', app.tocCollapsed);
  asideRail.classList.toggle('is-collapsed', app.asideCollapsed);

  layout.classList.toggle('toc-collapsed', app.tocCollapsed);
  layout.classList.toggle('aside-collapsed', app.asideCollapsed);

  $('tocChevron').textContent = app.tocCollapsed ? '›' : '‹';
  $('asideChevron').textContent = app.asideCollapsed ? '‹' : '›';
}

function renderArticleToc(sections, { streaming = false } = {}) {
  const list = $('tocList');
  if (!list) return;
  list.replaceChildren();
  if (!sections || sections.length === 0) {
    list.innerHTML = `<div class="toc-empty-note" style="padding:8px;font-size:0.78rem;color:var(--muted);">${
      streaming ? 'Loading sections…' : 'Intro only (no sub-sections)'
    }</div>`;
    return;
  }
  appendArticleToc(sections);
}

function appendArticleToc(sections) {
  const list = $('tocList');
  if (!list || !sections || sections.length === 0) return;
  list.querySelector('.toc-empty-note')?.remove();

  const frag = document.createDocumentFragment();
  for (const s of sections) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `toc-link level-${s.level}`;
    btn.dataset.secId = s.id;
    btn.innerHTML = `<span class="toc-num">${escapeHtml(s.number)}</span><span>${escapeHtml(s.title)}</span>`;
    frag.appendChild(btn);
  }
  list.appendChild(frag);
}

function renderArticleAside(asideNodes, lockInfobox) {
  const layout = $('readerLayout');
  const asideRail = $('asideRail');
  const asideContent = $('wikiAsideContent');
  if (!layout || !asideRail || !asideContent) return;

  asideContent.replaceChildren();

  if (!asideNodes || asideNodes.length === 0) {
    asideRail.classList.add('hide');
    layout.classList.add('no-aside');
    return;
  }

  asideRail.classList.remove('hide');
  layout.classList.remove('no-aside');

  if (lockInfobox) {
    const badge = document.createElement('div');
    badge.className = 'hc-banned-pill';
    badge.style.display = 'block';
    badge.style.textAlign = 'center';
    badge.style.marginBottom = '10px';
    badge.textContent = 'Boss Mode: Infobox Links Locked';
    asideContent.appendChild(badge);
  }

  asideContent.append(...asideNodes);
}

function appendArticleAside(asideNodes, lockInfobox) {
  if (!asideNodes || asideNodes.length === 0) return;
  const asideContent = $('wikiAsideContent');
  if (!asideContent) return;
  if (asideContent.childNodes.length === 0) {
    renderArticleAside(asideNodes, lockInfobox);
  } else {
    asideContent.append(...asideNodes);
  }
}

// ==================== Challenge Persistence, URL Sync & Resume Prompt ====================
function buildChallengeUrl(g) {
  const params = new URLSearchParams();
  if (g.dailyDate) {
    params.set('challenge', 'daily');
    params.set('date', g.dailyDate);
  } else {
    params.set('challenge', 'solo');
    params.set('from', g.start);
    params.set('to', g.target);
    params.set('lang', g.lang || 'en');
    params.set('tier', g.tier || 'medium');
  }
  return `/?${params.toString()}`;
}

function syncChallengeUrl(g) {
  if (!g || g.roomCode) return;
  try {
    history.replaceState({}, '', buildChallengeUrl(g));
  } catch {
    // Ignore restricted history API contexts
  }
}

function clearChallengeUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.has('challenge') || params.has('from') || params.has('to') || params.has('date')) {
      history.replaceState({}, '', '/');
    }
  } catch {
    // Ignore
  }
}

function persistActiveGame(inGame = true) {
  const g = app.game;
  if (!g || g.finished || g.roomCode) return;
  saveActiveGame({
    version: 1,
    start: g.start,
    target: g.target,
    lang: g.lang,
    par: g.par,
    tier: g.tier,
    titleLabel: g.titleLabel,
    dailyDate: g.dailyDate || null,
    startedDate: g.startedDate || g.dailyDate || formatUtcDate(),
    packId: g.packId || null,
    previews: g.previews,
    banHubs: g.banHubs,
    lockInfobox: g.lockInfobox,
    maxHints: g.maxHints,
    backCost: g.backCost,
    pairKey: g.pairKey,
    path: [...g.path],
    moves: [...g.moves],
    hints: g.hints,
    hintLevel: g.hintLevel,
    revealedHints: [...(g.revealedHints || [])],
    extraPenalties: g.extraPenalties || 0,
    accumulatedMs: getElapsedMs(),
    inGame
  });
  app.lastPersistAt = Date.now();
}

function openResumePrompt(saved, { onDiscard = null } = {}) {
  const dialog = $('resumeDialog');
  const body = $('resumeDialogBody');
  if (!dialog || !body || !saved) return;

  const currentArticle = saved.path[saved.path.length - 1] || saved.start;
  const clicks = (saved.moves?.length || 0) + (saved.extraPenalties || 0);
  const hints = saved.hints || 0;
  const score = clicks + hints;
  const dateDisplay = saved.dailyDate
    ? `${saved.dailyDate} (Daily)`
    : saved.startedDate || formatUtcDate();
  const tierMeta = DIFFICULTY_TIERS[saved.tier] || DIFFICULTY_TIERS.medium;
  const trailPreview =
    saved.path.length > 1
      ? `<div class="resume-trail-preview"><strong>Path so far:</strong> ${saved.path.map(escapeHtml).join(' → ')}</div>`
      : '';

  body.innerHTML = `
    <div style="text-align:center;">
      <div class="pg-badge periwinkle">${escapeHtml(saved.titleLabel || 'Challenge')} · ${escapeHtml(tierMeta.name)}</div>
      <h2 id="resumeTitle" style="font-family:var(--font-display);font-size:1.55rem;margin:0 0 6px;">Continue your challenge?</h2>
      <p class="section-sub">Your in-progress run is saved — pick up right on the same Wikipedia page.</p>
    </div>

    <div class="resume-summary-box">
      <div class="resume-pair-row">${escapeHtml(saved.start)} → ${escapeHtml(saved.target)}</div>
      <div class="resume-meta-grid">
        <div class="resume-meta-item">
          <small>Date</small>
          <strong class="tabular">${escapeHtml(dateDisplay)}</strong>
        </div>
        <div class="resume-meta-item">
          <small>Current Page</small>
          <strong>${escapeHtml(currentArticle)}</strong>
        </div>
        <div class="resume-meta-item">
          <small>Score</small>
          <strong class="tabular">${score} click${score === 1 ? '' : 's'}${hints ? ` (${hints} hint${hints === 1 ? '' : 's'})` : ''}</strong>
        </div>
        <div class="resume-meta-item">
          <small>Time</small>
          <strong class="tabular">${formatTime(saved.accumulatedMs || 0)}</strong>
        </div>
      </div>
      ${trailPreview}
    </div>

    <form method="dialog" class="resume-dialog-actions">
      <button type="submit" class="btn btn-primary btn-lg" value="continue" autofocus>Continue Challenge</button>
      <div class="resume-dialog-secondary">
        <button type="submit" class="btn" value="home">Go to Home</button>
        <button type="submit" class="btn btn-ghost" value="discard">${onDiscard ? 'Restart Fresh' : 'Discard Run'}</button>
      </div>
    </form>
  `;

  // Pre-warm the saved current article while the user decides
  prefetchWikiArticle(currentArticle, saved.lang || 'en');

  dialog.addEventListener(
    'close',
    () => {
      const choice = dialog.returnValue;
      dialog.returnValue = '';

      if (choice === 'continue') {
        playTap();
        resumeSavedGame(saved);
      } else if (choice === 'discard') {
        playTap();
        clearActiveGame();
        if (onDiscard) {
          onDiscard();
        } else {
          clearChallengeUrl();
          renderHome();
          showToast('Saved challenge discarded');
        }
      } else {
        // 'home' or '' (Esc / back gesture): keep saved challenge available on Home banner
        if (saved.inGame) {
          saveActiveGame({ ...saved, inGame: false });
        }
        clearChallengeUrl();
        renderHome();
      }
    },
    { once: true }
  );

  if (!dialog.open) dialog.showModal();
}

function resumeSavedGame(saved) {
  if (!saved) return;
  const tierMeta = DIFFICULTY_TIERS[saved.tier] || DIFFICULTY_TIERS.medium;
  const restoredPath = Array.isArray(saved.path) && saved.path.length ? [...saved.path] : [saved.start];
  const currentArticle = restoredPath[restoredPath.length - 1];

  startSoloGame({
    start: saved.start,
    target: saved.target,
    lang: saved.lang || 'en',
    par: saved.par || tierMeta.par,
    tier: saved.tier || 'medium',
    titleLabel: saved.titleLabel || 'Tangent',
    dailyDate: saved.dailyDate || null,
    startedDate: saved.startedDate || saved.dailyDate || formatUtcDate(),
    packId: saved.packId || null,
    previews: saved.previews !== false,
    banHubs: Boolean(saved.banHubs),
    lockInfobox: Boolean(saved.lockInfobox),
    maxHints: saved.maxHints ?? tierMeta.rules.maxHints,
    backCost: saved.backCost ?? tierMeta.rules.backCost,
    restoredState: {
      path: restoredPath,
      moves: Array.isArray(saved.moves) ? [...saved.moves] : [],
      hints: saved.hints || 0,
      hintLevel: saved.hintLevel || 0,
      revealedHints: Array.isArray(saved.revealedHints) ? [...saved.revealedHints] : [],
      extraPenalties: saved.extraPenalties || 0,
      accumulatedMs: saved.accumulatedMs || 0,
      currentArticle
    }
  });
}

// ==================== Article Loading & Non-Destructive Status Helpers ====================
function hideArticleStatusBar() {
  const bar = $('articleStatusBar');
  if (!bar) return;
  bar.classList.add('hide');
  bar.classList.remove('is-error');
  bar.replaceChildren();
}

function showArticleLoadingBar(title, subtitle = '') {
  const bar = $('articleStatusBar');
  if (!bar) return;
  bar.classList.remove('hide', 'is-error');
  const desc = subtitle ? ` — ${escapeHtml(subtitle)}` : '';
  bar.innerHTML = `
    <div class="article-status-msg">
      <progress aria-label="Loading article" class="loading-spinner sm"></progress>
      <span>Opening “${escapeHtml(title)}”${desc}…</span>
    </div>
  `;
}

function showArticleErrorBar(title, errMsg, onRetry) {
  const bar = $('articleStatusBar');
  if (!bar) return;
  bar.classList.remove('hide');
  bar.classList.add('is-error');
  bar.innerHTML = `
    <div class="article-status-msg">
      <span>Couldn't load “${escapeHtml(title)}” — ${escapeHtml(errMsg || 'Check your connection and retry.')}</span>
    </div>
    <div class="article-status-actions">
      <button type="button" class="btn btn-primary btn-sm" id="statusRetryBtn">Retry</button>
      <button type="button" class="btn btn-ghost btn-sm" id="statusDismissBtn">Dismiss</button>
    </div>
  `;
  $('statusRetryBtn')?.addEventListener('click', () => {
    playTap();
    onRetry();
  });
  $('statusDismissBtn')?.addEventListener('click', () => {
    playTap();
    hideArticleStatusBar();
  });
}

function renderInitialArticleLoading(title) {
  const art = $('wikiArticle');
  if (!art) return;
  $('tocList')?.replaceChildren();
  $('wikiAsideContent')?.replaceChildren();
  art.innerHTML = `
    <div class="article-loading-state" role="status" aria-live="polite">
      <div class="article-loading-head">
        <progress aria-label="Loading Wikipedia article" class="loading-spinner"></progress>
        <div>
          <div class="article-loading-title">Loading “${escapeHtml(title)}”</div>
          <p class="article-loading-sub">Fetching article from Wikipedia… timer starts once loaded</p>
        </div>
      </div>
      <div class="article-skel-group" aria-hidden="true">
        <div class="article-skel-line w-title"></div>
        <div class="article-skel-line w-95"></div>
        <div class="article-skel-line w-88"></div>
        <div class="article-skel-line w-76"></div>
        <div class="article-skel-line w-95"></div>
        <div class="article-skel-line w-60"></div>
      </div>
    </div>
  `;
}

function renderRevealedHints(revealedHints = []) {
  const stack = $('hintsStack');
  if (!stack) return;
  stack.replaceChildren();
  for (const h of revealedHints) {
    stack.insertAdjacentHTML(
      'beforeend',
      `<div class="hint-card"><strong>${escapeHtml(h.title)}</strong>${escapeHtml(h.text)}</div>`
    );
  }
}

// ==================== Core Game Engine (Solo, Daily, Custom, Room) ====================
function stopTimer() {
  if (app.timerInterval) {
    clearInterval(app.timerInterval);
    app.timerInterval = null;
  }
}

function getElapsedMs() {
  if (!app.game) return 0;
  const g = app.game;
  if (g.paused || !g.timerStarted) return g.accumulatedMs;
  return g.accumulatedMs + (Date.now() - g.resumeAt);
}

function startTimer() {
  stopTimer();
  app.timerInterval = setInterval(() => {
    if (!app.game || app.game.paused || !app.game.timerStarted) return;
    $('timerBox').textContent = formatTime(getElapsedMs());
    if (!app.game.roomCode && Date.now() - app.lastPersistAt >= 5000) {
      persistActiveGame(true);
    }
  }, 250);
}

function getTotalScore(g) {
  if (!g) return 0;
  return g.moves.length + g.hints + (g.extraPenalties || 0);
}

function startSoloGame({
  start,
  target,
  lang = 'en',
  par = null,
  tier = 'medium',
  titleLabel = 'Tangent',
  dailyDate = null,
  startedDate = null,
  packId = null,
  previews = true,
  banHubs = false,
  lockInfobox = false,
  maxHints = 2,
  backCost = 1,
  roomCode = null,
  restoredState = null
}) {
  const tierMeta = DIFFICULTY_TIERS[tier] || DIFFICULTY_TIERS.medium;
  const resolvedStartedDate = startedDate || dailyDate || formatUtcDate();

  app.game = {
    start,
    target,
    lang,
    par: par || tierMeta.par,
    tier: tierMeta.id,
    titleLabel,
    dailyDate,
    startedDate: resolvedStartedDate,
    packId,
    previews,
    banHubs,
    lockInfobox,
    maxHints,
    backCost,
    roomCode,
    pairKey: makePairKey(start, target, lang),
    path: restoredState ? [...restoredState.path] : [start],
    moves: restoredState ? [...restoredState.moves] : [],
    hints: restoredState ? restoredState.hints : 0,
    hintLevel: restoredState ? restoredState.hintLevel : 0,
    revealedHints: restoredState ? [...restoredState.revealedHints] : [],
    extraPenalties: restoredState ? restoredState.extraPenalties : 0,
    accumulatedMs: restoredState ? restoredState.accumulatedMs : 0,
    resumeAt: Date.now(),
    timerStarted: false,
    paused: false,
    finished: false
  };

  const ruleBadges = [
    dailyDate ? dailyDate : '',
    tierMeta.name.toUpperCase(),
    banHubs ? 'NO HUBS' : '',
    lockInfobox ? 'PROSE ONLY' : '',
    !previews ? 'BLIND' : ''
  ]
    .filter(Boolean)
    .join(' · ');

  $('gameModeLabel').textContent = roomCode
    ? `LIVE ROOM ${roomCode} · ${ruleBadges}`
    : `${titleLabel.toUpperCase()} · ${ruleBadges}`;
  $('gameTargetLabel').textContent = target;
  $('clicksBox').textContent = String(getTotalScore(app.game));
  $('timerBox').textContent = formatTime(app.game.accumulatedMs);
  renderRevealedHints(app.game.revealedHints);

  $('backBtn').textContent = `Back (+${backCost})`;
  $('backBtn').disabled = true;

  $('hintBtn').disabled = false;
  $('hintBtn').textContent =
    maxHints === 0
      ? 'Hint (0 in Boss)'
      : app.game.hintLevel >= maxHints
      ? 'Hint (Max)'
      : `Hint (+1)`;

  $('pauseBtn').classList.toggle('hide', Boolean(roomCode));
  $('pauseBtn').disabled = true;
  $('raceStrip').classList.toggle('hide', !roomCode);
  $('readerLayout').classList.remove('is-paused', 'is-loading-nav');
  $('articleShell').classList.remove('is-loading', 'is-paused');
  hideArticleStatusBar();
  $('wikiArticle').replaceChildren();

  const langMeta = getLanguage(lang);
  $('wikiArticle').dir = langMeta.rtl ? 'rtl' : 'ltr';
  $('wikiAsideContent').dir = langMeta.rtl ? 'rtl' : 'ltr';

  syncRailLayoutClasses();
  renderTrail();
  document.title = `${start} → ${target} — Tangent`;
  showView('viewGame');

  if (!roomCode) {
    syncChallengeUrl(app.game);
    persistActiveGame(true);
  }
  pushGameHistoryGuard();

  if (restoredState) {
    navigateToArticle(restoredState.currentArticle, { isResume: true });
  } else {
    navigateToArticle(start, { isStart: true });
  }
}

function renderTrail() {
  const g = app.game;
  if (!g) return;
  const bar = $('trailBar');
  bar.innerHTML = g.path
    .map((title, i) => {
      const isCur = i === g.path.length - 1;
      return `${i > 0 ? '<span class="trail-sep" aria-hidden="true">→</span>' : ''}<span class="trail-node ${isCur ? 'current' : ''}">${escapeHtml(title)}</span>`;
    })
    .join('');
  bar.scrollLeft = bar.scrollWidth;
  $('backBtn').disabled = app.navLoading || g.path.length < 2;
}

function bumpScoreUI() {
  const g = app.game;
  if (!g) return;
  const box = $('clicksBox');
  box.textContent = String(getTotalScore(g));
  box.classList.remove('bump');
  void box.offsetWidth;
  box.classList.add('bump');
}

async function navigateToArticle(
  title,
  { isStart = false, isResume = false, moveType = 'link', fromTitle = null, clickedTitle = null } = {}
) {
  const g = app.game;
  if (!g || g.finished) return;

  app.navAbort?.abort();
  const controller = new AbortController();
  app.navAbort = controller;
  const reqSeq = ++app.navSeq;
  app.navLoading = true;

  const shell = $('articleShell');
  const layout = $('readerLayout');
  const art = $('wikiArticle');
  const hasRenderedArticle = Boolean(art.querySelector('.wiki-article-header'));

  shell.classList.add('is-loading');
  layout.classList.add('is-loading-nav');
  $('backBtn').disabled = true;
  app.hovercard?.hide();

  const cachedSummary = getCachedWikiSummary(title, g.lang);
  if (!hasRenderedArticle) {
    hideArticleStatusBar();
    renderInitialArticleLoading(title);
  } else {
    showArticleLoadingBar(title, cachedSummary?.description || '');
  }

  let moveCommitted = false;
  let leadRendered = false;
  let streamTailEl = null;
  let tocCount = 0;

  const commitMove = (canonical) => {
    if (moveCommitted) return;
    moveCommitted = true;

    if (isStart) {
      g.path = [canonical];
    } else if (isResume) {
      g.path[g.path.length - 1] = canonical;
    } else if (moveType === 'back') {
      g.path.pop();
      g.moves.push({ type: 'back', from: fromTitle, to: canonical });
      if (g.backCost > 1) {
        g.extraPenalties += g.backCost - 1;
      }
      bumpScoreUI();
    } else {
      g.path.push(canonical);
      g.moves.push({ type: 'link', from: fromTitle, clicked: clickedTitle || title, to: canonical });
      bumpScoreUI();
    }

    renderTrail();

    if (g.roomCode && !isStart && !isResume) {
      syncRoomProgress({
        code: g.roomCode,
        clientId: app.clientId,
        clicks: g.moves.length + (g.extraPenalties || 0),
        hints: g.hints,
        finished: false
      }).catch(() => {});
    }
  };

  const checkImmediateWin = (canonical) => {
    if (!isStart && !isResume && normTitle(canonical) === normTitle(g.target)) {
      commitMove(canonical);
      app.navLoading = false;
      shell.classList.remove('is-loading');
      layout.classList.remove('is-loading-nav');
      hideArticleStatusBar();
      controller.abort(new DOMException('Target reached', 'AbortError'));
      handleWin();
      return true;
    }
    return false;
  };

  try {
    const parsed = await fetchWikiArticle(title, g.lang, {
      banHubs: g.banHubs,
      lockInfobox: g.lockInfobox,
      signal: controller.signal,
      onCanonical: (canonical) => {
        if (reqSeq !== app.navSeq || app.game !== g || g.finished) return;
        checkImmediateWin(canonical);
      },
      onLead: (lead) => {
        if (reqSeq !== app.navSeq || app.game !== g || g.finished) return;
        const canonical = lead.title;
        if (checkImmediateWin(canonical)) return;

        commitMove(canonical);
        leadRendered = true;
        app.navLoading = false;
        $('backBtn').disabled = g.path.length < 2;

        tocCount = (lead.sections || []).length;
        renderArticleToc(lead.sections, { streaming: !lead.fromCache });
        renderArticleAside(lead.asideNodes, g.lockInfobox);

        const header = document.createElement('div');
        header.className = 'wiki-article-header';
        header.innerHTML = `
          <h1 class="wiki-article-title">${escapeHtml(canonical)}</h1>
          <div class="wiki-article-sub">From Wikipedia (${escapeHtml(getLanguage(g.lang).native)}) · Click any highlighted link in the article</div>
        `;

        if (!lead.fromCache) {
          streamTailEl = document.createElement('div');
          streamTailEl.className = 'wiki-stream-tail';
          streamTailEl.innerHTML = `<progress aria-label="Streaming remaining sections" class="loading-spinner sm"></progress><span>Streaming rest of article…</span>`;
          art.replaceChildren(header, ...lead.bodyNodes, streamTailEl);
        } else {
          art.replaceChildren(header, ...lead.bodyNodes);
        }

        shell.classList.remove('is-loading');
        layout.classList.remove('is-loading-nav');
        hideArticleStatusBar();

        // Start (or resume) timer as soon as Section 0 (Lead + Infobox) is readable & playable
        $('pauseBtn').disabled = false;
        if (!g.timerStarted) {
          g.timerStarted = true;
          if (!g.paused) {
            g.resumeAt = Date.now();
            startTimer();
          }
        }

        persistActiveGame(true);
        window.scrollTo({ top: 0, behavior: 'instant' });
      },
      onSection: (chunk) => {
        if (reqSeq !== app.navSeq || app.game !== g || g.finished || !leadRendered) return;
        if (chunk.asideNodes?.length) {
          appendArticleAside(chunk.asideNodes, g.lockInfobox);
        }
        if (chunk.sections?.length) {
          tocCount += chunk.sections.length;
          appendArticleToc(chunk.sections);
        }
        if (chunk.bodyNodes?.length) {
          const frag = document.createDocumentFragment();
          frag.append(...chunk.bodyNodes);
          if (streamTailEl && streamTailEl.parentNode === art) {
            art.insertBefore(frag, streamTailEl);
          } else {
            art.appendChild(frag);
          }
        }
      }
    });

    if (reqSeq !== app.navSeq || app.game !== g || g.finished) return;

    streamTailEl?.remove();
    streamTailEl = null;

    if (tocCount === 0 && (!parsed.sections || parsed.sections.length === 0)) {
      renderArticleToc([], { streaming: false });
    }
  } catch (err) {
    streamTailEl?.remove();
    streamTailEl = null;

    if (isAbortError(err, controller.signal) || reqSeq !== app.navSeq || app.game !== g || g.finished) {
      return;
    }

    // If Lead already rendered cleanly, keep the playable article intact instead of showing a full error
    if (leadRendered) {
      if (tocCount === 0) renderArticleToc([], { streaming: false });
      return;
    }

    app.navLoading = false;
    shell.classList.remove('is-loading');
    layout.classList.remove('is-loading-nav');
    $('backBtn').disabled = g.path.length < 2;

    const retry = () =>
      navigateToArticle(title, { isStart, isResume, moveType, fromTitle, clickedTitle });

    if (hasRenderedArticle) {
      // Non-destructive error: keep the current article intact so the user isn't kicked or stuck
      showArticleErrorBar(title, err.message, retry);
    } else {
      hideArticleStatusBar();
      art.innerHTML = `
        <div style="padding:36px 0;text-align:center;">
          <h2 style="font-family:var(--font-display);margin:0 0 8px;">Couldn't load “${escapeHtml(title)}”</h2>
          <p style="color:var(--muted);margin:0 0 18px;">${escapeHtml(err.message || 'Check your connection and retry.')}</p>
          <div style="display:flex;justify-content:center;gap:10px;flex-wrap:wrap;">
            <button type="button" class="btn btn-primary" id="retryArticleBtn">Retry Page</button>
            <button type="button" class="btn" id="errorHomeBtn">Back to Home</button>
          </div>
        </div>
      `;
      $('retryArticleBtn')?.addEventListener('click', () => {
        playTap();
        retry();
      });
      $('errorHomeBtn')?.addEventListener('click', () => {
        playTap();
        setActiveTab('daily', { skipConfirm: true });
      });
    }
  }
}

async function handleHint() {
  const g = app.game;
  if (!g || g.finished || g.paused) return;

  if (g.maxHints === 0) {
    playThud();
    showToast('Boss Mode allows 0 hints — you got this!');
    return;
  }

  if (g.hintLevel >= g.maxHints) {
    if (getPrefs().vipPaidZero) {
      playThud();
      showToast(`You've used all ${g.maxHints} hint${g.maxHints === 1 ? '' : 's'} for this tier!`);
      return;
    }
    openJokePaywall({
      triggerReason: `You've used your ${g.maxHints} allowed hint${g.maxHints === 1 ? '' : 's'} for this tier! Extra hints require Tangent+ Ultra…`,
      onVipUnlocked: renderVipAndContrast
    });
    return;
  }

  playStep(2 + g.hintLevel);
  g.hintLevel++;
  g.hints++;
  bumpScoreUI();

  if (g.hintLevel === 1) {
    const s = await fetchWikiSummary(g.target, g.lang);
    const words = g.target
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = words.length ? new RegExp(words.join('|'), 'gi') : null;
    const raw = s?.extract || s?.description || 'No summary available for this article.';
    const masked = `${(re ? raw.replace(re, '▢▢▢') : raw).slice(0, 230)}…`;
    g.revealedHints.push({ title: 'Hint 1 · Target Clue (+1)', text: masked });
    renderRevealedHints(g.revealedHints);
  } else {
    const links = await fetchBacklinkHint(g.target, g.lang);
    const text = links.length ? links.join(' · ') : 'Try narrowing by era, location, or category.';
    g.revealedHints.push({ title: 'Hint 2 · Pages Linking Directly to Target (+1)', text });
    renderRevealedHints(g.revealedHints);
  }

  if (g.hintLevel >= g.maxHints) {
    $('hintBtn').textContent = 'Hint (Max)';
  }
  persistActiveGame(true);
}

function handleBack() {
  const g = app.game;
  if (!g || g.finished || g.paused || app.navLoading || app.pauseGateOpen || g.path.length < 2) return;
  playTap();
  const current = g.path[g.path.length - 1];
  const prev = g.path[g.path.length - 2];

  openConfirmDialog({
    title: `Go back to “${prev}”?`,
    message: `Stepping back adds +${g.backCost} click${g.backCost === 1 ? '' : 's'} to your score.`,
    confirmLabel: `Go Back (+${g.backCost})`,
    cancelLabel: 'Stay Here',
    onConfirm: () => {
      if (app.game !== g || g.finished || g.paused || app.navLoading || g.path.length < 2) return;
      playBack();
      navigateToArticle(prev, { moveType: 'back', fromTitle: current });
    }
  });
}

function handlePause() {
  const g = app.game;
  if (!g || g.finished || g.paused || g.roomCode || app.pauseGateOpen || !g.timerStarted) return;
  playTap();
  app.pauseGateOpen = true;
  app.hovercard?.hide();

  // Clock KEEPS RUNNING until the player passes the pre-pause challenge!
  app.closePauseGate = openPauseGate({
    getElapsedText: () => formatTime(getElapsedMs()),
    onPauseConfirmed: () => {
      if (app.game !== g || g.finished) return formatTime(0);
      g.accumulatedMs = getElapsedMs();
      g.paused = true;
      persistActiveGame(true);
      $('readerLayout').classList.add('is-paused');
      $('articleShell').classList.add('is-paused');
      return formatTime(g.accumulatedMs);
    },
    onResume: () => {
      app.closePauseGate = null;
      app.pauseGateOpen = false;
      if (app.game !== g) return;
      g.paused = false;
      g.resumeAt = Date.now();
      $('readerLayout').classList.remove('is-paused');
      $('articleShell').classList.remove('is-paused');
      persistActiveGame(true);
    },
    onCancel: () => {
      app.closePauseGate = null;
      app.pauseGateOpen = false;
    }
  });
}

// ==================== Win Screen, Global Records & Room Podium ====================
async function handleWin() {
  const g = app.game;
  if (!g || g.finished) return;
  g.finished = true;
  stopTimer();
  if (!g.roomCode) {
    clearActiveGame();
    clearChallengeUrl();
  }

  const elapsedMs = Math.max(800, getElapsedMs());
  const clicks = g.moves.length + (g.extraPenalties || 0);
  const hints = g.hints;
  const score = getTotalScore(g);

  const finalPath = [...g.path];

  playWin();
  launchBrandConfetti(38);

  finalPath.forEach((_, idx) => {
    setTimeout(() => playStep(idx), 220 + idx * 240);
  });

  const { isNewPB } = savePersonalBest(g.pairKey, { score, clicks, hints, elapsedMs, path: finalPath });
  let streakInfo = null;
  if (g.dailyDate) {
    streakInfo = saveDailyResult(g.dailyDate, { score, clicks, hints, elapsedMs, path: finalPath });
  }

  if (g.roomCode) {
    await syncRoomProgress({
      code: g.roomCode,
      clientId: app.clientId,
      clicks,
      hints,
      finished: true,
      elapsedMs,
      path: finalPath
    }).catch(() => {});
  }

  const serverPromise = submitScore({
    clientId: app.clientId,
    nickname: getNickname() || 'Player',
    pairKey: g.pairKey,
    start: g.start,
    target: g.target,
    lang: g.lang,
    dailyDate: g.dailyDate,
    hints,
    elapsedMs,
    moves: g.moves,
    path: finalPath
  });

  const parDiff = g.par ? score - g.par : null;
  const parLabel =
    parDiff === null
      ? '—'
      : parDiff === 0
      ? 'Even Par'
      : parDiff < 0
      ? `${parDiff} Under`
      : `+${parDiff}`;

  const headline = g.roomCode
    ? 'Finished the race!'
    : isNewPB
    ? 'New Personal Best'
    : parDiff !== null && parDiff <= 0
    ? 'Under Par!'
    : 'You made it';

  const shareUrl = g.dailyDate
    ? window.location.origin
    : `${window.location.origin}/?from=${encodeURIComponent(g.start)}&to=${encodeURIComponent(g.target)}&lang=${encodeURIComponent(g.lang)}&tier=${encodeURIComponent(g.tier || 'medium')}`;

  const shareText = buildShareText({
    titleLabel: `${g.titleLabel} (${(g.tier || 'medium').toUpperCase()})`,
    start: g.start,
    target: g.target,
    clicks,
    hints,
    score,
    par: g.par,
    elapsedMs,
    url: shareUrl
  });

  $('winContent').innerHTML = `
    <div class="win-kicker">${escapeHtml(g.titleLabel)} · <span class="tier-badge-chip ${g.tier || 'medium'}">${escapeHtml((g.tier || 'medium').toUpperCase())}</span> · ${escapeHtml(g.start)} → ${escapeHtml(g.target)}</div>
    <div class="win-score-big tabular">${score}</div>
    <h2 class="win-title">${headline}</h2>

    <div class="win-kpis">
      <div class="win-kpi"><small>Clicks</small><b class="tabular">${clicks}</b></div>
      <div class="win-kpi"><small>Time</small><b class="tabular">${formatTime(elapsedMs)}</b></div>
      <div class="win-kpi"><small>Hints</small><b class="tabular">${hints}</b></div>
      ${g.par ? `<div class="win-kpi"><small>vs Par ${g.par}</small><b class="tabular">${parLabel}</b></div>` : ''}
      ${streakInfo ? `<div class="win-kpi"><small>Streak</small><b class="tabular">${streakInfo.streak.count}d</b></div>` : ''}
    </div>

    <div id="globalStatsBanner" style="margin-bottom:18px;font-size:0.9rem;color:var(--muted);"></div>

    ${g.roomCode ? `<div id="roomPodiumBox"></div>` : ''}

    <div class="route-box">
      <div class="game-goal-kicker" style="margin-bottom:8px;">2-SECOND ROUTE REPLAY</div>
      ${buildRouteSVG(finalPath)}
    </div>

    <div class="win-actions">
      <button type="button" class="btn btn-primary btn-lg" id="copyResultBtn">Copy Share Text</button>
      <button type="button" class="btn btn-marigold btn-lg" id="downloadCardBtn">Download PNG Card</button>
      ${
        g.roomCode
          ? `<button type="button" class="btn btn-lg" id="backToLobbyBtn">Back to Room</button>`
          : `<button type="button" class="btn btn-lg" id="playAnotherBtn">Roll Another (${escapeHtml((g.tier || 'medium').toUpperCase())})</button>`
      }
      <button type="button" class="btn btn-lg" id="winHomeBtn">Home</button>
    </div>

    <div style="text-align:left;">
      <h3 class="section-title" style="font-size:1.25rem;margin-bottom:4px;">What You Passed Through</h3>
      <p class="section-sub">Every article along your tangent</p>
      <div class="learn-grid" id="learnGrid">
        <div class="section-sub" style="padding:12px 0;">Loading Wikipedia summaries…</div>
      </div>
    </div>
  `;

  showView('viewWin');

  $('copyResultBtn').addEventListener('click', async () => {
    playTap();
    try {
      await navigator.clipboard.writeText(shareText);
      $('copyResultBtn').textContent = 'Copied to Clipboard ✓';
      showToast('Spoiler-free result copied!');
    } catch {
      showToast('Copy failed — check clipboard permissions');
    }
  });

  $('downloadCardBtn').addEventListener('click', () => {
    playTap();
    downloadShareCardPNG({
      titleLabel: `${g.titleLabel} · ${(g.tier || 'medium').toUpperCase()}`,
      start: g.start,
      target: g.target,
      score,
      clicks,
      hints,
      par: g.par,
      elapsedMs,
      path: finalPath
    });
    showToast('PNG Share Card downloaded!');
  });

  $('playAnotherBtn')?.addEventListener('click', () => {
    playShuffle();
    const ch = generateTieredChallenge(g.tier || app.selectedTier);
    const tMeta = DIFFICULTY_TIERS[ch.tier] || DIFFICULTY_TIERS.medium;
    startSoloGame({
      start: ch.start,
      target: ch.target,
      lang: ch.lang,
      par: ch.par,
      tier: ch.tier,
      titleLabel: `${tMeta.name} Challenge`,
      ...ch.rules
    });
  });

  $('backToLobbyBtn')?.addEventListener('click', () => {
    playTap();
    setActiveTab('room');
  });

  $('winHomeBtn').addEventListener('click', () => {
    playTap();
    setActiveTab('daily');
  });

  serverPromise.then((res) => {
    const el = $('globalStatsBanner');
    if (!el || !res || res.offline || !res.valid) return;
    const bits = [];
    if (res.isGlobalRecord) {
      bits.push(`<span class="pg-badge marigold" style="margin:0 6px 0 0;">NEW GLOBAL RECORD</span>`);
    } else if (res.record?.best != null) {
      bits.push(`Global record: <strong>${res.record.best} clicks</strong> (${formatTime(res.record.elapsedMs)}) by ${escapeHtml(res.record.holder || 'Player')}`);
    }
    if (res.percentile != null && res.dailyTotal > 1) {
      bits.push(`Today's rank: <strong>#${res.dailyRank} of ${res.dailyTotal}</strong> (Top ${res.percentile}%)`);
    }
    el.innerHTML = bits.join(' · ');
  });

  if (g.roomCode && app.room) {
    renderRoomPodium(app.room);
  }

  const summaries = await Promise.all(finalPath.map((t) => fetchWikiSummary(t, g.lang)));
  const learn = $('learnGrid');
  if (learn) {
    learn.innerHTML = summaries
      .map((s, i) => {
        const title = s?.title || finalPath[i];
        const extract = (s?.extract || s?.description || 'Wikipedia article.').slice(0, 130);
        const safeThumb = s?.thumbnail && /^https?:\/\//i.test(s.thumbnail) ? s.thumbnail : null;
        const thumb = safeThumb
          ? `<img class="learn-thumb" src="${escapeHtml(safeThumb)}" alt="" loading="lazy">`
          : `<div class="learn-thumb" style="display:grid;place-items:center;font-weight:800;color:var(--muted);">${i + 1}</div>`;
        return `
          <div class="learn-card">
            ${thumb}
            <div>
              <h4>${escapeHtml(title)}</h4>
              <p>${escapeHtml(extract)}…</p>
            </div>
          </div>
        `;
      })
      .join('');
  }
}

// ==================== 10-Player Live Race Rooms ====================
function renderRoomView() {
  const hasRoom = Boolean(app.room);
  $('roomSetupPanel').classList.toggle('hide', hasRoom);
  $('roomLobbyPanel').classList.toggle('hide', !hasRoom);

  if (!hasRoom) return;
  const r = app.room;
  const isHost = r.hostId === app.clientId;
  const tierMeta = DIFFICULTY_TIERS[r.tier] || DIFFICULTY_TIERS.medium;

  $('lobbyRoundLabel').textContent = `LIVE RACE ROOM · ROUND ${r.round || 1} · ${tierMeta.name.toUpperCase()} TIER`;
  $('lobbyPairTitle').textContent = `${r.start} → ${r.target}`;
  $('lobbyRulesSummary').textContent = [
    `Wikipedia (${getLanguage(r.lang).name})`,
    `Par ${r.par || tierMeta.par}`,
    r.settings?.mode === 'speed' ? 'Speedrun Mode' : 'Fewest Clicks Wins',
    r.settings?.previews ? 'Previews On' : 'Previews Off (Blind)',
    r.settings?.banHubs ? 'Mega-Hubs Banned' : 'All Hubs Allowed',
    r.settings?.lockInfobox ? 'Prose Links Only' : ''
  ]
    .filter(Boolean)
    .join(' · ');

  $('lobbyCodeDisplay').textContent = r.code;
  $('lobbyPlayerCount').textContent = `Players (${r.players.length} / 10)`;

  $('lobbyRoster').innerHTML = r.players
    .map(
      (p) => `
      <div class="roster-chip">
        <span class="avatar-dot" style="background:${p.color}">${escapeHtml(p.name.slice(0, 1).toUpperCase())}</span>
        <div style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
          ${escapeHtml(p.name)}
          ${p.isHost ? '<small style="color:var(--pop-periwinkle);margin-left:4px;">HOST</small>' : ''}
          ${p.id === app.clientId ? '<small style="color:var(--muted);margin-left:4px;">(You)</small>' : ''}
        </div>
      </div>`
    )
    .join('');

  $('startRoomRaceBtn').classList.toggle('hide', !isHost);
  $('lobbyWaitText').classList.toggle('hide', isHost);
  $('startRoomRaceBtn').textContent = r.status === 'finished' ? 'Start Next Round (New Pair)' : 'Start Race (3-2-1)';
}

function renderLiveRaceStrip(room, serverNow) {
  const strip = $('raceStrip');
  if (!strip || !room) return;

  const finishedCount = room.players.filter((p) => p.finished).length;
  $('raceStripTitle').textContent = `LIVE ROOM ${room.code} · ${finishedCount}/${room.players.length} FINISHED`;

  if (room.graceEndsAt) {
    const left = Math.max(0, Math.ceil((room.graceEndsAt - serverNow) / 1000));
    $('raceGraceText').textContent = left > 0 ? `Grace timer: ${left}s` : 'Finishing up…';
  } else {
    $('raceGraceText').textContent = room.settings?.mode === 'speed' ? 'Speedrun' : 'Fewest clicks';
  }

  $('racePlayersList').innerHTML = room.players
    .map(
      (p) => `
      <span class="race-pill ${p.finished ? 'finished' : ''}">
        <span class="dot" style="background:${p.color}"></span>
        <span>${escapeHtml(p.name)}</span>
        <span class="tabular" style="color:var(--muted);">${p.finished ? `✓ ${p.score}` : `${p.clicks}c`}</span>
      </span>`
    )
    .join('');
}

function renderRoomPodium(room) {
  const box = $('roomPodiumBox');
  if (!box || !room) return;
  const isHost = room.hostId === app.clientId;
  const finishedAll = room.status === 'finished';

  box.innerHTML = `
    <div style="text-align:left;margin-bottom:20px;">
      <div class="section-head" style="margin:0 0 10px;">
        <h3 class="section-title" style="font-size:1.25rem;">Room ${room.code} Standings ${finishedAll ? '(Final)' : '(Live…)'}</h3>
        ${
          isHost
            ? `<button type="button" class="btn btn-sm btn-pop" id="podiumRematchBtn">Next Round</button>`
            : `<span class="section-sub">${finishedAll ? 'Waiting for host rematch' : 'Others still racing…'}</span>`
        }
      </div>
      <div class="podium-list">
        ${room.players
          .map((p, idx) => {
            const medal = idx === 0 ? '1st' : idx === 1 ? '2nd' : idx === 2 ? '3rd' : `#${idx + 1}`;
            const statusTxt = p.finished
              ? `<strong class="tabular">${p.score} clicks</strong> · <span class="tabular">${formatTime(p.elapsedMs)}</span>`
              : `<span style="color:var(--muted);">Racing (${p.clicks} clicks)</span>`;
            const pathHtml =
              finishedAll && p.path?.length
                ? `<div class="podium-path">Path: ${p.path.map(escapeHtml).join(' → ')}</div>`
                : '';
            return `
              <div class="podium-row">
                <div class="podium-row-top">
                  <div style="display:flex;align-items:center;gap:10px;">
                    <span class="podium-rank">${medal}</span>
                    <span class="avatar-dot" style="background:${p.color};width:24px;height:24px;font-size:0.72rem;">${escapeHtml(p.name.slice(0, 1).toUpperCase())}</span>
                    <strong>${escapeHtml(p.name)}</strong>
                  </div>
                  <div>${statusTxt}</div>
                </div>
                ${pathHtml}
              </div>`;
          })
          .join('')}
      </div>
    </div>
  `;

  $('podiumRematchBtn')?.addEventListener('click', () => triggerHostRoomStart(true));
}

function stopRoomPolling() {
  if (app.roomPollInterval) {
    clearInterval(app.roomPollInterval);
    app.roomPollInterval = null;
  }
}

function startRoomPolling(code) {
  stopRoomPolling();
  let lastRoundStarted = null;

  async function poll() {
    if (!app.room || app.room.code !== code) return;
    try {
      const { room, serverNow } = await getRoomState(code);
      app.room = room;

      if (!$('viewRoom').classList.contains('hide')) {
        renderRoomView();
      }

      if (room.status === 'racing' && lastRoundStarted !== room.round) {
        const me = room.players.find((p) => p.id === app.clientId);
        if (!me?.finished) {
          lastRoundStarted = room.round;
          runSynchronizedCountdown(room, serverNow);
        }
      }

      if (app.game && app.game.roomCode === code && !app.game.finished) {
        renderLiveRaceStrip(room, serverNow);
        if (room.status === 'finished') {
          showToast('Grace timer ended — showing final room standings!');
          app.game.finished = true;
          stopTimer();
          showView('viewWin');
          $('winContent').innerHTML = `<div id="roomPodiumBox"></div><div class="win-actions"><button type="button" class="btn btn-lg" id="winHomeBtn">Home</button></div>`;
          renderRoomPodium(room);
          $('winHomeBtn').addEventListener('click', () => setActiveTab('daily'));
        }
      }

      if (!$('viewWin').classList.contains('hide') && app.game?.roomCode === code) {
        renderRoomPodium(room);
      }
    } catch {
      // Quietly retry on next 2s tick
    }
  }

  poll();
  app.roomPollInterval = setInterval(poll, 2000);
}

function runSynchronizedCountdown(room, serverNow) {
  const overlay = $('countdownOverlay');
  const numEl = $('countdownNum');
  const pairEl = $('countdownPair');
  const drift = serverNow - Date.now();
  const targetStartLocal = (room.startAt || Date.now() + 2500) - drift;
  const tierMeta = DIFFICULTY_TIERS[room.tier] || DIFFICULTY_TIERS.medium;

  pairEl.textContent = `${room.start}  →  ${room.target} (${tierMeta.name})`;
  overlay.classList.remove('hide');

  let lastShown = null;
  clearInterval(app.countdownInterval);

  const launch = () => {
    clearInterval(app.countdownInterval);
    overlay.classList.add('hide');
    playCountdown(true);
    startSoloGame({
      start: room.start,
      target: room.target,
      lang: room.lang,
      par: room.par || tierMeta.par,
      tier: room.tier || 'medium',
      titleLabel: `Room ${room.code}`,
      previews: room.settings?.previews !== false,
      banHubs: Boolean(room.settings?.banHubs),
      lockInfobox: Boolean(room.settings?.lockInfobox),
      maxHints: room.settings?.maxHints ?? tierMeta.rules.maxHints,
      backCost: room.settings?.backCost ?? tierMeta.rules.backCost,
      roomCode: room.code
    });
  };

  function tick() {
    const rem = targetStartLocal - Date.now();
    if (rem <= 0) {
      launch();
      return;
    }
    const sec = Math.min(3, Math.ceil(rem / 1000));
    if (sec !== lastShown) {
      lastShown = sec;
      numEl.textContent = String(sec);
      playCountdown(false);
    }
  }

  tick();
  app.countdownInterval = setInterval(tick, 120);
}

async function triggerHostRoomStart(isRematch = false) {
  if (!app.room) return;
  try {
    let nextPair = {};
    if (isRematch) {
      const ch = generateTieredChallenge(app.room.tier || app.roomTier || 'medium');
      nextPair = { start: ch.start, target: ch.target, par: ch.par, tier: ch.tier, lang: app.room.lang };
    }
    const { room, serverNow } = await startRoom({
      code: app.room.code,
      clientId: app.clientId,
      action: isRematch ? 'rematch' : 'start',
      ...nextPair
    });
    app.room = room;
    runSynchronizedCountdown(room, serverNow);
  } catch (err) {
    playThud();
    showToast(err.message || 'Could not start race');
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ==================== Event Wiring & Init ====================
function initApp() {
  injectVercelAnalytics({ mode: 'auto' });
  initThemeSync();
  installDialogLightDismissFallback();
  renderThemeButton();
  renderSoundButton();
  renderVipAndContrast();
  startUtcCountdown();

  // Hydrate today's live Wikimedia Featured Daily & trending pool in the background
  const todayUtc = formatUtcDate();
  fetchAndCacheLiveDaily(todayUtc).then((live) => {
    if (!live) return;
    prefetchWikiArticle(live.start, live.lang || 'en');
    if (!$('viewHome').classList.contains('hide')) {
      renderHome();
    }
  });

  window.addEventListener('tangent:themechange', renderThemeButton);

  // Header controls
  $('brandBtn').addEventListener('click', () => {
    playTap();
    setActiveTab('daily');
  });

  document.querySelectorAll('.nav-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      playTap();
      setActiveTab(tab.dataset.tab);
    });
  });

  $('themeBtn').addEventListener('click', () => {
    playTap();
    const next = cycleTheme();
    renderThemeButton();
    showToast(`Theme: ${next === 'oled' ? 'OLED True Black' : next === 'dark' ? 'Dark Mode' : 'Light Mode'}`);
  });

  $('soundBtn').addEventListener('click', () => {
    const on = toggleSound();
    renderSoundButton();
    showToast(on ? 'Sound effects on' : 'Sound effects muted');
  });

  const openPro = () => openJokePaywall({ onVipUnlocked: renderVipAndContrast });
  $('proBtn').addEventListener('click', openPro);
  $('footerProBtn').addEventListener('click', openPro);
  $('vipBadge')?.addEventListener('click', () => {
    playTap();
    showToast('VIP · $0 Founding Member — everything is already unlocked!');
  });
  $('footerArchiveBtn').addEventListener('click', openArchiveModal);

  $('contrastToggleBtn').addEventListener('click', () => {
    playTap();
    const cur = getPrefs().highContrast;
    updatePrefs({ highContrast: !cur });
    renderVipAndContrast();
  });

  // Daily buttons
  $('playDailyBtn').addEventListener('click', () => {
    playTap();
    launchDailyByDate();
  });

  $('hostDailyRoomBtn').addEventListener('click', () => {
    playTap();
    const d = getDailyForDate();
    $('roomStartInput').value = d.start;
    $('roomTargetInput').value = d.target;
    setActiveTab('room');
    $('hostNameInput').focus();
  });

  // 4-Tier Selector on Home Page
  document.querySelectorAll('[data-tier]').forEach((btn) => {
    btn.addEventListener('click', () => {
      playTap();
      app.selectedTier = btn.dataset.tier;
      renderHome();
    });
  });

  $('rollTierBtn').addEventListener('click', () => {
    playShuffle();
    const ch = generateTieredChallenge(app.selectedTier);
    const tMeta = DIFFICULTY_TIERS[ch.tier] || DIFFICULTY_TIERS.medium;
    startSoloGame({
      start: ch.start,
      target: ch.target,
      lang: ch.lang,
      par: ch.par,
      tier: ch.tier,
      titleLabel: `${tMeta.name} Challenge`,
      ...ch.rules
    });
  });

  // 5-second interactive tutorial
  $('tutDemoLink').addEventListener('click', () => {
    playWin();
    updatePrefs({ tutorialDone: true });
    $('miniTutorial').innerHTML = `<div style="font-weight:700;color:var(--pop-mint);">Nice! That's the whole game — click links until you land on the target.</div>`;
    setTimeout(() => $('miniTutorial').classList.add('hide'), 2000);
  });

  $('tutDismissBtn').addEventListener('click', () => {
    playTap();
    updatePrefs({ tutorialDone: true });
    $('miniTutorial').classList.add('hide');
  });

  // Custom Challenge tier presets, language picker & autocomplete
  document.querySelectorAll('[data-custom-tier]').forEach((btn) => {
    btn.addEventListener('click', () => {
      playTap();
      app.customTier = btn.dataset.customTier;
      const t = DIFFICULTY_TIERS[app.customTier] || DIFFICULTY_TIERS.medium;
      document.querySelectorAll('[data-custom-tier]').forEach((b) => b.classList.toggle('active', b === btn));
      $('customPreviews').checked = t.rules.previews;
      $('customBanHubs').checked = t.rules.banHubs;
      $('customLockInfobox').checked = t.rules.lockInfobox;
    });
  });

  mountLanguagePicker('customLangPicker', () => app.customLang, (code) => {
    app.customLang = code;
  });
  attachWikiAutocomplete('customStartInput', 'customStartAC', () => app.customLang);
  attachWikiAutocomplete('customTargetInput', 'customTargetAC', () => app.customLang);

  $('rollCustomPairBtn').addEventListener('click', () => {
    playShuffle();
    const ch = generateTieredChallenge(app.customTier);
    $('customStartInput').value = ch.start;
    $('customTargetInput').value = ch.target;
  });

  $('playCustomBtn').addEventListener('click', () => {
    const start = $('customStartInput').value.trim();
    const target = $('customTargetInput').value.trim();
    if (!start || !target) {
      playThud();
      showToast('Pick both a Start and Target article (or click Roll Random Pair)!');
      return;
    }
    playTap();
    const t = DIFFICULTY_TIERS[app.customTier] || DIFFICULTY_TIERS.medium;
    startSoloGame({
      start,
      target,
      lang: app.customLang,
      par: t.par,
      tier: app.customTier,
      titleLabel: 'Custom Tangent',
      previews: $('customPreviews').checked,
      banHubs: $('customBanHubs').checked,
      lockInfobox: $('customLockInfobox').checked,
      maxHints: t.rules.maxHints,
      backCost: t.rules.backCost
    });
  });

  $('copyCustomLinkBtn').addEventListener('click', async () => {
    const start = $('customStartInput').value.trim();
    const target = $('customTargetInput').value.trim();
    if (!start || !target) {
      playThud();
      showToast('Enter Start and Target articles first');
      return;
    }
    playTap();
    const url = `${window.location.origin}/?from=${encodeURIComponent(start)}&to=${encodeURIComponent(target)}&lang=${encodeURIComponent(app.customLang)}&tier=${encodeURIComponent(app.customTier)}`;
    await navigator.clipboard?.writeText(url).catch(() => {});
    showToast('Friend Challenge link copied!');
  });

  $('customToRoomBtn').addEventListener('click', () => {
    playTap();
    $('roomStartInput').value = $('customStartInput').value.trim();
    $('roomTargetInput').value = $('customTargetInput').value.trim();
    app.roomLang = app.customLang;
    setActiveTab('room');
  });

  // Live Room controls
  const savedName = getNickname();
  if (savedName) {
    $('hostNameInput').value = savedName;
    $('joinNameInput').value = savedName;
  }

  document.querySelectorAll('[data-room-tier]').forEach((btn) => {
    btn.addEventListener('click', () => {
      playTap();
      app.roomTier = btn.dataset.roomTier;
      const t = DIFFICULTY_TIERS[app.roomTier] || DIFFICULTY_TIERS.medium;
      document.querySelectorAll('[data-room-tier]').forEach((b) => b.classList.toggle('active', b === btn));
      $('roomPreviews').checked = t.rules.previews;
      $('roomBanHubs').checked = t.rules.banHubs;
      $('roomLockInfobox').checked = t.rules.lockInfobox;
    });
  });

  mountLanguagePicker('roomLangPicker', () => app.roomLang, (code) => {
    app.roomLang = code;
  });
  attachWikiAutocomplete('roomStartInput', 'roomStartAC', () => app.roomLang);
  attachWikiAutocomplete('roomTargetInput', 'roomTargetAC', () => app.roomLang);

  document.querySelectorAll('[data-room-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      playTap();
      app.roomMode = btn.dataset.roomMode;
      document.querySelectorAll('[data-room-mode]').forEach((b) => b.classList.toggle('active', b === btn));
    });
  });

  $('roomRandomPairBtn').addEventListener('click', () => {
    playShuffle();
    const ch = generateTieredChallenge(app.roomTier);
    $('roomStartInput').value = ch.start;
    $('roomTargetInput').value = ch.target;
  });

  $('createRoomBtn').addEventListener('click', async () => {
    const name = $('hostNameInput').value.trim() || 'Host';
    setNickname(name);
    let start = $('roomStartInput').value.trim();
    let target = $('roomTargetInput').value.trim();
    const t = DIFFICULTY_TIERS[app.roomTier] || DIFFICULTY_TIERS.medium;
    let par = t.par;

    if (!start || !target) {
      const ch = generateTieredChallenge(app.roomTier);
      start = start || ch.start;
      target = target || ch.target;
      par = ch.par;
    }

    playTap();
    try {
      const { room } = await createRoom({
        clientId: app.clientId,
        name,
        start,
        target,
        lang: app.roomLang,
        par,
        tier: app.roomTier,
        mode: app.roomMode,
        previews: $('roomPreviews').checked,
        banHubs: $('roomBanHubs').checked,
        lockInfobox: $('roomLockInfobox').checked,
        maxHints: t.rules.maxHints,
        backCost: t.rules.backCost
      });
      app.room = room;
      history.replaceState({}, '', `/room/${room.code}`);
      renderRoomView();
      startRoomPolling(room.code);
      showToast(`Room ${room.code} created (${t.name} Tier)!`);
    } catch (err) {
      playThud();
      showToast(err.message || 'Could not create room');
    }
  });

  $('joinRoomBtn').addEventListener('click', async () => {
    const code = $('joinCodeInput').value.trim().toUpperCase();
    const name = $('joinNameInput').value.trim() || 'Player';
    $('roomJoinError').textContent = '';
    if (!code) {
      playThud();
      $('roomJoinError').textContent = 'Enter a 6-character room code.';
      return;
    }
    setNickname(name);
    playTap();
    try {
      const { room } = await joinRoom({ code, clientId: app.clientId, name });
      app.room = room;
      history.replaceState({}, '', `/room/${room.code}`);
      renderRoomView();
      startRoomPolling(room.code);
      showToast(`Joined room ${room.code}!`);
    } catch (err) {
      playThud();
      $('roomJoinError').textContent = err.message || 'Room not found';
    }
  });

  $('copyRoomInviteBtn').addEventListener('click', async () => {
    if (!app.room) return;
    playTap();
    const url = `${window.location.origin}/room/${app.room.code}`;
    await navigator.clipboard?.writeText(url).catch(() => {});
    showToast('Room invite link copied!');
  });

  $('startRoomRaceBtn').addEventListener('click', () => {
    playTap();
    triggerHostRoomStart(app.room?.status === 'finished');
  });

  $('leaveRoomBtn').addEventListener('click', () => {
    playTap();
    stopRoomPolling();
    app.room = null;
    history.replaceState({}, '', '/');
    renderRoomView();
  });

  // In-game controls & Collapsible Rails
  $('quitGameBtn').addEventListener('click', () => {
    playTap();
    setActiveTab('daily');
  });
  $('backBtn').addEventListener('click', handleBack);
  $('hintBtn').addEventListener('click', handleHint);
  $('pauseBtn').addEventListener('click', handlePause);

  $('toggleTocBtn').addEventListener('click', () => {
    playTap();
    app.tocCollapsed = !app.tocCollapsed;
    syncRailLayoutClasses();
  });

  $('toggleAsideBtn').addEventListener('click', () => {
    playTap();
    app.asideCollapsed = !app.asideCollapsed;
    syncRailLayoutClasses();
  });

  // Delegated Wikipedia link handler across both Center Prose AND Right Quick Facts Rail!
  $('readerLayout').addEventListener('click', (e) => {
    const link = e.target.closest('a[data-wiki-title]');
    if (!link || !app.game || app.game.paused || app.game.finished || app.navLoading) return;
    e.preventDefault();

    if (link.dataset.lockedInfobox === 'true') {
      playThud();
      link.classList.remove('shake');
      void link.offsetWidth;
      link.classList.add('shake');
      showToast('Boss Mode: Infobox links are locked! Navigate via article prose.');
      return;
    }

    if (link.dataset.bannedHub === 'true') {
      playThud();
      link.classList.remove('shake');
      void link.offsetWidth;
      link.classList.add('shake');
      showToast(`"${link.dataset.wikiTitle}" is a banned mega-hub in this tier!`);
      return;
    }

    playTap();
    const nextTitle = link.dataset.wikiTitle;
    const currentTitle = app.game.path[app.game.path.length - 1];
    navigateToArticle(nextTitle, {
      moveType: 'link',
      fromTitle: currentTitle,
      clickedTitle: nextTitle
    });
  });

  $('readerLayout').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const link = e.target.closest('a[data-wiki-title]');
      if (link) link.click();
    }
  });

  // Keep --site-header-h synced so sticky .game-bar never tucks behind wrapped mobile headers
  const siteHeader = document.querySelector('.site-header');
  if (siteHeader) {
    const syncHeaderHeight = () => {
      document.documentElement.style.setProperty(
        '--site-header-h',
        `${Math.round(siteHeader.getBoundingClientRect().height)}px`
      );
    };
    syncHeaderHeight();
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(syncHeaderHeight).observe(siteHeader);
    }
  }

  // Delegated TOC section scroll handler (works on 1st click even with deferred sections)
  $('tocList')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sec-id]');
    if (!btn) return;
    playTap();
    const targetEl = document.getElementById(btn.dataset.secId);
    if (!targetEl) return;

    app.tocScrollCancel?.();
    const ctrl = new AbortController();
    let rafId = null;
    app.tocScrollCancel = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      ctrl.abort();
    };

    // Reveal deferred sections up to and including the target section so layout height
    // is exact before computing the scroll offset (content-visibility: auto otherwise
    // estimates unvisited sections at 420px and stops smooth scrolls thousands of px short).
    const topTargetSec = targetEl.closest('#wikiArticle > section');
    for (const sec of document.querySelectorAll('#wikiArticle > section.wiki-section-deferred')) {
      if (sec === topTargetSec || sec.contains(targetEl)) {
        sec.classList.remove('wiki-section-deferred');
        break;
      }
      if (sec.compareDocumentPosition(targetEl) & Node.DOCUMENT_POSITION_FOLLOWING) {
        sec.classList.remove('wiki-section-deferred');
      } else {
        break;
      }
    }

    const getOffset = () => {
      const siteBottom = siteHeader?.getBoundingClientRect().bottom || 0;
      const barBottom = document.querySelector('#viewGame .game-bar')?.getBoundingClientRect().bottom || 0;
      return Math.round(Math.max(siteBottom, barBottom, 120)) + 14;
    };

    const getTargetTop = () => {
      const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      const rawTop = targetEl.getBoundingClientRect().top + window.scrollY - getOffset();
      return Math.max(0, Math.min(rawTop, maxScroll));
    };

    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      window.scrollTo({ top: getTargetTop(), behavior: 'instant' });
      return;
    }

    // Cancel automatic glide if the user manually scrolls or interacts
    const onUserInterrupt = () => app.tocScrollCancel?.();
    window.addEventListener('wheel', onUserInterrupt, { passive: true, once: true, signal: ctrl.signal });
    window.addEventListener('touchstart', onUserInterrupt, { passive: true, once: true, signal: ctrl.signal });

    const startY = window.scrollY;
    const dist = Math.abs(getTargetTop() - startY);
    if (dist <= 2) return;

    // Snappy ease-out cubic glide (260ms-520ms regardless of 500px or 35,000px distance)
    // that tracks live target coordinates each frame so mid-scroll layout shifts never miss.
    const duration = Math.min(520, Math.max(260, 220 + dist * 0.018));
    const startTs = performance.now();

    const step = (now) => {
      if (ctrl.signal.aborted || !targetEl.isConnected) return;
      const raw = Math.min(1, (now - startTs) / duration);
      const eased = 1 - Math.pow(1 - raw, 3);
      const liveTarget = getTargetTop();
      const nextY = raw >= 1 ? liveTarget : startY + (liveTarget - startY) * eased;
      window.scrollTo({ top: nextY, behavior: 'instant' });
      if (raw < 1) {
        rafId = requestAnimationFrame(step);
      } else {
        rafId = null;
        ctrl.abort();
      }
    };

    rafId = requestAnimationFrame(step);
  });

  // Decoupled intent-driven prefetching (works even when hover previews are OFF in Boss Mode!)
  // - Hover pause (80ms) -> low-priority max-1 prefetch
  // - pointerdown -> high-intent prefetch (~100ms head start before click)
  let hoverPrefetchTimer = null;
  $('readerLayout').addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const link = e.target.closest('a[data-wiki-title]');
    if (!link || !app.game || app.game.paused || app.game.finished) return;
    if (link.dataset.lockedInfobox === 'true' || link.dataset.bannedHub === 'true') return;
    clearTimeout(hoverPrefetchTimer);
    const title = link.dataset.wikiTitle;
    const lang = app.game.lang || 'en';
    hoverPrefetchTimer = setTimeout(() => {
      if (app.game && !app.game.paused && !app.game.finished) {
        prefetchWikiArticle(title, lang, { highIntent: false });
      }
    }, 80);
  });

  $('readerLayout').addEventListener('pointerout', (e) => {
    if (e.pointerType === 'touch') return;
    const link = e.target.closest('a[data-wiki-title]');
    if (!link) return;
    clearTimeout(hoverPrefetchTimer);
  });

  $('readerLayout').addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const link = e.target.closest('a[data-wiki-title]');
    if (!link || !app.game || app.game.paused || app.game.finished) return;
    if (link.dataset.lockedInfobox === 'true' || link.dataset.bannedHub === 'true') return;
    clearTimeout(hoverPrefetchTimer);
    prefetchWikiArticle(link.dataset.wikiTitle, app.game.lang || 'en', { highIntent: true });
  });

  // Guard browser Back / trackpad swipe back during an active challenge
  window.addEventListener('popstate', () => {
    if (!isActiveChallengeRunning()) return;
    // Immediately keep the user on the active challenge while asking for confirmation
    pushGameHistoryGuard();
    confirmLeaveChallenge('Leave to Home', () => {
      setActiveTab('daily', { skipConfirm: true });
    });
  });

  // Mount sleek Wikipedia Hovercard on #readerLayout (covers both Center Prose and Right Infobox Rail)
  app.hovercard = createHovercard({
    container: $('readerLayout'),
    getLang: () => app.game?.lang || 'en',
    isEnabled: () => Boolean(app.game && !app.game.paused && !app.game.finished && app.game.previews)
  });

  // Global keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || document.querySelector('dialog[open]')) return;

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && app.game && !app.game.finished) {
      showToast('Honour system: true Tangent pros skip Ctrl+F!');
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const k = e.key.toLowerCase();
    if (k === 't') {
      playTap();
      cycleTheme();
      renderThemeButton();
    } else if (k === 'm') {
      toggleSound();
      renderSoundButton();
    } else if (app.game && !app.game.finished && !app.game.paused) {
      if (k === 'h') handleHint();
      else if (k === 'p' && !app.game.roomCode) handlePause();
      else if (e.key === 'Backspace' || k === 'z') {
        e.preventDefault();
        handleBack();
      }
    }
  });

  // Persist exact progress & elapsed time before tab unload / refresh / backgrounding
  const flushActiveGameOnLeave = () => {
    if (!app.game || app.game.finished || app.game.roomCode) return;
    const isInGameView = !$('viewGame').classList.contains('hide');
    persistActiveGame(isInGameView);
  };
  window.addEventListener('pagehide', flushActiveGameOnLeave);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushActiveGameOnLeave();
  });

  // Deep-link & Refresh Restore handling:
  // /room/:code, ?challenge=daily&date=YYYY-MM-DD, ?challenge=solo&from=...&to=..., or ?from=...&to=...
  const pathMatch = window.location.pathname.match(/^\/room\/([A-Za-z0-9_-]+)/i);
  const params = new URLSearchParams(window.location.search);
  const roomCode = pathMatch?.[1] || params.get('room');
  const challengeParam = params.get('challenge');
  const dateParam = params.get('date');
  const fromParam = params.get('from');
  const toParam = params.get('to');
  const langParam = params.get('lang') || 'en';
  const tierParam = params.get('tier') || 'medium';
  const saved = getActiveGame();

  if (roomCode) {
    const upperCode = roomCode.toUpperCase();
    $('joinCodeInput').value = upperCode;
    setActiveTab('room');
    getRoomState(upperCode)
      .then(({ room }) => {
        if (room && room.players?.some((p) => p.id === app.clientId)) {
          app.room = room;
          renderRoomView();
          startRoomPolling(room.code);
          showToast(`Reconnected to room ${room.code}`);
        } else {
          showToast(`Enter your name to join room ${upperCode}`);
          $('joinNameInput').focus();
        }
      })
      .catch(() => {
        showToast(`Enter your name to join room ${upperCode}`);
        $('joinNameInput').focus();
      });
  } else if (challengeParam === 'daily' && dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    renderHome();
    if (saved && saved.dailyDate === dateParam) {
      openResumePrompt(saved);
    } else if (saved && saved.inGame) {
      openResumePrompt(saved);
    } else {
      launchDailyByDate(dateParam);
    }
  } else if (fromParam && toParam) {
    const cleanFrom = fromParam.replace(/_/g, ' ');
    const cleanTo = toParam.replace(/_/g, ' ');
    const tMeta = DIFFICULTY_TIERS[tierParam] || DIFFICULTY_TIERS.medium;
    const startFromUrl = () =>
      startSoloGame({
        start: cleanFrom,
        target: cleanTo,
        lang: langParam,
        par: tMeta.par,
        tier: tMeta.id,
        titleLabel: challengeParam === 'solo' ? 'Tangent' : 'Friend Challenge',
        ...tMeta.rules
      });

    renderHome();
    if (
      saved &&
      normTitle(saved.start) === normTitle(cleanFrom) &&
      normTitle(saved.target) === normTitle(cleanTo) &&
      (saved.lang || 'en') === langParam
    ) {
      openResumePrompt(saved, { onDiscard: startFromUrl });
    } else {
      startFromUrl();
    }
  } else {
    renderHome();
    if (saved && saved.inGame) {
      openResumePrompt(saved);
    }
  }
}

initApp();
