/**
 * Pre-Pause Gate Challenges ("Earn Your Pause"):
 * - The game clock KEEPS RUNNING until the player passes the check.
 * - Gate 0 (Runaway Pause Button): bounces across 4 distinct spots inside the arena,
 *   then settles — and clicking once isn't enough, you must click TWICE to pause!
 * - Once passed, the timer finally freezes, the article blurs, and a clean 1-click
 *   Resume button lets the player jump straight back in with zero friction.
 */
import { getPrefs, updatePrefs } from './storage.js';
import { playStep, playTap, playThud, playWin } from './sound.js';

const DODGE_WAYPOINTS = [
  { left: '28%', top: '24%' },
  { left: '72%', top: '26%' },
  { left: '72%', top: '76%' },
  { left: '28%', top: '74%' },
  { left: '50%', top: '22%' },
  { left: '50%', top: '78%' }
];

const DODGE_TAUNTS = [
  'Nope! Too slow — clock is still ticking!',
  'Almost had me! Catch me again!',
  'Parkour! Earn that break!',
  'Okay, okay… I’ll stay right here.'
];

export function openPauseGate({ getElapsedText, onPauseConfirmed, onResume, onCancel = () => {} }) {
  const dialog = document.getElementById('pauseDialog');
  const titleEl = document.getElementById('pauseTitle');
  const stage = document.getElementById('pauseStage');
  const subtitle = document.getElementById('pauseSubtitle');
  if (!dialog || !stage) {
    onPauseConfirmed();
    return { close() {} };
  }

  const prefs = getPrefs();
  // Rotate across all 5 gates; skip the Tangent+ tax gag if player already claimed VIP $0
  const totalGates = prefs.vipPaidZero ? 4 : 5;
  const gateIndex = (prefs.pauseIndex || 0) % totalGates;
  updatePrefs({ pauseIndex: (gateIndex + 1) % totalGates });

  if (titleEl) titleEl.textContent = 'Earn Your Pause';
  stage.replaceChildren();

  let phase = 'challenge'; // 'challenge' | 'paused' | 'closed'
  let cleanup = () => {};
  let clockInterval = null;
  let transitionTimer = null;

  const updateTickingClock = () => {
    if (phase !== 'challenge' || !subtitle) return;
    subtitle.textContent = `Clock still ticking: ${getElapsedText()} · Pass to freeze the timer`;
  };
  updateTickingClock();
  clockInterval = setInterval(updateTickingClock, 250);

  function addCleanup(fn) {
    const prev = cleanup;
    cleanup = () => {
      prev();
      fn();
    };
  }

  function stopLiveClock() {
    if (clockInterval) {
      clearInterval(clockInterval);
      clockInterval = null;
    }
  }

  function clearTransitionTimer() {
    if (transitionTimer) {
      clearTimeout(transitionTimer);
      transitionTimer = null;
    }
  }

  function scheduleEnterPaused(delayMs) {
    if (phase !== 'challenge') return;
    clearTransitionTimer();
    transitionTimer = setTimeout(() => {
      transitionTimer = null;
      enterPausedState();
    }, delayMs);
  }

  function onExternalClose() {
    if (phase === 'closed') return;
    const wasPaused = phase === 'paused';
    phase = 'closed';
    clearTransitionTimer();
    stopLiveClock();
    cleanup();
    cleanup = () => {};
    if (wasPaused) onResume();
    else onCancel();
  }

  function closeModalCleanly() {
    phase = 'closed';
    dialog.removeEventListener('close', onExternalClose);
    clearTransitionTimer();
    stopLiveClock();
    cleanup();
    cleanup = () => {};
    if (dialog.open) dialog.close();
  }

  function cancelAttempt() {
    if (phase !== 'challenge') return;
    playTap();
    closeModalCleanly();
    onCancel();
  }

  function enterPausedState() {
    if (phase !== 'challenge') return;
    phase = 'paused';
    clearTransitionTimer();
    stopLiveClock();
    cleanup();
    cleanup = () => {};
    playStep(5);

    const frozenText = onPauseConfirmed() || getElapsedText();
    if (titleEl) titleEl.textContent = 'Game Paused';
    if (subtitle) subtitle.textContent = `Timer frozen at ${frozenText}`;

    stage.replaceChildren();
    stage.innerHTML = `
      <div class="pg-badge mint">Timer Frozen</div>
      <p class="pg-prompt">Take a breather — the article is hidden and your clock is safely stopped.</p>
      <div class="pg-actions">
        <button type="button" class="btn btn-primary btn-lg" id="pgResumeNowBtn" autofocus>Resume Game</button>
      </div>
    `;

    const resumeBtn = stage.querySelector('#pgResumeNowBtn');
    const doResume = () => {
      playTap();
      closeModalCleanly();
      onResume();
    };
    resumeBtn.addEventListener('click', doResume);
    resumeBtn.focus();

    // Pressing Esc while paused cleanly resumes the game
    const onPausedCancel = (e) => {
      e.preventDefault();
      doResume();
    };
    dialog.addEventListener('cancel', onPausedCancel);
    addCleanup(() => dialog.removeEventListener('cancel', onPausedCancel));
  }

  dialog.addEventListener('close', onExternalClose, { once: true });

  // During the pre-pause challenge, Esc cancels the pause attempt and returns immediately to the game
  const onChallengeCancel = (e) => {
    e.preventDefault();
    cancelAttempt();
  };
  dialog.addEventListener('cancel', onChallengeCancel);
  addCleanup(() => dialog.removeEventListener('cancel', onChallengeCancel));

  const appendCancelRow = () => {
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-ghost btn-sm pg-nevermind';
    cancelBtn.textContent = 'Never mind, keep playing';
    cancelBtn.addEventListener('click', cancelAttempt);
    stage.appendChild(cancelBtn);
  };

  if (gateIndex === 0) {
    // Gate 1: Runaway Pause Button — bounces 4 times to distinct spots, settles,
    // and then requires TWO clicks to actually freeze the timer!
    const REQUIRED_DODGES = 4;
    stage.innerHTML = `
      <div class="pg-badge periwinkle">Catch the Pause Button</div>
      <p class="pg-prompt" id="pgShyPrompt">Click the button below to freeze your clock.</p>
      <div class="pg-shy-arena" id="pgShyArena">
        <button type="button" class="btn btn-primary pg-shy-btn" id="pgShyBtn">Pause Game</button>
      </div>
      <div class="pg-note" id="pgShyNote" aria-live="polite"></div>
    `;
    const btn = stage.querySelector('#pgShyBtn');
    const prompt = stage.querySelector('#pgShyPrompt');
    const note = stage.querySelector('#pgShyNote');

    // Pick 4 distinct random spots so the button clearly leaps around the arena
    const spots = [...DODGE_WAYPOINTS].sort(() => Math.random() - 0.5).slice(0, REQUIRED_DODGES);
    let dodges = 0;
    let settledClicks = 0;
    let lastDodgeTs = 0;

    const triggerDodge = () => {
      const now = performance.now();
      if (now - lastDodgeTs < 170) return;
      lastDodgeTs = now;

      const spot = spots[dodges] || DODGE_WAYPOINTS[0];
      dodges += 1;
      playTap();
      btn.style.left = spot.left;
      btn.style.top = spot.top;
      prompt.textContent = DODGE_TAUNTS[Math.min(dodges - 1, DODGE_TAUNTS.length - 1)];

      if (dodges < REQUIRED_DODGES) {
        note.textContent = `Dodged ${dodges}/${REQUIRED_DODGES} · Keep chasing!`;
      } else {
        note.textContent = 'Alright, it stopped moving. Click it now!';
      }
    };

    btn.addEventListener('pointerenter', (e) => {
      if (e.pointerType !== 'touch' && dodges < REQUIRED_DODGES) {
        triggerDodge();
      }
    });

    btn.addEventListener('click', () => {
      if (dodges < REQUIRED_DODGES) {
        triggerDodge();
        return;
      }

      settledClicks += 1;
      if (settledClicks === 1) {
        playThud();
        btn.style.left = '50%';
        btn.classList.add('is-armed');
        btn.classList.remove('shake');
        void btn.offsetWidth;
        btn.classList.add('shake');
        btn.textContent = 'Click Again to Pause (1/2)';
        prompt.textContent = 'Wait — are you REALLY sure? Once isn’t enough!';
        note.textContent = 'Click one more time to actually freeze the clock.';
        return;
      }

      enterPausedState();
    });

    appendCancelRow();
  } else if (gateIndex === 1) {
    // Gate 2: Hold to Earn Your Break (1.8s)
    stage.innerHTML = `
      <div class="pg-badge marigold">Patience Check</div>
      <p class="pg-prompt">Press and hold for <strong>1.8 seconds</strong> while the clock ticks to earn a pause.</p>
      <button type="button" class="pg-hold-btn" id="pgHoldBtn">
        <span class="pg-hold-fill" id="pgHoldFill"></span>
        <span class="pg-hold-label" id="pgHoldLabel">Hold to Pause</span>
      </button>
    `;
    const btn = stage.querySelector('#pgHoldBtn');
    const fill = stage.querySelector('#pgHoldFill');
    const label = stage.querySelector('#pgHoldLabel');
    let raf = null;
    let startTs = 0;
    let lastTone = -1;
    const DURATION = 1800;

    function stopHold() {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      startTs = 0;
      lastTone = -1;
      fill.style.transform = 'scaleX(0)';
      label.textContent = 'Hold to Pause';
    }

    function tick(now) {
      const pct = Math.min(1, (now - startTs) / DURATION);
      fill.style.transform = `scaleX(${pct})`;
      const toneIdx = Math.floor(pct * 4);
      if (toneIdx > lastTone) {
        lastTone = toneIdx;
        playStep(toneIdx);
      }
      if (pct >= 1) {
        label.textContent = 'Break earned!';
        raf = null;
        scheduleEnterPaused(120);
        return;
      }
      raf = requestAnimationFrame(tick);
    }

    function startHold(e) {
      e.preventDefault();
      if (raf) return;
      startTs = performance.now();
      label.textContent = 'Keep holding…';
      raf = requestAnimationFrame(tick);
    }

    btn.addEventListener('pointerdown', startHold);
    btn.addEventListener('pointerup', stopHold);
    btn.addEventListener('pointerleave', stopHold);
    btn.addEventListener('pointercancel', stopHold);
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        enterPausedState();
      }
    });

    addCleanup(() => {
      if (raf) cancelAnimationFrame(raf);
    });
    appendCancelRow();
  } else if (gateIndex === 2) {
    // Gate 3: 1 -> 2 -> 3 -> 4 Sequence Pop
    const order = [1, 2, 3, 4].sort(() => Math.random() - 0.5);
    stage.innerHTML = `
      <div class="pg-badge mint">Lock Sequence</div>
      <p class="pg-prompt">Tap the circles in order: <strong>1 → 2 → 3 → 4</strong> to freeze the timer.</p>
      <div class="pg-dots">
        ${order
          .map(
            (n) =>
              `<button type="button" class="pg-dot dot-${n}" data-n="${n}">${n}</button>`
          )
          .join('')}
      </div>
    `;
    let expected = 1;
    stage.querySelectorAll('.pg-dot').forEach((btn) => {
      btn.addEventListener('click', () => {
        const val = Number(btn.dataset.n);
        if (val === expected) {
          playStep(val);
          btn.classList.add('done');
          btn.disabled = true;
          expected += 1;
          if (expected > 4) scheduleEnterPaused(160);
        } else {
          playThud();
          btn.classList.remove('shake');
          void btn.offsetWidth;
          btn.classList.add('shake');
        }
      });
    });
    appendCancelRow();
  } else if (gateIndex === 3) {
    // Gate 4: Anti-Wiki-Bot Check
    const items = [
      { id: 'bot1', label: 'Bot #1', isHuman: false, svg: '<rect x="5" y="7" width="14" height="11" rx="2"/><path d="M12 3v4M9 12h.01M15 12h.01M9 15h6"/>' },
      { id: 'coffee', label: 'Hot Coffee', isHuman: true, svg: '<path d="M5 10h11v5a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4v-5z"/><path d="M16 11h2a2 2 0 0 1 0 4h-2M8 6c0-1 .8-1.5.8-2.5M12 6c0-1 .8-1.5.8-2.5"/>' },
      { id: 'bot2', label: 'Bot #2', isHuman: false, svg: '<rect x="5" y="7" width="14" height="11" rx="2"/><path d="M12 3v4M9 12h.01M15 12h.01M9 15h6"/>' }
    ].sort(() => Math.random() - 0.5);

    stage.innerHTML = `
      <div class="pg-badge lilac">Anti-Wiki-Bot Check</div>
      <p class="pg-prompt">Prove you need a human break: tap the one that is <strong>NOT a robot</strong>.</p>
      <div class="pg-bot-grid">
        ${items
          .map(
            (it) => `
          <button type="button" class="pg-bot-tile" data-human="${it.isHuman}">
            <svg viewBox="0 0 24 24" class="icon-svg" aria-hidden="true">${it.svg}</svg>
            <span>${it.label}</span>
          </button>`
          )
          .join('')}
      </div>
      <div class="pg-note" id="pgBotNote" aria-live="polite"></div>
    `;
    const note = stage.querySelector('#pgBotNote');
    stage.querySelectorAll('.pg-bot-tile').forEach((tile) => {
      tile.addEventListener('click', () => {
        if (tile.dataset.human === 'true') {
          tile.classList.add('correct');
          note.textContent = 'Verified caffeinated human. Freezing clock!';
          scheduleEnterPaused(180);
        } else {
          playThud();
          tile.classList.remove('shake');
          void tile.offsetWidth;
          tile.classList.add('shake');
          note.textContent = 'Beep boop… that one is definitely a robot.';
        }
      });
    });
    appendCancelRow();
  } else {
    // Gate 5: Tangent+ Pause Tax (only shown if player hasn't claimed the one-time $0 VIP gag yet)
    stage.innerHTML = `
      <div class="pg-badge coral">Tangent+ Pause Tax</div>
      <p class="pg-prompt">Pausing requires <strong>Tangent+ Ultra ($999/mo)</strong>.<br>Or just click the honest button below.</p>
      <div class="pg-actions">
        <button type="button" class="btn btn-primary" id="pgFakePay">Pay $999 / month</button>
        <button type="button" class="btn btn-ghost" id="pgRefuse">I refuse to pay, pause anyway</button>
      </div>
      <div class="pg-note" id="pgNote" aria-live="polite"></div>
    `;
    const fakePay = stage.querySelector('#pgFakePay');
    const refuse = stage.querySelector('#pgRefuse');
    const note = stage.querySelector('#pgNote');
    fakePay.addEventListener('click', () => {
      if (fakePay.disabled) return;
      fakePay.disabled = true;
      playWin();
      note.textContent = 'Card declined (we literally have no payment processor). Pausing for free!';
      scheduleEnterPaused(650);
    });
    refuse.addEventListener('click', enterPausedState);
    appendCancelRow();
  }

  dialog.showModal();
  return { close: closeModalCleanly };
}
