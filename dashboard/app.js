(function () {
  'use strict';

  if (!window.RADAR) {
    console.error('window.RADAR not found.');
    return;
  }

  const radar = window.RADAR;
  let boardDataRows = radar.rows || [];
  let boardJsonMap = new Map(); // slug -> full row from board.json

  // State
  let currentSortCol = 'rank';
  let currentSortAsc = true;
  let searchTerm = '';
  let selectedCategory = '';
  let selectedVerdict = 'ALL';
  let watchlistOnly = false;
  let farmableOnly = false;

  // Formatters
  const formatUSD = (num) => {
    if (num === null || num === undefined) return 'N/A';
    if (num >= 1e9) return '$' + (num / 1e9).toFixed(2) + 'B';
    if (num >= 1e6) return '$' + (num / 1e6).toFixed(2) + 'M';
    if (num >= 1e3) return '$' + (num / 1e3).toFixed(1) + 'k';
    return '$' + num.toLocaleString();
  };

  const formatPct = (num) => {
    if (num === null || num === undefined) return 'N/A';
    let val = num;
    if (val > 999) val = 999;
    if (val < -999) val = -999;
    const sign = val > 0 ? '+' : '';
    return sign + val.toFixed(1) + '%';
  };

  const formatNum = (num, decimals = 2) => {
    if (num === null || num === undefined) return 'N/A';
    return num.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  };

  // Fetch board.json for full farm steps
  fetch('./board.json')
    .then(res => res.json())
    .then(data => {
      if (data && data.rows) {
        data.rows.forEach(r => {
          boardJsonMap.set(r.slug, r);
        });
        handleRoute();
      }
    })
    .catch(() => {
      console.info('board.json fetch skipped/failed (file:// mode). Using data.js embedded fields.');
    });

  // Initialization
  function init() {
    setupKPIs();
    setupCategories();
    setupEventListeners();
    window.addEventListener('hashchange', handleRoute);
    handleRoute();
  }

  function setupKPIs() {
    if (radar.validation) {
      const v = radar.validation;
      document.getElementById('kpi-loo').textContent = `${v.loo_median_abs_log_err} log err (${(v.loo_within_2x_share * 100).toFixed(1)}% within 2×)`;
      document.getElementById('kpi-split').textContent = `${v.split_median_abs_log_err} log err (${(v.split_within_2x_share * 100).toFixed(1)}% within 2×)`;
      document.getElementById('kpi-walk').textContent = `${v.walk_forward_median_abs_log_err} median log err`;
      document.getElementById('kpi-auc').textContent = `${v.cv_auc} (5-fold CV)`;
      document.getElementById('kpi-eq').textContent = `R² = ${v.r2} | Quad OLS + Growth + Age`;

      // Validation view population
      const setVal = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
      };
      setVal('val-loo-err', v.loo_median_abs_log_err);
      setVal('val-loo-share', (v.loo_within_2x_share * 100).toFixed(1) + '%');
      setVal('val-split-err', v.split_median_abs_log_err);
      setVal('val-split-share', (v.split_within_2x_share * 100).toFixed(1) + '%');
      setVal('val-walk-err', v.walk_forward_median_abs_log_err);
      setVal('val-auc', v.cv_auc);

      if (v.coefficients) {
        setVal('coeff-intercept', v.coefficients.intercept);
        setVal('coeff-tvl', v.coefficients.log_tvl);
        setVal('coeff-tvl-sq', v.coefficients.log_tvl_sq);
        setVal('coeff-growth', v.coefficients.growth);
        setVal('coeff-age', v.coefficients.log_age);
      }
      if (v.bootstrap_slope_band) {
        setVal('coeff-band', `[${v.bootstrap_slope_band[0]}, ${v.bootstrap_slope_band[1]}]`);
      }
    }
    renderAnchors();
  }

  function setupCategories() {
    const cats = new Set();
    boardDataRows.forEach(r => {
      if (r.category) cats.add(r.category);
    });
    const select = document.getElementById('category-select');
    Array.from(cats).sort().forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = cat;
      select.appendChild(opt);
    });
  }

  function setupEventListeners() {
    document.getElementById('search-input').addEventListener('input', (e) => {
      searchTerm = e.target.value.toLowerCase().trim();
      renderBoardTable();
    });

    document.getElementById('category-select').addEventListener('change', (e) => {
      selectedCategory = e.target.value;
      renderBoardTable();
    });

    document.querySelectorAll('.v-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.v-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        selectedVerdict = e.target.getAttribute('data-verdict');
        if (selectedVerdict === 'ALL') {
          window.location.hash = '#/';
        } else {
          window.location.hash = `#/f/${selectedVerdict}`;
        }
        renderBoardTable();
      });
    });

    document.getElementById('watchlist-toggle').addEventListener('change', (e) => {
      watchlistOnly = e.target.checked;
      renderBoardTable();
    });

    document.getElementById('farmable-toggle').addEventListener('change', (e) => {
      farmableOnly = e.target.checked;
      renderBoardTable();
    });

    document.querySelectorAll('#board-table th.sortable').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.getAttribute('data-sort');
        if (currentSortCol === col) {
          currentSortAsc = !currentSortAsc;
        } else {
          currentSortCol = col;
          currentSortAsc = true;
        }
        renderBoardTable();
      });
    });

    ['sb-tvl', 'sb-change', 'sb-age', 'sb-odds'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', updateSandbox);
      }
    });

    updateSandbox();
  }

  function handleRoute() {
    const hash = window.location.hash || '#/';
    
    document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav-link').forEach(el => el.classList.remove('active'));

    if (hash.startsWith('#/p/')) {
      const slug = hash.replace('#/p/', '');
      document.getElementById('view-detail').classList.add('active');
      renderDetail(slug);
    } else if (hash.startsWith('#/f/')) {
      const verdict = hash.replace('#/f/', '').toUpperCase();
      selectedVerdict = ['FARM', 'THIN', 'SKIP'].includes(verdict) ? verdict : 'ALL';
      syncVerdictButtons();
      document.getElementById('view-board').classList.add('active');
      document.getElementById('nav-board').classList.add('active');
      renderBoardTable();
    } else if (hash === '#/validation') {
      document.getElementById('view-validation').classList.add('active');
      document.getElementById('nav-validation').classList.add('active');
    } else if (hash === '#/sandbox') {
      document.getElementById('view-sandbox').classList.add('active');
      document.getElementById('nav-sandbox').classList.add('active');
    } else if (hash === '#/research') {
      document.getElementById('view-research').classList.add('active');
      document.getElementById('nav-research').classList.add('active');
    } else {
      selectedVerdict = 'ALL';
      syncVerdictButtons();
      document.getElementById('view-board').classList.add('active');
      document.getElementById('nav-board').classList.add('active');
      renderBoardTable();
    }
    window.scrollTo(0, 0);
  }

  function syncVerdictButtons() {
    document.querySelectorAll('.v-btn').forEach(btn => {
      if (btn.getAttribute('data-verdict') === selectedVerdict) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }

  function renderBoardTable() {
    const tbody = document.getElementById('board-tbody');
    tbody.innerHTML = '';

    let filtered = boardDataRows.filter(r => {
      if (searchTerm) {
        const matchName = r.name.toLowerCase().includes(searchTerm);
        const matchSlug = r.slug.toLowerCase().includes(searchTerm);
        if (!matchName && !matchSlug) return false;
      }
      if (selectedCategory && r.category !== selectedCategory) {
        return false;
      }
      if (selectedVerdict !== 'ALL' && r.verdict !== selectedVerdict) {
        return false;
      }
      if (watchlistOnly && r.rank > 40) {
        return false;
      }
      if (farmableOnly && !r.farmable) {
        return false;
      }
      return true;
    });

    filtered.sort((a, b) => {
      let va = a[currentSortCol];
      let vb = b[currentSortCol];
      if (va === null || va === undefined) va = '';
      if (vb === null || vb === undefined) vb = '';
      if (typeof va === 'string') {
        return currentSortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      }
      return currentSortAsc ? va - vb : vb - va;
    });

    document.getElementById('row-count').textContent = `Showing ${filtered.length} of ${boardDataRows.length} pre-token protocols`;

    if (filtered.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="8" style="text-align: center; color: var(--text-muted); padding: 24px;">No protocols match the current filters.</td>`;
      tbody.appendChild(tr);
      return;
    }

    filtered.forEach(r => {
      const tr = document.createElement('tr');
      tr.addEventListener('click', () => {
        window.location.hash = `#/p/${r.slug}`;
      });

      const verdictClass = r.verdict ? r.verdict.toLowerCase() : 'skip';
      const farmBadge = r.farmable ? '' : ` <span class="badge not-farmable">NOT FARMABLE</span>`;
      const evStr = r.farmable && r.ev_usd !== null ? formatUSD(r.ev_usd) : 'n/a';

      tr.innerHTML = `
        <td class="num">${r.rank}</td>
        <td class="proto-cell">
          <span class="proto-name">${escapeHTML(r.name)}${farmBadge}</span>
          <span class="proto-cat">${escapeHTML(r.category || 'Unknown')}</span>
        </td>
        <td class="num">${formatUSD(r.tvl_usd)}</td>
        <td class="num">${formatPct(r.change_7d)}</td>
        <td class="num">${formatNum(r.token_odds, 3)}</td>
        <td class="num">${formatUSD(r.implied_value_usd)}</td>
        <td class="num">${evStr}</td>
        <td><span class="verdict-badge ${verdictClass}">${r.verdict}</span></td>
      `;
      tbody.appendChild(tr);
    });
  }

  function renderAnchors() {
    const tbody = document.getElementById('anchors-tbody');
    if (!tbody || !radar.live) return;
    tbody.innerHTML = '';

    radar.live.forEach(l => {
      const tr = document.createElement('tr');
      const tvl = l.tvl_usd || 0;
      const mcap = l.mcap_usd || 0;
      const ratio = tvl > 0 ? (mcap / tvl).toFixed(2) : 'N/A';
      const chainsStr = l.chains ? l.chains.slice(0, 3).join(', ') + (l.chains.length > 3 ? '...' : '') : '';

      tr.innerHTML = `
        <td><strong>${escapeHTML(l.name)}</strong></td>
        <td>${escapeHTML(l.category || '')}</td>
        <td style="color: var(--text-muted); font-size: 0.8rem;">${escapeHTML(chainsStr)}</td>
        <td class="num">${formatUSD(tvl)}</td>
        <td class="num">${formatUSD(mcap)}</td>
        <td class="num">${ratio}×</td>
        <td class="num">${formatPct(l.change_7d)}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  function renderDetail(slug) {
    const container = document.getElementById('detail-content');
    const r = boardDataRows.find(item => item.slug === slug);
    const boardRow = boardJsonMap.get(slug);

    if (!r) {
      container.innerHTML = `<div class="panel"><h2>Protocol not found</h2><p>Could not find protocol with slug: <code>${escapeHTML(slug)}</code></p></div>`;
      return;
    }

    const chainsStr = r.chains ? r.chains.join(', ') : 'N/A';
    const verdictClass = r.verdict ? r.verdict.toLowerCase() : 'skip';
    const farmBadge = r.farmable ? `<span class="badge" style="background: rgba(61,220,132,0.1); color: var(--verdict-farm); border-color: rgba(61,220,132,0.3);">FARMABLE PROTOCOL</span>` : `<span class="badge not-farmable" style="font-size: 0.85rem; padding: 4px 10px;">NOT FARMABLE — CEX / BRIDGE</span>`;
    
    let steps = r.farm_steps || (boardRow && boardRow.farm_steps);
    let stepsHTML = '';
    if (steps && steps.length > 0) {
      stepsHTML = `<ol class="steps-list">` + steps.map(s => `<li>${escapeHTML(s)}</li>`).join('') + `</ol>`;
    } else {
      stepsHTML = `<p style="color: var(--text-muted); font-style: italic;">Standard execution guidelines apply across ${escapeHTML(chainsStr)}.</p>`;
    }

    const evDisplay = r.farmable && r.ev_usd !== null ? formatUSD(r.ev_usd) + ' per $1,000 farmed' : 'n/a — no farm path';
    const breakEvenDisplay = r.farmable && r.break_even_days !== null ? r.break_even_days + ' days' : 'n/a';

    container.innerHTML = `
      <div class="panel">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 16px; margin-bottom: 16px;">
          <div>
            <h2 style="font-size: 1.5rem; margin-bottom: 4px;">${escapeHTML(r.name)} ${farmBadge}</h2>
            <p style="color: var(--text-muted);">Category: <strong>${escapeHTML(r.category || 'N/A')}</strong> • Rank #${r.rank} • Chains: ${escapeHTML(chainsStr)}</p>
          </div>
          <div>
            <span class="verdict-badge ${verdictClass}" style="font-size: 0.9rem; padding: 5px 14px;">VERDICT: ${r.verdict}</span>
          </div>
        </div>

        <div class="detail-grid">
          <div class="panel" style="margin-bottom: 0;">
            <h3>Key Valuation & Farm Metrics</h3>
            <div class="meta-row"><span class="label">Total Value Locked (TVL)</span><span class="val">${formatUSD(r.tvl_usd)}</span></div>
            <div class="meta-row"><span class="label">7d TVL Change</span><span class="val">${formatPct(r.change_7d)}</span></div>
            <div class="meta-row"><span class="label">Implied Market Cap</span><span class="val" style="color: var(--accent-cyan); font-weight: 700;">${formatUSD(r.implied_value_usd)}</span></div>
            <div class="meta-row"><span class="label">Blended Token Odds</span><span class="val">${formatNum(r.token_odds, 3)}</span></div>
            <div class="meta-row"><span class="label">Expected Value (EV)</span><span class="val" style="font-weight: 700;">${evDisplay}</span></div>
            <div class="meta-row"><span class="label">Break-Even Horizon</span><span class="val">${breakEvenDisplay}</span></div>
            <div class="meta-row"><span class="label">Protocol Age</span><span class="val">${r.age_days !== null ? r.age_days + ' days' : 'N/A'}</span></div>
          </div>

          <div class="panel" style="margin-bottom: 0;">
            <h3>v2 Valuation Breakdown & Formula</h3>
            <p style="font-size: 0.85rem; color: var(--text-main); margin-bottom: 10px;">
              The implied value of <strong>${formatUSD(r.implied_value_usd)}</strong> is computed via the v2 quadratic OLS model:
            </p>
            <p style="font-family: var(--font-mono); font-size: 0.75rem; color: var(--accent-cyan); background: var(--bg-main); padding: 8px; border-radius: 4px; margin-bottom: 10px;">
              log10(mcap) = 4.1644 + 0.3278·log(TVL) + 0.0121·log(TVL)² - 0.0162·growth - 0.1768·log(age+1) + cat_adj
            </p>
            <p style="font-size: 0.80rem; color: var(--text-muted); line-height: 1.45;">
              Multiplied by blended odds (0.5 logistic + 0.5 peer record = ${formatNum(r.token_odds, 3)}). Non-farmable protocols (CEX/bridges) display n/a EV and direct users away from non-existent farm paths.
            </p>
          </div>
        </div>

        <div class="panel" style="margin-bottom: 0;">
          <h3>Farm Plan Steps & Capital Allocation</h3>
          <p class="section-desc">Tactical action steps with estimated capital tier, gas overhead, and time horizon.</p>
          ${stepsHTML}
        </div>
      </div>
    `;
  }

  function updateSandbox() {
    const tvlM = parseFloat(document.getElementById('sb-tvl').value) || 100;
    const tvlUSD = tvlM * 1e6;
    const change7d = parseFloat(document.getElementById('sb-change').value) || 0;
    const ageDays = parseFloat(document.getElementById('sb-age').value) || 365;
    const odds = parseFloat(document.getElementById('sb-odds').value) || 0.6;

    document.getElementById('sb-odds-val').textContent = odds.toFixed(2);

    const logTVL = Math.log10(tvlUSD);
    const intercept = 4.1644;
    const b1 = 0.3278;
    const b2 = 0.0121;
    const b3 = -0.0162;
    const b4 = -0.1768;

    const logMcap = intercept + (b1 * logTVL) + (b2 * logTVL * logTVL) + (b3 * (change7d / 100)) + (b4 * Math.log10(ageDays + 1));
    const baseValuation = Math.pow(10, logMcap);
    const finalImplied = baseValuation * odds;

    const stepsContainer = document.getElementById('sandbox-steps');
    stepsContainer.innerHTML = `
      <div class="calc-row"><span>TVL Input:</span><span>${formatUSD(tvlUSD)} ($${tvlM}M)</span></div>
      <div class="calc-row"><span>log10(TVL):</span><span>${logTVL.toFixed(4)}</span></div>
      <div class="calc-row"><span>Quadratic Fitted log10(mcap):</span><span>${logMcap.toFixed(4)}</span></div>
      <div class="calc-row"><span>Base Fitted Valuation ($10^x):</span><span>${formatUSD(baseValuation)}</span></div>
      <div class="calc-row"><span>Blended Token Odds:</span><span>× ${odds.toFixed(2)}</span></div>
      <div class="calc-row highlight"><span>Final Computed Implied Value:</span><span>${formatUSD(finalImplied)}</span></div>
    `;
  }

  function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/[&<>'"]/g, 
      tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
    );
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
