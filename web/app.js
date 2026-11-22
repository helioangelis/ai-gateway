'use strict';

(() => {
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

  const LS = 'agw_token';
  let token = localStorage.getItem(LS) || '';
  let status = null;
  let settings = null;
  let tab = 'overview';
  let timer = null;

  // ------------------------------------------------------------------ util
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const fmt = (n) => new Intl.NumberFormat('pt-BR').format(Number(n) || 0);

  function dur(sec) {
    if (sec == null) return '';
    if (sec < 60) return sec + 's';
    if (sec < 3600) return Math.ceil(sec / 60) + ' min';
    return Math.ceil(sec / 3600) + ' h';
  }

  function ago(ts) {
    if (!ts) return '—';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return 'agora';
    if (s < 3600) return Math.floor(s / 60) + ' min';
    if (s < 86400) return Math.floor(s / 3600) + ' h';
    return Math.floor(s / 86400) + ' d';
  }

  function toast(msg, kind = '') {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast ' + kind;
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), 3200);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(opts.headers || {}) },
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) throw new Error((data.error && data.error.message) || 'HTTP ' + res.status);
    return data;
  }

  // ----------------------------------------------------------------- login
  function showLogin() {
    $('#login').classList.remove('hidden');
    $('#app').classList.add('hidden');
    $('#loginToken').focus();
  }

  async function showApp() {
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    updatePill();
    await render();
    if (timer) clearInterval(timer);
    timer = setInterval(async () => {
      try {
        status = await api('/api/status');
        updatePill();
        if (tab === 'overview') renderOverview();
      } catch { /* silencioso */ }
    }, 15000);
  }

  function updatePill() {
    if (!status) return;
    const total = status.providers.length;
    const on = status.providers.filter((p) => p.configured && p.enabled !== false).length;
    const models = status.providers.reduce((n, p) => n + (p.configured && p.enabled !== false ? p.models.length : 0), 0);
    $('#pill').textContent = `${on}/${total} IAs · ${models} modelos`;
  }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = $('#loginToken').value.trim();
    if (!value) return;
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: value }),
      });
      if (!res.ok) throw new Error('Token inválido.');
      token = value;
      localStorage.setItem(LS, token);
      status = await api('/api/status');
      $('#loginError').textContent = '';
      showApp();
    } catch (err) {
      $('#loginError').textContent = err.message;
    }
  });

  $('#btnLogout').addEventListener('click', () => {
    localStorage.removeItem(LS);
    token = '';
    status = null;
    if (timer) clearInterval(timer);
    showLogin();
  });

  $('#btnTheme').addEventListener('click', () => {
    const light = document.documentElement.classList.toggle('light');
    localStorage.setItem('agw_theme', light ? 'light' : 'dark');
  });

  if (localStorage.getItem('agw_theme') === 'light') document.documentElement.classList.add('light');

  // ------------------------------------------------------------------ tabs
  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    tab = btn.dataset.tab;
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    $$('.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + tab));
    render();
  });

  async function render() {
    try {
      if (tab !== 'settings' && tab !== 'chain' && tab !== 'models') status = await api('/api/status');
      if (tab === 'overview') renderOverview();
      else if (tab === 'keys') await renderKeys();
      else if (tab === 'chain') await renderChain();
      else if (tab === 'models') await renderModels();
      else if (tab === 'usage') await renderUsage();
      else if (tab === 'play') await renderPlay();
      else if (tab === 'settings') await renderSettings();
      updatePill();
    } catch (e) {
      if (/401/.test(e.message)) showLogin();
      else toast(e.message, 'bad');
    }
  }

  // -------------------------------------------------------------- visão geral
  function renderOverview() {
    const el = $('#tab-overview');
    if (!status) return;
    const on = status.providers.filter((p) => p.configured && p.enabled !== false);

    el.innerHTML = `
      <div class="cards">
        <div class="card"><div class="label">IAs conectadas</div><div class="value">${on.length}<span class="muted" style="font-size:15px">/${status.providers.length}</span></div><div class="sub">${on.reduce((n, p) => n + p.models.length, 0)} modelos disponíveis</div></div>
        <div class="card"><div class="label">Requisições hoje</div><div class="value">${fmt(status.today.requests)}</div><div class="sub">${Object.keys(status.today.byProvider || {}).length} provedores usados</div></div>
        <div class="card"><div class="label">Tokens hoje</div><div class="value">${fmt(status.today.tokens)}</div><div class="sub">contagem informada pelos provedores</div></div>
      </div>

      <div class="panel">
        <div class="row between">
          <h3>Provedores</h3>
          <div class="row">
            <button id="btnCheck" class="tiny">Testar todas</button>
            <button id="btnReset" class="tiny">Liberar esperas</button>
          </div>
        </div>
        <div id="provList"></div>
      </div>

      <div class="panel">
        <h3>Últimas requisições</h3>
        <div id="recent"></div>
      </div>`;

    $('#provList').innerHTML = status.providers
      .map((p) => {
        const st = p.stats || {};
        const cd = p.cooldown;
        const badges = [
          p.enabled === false ? '<span class="badge off">desativado</span>' : '',
          p.configured ? '<span class="badge ok">conectado</span>' : '<span class="badge off">sem chave</span>',
          cd ? `<span class="badge warn">em espera · ${dur(cd.seconds)}</span>` : '',
          p.keys.some((k) => k.source === 'app') ? '<span class="badge">painel</span>' : '',
          p.keys.some((k) => k.source === 'env') ? '<span class="badge">.env</span>' : '',
        ].join('');
        const err = st.lastError ? `<div class="small muted">último erro: ${esc(st.lastError.reason)} — ${esc(st.lastError.detail || '')}</div>` : '';
        return `<div class="prov">
          <div class="prov-head">
            <span class="prov-name">${esc(p.name)}</span>
            ${badges}
            <span class="grow"></span>
            <span class="small muted">${p.models.length} modelo(s)${st.latency ? ' · ' + st.latency + ' ms' : ''}</span>
          </div>
          ${err}
        </div>`;
      })
      .join('');

    const recent = status.recent || [];
    $('#recent').innerHTML = recent.length
      ? `<table><thead><tr><th>Quando</th><th>Provedor</th><th>Modelo</th><th class="num">Tokens</th><th class="num">ms</th><th>Status</th></tr></thead><tbody>
          ${recent
            .slice(0, 12)
            .map(
              (r) => `<tr>
                <td class="muted">${ago(r.at)}</td>
                <td>${esc(r.provider)}</td>
                <td class="mono truncate" style="max-width:240px">${esc(r.model)}</td>
                <td class="num">${fmt(r.tokens)}</td>
                <td class="num">${r.ms || '—'}</td>
                <td>${r.ok ? '<span class="badge ok">ok</span>' : `<span class="badge bad">${esc(r.reason || 'falha')}</span>`}</td>
              </tr>`
            )
            .join('')}
        </tbody></table>`
      : '<p class="muted small">Nada ainda. Use o Playground ou aponte seu app para <code>/v1</code>.</p>';

    $('#btnCheck').onclick = async () => {
      const btn = $('#btnCheck');
      btn.disabled = true;
      btn.textContent = 'Testando...';
      try {
        const { results } = await api('/api/check', { method: 'POST' });
        showModal(
          'Teste dos provedores',
          results.map((r) => `<div class="list-item"><span class="${r.ok ? 'badge ok' : 'badge bad'}">${r.ok ? 'ok' : 'falha'}</span><span class="small mono">${esc(r.line)}</span></div>`).join('')
        );
        status = await api('/api/status');
        renderOverview();
      } catch (e) {
        toast(e.message, 'bad');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Testar todas';
      }
    };

    $('#btnReset').onclick = async () => {
      try {
        await api('/api/reset', { method: 'POST' });
        status = await api('/api/status');
        renderOverview();
        toast('Esperas liberadas.', 'ok');
      } catch (e) {
        toast(e.message, 'bad');
      }
    };
  }

  // ------------------------------------------------------------------ chaves
  async function renderKeys() {
    const el = $('#tab-keys');
    const { keys } = await api('/api/keys');
    if (!status) status = await api('/api/status');

    el.innerHTML = status.providers
      .map((p) => {
        const saved = keys.filter((k) => k.provider === p.id);
        const fields = (p.fields || [])
          .map(
            (f) => `<label class="field">${esc(f.label)}
              <input type="${f.secret ? 'password' : 'text'}" data-provider="${esc(p.id)}" data-field="${esc(f.name)}" placeholder="${esc(f.label)}" autocomplete="off" spellcheck="false">
            </label>`
          )
          .join('');

        const list = saved.length
          ? saved
              .map(
                (k) => `<div class="list-item">
                  <span class="badge ${k.disabled ? 'bad' : 'ok'}">${k.disabled ? 'desativada' : 'ativa'}</span>
                  <span class="small grow truncate">${esc(k.label)} <span class="mono muted">${esc(Object.values(k.masked).join(' · '))}</span></span>
                  <button class="tiny" data-act="test" data-id="${k.id}">Testar</button>
                  <button class="tiny" data-act="toggle" data-id="${k.id}" data-disabled="${k.disabled ? '1' : '0'}">${k.disabled ? 'Ativar' : 'Desativar'}</button>
                  <button class="tiny danger" data-act="del" data-id="${k.id}">Remover</button>
                </div>`
              )
              .join('')
          : `<p class="small muted">Nenhuma chave salva${p.configured ? ' (usando variável de ambiente)' : ''}.</p>`;

        return `<div class="panel">
          <div class="row between">
            <div class="row"><h3>${esc(p.name)}</h3>
              ${p.enabled === false ? '<span class="badge off">desativado</span>' : ''}
              ${p.configured ? '<span class="badge ok">conectado</span>' : '<span class="badge off">sem chave</span>'}
            </div>
            ${p.keyUrl ? `<a class="small" href="${esc(p.keyUrl)}" target="_blank" rel="noopener">onde pegar a chave ↗</a>` : ''}
          </div>
          ${p.hint ? `<p class="small muted">${esc(p.hint)}</p>` : ''}
          <div class="grid2" style="margin:10px 0">
            ${fields}
            <label class="field">Apelido (opcional)<input type="text" data-label="${esc(p.id)}" placeholder="ex.: conta principal"></label>
          </div>
          <button class="primary tiny" data-save="${esc(p.id)}">Salvar chave</button>
          <div class="list" style="margin-top:12px">${list}</div>
        </div>`;
      })
      .join('');

    $$('[data-save]', el).forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.dataset.save;
        const values = {};
        $$(`input[data-provider="${id}"]`, el).forEach((i) => (values[i.dataset.field] = i.value.trim()));
        const label = $(`input[data-label="${id}"]`, el).value.trim();
        btn.disabled = true;
        try {
          await api('/api/keys', { method: 'POST', body: JSON.stringify({ provider: id, label, values }) });
          toast('Chave salva.', 'ok');
          status = await api('/api/status');
          await renderKeys();
        } catch (e) {
          toast(e.message, 'bad');
        } finally {
          btn.disabled = false;
        }
      };
    });

    $$('[data-act]', el).forEach((btn) => {
      btn.onclick = async () => {
        const { act, id } = btn.dataset;
        try {
          if (act === 'del') {
            if (!confirm('Remover esta chave?')) return;
            await api('/api/keys/' + id, { method: 'DELETE' });
          } else if (act === 'toggle') {
            await api('/api/keys/' + id + '/toggle', { method: 'POST', body: JSON.stringify({ disabled: btn.dataset.disabled !== '1' }) });
          } else if (act === 'test') {
            btn.disabled = true;
            btn.textContent = '...';
            const r = await api('/api/keys/' + id + '/test', { method: 'POST' });
            toast(`Chave válida — ${r.models} modelos encontrados.`, 'ok');
          }
          status = await api('/api/status');
          await renderKeys();
        } catch (e) {
          toast(e.message, 'bad');
        } finally {
          btn.disabled = false;
        }
      };
    });
  }

  // ------------------------------------------------------------------ cadeia
  async function renderChain() {
    const el = $('#tab-chain');
    settings = await api('/api/settings');
    if (!status) status = await api('/api/status');

    const order = [...(settings.order || [])];
    for (const p of status.providers) if (!order.includes(p.id)) order.push(p.id);
    const disabled = new Set(settings.disabled || []);

    el.innerHTML = `
      <div class="panel">
        <div class="row between">
          <h3>Ordem e estratégia</h3>
          <label class="field" style="width:200px">Estratégia
            <select id="strategy">
              ${[
                ['priority', 'Prioridade (ordem)'],
                ['balanced', 'Equilibrada'],
                ['fastest', 'Mais rápida'],
                ['reliable', 'Mais confiável'],
              ]
                .map(([v, l]) => `<option value="${v}" ${settings.strategy === v ? 'selected' : ''}>${l}</option>`)
                .join('')}
            </select>
          </label>
        </div>
        <p class="small muted">A ordem vale para <code>auto</code>. <code>auto-code</code> coloca os modelos de código primeiro.</p>
        <div id="chainList" class="list" style="margin-top:10px"></div>
      </div>`;

    const draw = () => {
      $('#chainList').innerHTML = order
        .map((id, i) => {
          const p = status.providers.find((x) => x.id === id) || { name: id, configured: false };
          return `<div class="list-item">
            <span class="mono muted" style="width:22px">${i + 1}</span>
            <span class="grow">${esc(p.name)} ${p.configured ? '' : '<span class="badge off">sem chave</span>'}</span>
            <button class="tiny" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="tiny" data-down="${i}" ${i === order.length - 1 ? 'disabled' : ''}>↓</button>
            <label class="small"><input type="checkbox" data-on="${id}" ${disabled.has(id) ? '' : 'checked'} style="width:auto"> ativo</label>
          </div>`;
        })
        .join('');

      $$('[data-up]', $('#chainList')).forEach((b) => (b.onclick = () => move(+b.dataset.up, -1)));
      $$('[data-down]', $('#chainList')).forEach((b) => (b.onclick = () => move(+b.dataset.down, 1)));
      $$('[data-on]', $('#chainList')).forEach(
        (c) =>
          (c.onchange = async () => {
            if (c.checked) disabled.delete(c.dataset.on);
            else disabled.add(c.dataset.on);
            await save();
          })
      );
    };

    const save = async () => {
      try {
        settings = (await api('/api/settings', { method: 'PUT', body: JSON.stringify({ order, disabled: [...disabled], strategy: $('#strategy').value }) })).settings;
        status = await api('/api/status');
        toast('Cadeia atualizada.', 'ok');
      } catch (e) {
        toast(e.message, 'bad');
      }
    };

    const move = async (i, d) => {
      const j = i + d;
      if (j < 0 || j >= order.length) return;
      [order[i], order[j]] = [order[j], order[i]];
      draw();
      await save();
    };

    $('#strategy').onchange = save;
    draw();
  }

  // ----------------------------------------------------------------- modelos
  async function renderModels() {
    const el = $('#tab-models');
    settings = await api('/api/settings');
    if (!status) status = await api('/api/status');

    const overrides = settings.models || {};

    el.innerHTML = status.providers
      .map((p) => {
        const models = p.models
          .map(
            (m) => `<label class="list-item">
              <input type="checkbox" data-model="${esc(p.id)}" data-id="${esc(m.id)}" ${m.enabled ? 'checked' : ''} style="width:auto">
              <span class="grow mono truncate">${esc(m.id)}</span>
              ${m.code ? '<span class="badge">código</span>' : ''}
              ${m.tools ? '<span class="badge">tools</span>' : ''}
              ${m.vision ? '<span class="badge">visão</span>' : ''}
              ${m.cooldown ? `<span class="badge warn">espera ${dur(m.cooldown.seconds)}</span>` : ''}
            </label>`
          )
          .join('');

        return `<div class="panel">
          <div class="row between">
            <div class="row"><h3>${esc(p.name)}</h3>${p.configured ? '<span class="badge ok">conectado</span>' : '<span class="badge off">sem chave</span>'}</div>
            <button class="tiny" data-discover="${esc(p.id)}">Descobrir modelos</button>
          </div>
          <div class="list" style="margin-top:10px">${models || '<p class="small muted">Nenhum modelo.</p>'}</div>
        </div>`;
      })
      .join('') +
      `<div class="panel">
        <h3>Provedor custom (OpenAI-compatível)</h3>
        <p class="small muted">Ollama, LM Studio, vLLM, llama.cpp ou qualquer gateway. Use a URL com <code>/v1</code>.</p>
        <div class="grid2" style="margin:10px 0">
          <label class="field">ID (sem espaços)<input id="cpId" placeholder="ollama"></label>
          <label class="field">Nome<input id="cpName" placeholder="Ollama local"></label>
          <label class="field">Base URL<input id="cpUrl" placeholder="http://127.0.0.1:11434/v1"></label>
          <label class="field">Modelos (separados por vírgula)<input id="cpModels" placeholder="qwen3:8b, llama3.2"></label>
        </div>
        <button class="primary tiny" id="cpAdd">Adicionar provedor</button>
        <div class="list" style="margin-top:12px">${(settings.custom || [])
          .map(
            (c) => `<div class="list-item"><span class="grow">${esc(c.name || c.id)} <span class="mono muted">${esc(c.baseUrl)}</span></span>
              <button class="tiny danger" data-delcustom="${esc(c.id)}">Remover</button></div>`
          )
          .join('')}</div>
      </div>`;

    $$('[data-model]', el).forEach(
      (c) =>
        (c.onchange = async () => {
          const pid = c.dataset.model;
          const list = status.providers
            .find((x) => x.id === pid)
            .models.map((m) => ({
              id: m.id,
              ...(m.code ? { code: true } : {}),
              ...(m.tools ? { tools: true } : {}),
              ...(m.vision ? { vision: true } : {}),
              enabled: m.id === c.dataset.id ? c.checked : m.enabled !== false,
            }));
          overrides[pid] = list;
          try {
            settings = (await api('/api/settings', { method: 'PUT', body: JSON.stringify({ models: overrides }) })).settings;
            status = await api('/api/status');
            toast('Modelos atualizados.', 'ok');
          } catch (e) {
            toast(e.message, 'bad');
          }
        })
    );

    $$('[data-discover]', el).forEach(
      (b) =>
        (b.onclick = async () => {
          b.disabled = true;
          b.textContent = 'Buscando...';
          try {
            const { models } = await api('/api/discover', { method: 'POST', body: JSON.stringify({ provider: b.dataset.discover }) });
            const current = new Set(status.providers.find((p) => p.id === b.dataset.discover).models.map((m) => m.id));
            const fresh = models.filter((m) => !current.has(m));
            showModal(
              `Modelos de ${b.dataset.discover} (${models.length})`,
              fresh.length
                ? `<p class="small muted">${fresh.length} novo(s). Marque e adicione.</p>
                   <div class="list">${fresh
                     .map((m) => `<label class="list-item"><input type="checkbox" value="${esc(m)}" style="width:auto" checked><span class="mono small grow truncate">${esc(m)}</span></label>`)
                     .join('')}</div>
                   <button class="primary" id="modalAdd" style="margin-top:12px">Adicionar selecionados</button>`
                : '<p class="small muted">Todos os modelos retornados já estão na lista.</p>'
            );
            const add = $('#modalAdd');
            if (add)
              add.onclick = async () => {
                const picked = $$('#modalBody input:checked').map((i) => i.value);
                const pid = b.dataset.discover;
                const p = status.providers.find((x) => x.id === pid);
                overrides[pid] = [
                  ...p.models.map((m) => ({ id: m.id, ...(m.code ? { code: true } : {}), enabled: m.enabled !== false })),
                  ...picked.map((id) => ({ id, enabled: true })),
                ];
                settings = (await api('/api/settings', { method: 'PUT', body: JSON.stringify({ models: overrides }) })).settings;
                status = await api('/api/status');
                closeModal();
                await renderModels();
                toast(`${picked.length} modelo(s) adicionado(s).`, 'ok');
              };
          } catch (e) {
            toast(e.message, 'bad');
          } finally {
            b.disabled = false;
            b.textContent = 'Descobrir modelos';
          }
        })
    );

    $('#cpAdd').onclick = async () => {
      const id = $('#cpId').value.trim().replace(/[^\w-]/g, '');
      const name = $('#cpName').value.trim() || id;
      const baseUrl = $('#cpUrl').value.trim().replace(/\/+$/, '');
      const models = $('#cpModels')
        .value.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => ({ id: s }));
      if (!id || !baseUrl || !models.length) return toast('Preencha ID, URL e ao menos um modelo.', 'bad');
      const custom = [...(settings.custom || []).filter((c) => c.id !== id), { id, name, baseUrl, models }];
      try {
        settings = (await api('/api/settings', { method: 'PUT', body: JSON.stringify({ custom }) })).settings;
        status = await api('/api/status');
        await renderModels();
        toast('Provedor adicionado.', 'ok');
      } catch (e) {
        toast(e.message, 'bad');
      }
    };

    $$('[data-delcustom]', el).forEach(
      (b) =>
        (b.onclick = async () => {
          if (!confirm('Remover este provedor?')) return;
          const custom = (settings.custom || []).filter((c) => c.id !== b.dataset.delcustom);
          settings = (await api('/api/settings', { method: 'PUT', body: JSON.stringify({ custom }) })).settings;
          status = await api('/api/status');
          await renderModels();
        })
    );
  }

  // -------------------------------------------------------------------- uso
  async function renderUsage() {
    const el = $('#tab-usage');
    const data = await api('/api/usage');

    el.innerHTML = `
      <div class="panel">
        <h3>Últimos 30 dias</h3>
        <table><thead><tr><th>Dia</th><th class="num">Requisições</th><th class="num">Tokens</th><th>Provedores</th></tr></thead><tbody>
          ${(data.daily || [])
            .map(
              (d) => `<tr><td>${esc(d.date)}</td><td class="num">${fmt(d.requests)}</td><td class="num">${fmt(d.tokens)}</td>
                <td class="small muted">${Object.entries(d.byProvider || {}).map(([k, v]) => `${esc(k)} (${v})`).join(', ') || '—'}</td></tr>`
            )
            .join('') || '<tr><td colspan="4" class="muted">Sem uso ainda.</td></tr>'}
        </tbody></table>
      </div>

      <div class="panel">
        <h3>Cotas em memória</h3>
        <p class="small muted">Janela de 1 minuto reinicia com o processo; o total do dia persiste.</p>
        <table><thead><tr><th>Chave (provedor | modelo | chave)</th><th class="num">Req/min</th><th class="num">Req/dia</th><th class="num">Tokens/dia</th></tr></thead><tbody>
          ${Object.entries(data.limits || {})
            .map(([k, v]) => `<tr><td class="mono small truncate" style="max-width:420px">${esc(k)}</td><td class="num">${v.minuteRequests}</td><td class="num">${v.dayRequests}</td><td class="num">${fmt(v.dayTokens)}</td></tr>`)
            .join('') || '<tr><td colspan="4" class="muted">Nenhuma requisição nesta sessão.</td></tr>'}
        </tbody></table>
      </div>

      <div class="panel">
        <h3>Requisições recentes</h3>
        <table><thead><tr><th>Quando</th><th>Provedor</th><th>Modelo</th><th class="num">Tokens</th><th>Status</th></tr></thead><tbody>
          ${(data.recent || [])
            .map(
              (r) => `<tr><td class="muted">${ago(r.at)}</td><td>${esc(r.provider)}</td><td class="mono small truncate" style="max-width:240px">${esc(r.model)}</td>
                <td class="num">${fmt(r.tokens)}</td><td>${r.ok ? '<span class="badge ok">ok</span>' : `<span class="badge bad">${esc(r.reason || 'falha')}</span>`}</td></tr>`
            )
            .join('') || '<tr><td colspan="5" class="muted">Nada ainda.</td></tr>'}
        </tbody></table>
      </div>`;
  }

  // ------------------------------------------------------------- playground
  async function renderPlay() {
    const el = $('#tab-play');
    const { data } = await api('/v1/models');

    el.innerHTML = `
      <div class="panel">
        <div class="grid2">
          <label class="field">Modelo
            <select id="pgModel">${data.map((m) => `<option value="${esc(m.id)}">${esc(m.id)}</option>`).join('')}</select>
          </label>
          <label class="field">System (opcional)<input id="pgSystem" placeholder="Você é um assistente direto."></label>
        </div>
        <label class="field" style="margin-top:12px">Mensagem
          <textarea id="pgPrompt" placeholder="Escreva algo...">Diga em uma frase o que você é.</textarea>
        </label>
        <div class="row" style="margin-top:10px">
          <button class="primary" id="pgSend">Enviar</button>
          <span id="pgMeta" class="small muted"></span>
        </div>
        <pre id="pgOut" class="answer hidden"></pre>
      </div>`;

    $('#pgSend').onclick = async () => {
      const btn = $('#pgSend');
      const out = $('#pgOut');
      const meta = $('#pgMeta');
      const messages = [];
      const sys = $('#pgSystem').value.trim();
      if (sys) messages.push({ role: 'system', content: sys });
      messages.push({ role: 'user', content: $('#pgPrompt').value });

      btn.disabled = true;
      btn.textContent = 'Enviando...';
      meta.textContent = '';
      out.classList.add('hidden');
      const t0 = performance.now();
      try {
        const res = await fetch('/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ model: $('#pgModel').value, messages, max_tokens: 1024 }),
        });
        const text = await res.text();
        const data = JSON.parse(text);
        if (!res.ok) throw new Error((data.error && data.error.message) || 'HTTP ' + res.status);
        const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '(resposta vazia)';
        out.textContent = content;
        out.classList.remove('hidden');
        meta.textContent = `${data.gateway ? data.gateway.provider + '/' + data.gateway.model : 'ok'} · ${Math.round(performance.now() - t0)} ms · ${data.usage ? data.usage.total_tokens : '?'} tokens`;
        status = await api('/api/status');
        updatePill();
      } catch (e) {
        out.textContent = 'Erro: ' + e.message;
        out.classList.remove('hidden');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Enviar';
      }
    };
  }

  // ---------------------------------------------------------------- ajustes
  async function renderSettings() {
    const el = $('#tab-settings');
    settings = await api('/api/settings');

    el.innerHTML = `
      <div class="panel">
        <h3>Roteamento</h3>
        <div class="grid2">
          <label class="field">Tentativas por requisição<input id="setAttempts" type="number" min="1" max="64" value="${settings.maxAttempts}"></label>
          <label class="field">Timeout por provedor (ms)<input id="setTimeout" type="number" min="5000" step="1000" value="${settings.timeoutMs}"></label>
          <label class="field">Histórico máximo (caracteres)<input id="setChars" type="number" min="4000" step="1000" value="${settings.maxContextChars}"></label>
          <label class="field">Desligar ocioso (min, APK)<input id="setOff" type="number" min="0" value="${settings.autoOffMinutes}"></label>
        </div>
        <button class="primary" id="setSave" style="margin-top:12px">Salvar</button>
      </div>

      <div class="panel">
        <h3>Chave do gateway</h3>
        <p class="small muted">É a credencial que o OpenCode (ou qualquer cliente) usa em <code>Authorization: Bearer</code>.</p>
        <div class="list-item" style="margin-top:8px">
          <span class="mono grow">${esc(settings.tokenMasked)}</span>
          <button class="tiny" id="copyUrl">Copiar URL base</button>
        </div>
        <p class="small muted" style="margin-top:8px">A chave completa fica em <code>data/.token</code> e aparece no console ao iniciar.</p>
      </div>

      <div class="panel">
        <h3>Manutenção</h3>
        <div class="row">
          <button id="btnReset2">Liberar todas as esperas</button>
          <button id="btnReload">Recarregar painel</button>
        </div>
      </div>`;

    $('#setSave').onclick = async () => {
      try {
        settings = (
          await api('/api/settings', {
            method: 'PUT',
            body: JSON.stringify({
              maxAttempts: Number($('#setAttempts').value) || 16,
              timeoutMs: Number($('#setTimeout').value) || 60000,
              maxContextChars: Number($('#setChars').value) || 48000,
              autoOffMinutes: Number($('#setOff').value) || 0,
            }),
          })
        ).settings;
        toast('Ajustes salvos.', 'ok');
      } catch (e) {
        toast(e.message, 'bad');
      }
    };

    $('#copyUrl').onclick = async () => {
      await navigator.clipboard.writeText(location.origin + '/v1');
      toast('URL copiada.', 'ok');
    };

    $('#btnReset2').onclick = async () => {
      await api('/api/reset', { method: 'POST' });
      toast('Esperas liberadas.', 'ok');
    };

    $('#btnReload').onclick = () => location.reload();
  }

  // ------------------------------------------------------------------ modal
  function showModal(title, html) {
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = html;
    $('#modal').classList.remove('hidden');
  }
  function closeModal() {
    $('#modal').classList.add('hidden');
  }
  $('#modalClose').onclick = closeModal;
  $('#modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal') closeModal();
  });

  // ------------------------------------------------------------------- boot
  (async () => {
    if (!token) return showLogin();
    try {
      status = await api('/api/status');
      await showApp();
    } catch {
      showLogin();
    }
  })();
})();
