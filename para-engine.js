/* =====================================================================
   Pomogator.med · Паразитология — надстройка над существующим index.html.
   Не переписывает NAV_DATA/FILE_MAP/loadContent и т.д., а дополняет их:
   классические <script> на одной странице делят общую область видимости,
   поэтому можно ссылаться на state/NAV_DATA/loadContent по имени и
   переопределять их, оборачивая оригинальную логику.
   ===================================================================== */

const PKEY = 'pomogator:para:progress';
let MANIFEST = {};
let SEARCH_INDEX = [];

// ---------------------------------------------------------------------
// Прогресс: localStorage
// ---------------------------------------------------------------------
function loadProgress() {
  try { return JSON.parse(localStorage.getItem(PKEY)) || {}; }
  catch (e) { return {}; }
}
function saveProgress(p) {
  try { localStorage.setItem(PKEY, JSON.stringify(p)); } catch (e) {}
}
function ensureEntry(p, itemId, tabIndex) {
  if (!p[itemId]) p[itemId] = {};
  if (!p[itemId][tabIndex]) {
    p[itemId][tabIndex] = { visited: false, isQuizTab: false, quiz: { total: 0, answers: {} }, explicit: null };
  }
  const e = p[itemId][tabIndex];
  if (!e.quiz || typeof e.quiz !== 'object') e.quiz = { total: 0, answers: {} };
  if (!e.quiz.answers || typeof e.quiz.answers !== 'object') e.quiz.answers = {};
  if (typeof e.quiz.total !== 'number') e.quiz.total = 0;
  return e;
}
function markVisited(itemId, tabIndex) {
  const p = loadProgress();
  const e = ensureEntry(p, itemId, tabIndex);
  if (e.visited) return;
  e.visited = true;
  saveProgress(p);
  refreshSidebarBadges();
}
function markTabAsQuiz(itemId, tabIndex) {
  const p = loadProgress();
  const e = ensureEntry(p, itemId, tabIndex);
  if (e.isQuizTab) return;
  e.isQuizTab = true;
  // Старые correct/wrong были собраны по CSS-классам и могли дублироваться.
  // Сохраняем посещение вкладки, но старые счётчики больше не используем.
  saveProgress(p);
}
function setQuizSnapshot(itemId, tabIndex, total, states) {
  const p = loadProgress();
  const e = ensureEntry(p, itemId, tabIndex);
  let changed = false;
  if (!e.isQuizTab) { e.isQuizTab = true; changed = true; }
  if (Number.isFinite(total) && total > e.quiz.total) { e.quiz.total = total; changed = true; }

  states.forEach(st => {
    if (!st || !st.id || typeof st.correct !== 'boolean') return;
    const prev = e.quiz.answers[st.id];
    if (!prev || prev.correct !== st.correct) {
      e.quiz.answers[st.id] = {
        correct: st.correct,
        attempts: prev && prev.attempts ? prev.attempts + 1 : 1
      };
      changed = true;
    }
  });

  if (changed) {
    saveProgress(p);
    refreshSidebarBadges();
  }
}
function setExplicitScore(itemId, tabIndex, correct, total) {
  if (!Number.isFinite(correct) || !Number.isFinite(total) || total <= 0) return;
  const p = loadProgress();
  const e = ensureEntry(p, itemId, tabIndex);
  const prev = e.explicit;
  if (e.isQuizTab && prev && prev.correct === correct && prev.total === total) return;
  e.isQuizTab = true;
  e.explicit = { correct, total };
  saveProgress(p);
  refreshSidebarBadges();
}

function computeItemStats(itemId) {
  const man = MANIFEST[itemId];
  if (!man) return { coverage: 0, quality: null, visitedCount: 0, totalReady: 0 };
  const p = loadProgress()[itemId] || {};
  const readyIdx = man.tabs.map((t, i) => (t.exists ? i : null)).filter(i => i !== null);
  let completionSum = 0;
  let answeredTotal = 0;
  let correctTotal = 0;

  readyIdx.forEach(i => {
    const t = p[i];
    let tabDone = 0;
    if (t) {
      if (t.isQuizTab) {
        // Прогресс интерактива = доля УНИКАЛЬНЫХ отвеченных вопросов,
        // качество = доля правильных среди отвеченных. Эти метрики независимы.
        if (t.explicit && t.explicit.total > 0) {
          tabDone = 1; // итоговый тест проверен целиком
          answeredTotal += t.explicit.total;
          correctTotal += Math.max(0, Math.min(t.explicit.correct, t.explicit.total));
        } else if (t.quiz && t.quiz.total > 0) {
          const answers = Object.values(t.quiz.answers || {}).filter(a => a && typeof a.correct === 'boolean');
          const answered = Math.min(answers.length, t.quiz.total);
          const correct = answers.filter(a => a.correct).length;
          tabDone = Math.min(1, answered / t.quiz.total);
          answeredTotal += answered;
          correctTotal += Math.min(correct, answered);
        }
      } else {
        // Теоретическая вкладка: просмотрена = пройдена.
        tabDone = t.visited ? 1 : 0;
      }
    }
    completionSum += tabDone;
  });

  const coverage = readyIdx.length ? completionSum / readyIdx.length : 0;
  const quality = answeredTotal ? correctTotal / answeredTotal : null;
  return { coverage, quality, visitedCount: completionSum, totalReady: readyIdx.length };
}

// ---------------------------------------------------------------------
// Обёртка над loadContent: подмена "битых" вкладок аккуратной карточкой,
// отметка "просмотрено"
// ---------------------------------------------------------------------
const _origLoadContent = loadContent;
loadContent = function (itemId, tabIndex, container) {
  const man = MANIFEST[itemId];
  const tabMeta = man && man.tabs[tabIndex];
  if (tabMeta && !tabMeta.exists) {
    container.innerHTML = `<div class="wip-card"><div class="wip-emoji">🚧</div>
      <div class="wip-title">Материал готовится</div>
      <p>Эта тема пока в разработке — скоро здесь появится разбор. Загляните позже 🙂</p></div>`;
    return;
  }
  markVisited(itemId, tabIndex);
  _origLoadContent(itemId, tabIndex, container);
};

// ---------------------------------------------------------------------
// Обёртка над afterContentLoaded: защита вёрстки + корректный учёт прогресса
// ---------------------------------------------------------------------
const _origAfterContentLoaded = afterContentLoaded;
afterContentLoaded = function (container, itemId, tabIndex) {
  _origAfterContentLoaded(container, itemId, tabIndex);
  stabilizeRichContent(container, itemId);
  attachScoreObserver(container, itemId, tabIndex);
};

function stabilizeRichContent(container, itemId) {
  // Любая широкая таблица прокручивается ВНУТРИ вкладки и больше не
  // растягивает всю страницу. Уже существующие table-wrapper сохраняем.
  container.querySelectorAll('table').forEach(table => {
    if (table.closest('.pm-table-scroll')) return;
    const parent = table.parentElement;
    const parentLooksLikeWrapper = parent && (
      parent.classList.contains('table-wrapper') ||
      parent.classList.contains('table-container') ||
      parent.classList.contains('responsive-table') ||
      /table.*(wrapper|container)|scroll/i.test(parent.className || '')
    );
    if (parentLooksLikeWrapper) {
      parent.classList.add('pm-table-scroll');
      return;
    }
    if (!parent) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'pm-table-scroll';
    wrapper.setAttribute('role', 'region');
    wrapper.setAttribute('aria-label', 'Таблица с горизонтальной прокруткой');
    parent.insertBefore(wrapper, table);
    wrapper.appendChild(table);
  });

  // Все медиа ограничиваются шириной вкладки. Это работает даже для старых
  // файлов с width/height в style/атрибутах и не меняет сам материал.
  container.querySelectorAll('img, video, canvas, svg').forEach(el => {
    el.classList.add('pm-responsive-media');
  });

  // Фрагменты HTML загружаются через fetch() в корневой index.html, поэтому
  // пути к изображениям должны считаться от корня сайта. Одновременно здесь
  // ставится общий fallback: отсутствующий файл никогда не показывает битую
  // иконку и не ломает размеры страницы.
  container.querySelectorAll('img').forEach(img => {
    const raw = (img.getAttribute('src') || '').trim();
    if (raw && !/^(?:https?:|data:|blob:|\/\/)/i.test(raw)) {
      let normalized = raw.replace(/^\.\//, '');
      while (normalized.startsWith('../')) normalized = normalized.slice(3);
      if (normalized !== raw) img.setAttribute('src', normalized);
    }

    if (img.dataset.pmFallbackBound === '1') return;
    img.dataset.pmFallbackBound = '1';
    const showMissingImage = () => {
      img.classList.add('pm-media-broken');
      img.style.display = 'none';

      const sibling = img.nextElementSibling;
      if (sibling && (sibling.classList.contains('placeholder') || sibling.classList.contains('image-placeholder'))) {
        sibling.style.display = 'flex';
        sibling.classList.add('pm-media-placeholder');
        return;
      }

      if (img.dataset.pmFallbackInserted === '1') return;
      img.dataset.pmFallbackInserted = '1';
      const fallback = document.createElement('div');
      fallback.className = 'pm-media-placeholder';
      const alt = (img.getAttribute('alt') || 'Изображение').trim();
      const src = (img.getAttribute('src') || '').trim();
      fallback.innerHTML = `<span class="pm-media-placeholder-icon">🖼️</span><strong>${escapeHtml(alt)}</strong><small>Файл изображения пока отсутствует${src ? ': ' + escapeHtml(src.split('/').pop()) : ''}</small>`;
      img.insertAdjacentElement('afterend', fallback);
    };
    img.addEventListener('error', showMissingImage);
    // Если ошибка загрузки успела произойти до подключения обработчика.
    if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) showMissingImage();
  });
}

function quizStateFromResult(resultEl) {
  if (!resultEl) return null;
  const text = (resultEl.textContent || '').trim();
  // Предупреждения «выберите/введите» не являются ответом.
  if (!text || text.startsWith('⚠️')) return null;
  if (resultEl.classList.contains('pass')) return true;
  if (resultEl.classList.contains('fail')) return false;
  return null;
}

function collectQuizSnapshot(container) {
  const states = [];
  let total = 0;

  const addUnits = (selector, prefix, getter, filter) => {
    Array.from(container.querySelectorAll(selector)).forEach((el, idx) => {
      if (filter && !filter(el)) return;
      total += 1;
      const correct = getter(el);
      if (typeof correct === 'boolean') {
        const id = el.dataset.progressId || `${prefix}:${idx}`;
        states.push({ id, correct });
      }
    });
  };

  addUnits('.term-task', 'term', el => quizStateFromResult(el.querySelector('.task-result')));
  addUnits('.test-item', 'test', el => quizStateFromResult(el.querySelector('.test-result-custom')));
  addUnits('.test-block', 'test-block', el => quizStateFromResult(el.querySelector('.test-result')));
  addUnits('.question-block', 'question', el => {
    if (el.querySelector('.option.selected-correct')) return true;
    if (el.querySelector('.option.selected-wrong')) return false;
    return null;
  }, el => !el.closest('#randomQuestionsContainer'));

  return { total, states };
}

function attachScoreObserver(container, itemId, tabIndex) {
  (state._activeObservers || []).forEach(o => o.disconnect());
  state._activeObservers = [];

  let syncTimer = null;
  const sync = () => {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      const snap = collectQuizSnapshot(container);
      const scoreEl = container.querySelector('#scoreDisplay, .score');
      if (snap.total > 0 || scoreEl) {
        markTabAsQuiz(itemId, tabIndex);
        if (snap.total > 0) setQuizSnapshot(itemId, tabIndex, snap.total, snap.states);
      }
    }, 40);
  };

  // Наблюдаем не за отдельными .correct/.wrong, а за состоянием вопроса
  // целиком. Поэтому подсветка правильного варианта после ошибки больше
  // не создаёт фиктивный «правильный ответ» в статистике.
  const uiObs = new MutationObserver(sync);
  uiObs.observe(container, {
    attributes: true,
    attributeFilter: ['class'],
    childList: true,
    characterData: true,
    subtree: true
  });
  state._activeObservers.push(uiObs);

  const scoreEl = container.querySelector('#scoreDisplay, .score');
  if (scoreEl) {
    const readScore = () => {
      const m = scoreEl.textContent.match(/(\d+)\s*\/\s*(\d+)/);
      if (m && parseInt(m[2], 10) > 0) {
        setExplicitScore(itemId, tabIndex, parseInt(m[1], 10), parseInt(m[2], 10));
      }
    };
    const textObs = new MutationObserver(readScore);
    textObs.observe(scoreEl, { characterData: true, childList: true, subtree: true });
    state._activeObservers.push(textObs);
    readScore();
  }

  sync();
}

// ---------------------------------------------------------------------
// Обёртка над renderSidebar/renderTabs: значки прогресса и "🚧"
// ---------------------------------------------------------------------
const _origRenderSidebar = renderSidebar;
renderSidebar = function () {
  _origRenderSidebar();
  enhanceSidebar();
};

function enhanceSidebar() {
  document.querySelectorAll('.menu-item').forEach(btn => {
    const id = btn.getAttribute('data-item-id');
    const man = MANIFEST[id];
    btn.querySelectorAll('.mi-dot, .mi-soon').forEach(el => el.remove());
    const label = document.createElement('span');
    label.textContent = btn.textContent;
    // не трогаем textContent напрямую — оборачиваем в span, чтобы добавить бейджи рядом
    btn.innerHTML = '';
    btn.appendChild(label);

    if (man && !man.ready) {
      btn.classList.add('not-ready');
      const soon = document.createElement('span');
      soon.className = 'mi-soon';
      soon.textContent = 'скоро';
      btn.appendChild(soon);
      return;
    }
    if (man) {
      const stats = computeItemStats(id);
      const dot = document.createElement('span');
      dot.className = 'mi-dot' + (stats.coverage >= 1 ? ' done' : stats.coverage > 0 ? ' started' : '');
      btn.appendChild(dot);
    }
  });

  document.querySelectorAll('.accordion-header').forEach(header => {
    header.querySelectorAll('.sec-pct').forEach(el => el.remove());
  });
  NAV_DATA.forEach(section => {
    let ready = 0, visited = 0;
    section.items.forEach(item => {
      const man = MANIFEST[item.id];
      if (!man || !man.ready) return;
      const s = computeItemStats(item.id);
      ready += s.totalReady;
      visited += s.visitedCount;
    });
    if (!ready) return;
    const pct = Math.round(100 * visited / ready);
    const headers = document.querySelectorAll('.accordion-header');
    headers.forEach(h => {
      if (h.textContent.trim().startsWith(section.title)) {
        const span = document.createElement('span');
        span.className = 'sec-pct';
        span.textContent = pct + '%';
        const arrow = h.querySelector('.arrow');
        if (arrow) h.insertBefore(span, arrow); else h.appendChild(span);
      }
    });
  });

  refreshProgressButton();
}

function refreshSidebarBadges() {
  enhanceSidebar();
  const dash = document.getElementById('progressDash');
  if (dash && dash.style.display !== 'none') renderDashboard();
}

const _origRenderTabs = renderTabs;
renderTabs = function (item) {
  _origRenderTabs(item);
  const man = MANIFEST[item.id];
  if (!man) return;
  const header = document.getElementById('tabsHeader');
  header.querySelectorAll('.tab-btn').forEach((btn, idx) => {
    const t = man.tabs[idx];
    if (t && !t.exists) btn.classList.add('not-ready');
  });
};

// ---------------------------------------------------------------------
// Поиск по терминам
// ---------------------------------------------------------------------
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function searchScore(entry, ql) {
  let score = 0;
  if (entry.itemTitle.toLowerCase().includes(ql)) score += 50;
  if (entry.tabName.toLowerCase().includes(ql)) score += 30;
  const occurrences = entry.text.toLowerCase().split(ql).length - 1;
  score += occurrences * 5;
  return score;
}
function snippetFor(text, q) {
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  let snippet;
  if (idx === -1) snippet = text.slice(0, 120) + '…';
  else {
    const start = Math.max(0, idx - 50);
    const end = Math.min(text.length, idx + q.length + 70);
    snippet = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
  }
  const safe = escapeHtml(snippet);
  const re = new RegExp(escapeRegExp(escapeHtml(q)), 'ig');
  return safe.replace(re, m => `<mark>${m}</mark>`);
}

function runSearch(query) {
  const results = document.getElementById('searchResults');
  const ql = query.trim().toLowerCase();
  if (ql.length < 2) { results.classList.remove('show'); results.innerHTML = ''; return; }

  const scored = SEARCH_INDEX
    .map(e => ({ e, score: searchScore(e, ql) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  if (!scored.length) {
    results.innerHTML = `<div class="sr-empty">Ничего не найдено по «${escapeHtml(query)}»</div>`;
    results.classList.add('show');
    return;
  }

  results.innerHTML = scored.map(({ e }) => `
    <button class="search-result-item" data-item-id="${e.itemId}" data-tab-index="${e.tabIndex}">
      <div class="sr-path">${escapeHtml(e.sectionTitle)} / ${escapeHtml(e.itemTitle)}</div>
      <div class="sr-tab">${escapeHtml(e.tabName)}</div>
      <div class="sr-snippet">${snippetFor(e.text, query)}</div>
    </button>`).join('');
  results.classList.add('show');

  results.querySelectorAll('.search-result-item').forEach(btn => {
    btn.addEventListener('click', () => {
      openSearchResult(btn.getAttribute('data-item-id'), parseInt(btn.getAttribute('data-tab-index'), 10));
    });
  });
}

function openSearchResult(itemId, tabIndex) {
  showDashboard(false);
  selectMenuItem(itemId);
  const header = document.getElementById('tabsHeader');
  const btn = header.querySelector(`[data-tab-index="${tabIndex}"]`);
  if (btn) btn.click();
  document.getElementById('searchResults').classList.remove('show');
  document.getElementById('searchInput').value = '';
  if (window.innerWidth < 900) {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('overlay').classList.remove('show');
  }
}

function setupSearch() {
  const input = document.getElementById('searchInput');
  if (!input) return;
  let t = null;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => runSearch(input.value), 150);
  });
  input.addEventListener('keydown', e => { if (e.key === 'Escape') { input.value = ''; runSearch(''); } });
  document.addEventListener('click', e => {
    if (!e.target.closest('.search-box')) document.getElementById('searchResults').classList.remove('show');
  });
}

// ---------------------------------------------------------------------
// Дашборд прогресса и рекомендаций
// ---------------------------------------------------------------------
function refreshProgressButton() {
  const btn = document.getElementById('progressNavBtn');
  if (!btn) return;
  const { pct } = overallStats();
  btn.querySelector('.pnb-pct').textContent = pct + '%';
}

function overallStats() {
  let totalReady = 0, totalVisited = 0;
  Object.keys(MANIFEST).forEach(id => {
    if (!MANIFEST[id].ready) return;
    const s = computeItemStats(id);
    totalReady += s.totalReady;
    totalVisited += s.visitedCount;
  });
  const pct = totalReady ? Math.round(100 * totalVisited / totalReady) : 0;
  return { totalReady, totalVisited, pct };
}

function renderDashboard() {
  const dash = document.getElementById('progressDash');
  if (!dash) return;

  const readyItems = Object.entries(MANIFEST).filter(([, m]) => m.ready);
  const statsById = {};
  const perSection = {};
  readyItems.forEach(([id, m]) => {
    const s = computeItemStats(id);
    statsById[id] = s;
    if (!perSection[m.sectionTitle]) perSection[m.sectionTitle] = { ready: 0, visited: 0 };
    perSection[m.sectionTitle].ready += s.totalReady;
    perSection[m.sectionTitle].visited += s.visitedCount;
  });

  const { pct: overallPct, totalReady, totalVisited } = overallStats();

  const notStarted = readyItems.filter(([id]) => statsById[id].coverage === 0);
  const weak = readyItems
    .filter(([id]) => statsById[id].quality !== null && statsById[id].quality < 0.7)
    .sort((a, b) => statsById[a[0]].quality - statsById[b[0]].quality);

  let html = `<div class="pd-summary" style="--pct:${overallPct}%">
      <div class="pd-ring"><span>${overallPct}%</span></div>
      <div><h2>Ваш прогресс по паразитологии</h2><p>${Math.round(totalVisited * 10) / 10} из ${totalReady} вкладок пройдено по объёму материала</p></div>
    </div>`;

  html += `<div class="pd-section"><h3>Прогресс по разделам</h3>`;
  Object.entries(perSection).forEach(([title, s]) => {
    const pct = s.ready ? Math.round(100 * s.visited / s.ready) : 0;
    html += `<div class="pd-bar-row"><div class="pd-label">${escapeHtml(title)}</div>
      <div class="pd-bar-track"><div class="pd-bar-fill" style="width:${pct}%"></div></div>
      <div class="pd-pct">${pct}%</div></div>`;
  });
  html += `</div>`;

  html += `<div class="pd-section"><h3>🔁 Рекомендуем повторить</h3>`;
  if (!weak.length) {
    html += `<div class="pd-empty-good">Слабых тем по тестам пока нет — либо всё хорошо, либо тесты ещё не пройдены.</div>`;
  } else {
    weak.slice(0, 6).forEach(([id, m]) => {
      html += `<div class="pd-reco-item" data-open-item="${id}">
        <div><div class="pri-title">${escapeHtml(m.title)}</div><div class="pri-sub">${escapeHtml(m.sectionTitle)}</div></div>
        <span class="pri-badge weak">${Math.round(statsById[id].quality * 100)}% верно</span></div>`;
    });
  }
  html += `</div>`;

  html += `<div class="pd-section"><h3>🆕 Ещё не открыто</h3>`;
  if (!notStarted.length) {
    html += `<div class="pd-empty-good">Вы открыли все готовые темы 🎉</div>`;
  } else {
    notStarted.slice(0, 6).forEach(([id, m]) => {
      html += `<div class="pd-reco-item" data-open-item="${id}">
        <div><div class="pri-title">${escapeHtml(m.title)}</div><div class="pri-sub">${escapeHtml(m.sectionTitle)}</div></div>
        <span class="pri-badge new">начать</span></div>`;
    });
  }
  html += `</div>`;

  html += `<button class="pd-reset-btn" id="resetProgressBtn">🗑 Сбросить весь прогресс (например, перед подготовкой к экзамену)</button>
    <button class="btn btn-back" style="margin-top:10px;" id="dashBackBtn">⬅ Вернуться к материалам</button>`;

  dash.innerHTML = html;

  dash.querySelectorAll('[data-open-item]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.getAttribute('data-open-item');
      showDashboard(false);
      selectMenuItem(id);
    });
  });
  document.getElementById('resetProgressBtn').addEventListener('click', () => {
    if (confirm('Точно сбросить весь прогресс по паразитологии?\n\nЭто удалит все отметки о пройденных темах и результаты тестов. Действие нельзя отменить.')) {
      localStorage.removeItem(PKEY);
      renderDashboard();
      refreshSidebarBadges();
    }
  });
  document.getElementById('dashBackBtn').addEventListener('click', () => showDashboard(false));
}

function showDashboard(show) {
  const dash = document.getElementById('progressDash');
  const tabs = document.getElementById('tabsContainer');
  if (!dash || !tabs) return;
  dash.style.display = show ? 'block' : 'none';
  tabs.style.display = show ? 'none' : 'block';
  if (show) renderDashboard();
}

// ---------------------------------------------------------------------
// Инициализация
// ---------------------------------------------------------------------
Promise.all([
  fetch('content-manifest.json').then(r => r.json()),
  fetch('search-index.json').then(r => r.json())
]).then(([manifest, index]) => {
  MANIFEST = manifest;
  SEARCH_INDEX = index;
  enhanceSidebar();
}).catch(err => console.warn('Не удалось загрузить данные поиска/прогресса:', err));

document.addEventListener('DOMContentLoaded', () => {
  setupSearch();
  const progressBtn = document.getElementById('progressNavBtn');
  if (progressBtn) progressBtn.addEventListener('click', () => showDashboard(true));
});
