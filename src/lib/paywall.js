/**
 * One-time tongue-in-cheek "Tangent+ Ultra ($0.00/forever)" joke paywall modal.
 * Once claimed, unlocks the permanent VIP · $0 badge and hides the Tangent+ upsell
 * so the joke lands once and never clutters the UI afterward.
 */
import { getPrefs, updatePrefs } from './storage.js';
import { playTap, playWin } from './sound.js';

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function launchBrandConfetti(count = 36) {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const palette = ['#5372F8', '#F7C948', '#FF7A90', '#65C99A', '#B695F8'];
  for (let i = 0; i < count; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.background = palette[i % palette.length];
    piece.style.left = `${Math.random() * 100}vw`;
    piece.style.animationDelay = `${Math.random() * 0.45}s`;
    piece.style.borderRadius = i % 2 === 0 ? '50%' : '2px';
    document.body.appendChild(piece);
    setTimeout(() => piece.remove(), 2600);
  }
}

export function openJokePaywall({ triggerReason = '', onVipUnlocked = () => {} } = {}) {
  const dialog = document.getElementById('paywallDialog');
  const body = document.getElementById('paywallBody');
  if (!dialog || !body) return;

  const alreadyVip = getPrefs().vipPaidZero;
  playTap();

  body.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;">
      <div class="pw-ribbon" style="margin:0;">LIMITED TIME · ENDS NEVER</div>
      <form method="dialog" style="margin:0;">
        <button type="submit" class="icon-btn" aria-label="Close modal" style="width:32px;height:32px;min-width:32px;padding:0;">✕</button>
      </form>
    </div>
    <h2 id="paywallTitle" class="pw-title">Upgrade to <em>Tangent+ Ultra</em></h2>
    ${triggerReason ? `<p class="pw-trigger">${escapeHtml(triggerReason)}</p>` : ''}
    <div class="pw-price-box">
      <div class="pw-strike">$99.99/mo</div>
      <div class="pw-price">$0.00<span> / forever</span></div>
      <div class="pw-sub">No credit card. No subscription. Literally no checkout page.</div>
    </div>
    <ul class="pw-perks">
      <li><span class="pw-check">✓</span> Unlock all 26 letters of the alphabet in Wikipedia articles</li>
      <li><span class="pw-check">✓</span> 10-player Live Race Rooms (already free, we just wanted a bullet)</li>
      <li><span class="pw-check">✓</span> OLED True Black mode that is 0% blacker than free OLED mode</li>
      <li><span class="pw-check">✓</span> Exclusive golden <strong>VIP · $0</strong> badge — and this button disappears forever</li>
    </ul>
    <div class="pw-actions">
      <button type="button" class="btn btn-primary btn-lg" id="pwClaimBtn">
        ${alreadyVip ? 'Already a $0.00 Founding Member ✓' : 'Pay $0.00 Now'}
      </button>
      <button type="button" class="btn btn-ghost" id="pwCloseBtn">No thanks, I prefer paying $0 without the badge</button>
    </div>
    <div class="pw-status" id="pwStatus" aria-live="polite"></div>
  `;

  const claimBtn = body.querySelector('#pwClaimBtn');
  const closeBtn = body.querySelector('#pwCloseBtn');
  const status = body.querySelector('#pwStatus');

  if (alreadyVip) {
    claimBtn.disabled = true;
    closeBtn.textContent = 'Close';
  }

  claimBtn.addEventListener('click', () => {
    playWin();
    updatePrefs({ vipPaidZero: true });
    onVipUnlocked();
    launchBrandConfetti(42);
    claimBtn.disabled = true;
    claimBtn.textContent = 'Payment of $0.00 Approved ✓';
    closeBtn.textContent = 'Back to Tangent';
    status.textContent =
      'Welcome, Founding Billionaire. Tangent is 100% free forever — and we retired the Tangent+ button for you!';
  });

  closeBtn.addEventListener('click', () => {
    playTap();
    dialog.close();
  });

  dialog.showModal();
}
