/* Remind Me: first-run household setup. */
'use strict';

(() => {
  const { api } = RM;
  const $ = (id) => document.getElementById(id);

  function addRow(focus = true) {
    const row = document.createElement('div');
    row.className = 'setup-row';
    row.innerHTML = `
      <input type="text" maxlength="40" placeholder="Name" autocapitalize="words" enterkeyhint="next" aria-label="Name">
      <button type="button" class="icon-btn" aria-label="Remove">&times;</button>`;
    row.querySelector('button').addEventListener('click', () => {
      if ($('setup-list').children.length > 1) row.remove();
    });
    $('setup-list').appendChild(row);
    if (focus) row.querySelector('input').focus();
  }

  $('add-row').addEventListener('click', () => addRow(true));

  $('setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const names = [...$('setup-list').querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean);
    const err = $('setup-error');
    if (!names.length) {
      err.textContent = 'Add at least one name.';
      err.classList.remove('hidden');
      return;
    }
    $('setup-submit').disabled = true;
    try {
      await api('api/bootstrap/household', { method: 'POST', body: { members: names } });
      window.location.href = 'people';
    } catch (ex) {
      if (ex.code === 'household_already_initialized') { window.location.href = './'; return; }
      err.textContent = ex.message;
      err.classList.remove('hidden');
      $('setup-submit').disabled = false;
    }
  });

  addRow(false);
  addRow(false);
})();
