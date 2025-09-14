async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  return res.json();
}

function showStatus(msg) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.hidden = !msg;
}

function pills(containerId, arr, label) {
  const c = document.getElementById(containerId);
  c.innerHTML = '';
  if (!arr || !arr.length) return;
  const head = document.createElement('div');
  head.className = 'pill';
  head.textContent = label;
  head.style.borderColor = '#333';
  head.style.color = '#fff';
  c.appendChild(head);
  for (const item of arr) {
    const d = document.createElement('div');
    d.className = 'pill';
    d.textContent = item;
    c.appendChild(d);
  }
}

function renderNotes(notes) {
  const notesSec = document.getElementById('notes');
  pills('notes-top', notes.top, 'Top');
  pills('notes-middle', notes.middle, 'Middle');
  pills('notes-base', notes.base, 'Base');
  notesSec.hidden = false;
}

function renderResults(suggestions) {
  const resSec = document.getElementById('results');
  const cards = document.getElementById('cards');
  cards.innerHTML = '';
  for (const s of suggestions) {
    const div = document.createElement('div');
    div.className = 'card';
    div.innerHTML = `
      <h3>${escapeHtml(s.title || 'Result')}</h3>
      <p>${escapeHtml(s.snippet || '')}</p>
      <div class="meta">
        <a href="${s.url}" target="_blank" rel="noopener noreferrer">Open</a>
        <span>${s.price ? escapeHtml(s.price) : ''}</span>
      </div>
    `;
    cards.appendChild(div);
  }
  resSec.hidden = false;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"]+/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[s]));
}

async function onExtract() {
  const scene = document.getElementById('scene').value.trim();
  if (!scene) return showStatus('Enter a scene description.');
  showStatus('Extracting notes locally...');
  try {
    const { notes } = await postJSON('/api/extract-notes', { scene });
    renderNotes(notes);
    showStatus('Notes extracted. You can now search.');
  } catch (e) {
    showStatus('Error: ' + e.message);
  }
}

async function onFind() {
  const scene = document.getElementById('scene').value.trim();
  if (!scene) return showStatus('Enter a scene description.');
  const extractBtn = document.getElementById('extract');
  const findBtn = document.getElementById('find');
  extractBtn.disabled = true; findBtn.disabled = true;
  try {
    showStatus('Extracting notes locally...');
    const { notes } = await postJSON('/api/extract-notes', { scene });
    renderNotes(notes);
    showStatus('Searching fragrances...');
    try {
      const { suggestions } = await postJSON('/api/search', { notes });
      renderResults(suggestions);
      showStatus('Done.');
    } catch (searchErr) {
      showStatus('Notes extracted. Search error: ' + searchErr.message);
    }
  } catch (e) {
    showStatus('Error during note extraction: ' + e.message);
  } finally {
    extractBtn.disabled = false; findBtn.disabled = false;
  }
}

document.getElementById('extract').addEventListener('click', onExtract);

document.getElementById('find').addEventListener('click', onFind);
