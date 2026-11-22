/**
 * Sleek rounded Wikipedia Link Preview Hovercard.
 * Uses native [popover="manual"] with WCAG 3.2.1 safe tooltip semantics
 * (never steals focus) and viewport-clamped positioning.
 */
import { fetchWikiSummary, prefetchWikiArticle } from './wikipedia.js';

export function createHovercard({ container, getLang, isEnabled }) {
  const card = document.getElementById('wikiHovercard');
  if (!card) return { hide() {}, destroy() {} };

  let openTimer = null;
  let closeTimer = null;
  let activeLink = null;
  let activeToken = 0;
  let wasRecentlyOpen = false;
  let recentTimer = null;

  const supportsPopover = Object.hasOwn(HTMLElement.prototype, 'popover');

  function showPopover() {
    if (supportsPopover) {
      try {
        if (!card.matches(':popover-open')) card.showPopover();
      } catch {
        card.classList.add('is-open');
      }
    } else {
      card.classList.add('is-open');
    }
    wasRecentlyOpen = true;
    clearTimeout(recentTimer);
  }

  function hidePopover() {
    if (activeLink) {
      activeLink.removeAttribute('aria-describedby');
      activeLink = null;
    }
    if (supportsPopover) {
      try {
        if (card.matches(':popover-open')) card.hidePopover();
      } catch {
        card.classList.remove('is-open');
      }
    } else {
      card.classList.remove('is-open');
    }
    recentTimer = setTimeout(() => {
      wasRecentlyOpen = false;
    }, 350);
  }

  function positionNear(link) {
    const rect = link.getBoundingClientRect();
    const cardW = Math.min(340, window.innerWidth - 24);
    const estH = card.offsetHeight || 168;
    const margin = 12;

    let left = rect.left + rect.width / 2 - cardW / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - cardW - margin));

    const spaceBelow = window.innerHeight - rect.bottom;
    const placeAbove = spaceBelow < estH + 20 && rect.top > estH + 20;
    const top = placeAbove ? rect.top - estH - 10 : rect.bottom + 10;

    card.style.width = `${cardW}px`;
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(Math.max(margin, top))}px`;
    card.dataset.placement = placeAbove ? 'top' : 'bottom';
  }

  function renderLoading(title) {
    card.replaceChildren();
    const body = document.createElement('div');
    body.className = 'hc-body';

    const h = document.createElement('div');
    h.className = 'hc-title';
    h.textContent = title;

    const sk1 = document.createElement('div');
    sk1.className = 'hc-skel';
    const sk2 = document.createElement('div');
    sk2.className = 'hc-skel short';

    body.append(h, sk1, sk2);
    card.append(body);
  }

  function renderSummary(summary, isBanned) {
    card.replaceChildren();

    if (summary.thumbnail) {
      const thumbWrap = document.createElement('div');
      thumbWrap.className = 'hc-thumb-wrap';
      const img = document.createElement('img');
      img.className = 'hc-thumb';
      img.src = summary.thumbnail;
      img.alt = '';
      img.loading = 'eager';
      thumbWrap.appendChild(img);
      card.appendChild(thumbWrap);
    }

    const body = document.createElement('div');
    body.className = 'hc-body';

    const titleEl = document.createElement('div');
    titleEl.className = 'hc-title';
    titleEl.textContent = summary.title;
    body.appendChild(titleEl);

    if (isBanned) {
      const warn = document.createElement('div');
      warn.className = 'hc-banned-pill';
      warn.textContent = 'Banned Hub (Purist Rule)';
      body.appendChild(warn);
    } else if (summary.description) {
      const desc = document.createElement('div');
      desc.className = 'hc-desc';
      desc.textContent = summary.description;
      body.appendChild(desc);
    }

    if (summary.extract) {
      const p = document.createElement('p');
      p.className = 'hc-extract';
      p.textContent = summary.extract.length > 155 ? `${summary.extract.slice(0, 152)}…` : summary.extract;
      body.appendChild(p);
    }

    card.appendChild(body);
  }

  async function openForLink(link) {
    if (!isEnabled()) return;
    const title = link.dataset.wikiTitle;
    if (!title) return;

    const token = ++activeToken;
    activeLink = link;
    link.setAttribute('aria-describedby', card.id);

    renderLoading(title);
    showPopover();
    positionNear(link);

    const summary = await fetchWikiSummary(title, getLang());
    if (token !== activeToken || activeLink !== link) return;

    if (!summary) {
      hidePopover();
      return;
    }

    const isBanned = link.dataset.bannedHub === 'true';
    const isLocked = link.dataset.lockedInfobox === 'true';
    renderSummary(summary, isBanned);
    if (!isBanned && !isLocked) {
      prefetchWikiArticle(summary.title || title, getLang());
    }
    // Re-clamp once final image/text height is known
    requestAnimationFrame(() => {
      if (token === activeToken && activeLink === link) {
        positionNear(link);
      }
    });
  }

  function scheduleOpen(link) {
    if (!isEnabled()) return;
    clearTimeout(closeTimer);
    clearTimeout(openTimer);
    const delay = wasRecentlyOpen ? 80 : 250;
    openTimer = setTimeout(() => openForLink(link), delay);
  }

  function scheduleClose() {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    closeTimer = setTimeout(hidePopover, 140);
  }

  function onPointerOver(e) {
    if (e.pointerType === 'touch') return;
    const link = e.target.closest('a[data-wiki-title]');
    if (!link || !container.contains(link)) return;
    if (link === activeLink) {
      clearTimeout(closeTimer);
      return;
    }
    scheduleOpen(link);
  }

  function onPointerOut(e) {
    if (e.pointerType === 'touch') return;
    const link = e.target.closest('a[data-wiki-title]');
    if (!link) return;
    const to = e.relatedTarget;
    if (to && (card.contains(to) || link.contains(to))) return;
    scheduleClose();
  }

  function onFocusIn(e) {
    const link = e.target.closest('a[data-wiki-title]');
    if (link && container.contains(link)) scheduleOpen(link);
  }

  function onFocusOut(e) {
    const link = e.target.closest('a[data-wiki-title]');
    if (link) scheduleClose();
  }

  function onScrollOrClick() {
    clearTimeout(openTimer);
    hidePopover();
  }

  card.addEventListener('pointerenter', () => clearTimeout(closeTimer));
  card.addEventListener('pointerleave', scheduleClose);

  container.addEventListener('pointerover', onPointerOver);
  container.addEventListener('pointerout', onPointerOut);
  container.addEventListener('focusin', onFocusIn);
  container.addEventListener('focusout', onFocusOut);
  container.addEventListener('click', onScrollOrClick);
  window.addEventListener('scroll', onScrollOrClick, { passive: true });

  return {
    hide: onScrollOrClick,
    destroy() {
      onScrollOrClick();
      container.removeEventListener('pointerover', onPointerOver);
      container.removeEventListener('pointerout', onPointerOut);
      container.removeEventListener('focusin', onFocusIn);
      container.removeEventListener('focusout', onFocusOut);
      container.removeEventListener('click', onScrollOrClick);
      window.removeEventListener('scroll', onScrollOrClick);
    }
  };
}
