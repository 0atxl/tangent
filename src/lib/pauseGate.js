/**
 * 5 rotating playful <5-second Pause Gate mini-challenges.
 * Freezes the timer and blurs the article while paused; cycles cleanly
 * through all 5 gates on every pause interaction so it's always fresh & funny.
 */
import { getPrefs, updatePrefs } from './storage.js';
import { playStep, playTap, playThud, playWin } from './sound.js';

export function openPauseGate({ onResume, formatElapsed }) {
  const dialog = document.getElementById('pauseDialog');
  const stage = document.getElementById('pauseStage');
  const subtitle = document.getElementById('pauseSubtitle');
  if (!dialog || !stage) return onResume();

  const prefs = getPrefs();
  const gateIndex = (prefs.pauseIndex || 0) % 5;
  updatePrefs({ pauseIndex: (gateIndex + 1) % 5 });

  subtitle.textContent = `Timer frozen at ${formatElapsed()} · Quick human check to resume`;
  stage.replaceChildren();

  let cleanup = () => {};

  function completeGate() {
    cleanup();
    playStep(5);
    if (dialog.open) dialog.close();
    onResume();
  }

  // Prevent Esc from bypassing the pause gate while paused, showing a friendly note
  const onCancel = (e) => {
    e.preventDefault();
    playThud();
    stage.classList.remove('shake');
    void stage.offsetWidth;
    stage.classList.add('shake');
  };
  dialog.addEventListener('cancel', onCancel);
  const prevCleanup = cleanup;
  cleanup = () => {
    prevCleanup();
    dialog.removeEventListener('cancel', onCancel);
  };

  if (gateIndex === 0) {
    // Gate 1: Fake Tangent+ Pause Tax
    stage.innerHTML = `
      <div class="pg-badge coral">Tangent+ Pause Tax</div>
      <p class="pg-prompt">Unpausing requires <strong>Tangent+ Ultra ($999/mo)</strong>.<br>Or just click the honest button below.</p>
      <div class="pg-actions">
        <button type="button" class="btn btn-primary" id="pgFakePay">Pay $999 / month</button>
        <button type="button" class="btn btn-ghost" id="pgRefuse">I refuse to pay, let me resume</button>
      </div>
      <div class="pg-note" id="pgNote" aria-live="polite"></div>
    `;
    const fakePay = stage.querySelector('#pgFakePay');
    const refuse = stage.querySelector('#pgRefuse');
    const note = stage.querySelector('#pgNote');
    fakePay.addEventListener('click', () => {
      playWin();
      note.textContent = 'Card declined (we literally have no payment processor). Resuming for free!';
      setTimeout(completeGate, 650);
    });
    refuse.addEventListener('click', completeGate);
  } else if (gateIndex === 1) {
    // Gate 2: Hold to Prove You're Awake (1.3s)
    stage.innerHTML = `
      <div class="pg-badge marigold">Awake Check</div>
      <p class="pg-prompt">Press and hold for <strong>1.3 seconds</strong> to prove you didn't fall asleep mid-article.</p>
      <button type="button" class="pg-hold-btn" id="pgHoldBtn">
        <span class="pg-hold-fill" id="pgHoldFill"></span>
        <span class="pg-hold-label" id="pgHoldLabel">Hold to Resume</span>
      </button>
    `;
    const btn = stage.querySelector('#pgHoldBtn');
    const fill = stage.querySelector('#pgHoldFill');
    const label = stage.querySelector('#pgHoldLabel');
    let raf = null;
    let startTs = 0;
    let lastTone = -1;
    const DURATION = 1300;

    function stopHold() {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      startTs = 0;
      lastTone = -1;
      fill.style.transform = 'scaleX(0)';
      label.textContent = 'Hold to Resume';
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
        label.textContent = 'Wide awake!';
        raf = null;
        setTimeout(completeGate, 120);
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
      if (e.key === 'Enter' || e.key === ' ') completeGate();
    });

    const oldCleanup = cleanup;
    cleanup = () => {
      oldCleanup();
      if (raf) cancelAnimationFrame(raf);
    };
  } else if (gateIndex === 2) {
    // Gate 3: 1 -> 2 -> 3 Musical Pop
    const order = [1, 2, 3].sort(() => Math.random() - 0.5);
    stage.innerHTML = `
      <div class="pg-badge mint">Warm-Up Tap</div>
      <p class="pg-prompt">Tap the circles in order: <strong>1 → 2 → 3</strong></p>
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
          expected++;
          if (expected > 3) setTimeout(completeGate, 180);
        } else {
          playThud();
          btn.classList.remove('shake');
          void btn.offsetWidth;
          btn.classList.add('shake');
        }
      });
    });
  } else if (gateIndex === 3) {
    // Gate 4: Shy Resume Button (dodges playfully ONCE, then sits still)
    stage.innerHTML = `
      <div class="pg-badge periwinkle">Catch It</div>
      <p class="pg-prompt" id="pgShyPrompt">Tap the button below to jump back in.</p>
      <div class="pg-shy-arena">
        <button type="button" class="btn btn-primary pg-shy-btn" id="pgShyBtn">Resume Game</button>
      </div>
    `;
    const btn = stage.querySelector('#pgShyBtn');
    const prompt = stage.querySelector('#pgShyPrompt');
    let dodged = false;

    const dodgeOnce = () => {
      if (dodged) return;
      dodged = true;
      playTap();
      btn.style.transform = `translateX(${Math.random() > 0.5 ? 64 : -64}px)`;
      prompt.textContent = 'Whoa, too slow! Okay, okay — I’ll hold still now.';
    };

    btn.addEventListener('pointerenter', (e) => {
      if (e.pointerType !== 'touch') dodgeOnce();
    });
    btn.addEventListener('click', () => {
      if (!dodged) {
        dodgeOnce();
      } else {
        completeGate();
      }
    });
  } else {
    // Gate 5: Parody Bot Check ("Tap the one that is NOT a robot")
    const items = [
      { id: 'bot1', label: 'Bot #1', isHuman: false, svg: '<rect x="5" y="7" width="14" height="11" rx="2"/><path d="M12 3v4M9 12h.01M15 12h.01M9 15h6"/>' },
      { id: 'coffee', label: 'Hot Coffee', isHuman: true, svg: '<path d="M5 10h11v5a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4v-5z"/><path d="M16 11h2a2 2 0 0 1 0 4h-2M8 6c0-1 .8-1.5.8-2.5M12 6c0-1 .8-1.5.8-2.5"/>' },
      { id: 'bot2', label: 'Bot #2', isHuman: false, svg: '<rect x="5" y="7" width="14" height="11" rx="2"/><path d="M12 3v4M9 12h.01M15 12h.01M9 15h6"/>' }
    ].sort(() => Math.random() - 0.5);

    stage.innerHTML = `
      <div class="pg-badge lilac">Anti-Wiki-Bot Check</div>
      <p class="pg-prompt">Prove you aren't a web scraper: tap the one that is <strong>NOT a robot</strong>.</p>
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
          note.textContent = 'Verified caffeinated human.';
          setTimeout(completeGate, 200);
        } else {
          playThud();
          tile.classList.remove('shake');
          void tile.offsetWidth;
          tile.classList.add('shake');
          note.textContent = 'Beep boop… that one is definitely a robot.';
        }
      });
    });
  }

  dialog.showModal();
}
