/* Remind Me: the link page (tailnet mode). A parent matches each person here to their household account. */
'use strict';

(() => {
  const { esc, api, avatar } = RM;
  const $ = (id) => document.getElementById(id);

  function setStatus(message, isError = false) {
    const el = $('link-status');
    el.textContent = message;
    el.classList.toggle('person-error', isError);
  }

  // Reloads the list from the server, which is what the pickers show; problem, if given, is shown after it.
  async function load(problem) {
    try {
      render(await api('api/suite/links'));
      if (problem) setStatus(problem, true);
    } catch (err) {
      setStatus(problem || err.message, true);
      // Leave the pickers usable, so the parent can try again.
      document.querySelectorAll('#link-rows select').forEach((select) => { select.disabled = false; });
    }
  }

  function render({ you, directory, members }) {
    const linked = new Map(members.filter((m) => m.suite_member_id).map((m) => [m.suite_member_id, m.id]));
    $('link-rows').innerHTML = members.map((m) => {
      const options = directory
        .filter((person) => !linked.has(person.memberId) || linked.get(person.memberId) === m.id)
        .map((person) => `<option value="${esc(person.memberId)}"${person.memberId === m.suite_member_id ? ' selected' : ''}>${
          esc(`${person.name} (${person.role}${person.memberId === you ? ', you' : ''})`)}</option>`)
        .join('');
      const gone = m.suite_member_id && !directory.some((person) => person.memberId === m.suite_member_id);
      return `
        <article class="person-card">
          <div class="person-head">${avatar(m)}<div class="person-title"><h3>${esc(m.name)}</h3></div></div>
          <select class="link-select" data-id="${m.id}" aria-label="Household account for ${esc(m.name)}">
            <option value="">Not linked</option>${options}
          </select>
          ${gone ? '<p class="person-status">Linked to a household account that no longer has access to Remind Me.</p>' : ''}
        </article>`;
    }).join('');

    const youLinked = linked.has(you);
    $('link-done-card').classList.toggle('hidden', !youLinked && members.length > 0);
    if (!members.length) {
      $('link-done').textContent = 'Set up the household';
      $('link-done').setAttribute('href', 'setup');
      setStatus('Remind Me has nobody in it yet. Set up the household first.');
    } else if (!youLinked) {
      setStatus('Start with yourself: pick which person here you are.');
    } else {
      setStatus('Changes save as you pick them.');
    }
  }

  $('link-rows').addEventListener('change', async (e) => {
    const select = e.target.closest('select[data-id]');
    if (!select) return;
    select.disabled = true;
    try {
      await api(`api/suite/links/${select.dataset.id}`, { method: 'PUT', body: { suite_member_id: select.value || null } });
      await load();
    } catch (err) {
      // Refused or not, the server's list is what the pickers show next, so a refused choice doesn't linger.
      await load(err.message);
    }
  });

  load();
})();
