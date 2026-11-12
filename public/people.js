/* Remind Me: people and their brrr keys. */
'use strict';

(() => {
  const { esc, api, avatar, toast, confirmSheet } = RM;
  const $ = (id) => document.getElementById(id);
  let members = [];
  let mirrorEnabled = false; // the server has a mirror gateway (PUSH_MIRROR_URL)
  const editing = new Set(); // people whose key field is open
  const editingMirror = new Set(); // people whose mirror key field is open
  const renaming = new Set(); // people whose name field is open (no window.prompt: iOS wrappers drop it)

  function status(m) {
    if (!m.has_key) return { cls: 'bad', text: 'No key: can’t get reminders' };
    if (m.last_error && (!m.last_ok_at || new Date(m.last_error_at) > new Date(m.last_ok_at))) return { cls: 'bad', text: 'Last send failed' };
    if (m.last_ok_at) return { cls: 'ok', text: `Ready · last delivered ${RM.relativeAgo(m.last_ok_at)}` };
    return { cls: 'warn', text: 'Key saved · not tested yet' };
  }

  // Optional second gateway that gets a copy of every push (for side-by-side testing). brrr is unaffected.
  function mirrorBlock(m) {
    if (!mirrorEnabled) return '';
    const open = editingMirror.has(m.id);
    let state = 'No mirror key';
    let cls = 'warn';
    if (m.has_mirror_key) {
      if (m.mirror_last_error && (!m.mirror_last_ok_at || new Date(m.mirror_last_error_at) > new Date(m.mirror_last_ok_at))) { state = 'Mirror: last copy failed'; cls = 'bad'; }
      else if (m.mirror_last_ok_at) { state = `Mirror: last copy ${RM.relativeAgo(m.mirror_last_ok_at)}`; cls = 'ok'; }
      else state = 'Mirror key saved · not tested yet';
    }
    return `
        <div class="mirror-block">
          <div class="person-status"><span class="status-dot ${cls}"></span>${esc(state)}${m.has_mirror_key ? ` <code>${esc(m.mirror_key_preview)}</code>` : ''}</div>
          ${cls === 'bad' && m.mirror_last_error ? `<p class="person-error">${esc(m.mirror_last_error)}</p>` : ''}
          ${open ? `
            <form class="key-row" data-mirror-form="${m.id}" autocomplete="off">
              <input type="password" name="key" inputmode="text" autocapitalize="off" autocorrect="off" spellcheck="false"
                     autocomplete="off" placeholder="Paste mirror webhook secret" aria-label="mirror key for ${esc(m.name)}">
              <button type="submit" class="btn-solid">Save</button>
            </form>` : ''}
          <div class="person-actions">
            ${m.has_mirror_key ? `<button type="button" class="btn-ghost btn-sm" data-do="mirror-test" data-id="${m.id}">Test mirror</button>` : ''}
            ${open ? `<button type="button" class="btn-ghost btn-sm" data-do="mirror-cancel" data-id="${m.id}">Cancel</button>`
                   : `<button type="button" class="btn-ghost btn-sm" data-do="mirror-change" data-id="${m.id}">${m.has_mirror_key ? 'Change mirror key' : 'Add mirror key'}</button>`}
            ${m.has_mirror_key ? `<button type="button" class="btn-ghost btn-sm" data-do="mirror-clear" data-id="${m.id}">Remove mirror key</button>` : ''}
          </div>
        </div>`;
  }

  function card(m) {
    const s = status(m);
    const open = editing.has(m.id) || !m.has_key;
    const failed = s.cls === 'bad' && m.has_key;
    return `
      <article class="person-card" data-id="${m.id}">
        <div class="person-head">
          ${avatar(m)}
          <div class="person-title">
            <h3>${esc(m.name)}</h3>
            <div class="person-status"><span class="status-dot ${s.cls}"></span>${esc(s.text)}${m.has_key ? ` <code>${esc(m.key_preview)}</code>` : ''}</div>
          </div>
        </div>
        ${renaming.has(m.id) ? `
          <form class="inline-form" data-rename-form="${m.id}" autocomplete="off">
            <input type="text" name="name" maxlength="40" value="${esc(m.name)}" autocapitalize="words" enterkeyhint="done" aria-label="New name">
            <button type="submit" class="btn-solid">Save</button>
            <button type="button" class="btn-ghost" data-do="rename-cancel" data-id="${m.id}">Cancel</button>
          </form>` : ''}
        ${failed && m.last_error ? `<p class="person-error">${esc(m.last_error)}</p>` : ''}
        ${open ? `
          <form class="key-row" data-key-form="${m.id}" autocomplete="off">
            <input type="password" name="key" inputmode="text" autocapitalize="off" autocorrect="off" spellcheck="false"
                   autocomplete="off" placeholder="${m.has_key ? 'Paste a new brrr secret or URL' : 'Paste brrr secret or URL'}" aria-label="brrr key for ${esc(m.name)}">
            <button type="submit" class="btn-solid">Save</button>
          </form>` : ''}
        <div id="push-check-${m.id}" role="status" aria-live="polite"></div>
        <div class="person-actions">
          ${m.has_key ? `<button type="button" class="btn-ghost btn-sm" data-do="check" data-id="${m.id}">Verify saved secret (no push)</button>` : ''}
          ${m.has_key ? `<button type="button" class="btn-primary btn-sm" data-do="test" data-id="${m.id}">Send test</button>` : ''}
          ${m.has_key && !editing.has(m.id) ? `<button type="button" class="btn-ghost btn-sm" data-do="change" data-id="${m.id}">Change key</button>` : ''}
          ${m.has_key && editing.has(m.id) ? `<button type="button" class="btn-ghost btn-sm" data-do="cancel" data-id="${m.id}">Cancel</button>` : ''}
          ${m.has_key ? `<button type="button" class="btn-ghost btn-sm" data-do="clear" data-id="${m.id}">Remove key</button>` : ''}
          <button type="button" class="btn-ghost btn-sm" data-do="rename" data-id="${m.id}">Rename</button>
          <button type="button" class="btn-danger btn-sm" data-do="remove" data-id="${m.id}">Remove</button>
        </div>${mirrorBlock(m)}
      </article>`;
  }

  async function load() {
    try {
      const data = await api('api/members');
      members = data.members;
      mirrorEnabled = Boolean(data.mirror_enabled);
      render();
    } catch (err) {
      $('person-list').innerHTML = `<div class="person-card"><p class="person-error">${esc(err.message)}</p></div>`;
    }
  }

  function render() {
    $('person-list').innerHTML = members.length
      ? members.map(card).join('')
      : '<div class="person-card"><p class="muted">Nobody yet. Add the people who should get reminders.</p></div>';
  }

  $('person-list').addEventListener('submit', async (e) => {
    const renameForm = e.target.closest('[data-rename-form]');
    if (renameForm) {
      e.preventDefault();
      const id = Number(renameForm.dataset.renameForm);
      const name = renameForm.querySelector('input').value.trim();
      try {
        if (name) await api(`api/members/${id}`, { method: 'PATCH', body: { name } });
        renaming.delete(id);
        await load();
      } catch (err) { toast(err.message, 'bad'); }
      return;
    }
    const mirrorForm = e.target.closest('[data-mirror-form]');
    if (mirrorForm) {
      e.preventDefault();
      const id = Number(mirrorForm.dataset.mirrorForm);
      const input = mirrorForm.querySelector('input');
      const key = input.value.trim();
      if (!key) { input.focus(); return; }
      try {
        await api(`api/members/${id}/mirror`, { method: 'PUT', body: { key } });
        input.value = '';
        editingMirror.delete(id);
        toast('Mirror key saved. Sending a test…');
        await load();
        await testMirror(id);
      } catch (err) { toast(err.message, 'bad'); }
      return;
    }
    const form = e.target.closest('[data-key-form]');
    if (!form) return;
    e.preventDefault();
    const id = Number(form.dataset.keyForm);
    const input = form.querySelector('input');
    const key = input.value.trim();
    if (!key) { input.focus(); return; }
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      const saved = await api(`api/members/${id}/brrr`, { method: 'PUT', body: { key } });
      input.value = '';
      editing.delete(id);
      await load();
      document.getElementById(`push-check-${id}`).textContent = `Saved. ${saved.verification.message}`;
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      btn.disabled = false;
    }
  });

  async function test(id) {
    const m = members.find((x) => x.id === id);
    try {
      const r = await api(`api/members/${id}/brrr/test`, { method: 'POST', body: { level: 'active' } });
      toast(r.ok ? `Test sent to ${m?.name}. Check their phone.` : `Test failed: ${r.error}`, r.ok ? 'ok' : 'bad');
    } catch (err) {
      toast(err.message, 'bad');
    }
    await load();
  }

  async function testMirror(id) {
    const m = members.find((x) => x.id === id);
    try {
      const r = await api(`api/members/${id}/mirror/test`, { method: 'POST', body: { level: 'active' } });
      toast(r.ok ? `Mirror test sent to ${m?.name}.` : `Mirror test failed: ${r.error}`, r.ok ? 'ok' : 'bad');
    } catch (err) {
      toast(err.message, 'bad');
    }
    await load();
  }

  $('person-list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-do]');
    if (!b) return;
    const id = Number(b.dataset.id);
    const m = members.find((x) => x.id === id);
    if (!m) return;
    try {
      switch (b.dataset.do) {
        case 'check': {
          b.disabled = true;
          const el = document.getElementById(`push-check-${id}`);
          el.textContent = 'Checking saved secret (no notification)…';
          const data = await api(`api/members/${id}/brrr/check`, { method: 'POST', body: {} });
          el.textContent = data.message;
          break;
        }
        case 'test':
          b.disabled = true;
          await test(id);
          break;
        case 'mirror-test':
          b.disabled = true;
          await testMirror(id);
          break;
        case 'mirror-change':
          editingMirror.add(id);
          render();
          document.querySelector(`[data-mirror-form="${id}"] input`)?.focus();
          break;
        case 'mirror-cancel':
          editingMirror.delete(id);
          render();
          break;
        case 'mirror-clear':
          if (!(await confirmSheet({ title: `Remove ${m.name}’s mirror key?`, body: 'Copies to the mirror gateway stop. brrr delivery is unaffected.', confirmLabel: 'Remove', danger: true }))) return;
          await api(`api/members/${id}/mirror`, { method: 'DELETE' });
          toast('Mirror key removed');
          await load();
          break;
        case 'change':
          editing.add(id);
          render();
          document.querySelector(`[data-key-form="${id}"] input`)?.focus();
          break;
        case 'cancel':
          editing.delete(id);
          render();
          break;
        case 'clear': {
          const warn = m.active_reminders ? ` They’re on ${m.active_reminders} scheduled reminder${m.active_reminders === 1 ? '' : 's'}, which will fail to reach them until a new key is added.` : '';
          if (!(await confirmSheet({ title: `Remove ${m.name}’s key?`, body: `They won’t get reminders.${warn}`, confirmLabel: 'Remove key', danger: true }))) return;
          await api(`api/members/${id}/brrr`, { method: 'DELETE' });
          toast('Key removed');
          await load();
          break;
        }
        case 'rename':
          renaming.add(id);
          render();
          document.querySelector(`[data-rename-form="${id}"] input`)?.focus();
          break;
        case 'rename-cancel':
          renaming.delete(id);
          render();
          break;
        case 'remove': {
          const body = m.active_reminders
            ? `They come off ${m.active_reminders} scheduled reminder${m.active_reminders === 1 ? '' : 's'}; any reminder left with nobody to remind is deleted. Their brrr key is erased.`
            : 'Their brrr key is erased.';
          if (!(await confirmSheet({ title: `Remove ${m.name}?`, body, confirmLabel: 'Remove', danger: true }))) return;
          await api(`api/members/${id}?force=1`, { method: 'DELETE' });
          if (RM.getMe() === id) RM.setMe(null);
          toast(`${m.name} removed`);
          await load();
          break;
        }
        default:
      }
    } catch (err) {
      toast(err.message, 'bad');
    } finally { b.disabled = false; }
  });

  $('add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('add-name');
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    try {
      await api('api/members', { method: 'POST', body: { name } });
      input.value = '';
      toast(`${name} added. Paste their brrr key next.`);
      await load();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });

  load();
})();
