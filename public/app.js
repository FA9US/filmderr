const $ = (selector, root = document) => root.querySelector(selector);
const state = { session: null, movies: [], preferences: null, genres: [], busy: false, deckRequest: 0, remaining: 0, syncedAt: '', view: '', toastTimer: null, toastDecisionId: null, plexPoll: 0, historyTimer: null };
const icons = {
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  filter: '<path d="M4 7h7m4 0h5M4 17h3m4 0h9"/><circle cx="13" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  discover: '<rect x="5" y="3" width="14" height="18" rx="3"/><path d="m9 8 6 4-6 4Z"/>',
  history: '<path d="M3 11a9 9 0 1 1 2.7 7M3 4v7h7M12 7v5l3 2"/>',
  settings: '<path d="m9.5 3-.7 2.1-2 .9-2.1-.5-2 3.4 1.5 1.6v2.9l-1.5 1.6 2 3.4 2.1-.5 2 .9.7 2.2h4.1l.7-2.2 2-.9 2.1.5 2-3.4-1.5-1.6v-2.9l1.5-1.6-2-3.4-2.1.5-2-.9-.7-2.1Z"/><circle cx="11.5" cy="12" r="3"/>',
  play: '<path d="m8 4 13 8-13 8Z"/>',
  skip: '<path d="m5 5 10 7-10 7ZM19 5v14"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  film: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4M7 12h10"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
};

function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined && content !== null) node.textContent = String(content);
  return node;
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  // Only fixed, application-owned SVG paths enter this renderer.
  svg.innerHTML = icons[name] || icons.film;
  return svg;
}
function button(text, className = 'button secondary', handler) {
  const node = el('button', className, text); node.type = 'button';
  if (handler) node.addEventListener('click', handler);
  return node;
}
function field(label, type = 'text', value = '', hint = '') {
  const wrap = el('label', 'field'); const title = el('span', '', label); const input = el('input');
  input.type = type; input.value = value ?? ''; wrap.append(title, input);
  if (hint) wrap.append(el('small', 'field-hint', hint));
  return { wrap, input };
}
function selectField(label, options, value, hint = '') {
  const wrap = el('label', 'field'); wrap.append(el('span', '', label)); const input = el('select');
  options.forEach(([key, name]) => { const o = el('option', '', name); o.value = key; input.append(o); });
  input.value = value ?? ''; wrap.append(input);
  if (hint) wrap.append(el('small', 'field-hint', hint));
  return { wrap, input };
}
function checkbox(label, checked) {
  const wrap = el('label', 'check-field'); const input = el('input'); input.type = 'checkbox'; input.checked = Boolean(checked);
  wrap.append(input, el('span', '', label)); return { wrap, input };
}
function feedback(message = '', kind = '') {
  const node = el('p', `form-feedback ${kind}`, message); node.setAttribute('role', 'status'); node.hidden = !message; return node;
}
function setFeedback(node, message, kind = '') { node.textContent = message; node.className = `form-feedback ${kind}`; node.hidden = !message; }
function formatDate(value) { const d = new Date(value); return Number.isNaN(+d) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
function safeImage(value) { try { const u = new URL(value, location.origin); return ['https:', 'http:'].includes(u.protocol) ? u.href : ''; } catch { return ''; } }

async function api(path, method = 'GET', body) {
  const headers = { Accept: 'application/json' };
  const sendsJson = !['GET', 'HEAD'].includes(method);
  if (sendsJson) headers['Content-Type'] = 'application/json';
  if (state.session?.csrf && method !== 'GET') headers['X-CSRF-Token'] = state.session.csrf;
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 45000);
  try {
    const res = await fetch(path, { method, headers, body: sendsJson ? JSON.stringify(body ?? {}) : undefined, credentials: 'same-origin', signal: abort.signal });
    let data;
    try { data = await res.json(); } catch { throw new Error('The server returned an unexpected response. Please try again.'); }
    if (!res.ok) { const error = new Error(data.error || `Request failed (${res.status}).`); error.status = res.status; throw error; }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The connection took too long. Please try again.');
    if (error instanceof TypeError) throw new Error('Cannot reach Filmderr. Check your connection and try again.');
    throw error;
  } finally { clearTimeout(timer); }
}

function toast(message, { error = false, undo = null, persistent = false } = {}) {
  clearTimeout(state.toastTimer); state.toastDecisionId = undo; const region = $('#toast-region'); const box = el('div', `toast${error ? ' error' : ''}`);
  box.append(el('p', '', message));
  if (undo) box.append(button('Undo', 'text-button', async event => { event.currentTarget.disabled = true; await undoDecision(undo); }));
  box.append(button('×', 'toast-close', () => { state.toastDecisionId = null; region.replaceChildren(); })); box.lastChild.setAttribute('aria-label', 'Dismiss message');
  region.replaceChildren(box);
  if (!persistent && !undo) state.toastTimer = setTimeout(() => region.replaceChildren(), error ? 11000 : 6000);
}
function openSheet(title, eyebrow = 'YOUR SCREENING ROOM', view = '') {
  clearInterval(state.historyTimer); state.view = view; $('#sheet-title').textContent = title; $('#sheet-eyebrow').textContent = eyebrow;
  $('#sheet-body').replaceChildren(); if (!$('#sheet').open) $('#sheet').showModal(); $('#sheet').scrollTop = 0; return $('#sheet-body');
}
function loading(parent, message = 'Just a moment…') { const box = el('div', 'empty-note'); box.append(el('span', 'spinner'), el('p', '', message)); parent.append(box); return box; }
function sheetError(parent, error, retry) { parent.replaceChildren(feedback(error.message)); if (retry) parent.append(button('Try again', 'button secondary', retry)); }

async function loadSession() {
  const session = await api('/api/session'); state.session = session;
  $('#app').hidden = !session.user; $('#auth-screen').hidden = Boolean(session.user);
  if (!session.user) { renderAuth(); return; }
  $('#demo-badge').hidden = !session.demo;
  const account = $('#account-button'); account.replaceChildren(); const avatar = safeImage(session.user.avatar);
  if (avatar) { const img = el('img'); img.alt = ''; img.src = avatar; img.addEventListener('error', () => account.replaceChildren(document.createTextNode((session.user.name || 'U').slice(0, 1).toUpperCase())), { once: true }); account.append(img); }
  else account.textContent = (session.user.name || session.user.email || 'U').slice(0, 1).toUpperCase();
  account.setAttribute('aria-label', `Account: ${session.user.name || session.user.email}`);
  try {
    const [preferences, genres] = await Promise.all([api('/api/preferences'), api('/api/genres')]);
    state.preferences = preferences; state.genres = genres.genres || []; updateContext();
  } catch (error) { toast(error.message, { error: true }); }
  await loadDeck();
}

function authHeader(parent, title, intro) {
  const brand = el('div', 'brand auth-brand', 'filmderr'); brand.append(el('span', 'brand-dot', '.')); parent.append(brand);
  const art = el('div', 'auth-art'); ['film', 'heart', 'play'].forEach(name => { const card = el('span'); card.append(icon(name)); art.append(card); });
  parent.append(art, el('p', 'eyebrow', 'LESS SEARCHING. MORE WATCHING.'), el('h1', '', title), el('p', 'intro', intro));
}
function renderAuth() {
  const screen = $('#auth-screen'); screen.replaceChildren(); state.plexPoll++;
  if (!state.session.configured) { renderSetup(screen); return; }
  authHeader(screen, 'Your next film is waiting.', 'One poster. One choice. Find something you love and send it straight to your library.');
  const mode = state.session.authMode || 'plex'; const actions = el('div', 'auth-actions'); const status = feedback();
  if (mode === 'plex' || mode === 'both') {
    const plex = button('Continue with Plex', 'button primary', () => startPlex(plex, status, actions)); plex.prepend(icon('play')); actions.append(plex);
  }
  screen.append(actions);
  if (mode === 'both') screen.append(el('div', 'divider', 'OR USE YOUR FILMDERR ACCOUNT'));
  if (mode === 'local' || mode === 'both') {
    const form = el('form', 'form'); const email = field('Email address', 'email'); email.input.required = true; email.input.autocomplete = 'username';
    const password = field('Password', 'password'); password.input.required = true; password.input.autocomplete = 'current-password';
    const submit = button('Sign in', mode === 'local' ? 'button primary' : 'button secondary'); submit.type = 'submit'; form.append(email.wrap, password.wrap, submit);
    form.addEventListener('submit', async event => { event.preventDefault(); submit.disabled = true; setFeedback(status, ''); try { await api('/api/auth/local', 'POST', { email: email.input.value.trim(), password: password.input.value }); await loadSession(); } catch (error) { setFeedback(status, error.message); } finally { submit.disabled = false; } }); screen.append(form);
  }
  screen.append(status, el('p', 'login-note', 'Private by invitation. Ask your Filmderr administrator for access.'));
}
function renderSetup(screen) {
  authHeader(screen, 'Make room for better movie nights.', 'Connect your own library. Keep the films you want. Filmderr takes care of the discovery.');
  const form = el('form', 'form'); const token = field('Setup token', 'password', '', 'Use FILMDERR_SETUP_TOKEN from your server configuration.'); token.input.required = true; token.input.minLength = 24; token.input.autocomplete = 'off';
  const name = field('Your name'); name.input.required = true; name.input.autocomplete = 'name';
  const email = field('Owner email address', 'email', '', 'For Plex sign-in, use the exact email address on your Plex account.'); email.input.required = true; email.input.autocomplete = 'email';
  const mode = selectField('Sign-in method', [['plex', 'Plex account'], ['both', 'Plex and local accounts'], ['local', 'Local accounts']], 'plex');
  const password = field('Owner password', 'password', '', 'At least 12 characters. Used for local sign-in only.'); password.input.minLength = 12; password.input.autocomplete = 'new-password'; password.wrap.hidden = true;
  mode.input.addEventListener('change', () => { password.wrap.hidden = mode.input.value === 'plex'; password.input.required = mode.input.value !== 'plex'; });
  const status = feedback(); const submit = button('Create my screening room', 'button primary'); submit.type = 'submit';
  form.append(token.wrap, name.wrap, email.wrap, mode.wrap, password.wrap, status, submit);
  form.addEventListener('submit', async event => { event.preventDefault(); submit.disabled = true; setFeedback(status, ''); try { await api('/api/setup', 'POST', { token: token.input.value, name: name.input.value.trim(), email: email.input.value.trim(), password: mode.input.value === 'plex' ? undefined : password.input.value, authMode: mode.input.value }); await loadSession(); if (state.session.user) openSettings(); } catch (error) { setFeedback(status, error.message); } finally { submit.disabled = false; } }); screen.append(form);
}
async function startPlex(trigger, status, container) {
  trigger.disabled = true; setFeedback(status, 'Opening Plex…', 'neutral'); const pollId = ++state.plexPoll;
  const popup = window.open('about:blank', 'filmderr-plex', 'popup,width=780,height=720');
  try {
    const { url } = await api('/api/auth/plex/start', 'POST'); const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !['app.plex.tv', 'plex.tv', 'www.plex.tv'].includes(parsed.hostname)) throw new Error('The server returned an invalid Plex sign-in address.');
    if (popup) { popup.opener = null; popup.location.href = parsed.href; }
    const fallback = el('a', 'button subtle', 'Open Plex sign-in'); fallback.href = parsed.href; fallback.target = '_blank'; fallback.rel = 'noopener noreferrer'; container.append(fallback);
    setFeedback(status, 'Finish signing in with Plex, then return here. Filmderr will continue automatically.', 'neutral');
    for (let attempt = 0; attempt < 150; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 2000)); if (pollId !== state.plexPoll) return;
      const result = await api('/api/auth/plex/poll', 'POST');
      if (result.user) { try { popup?.close(); } catch {} await loadSession(); return; }
      if (!result.pending) throw new Error('Plex sign-in could not be completed. Please try again.');
    }
    throw new Error('Plex sign-in expired. Please start again.');
  } catch (error) { setFeedback(status, error.message); try { if (popup?.location.href === 'about:blank') popup.close(); } catch {} }
  finally { trigger.disabled = false; }
}

function updateContext() {
  const p = state.preferences || {}; const year = p.year || new Date().getFullYear();
  const genreNames = (p.genres || []).map(id => state.genres.find(g => Number(g.id) === Number(id))?.name).filter(Boolean);
  $('#deck-context').textContent = `${year} films · ${p.includeUpcoming ? 'Released + upcoming' : 'Released'} · Shuffled`;
  $('#genre-label').textContent = genreNames.length === 0 ? 'All genres' : genreNames.length === 1 ? genreNames[0] : `${genreNames.length} genres`;
}
function setActionEnabled(enabled) { ['#like-button', '#dislike-button', '#skip-button'].forEach(id => $(id).disabled = !enabled); }
function renderDeckState(title, text, { error = false, spinner = false } = {}) {
  const box = $('#deck-state'); box.replaceChildren(); box.hidden = false; $('#movie-card').hidden = true; setActionEnabled(false);
  if (spinner) box.append(el('span', 'spinner')); else { const mark = el('span', 'state-icon'); mark.append(icon(error ? 'film' : 'check')); box.append(mark); }
  box.append(el('h2', '', title), el('p', '', text));
  if (!spinner) box.append(button(error ? 'Try again' : 'Adjust your preferences', 'button subtle', error ? loadDeck : openPreferences));
}
async function loadDeck() {
  const request = ++state.deckRequest; $('#card-stage').setAttribute('aria-busy', 'true'); $('#refresh-button').disabled = true;
  renderDeckState('Setting the scene', 'Finding films outside your library.', { spinner: true });
  try {
    const deck = await api('/api/deck'); if (request !== state.deckRequest) return;
    state.movies = Array.isArray(deck.movies) ? deck.movies : []; state.remaining = Number(deck.remaining) || state.movies.length; state.syncedAt = deck.syncedAt || '';
    $('#deck-warning').textContent = deck.warning || ''; $('#deck-warning').hidden = !deck.warning; renderMovie();
  } catch (error) { if (request === state.deckRequest) { state.movies = []; renderDeckState('A short intermission', error.message, { error: true }); } }
  finally { if (request === state.deckRequest) { $('#card-stage').setAttribute('aria-busy', 'false'); $('#refresh-button').disabled = false; } }
}
function renderMovie() {
  const movie = state.movies[0]; const card = $('#movie-card'); card.style.transform = ''; card.style.opacity = ''; card.style.transition = ''; resetDrag();
  if (!movie) { renderDeckState('You’re all caught up.', 'There are no more unseen films in this selection. Try another year or a different genre.'); $('#deck-count').textContent = 'A good place to start something new'; return; }
  $('#deck-state').hidden = true; card.hidden = false; card.classList.remove('card-enter'); void card.offsetWidth; card.classList.add('card-enter');
  $('#movie-title').textContent = movie.title; $('#movie-overview').textContent = movie.overview || 'A new story to discover. Open the details to learn more.';
  $('#movie-genre').textContent = (movie.genres || []).slice(0, 2).join(' / ') || 'Discover';
  const facts = $('#movie-facts'); facts.replaceChildren(el('span', '', movie.year || 'Coming soon'));
  if (movie.runtime) facts.append(el('span', 'dot', '·'), el('span', '', `${movie.runtime} min`));
  if (Number(movie.rating) > 0) facts.append(el('span', 'dot', '·'), el('span', 'rating', `★ ${Number(movie.rating).toFixed(1)}`));
  const poster = $('#movie-poster'); const src = safeImage(movie.poster); poster.hidden = !src; $('#poster-fallback').hidden = Boolean(src);
  poster.onload = () => { poster.hidden = false; $('#poster-fallback').hidden = true; }; poster.onerror = () => { poster.hidden = true; $('#poster-fallback').hidden = false; };
  poster.alt = `${movie.title} poster`; if (src) poster.src = src; else poster.removeAttribute('src');
  card.setAttribute('aria-label', `${movie.title}, ${movie.year || 'upcoming'}. Swipe left to add, right to pass. Hold for trailer.`);
  $('#movie-details').setAttribute('aria-label', `Read the story of ${movie.title}`);
  $('#deck-count').textContent = `${state.movies.length} in this shuffle · No repeats`;
  setActionEnabled(!state.busy);
  if (state.movies[1]?.poster) { const next = new Image(); next.src = safeImage(state.movies[1].poster); }
}
async function decide(action) {
  const movie = state.movies[0]; if (!movie || state.busy) return;
  state.busy = true; setActionEnabled(false);
  try {
    const { decision } = await api('/api/decisions', 'POST', { tmdbId: Number(movie.id), action });
    const card = $('#movie-card'); card.style.transition = 'transform .22s ease, opacity .22s ease'; card.style.transform = `translateX(${action === 'like' ? '-110' : action === 'dislike' ? '110' : '0'}%) rotate(${action === 'like' ? '-12' : action === 'dislike' ? '12' : '0'}deg)`; card.style.opacity = '0';
    await new Promise(resolve => setTimeout(resolve, 220)); state.movies.shift(); state.busy = false; renderMovie();
    const pending = decision.status === 'pending';
    const message = pending ? `${action === 'like' ? 'Adding' : 'Passing on'} “${movie.title}” in 5 seconds.` : decision.message || (action === 'skip' ? 'Saved for another day.' : `${movie.title}: ${decision.status}`);
    toast(message, { undo: action === 'skip' ? null : decision.id, persistent: pending });
    if (pending) setTimeout(() => refreshDecisionToast(decision.id), Math.max(5500, (new Date(decision.executeAt).getTime() || Date.now()) - Date.now() + 1200));
  } catch (error) { toast(error.message, { error: true }); state.busy = false; renderMovie(); }
  finally { state.busy = false; setActionEnabled(Boolean(state.movies[0])); }
}
async function refreshDecisionToast(id) {
  if (state.toastDecisionId !== id) return;
  try { const history = await api('/api/history'); const d = (history.decisions || []).find(row => row.id === id); if (!d) return;
    if (state.toastDecisionId !== id) return;
    if (['pending', 'processing', 'undoing', 'executing'].includes(d.status)) { setTimeout(() => refreshDecisionToast(id), 2500); return; }
    if (['cancelled', 'undone'].includes(d.status)) return;
    toast(d.message || `${d.title}: ${d.status}`, { error: d.status === 'failed', undo: d.action === 'dislike' && d.status !== 'failed' ? d.id : null });
  } catch { /* The Activity view can always refresh the persisted result. */ }
}
async function undoDecision(id) {
  try { const { decision } = await api(`/api/decisions/${encodeURIComponent(id)}/undo`, 'POST'); toast(decision.message || 'Choice undone.'); await loadDeck(); if (state.view === 'history' && $('#sheet').open) renderHistory(); }
  catch (error) { toast(error.message, { error: true }); if (state.view === 'history') renderHistory(); }
}

let gesture = null; let holdTimer = null; let suppressClickUntil = 0;
function resetDrag() { clearTimeout(holdTimer); gesture = null; $('#like-stamp').style.opacity = '0'; $('#dislike-stamp').style.opacity = '0'; }
$('#movie-card').addEventListener('pointerdown', event => {
  if (event.button !== 0 || state.busy || !state.movies[0] || event.target.closest('.trailer-button')) return;
  gesture = { x: event.clientX, y: event.clientY, id: event.pointerId, dx: 0, dy: 0, dragging: false, held: false };
  holdTimer = setTimeout(() => { if (!gesture) return; gesture.held = true; suppressClickUntil = Date.now() + 600; openTrailer(); }, 520);
});
$('#movie-card').addEventListener('pointermove', event => {
  if (!gesture || event.pointerId !== gesture.id) return; gesture.dx = event.clientX - gesture.x; gesture.dy = event.clientY - gesture.y;
  if (Math.hypot(gesture.dx, gesture.dy) > 8) clearTimeout(holdTimer);
  if (gesture.held || Math.abs(gesture.dy) > Math.abs(gesture.dx) + 15) return;
  if (Math.abs(gesture.dx) > 12) { gesture.dragging = true; suppressClickUntil = Date.now() + 500; const card = $('#movie-card'); card.style.transition = 'none'; card.style.transform = `translateX(${gesture.dx}px) rotate(${gesture.dx / 22}deg)`; $('#like-stamp').style.opacity = String(Math.min(1, Math.max(0, -gesture.dx / 110))); $('#dislike-stamp').style.opacity = String(Math.min(1, Math.max(0, gesture.dx / 110))); }
});
function finishGesture(event) {
  if (!gesture || event.pointerId !== gesture.id) return; clearTimeout(holdTimer); const g = gesture; resetDrag();
  if (g.dragging && Math.abs(g.dx) > Math.min(100, $('#movie-card').clientWidth * .26)) { decide(g.dx < 0 ? 'like' : 'dislike'); }
  else { $('#movie-card').style.transition = 'transform .2s ease'; $('#movie-card').style.transform = ''; }
}
window.addEventListener('pointerup', finishGesture);
$('#movie-card').addEventListener('pointercancel', () => { resetDrag(); $('#movie-card').style.transform = ''; });
$('#movie-card').addEventListener('contextmenu', event => event.preventDefault());
$('#movie-details').addEventListener('click', () => { if (Date.now() > suppressClickUntil) openDetails(); });
document.addEventListener('keydown', event => { if (event.repeat || $('#sheet').open || $('#trailer-dialog').open || /INPUT|SELECT|TEXTAREA|BUTTON/.test(event.target.tagName) || !state.session?.user) return; if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); decide(event.key === 'ArrowLeft' ? 'like' : 'dislike'); } });

async function openDetails() {
  const movie = state.movies[0]; if (!movie) return; const body = openSheet(movie.title, 'THE STORY', 'details');
  const facts = el('div', 'detail-facts'); [movie.year, ...(movie.genres || []), movie.rating ? `TMDB ${Number(movie.rating).toFixed(1)} · ${Number(movie.votes || 0).toLocaleString()} votes` : '', movie.releaseDate ? `Release: ${movie.releaseDate}` : ''].filter(Boolean).forEach(value => facts.append(el('span', '', value)));
  body.append(facts, el('p', 'detail-overview', movie.overview || 'A synopsis is not available for this film yet.'));
  const trailer = button('Watch trailer', 'button primary', () => openTrailer(movie)); trailer.prepend(icon('play')); body.append(trailer);
}
async function openTrailer(movie = state.movies[0]) {
  if (!movie || $('#trailer-dialog').open) return; const dialog = $('#trailer-dialog'); const content = $('#trailer-content'); content.replaceChildren(); $('#trailer-title').textContent = `${movie.title} · Trailer`; dialog.showModal(); loading(content, 'Finding the trailer…');
  try { const detail = await api(`/api/movies/${encodeURIComponent(movie.id)}`); if (!dialog.open) return; content.replaceChildren();
    const key = detail.trailer?.key;
    if (!key || !/^[a-zA-Z0-9_-]{6,32}$/.test(key)) { content.append(el('p', 'empty-note', 'No trailer is available for this movie yet.')); return; }
    const iframe = el('iframe'); iframe.title = `${movie.title} official trailer`; iframe.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(key)}?autoplay=1&playsinline=1&rel=0`; iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen'; iframe.allowFullscreen = true; iframe.referrerPolicy = 'strict-origin-when-cross-origin'; content.append(iframe);
    const note = el('p', 'trailer-note', 'If playback does not start, tap Play. '); const link = el('a', '', 'Open on YouTube'); link.href = `https://www.youtube.com/watch?v=${encodeURIComponent(key)}`; link.target = '_blank'; link.rel = 'noopener noreferrer'; note.append(link); content.append(note);
  } catch (error) { content.replaceChildren(feedback(error.message)); }
}

async function ensurePreferences() {
  if (!state.preferences || !state.genres.length) { const [p, g] = await Promise.all([api('/api/preferences'), api('/api/genres')]); state.preferences = p; state.genres = g.genres || []; }
}
function buildGenreChoices(selected, parent) {
  const selectedSet = new Set((selected || []).map(Number)); const grid = el('div', 'genre-grid');
  const all = button('All genres', 'genre-chip'); grid.append(all);
  const sync = () => { all.setAttribute('aria-pressed', String(!selectedSet.size)); [...grid.querySelectorAll('[data-genre]')].forEach(node => node.setAttribute('aria-pressed', String(selectedSet.has(Number(node.dataset.genre))))); };
  all.addEventListener('click', () => { selectedSet.clear(); sync(); });
  state.genres.forEach(genre => { const chip = button(genre.name, 'genre-chip', () => { const id = Number(genre.id); selectedSet.has(id) ? selectedSet.delete(id) : selectedSet.add(id); sync(); }); chip.dataset.genre = genre.id; grid.append(chip); }); sync(); parent.append(grid); return selectedSet;
}
async function openGenres() {
  const body = openSheet('Set the mood.', 'WHAT ARE YOU IN THE MOOD FOR?', 'genres'); loading(body);
  try { await ensurePreferences(); if (state.view !== 'genres') return; body.replaceChildren(el('p', 'intro', 'Pick one genre or mix a few. Every shuffle brings something different.')); const selected = buildGenreChoices(state.preferences.genres, body); const status = feedback(); const save = button('Find my films', 'button primary', async () => { save.disabled = true; try { state.preferences = await api('/api/preferences', 'PUT', { ...state.preferences, genres: [...selected] }); updateContext(); $('#sheet').close(); await loadDeck(); } catch (error) { setFeedback(status, error.message); } finally { save.disabled = false; } }); body.append(status, save); }
  catch (error) { sheetError(body, error, openGenres); }
}
async function openPreferences() {
  const body = openSheet('Your kind of cinema.', 'MOVIE PREFERENCES', 'preferences'); loading(body);
  try { await ensurePreferences(); if (state.view !== 'preferences') return; body.replaceChildren(el('p', 'intro', 'Fine-tune your discovery. These preferences belong to you. Your existing library and exclusions stay out of the deck.'));
    const p = state.preferences; const form = el('form', 'form'); const year = field('Release year', 'number', p.year || new Date().getFullYear()); year.input.min = 1900; year.input.max = new Date().getFullYear() + 5; year.input.required = true;
    const release = selectField('Release type', [['any', 'Any release'], ['digital', 'Digital release']], p.releaseType || 'any'); const row = el('div', 'form-row'); row.append(year.wrap, release.wrap);
    const upcoming = checkbox('Include upcoming films from this year', p.includeUpcoming);
    const language = selectField('Original language', [['', 'All languages'], ['en', 'English'], ['nl', 'Dutch'], ['fa', 'Persian'], ['fr', 'French'], ['de', 'German'], ['es', 'Spanish'], ['it', 'Italian'], ['ko', 'Korean'], ['ja', 'Japanese'], ['hi', 'Hindi'], ['zh', 'Chinese'], ['pt', 'Portuguese'], ['tr', 'Turkish'], ['ar', 'Arabic'], ['sv', 'Swedish'], ['da', 'Danish'], ['no', 'Norwegian']], p.originalLanguage || '');
    if (p.originalLanguage && !language.input.value) { const option = el('option', '', p.originalLanguage); option.value = p.originalLanguage; language.input.append(option); language.input.value = p.originalLanguage; }
    const rating = field('Minimum TMDB rating', 'number', p.minRating ?? 0, '0 includes unrated films.'); rating.input.min = 0; rating.input.max = 10; rating.input.step = .1;
    const votes = field('Minimum votes', 'number', p.minVotes ?? 0, 'A higher count favors established releases.'); votes.input.min = 0; votes.input.step = 1; const scores = el('div', 'form-row'); scores.append(rating.wrap, votes.wrap);
    form.append(row, upcoming.wrap, language.wrap, scores, el('h3', 'section-heading', 'Genres')); const selected = buildGenreChoices(p.genres, form);
    const status = feedback(); const save = button('Save & shuffle', 'button primary'); save.type = 'submit'; form.append(status, save);
    form.addEventListener('submit', async event => { event.preventDefault(); save.disabled = true; try { state.preferences = await api('/api/preferences', 'PUT', { year: Number(year.input.value), includeUpcoming: upcoming.input.checked, releaseType: release.input.value, originalLanguage: language.input.value, minRating: Number(rating.input.value), minVotes: Number(votes.input.value), genres: [...selected] }); updateContext(); $('#sheet').close(); await loadDeck(); } catch (error) { setFeedback(status, error.message); } finally { save.disabled = false; } }); body.append(form);
  } catch (error) { sheetError(body, error, openPreferences); }
}

async function renderHistory() {
  const body = openSheet('Your choices.', 'RECENT ACTIVITY', 'history'); loading(body, 'Checking your requests…');
  try { const result = await api('/api/history'); if (state.view !== 'history') return; body.replaceChildren();
    const toolbar = el('div', 'history-toolbar'); toolbar.append(el('span', 'help', 'Only your activity is shown.'), button('Refresh', 'text-button', renderHistory)); body.append(toolbar);
    const rows = result.decisions || []; const list = el('div', 'history-list');
    rows.forEach(d => { const item = el('article', 'history-item'); const mark = el('span', `history-symbol ${d.action}`); mark.append(icon(d.action === 'like' ? 'heart' : d.action === 'dislike' ? 'close' : 'skip')); const info = el('div'); info.append(el('h3', '', d.title || `Movie ${d.tmdbId}`));
      const labels = { pending: 'Pending · undo is available', processing: 'Applying your choice…', undoing: 'Undoing…', executing: 'Applying your choice…', completed: d.action === 'like' ? 'Submitted' : d.action === 'dislike' ? 'Excluded' : 'Skipped', added: 'Added to Radarr', requested: 'Requested in Seerr', excluded: 'Excluded', hidden: 'Hidden from your deck', 'already-present': 'Already in your library', skipped: 'Skipped for now', failed: 'Needs attention', cancelled: 'Cancelled', undone: 'Undone' };
      info.append(el('p', d.status === 'failed' ? 'history-error' : 'history-status', labels[d.status] || d.status)); if (d.message) info.append(el('p', '', d.message)); info.append(el('p', '', formatDate(d.createdAt))); item.append(mark, info);
      if (d.status === 'pending' || (d.action === 'dislike' && !['failed', 'cancelled', 'undone', 'processing', 'undoing', 'executing'].includes(d.status))) item.append(button('Undo', 'text-button', async event => { event.currentTarget.disabled = true; await undoDecision(d.id); })); list.append(item); });
    body.append(rows.length ? list : el('p', 'empty-note', 'Your movie nights start here. Add a film or pass on one, and your choices will appear here.'));
    body.append(el('p', 'sync-note', 'Likes have a short undo window before submission. Once a request is submitted, undo will not delete media or cancel downloads. Shared exclusions are removed only when Filmderr owns them and no one else still dislikes that film.'));
    body.append(button('Show my skipped films again', 'button subtle', async event => { event.currentTarget.disabled = true; try { await api('/api/history/reset-skips', 'POST'); toast('Your skipped films can appear again.'); await loadDeck(); await renderHistory(); } catch (error) { toast(error.message, { error: true }); event.currentTarget.disabled = false; } }));
    if (rows.some(d => ['pending', 'processing', 'undoing', 'executing'].includes(d.status))) state.historyTimer = setTimeout(() => { if (state.view === 'history' && $('#sheet').open) renderHistory(); }, 4000);
  } catch (error) { sheetError(body, error, renderHistory); }
}

function openAccount() {
  const body = openSheet('Good evening, movie lover.', 'YOUR ACCOUNT', 'account'); const user = state.session.user;
  body.append(el('h3', 'section-heading', user.name || 'Filmderr member'), el('p', 'section-description', user.email || ''), button('Movie preferences', 'button secondary', openPreferences));
  if (user.role === 'admin') body.append(button('Manage Filmderr', 'button secondary', openSettings));
  body.append(button('About & credits', 'button subtle', openAbout));
  const status = feedback(); body.append(status, button('Sign out', 'button subtle', async event => { event.currentTarget.disabled = true; try { await api('/api/auth/logout', 'POST'); state.plexPoll++; $('#sheet').close(); state.movies = []; state.preferences = null; state.genres = []; $('#toast-region').replaceChildren(); await loadSession(); } catch (error) { setFeedback(status, error.message); event.currentTarget.disabled = false; } }));
  body.append(el('p', 'sync-note', state.session.demo ? 'Demo mode. Connections and movie choices are simulated; no media is downloaded.' : 'Filmderr keeps integration credentials on the server. Your browser uses your authenticated session.'));
}

function openAbout() {
  const body = openSheet('Filmderr.', 'ABOUT & CREDITS', 'about');
  body.append(el('p', 'intro', 'A little discovery for your next movie night. An independent, self-hosted movie discovery app.'));
  const tmdb = el('section', 'settings-section');
  const logoLink = el('a', 'credit-logo'); logoLink.href = 'https://www.themoviedb.org'; logoLink.target = '_blank'; logoLink.rel = 'noopener noreferrer';
  const logo = el('img'); logo.src = '/tmdb-logo.svg'; logo.alt = 'TMDB'; logo.width = 112; logoLink.append(logo);
  tmdb.append(logoLink, el('p', 'credit-copy', 'This product uses the TMDB API but is not endorsed or certified by TMDB.'), el('p', 'help', 'Movie information, poster imagery and trailer metadata are provided by The Movie Database.'));
  body.append(tmdb);
  const seerr = el('section', 'settings-section'); seerr.append(el('h3', 'section-heading', 'Built with open-source foundations'), el('p', 'credit-copy', 'Selected integration routines are adapted from Seerr. Copyright © 2020 sct. Used under the MIT License.'));
  const link = el('a', 'credit-link', 'Seerr source & MIT license ↗'); link.href = 'https://github.com/seerr-team/seerr/blob/e59ffce72dcde43105fb53cfc9eee9e5d0bfa34c/LICENSE'; link.target = '_blank'; link.rel = 'noopener noreferrer'; seerr.append(link); body.append(seerr);
  body.append(el('p', 'help', 'Filmderr is an independent project. Seerr, Radarr, Plex and TMDB do not endorse or operate this app.'), button('Back to my account', 'button subtle', openAccount));
}

async function openSettings() {
  if (state.session.user.role !== 'admin') { openPreferences(); return; }
  const body = openSheet('Behind the scenes.', 'ADMINISTRATION', 'settings'); loading(body);
  try { const result = await api('/api/settings'); if (state.view !== 'settings') return; body.replaceChildren();
    const tabs = el('div', 'settings-tabs'); tabs.append(button('Connections', 'button subtle active'), button('People', 'button subtle', () => renderUsers(result.users || [])), button('My preferences', 'button subtle', openPreferences)); body.append(tabs);
    body.append(el('p', 'intro', 'Connect your services, save the configuration, then test each connection. Credentials stay on this server.'));
    buildSettings(body, result.settings || {});
  } catch (error) { sheetError(body, error, openSettings); }
}
function buildSettings(body, settings) {
  const form = el('form', 'form'); const refs = {}; const clearSecrets = new Set();
  function section(title, description) { const block = el('section', 'settings-section'); block.append(el('h3', 'section-heading', title)); if (description) block.append(el('p', 'section-description', description)); const fields = el('div', 'form'); block.append(fields); form.append(block); return fields; }
  function add(parent, key, label, type, value, hint) { const f = field(label, type, value, hint); refs[key] = f.input; parent.append(f.wrap); return f.input; }
  function secret(parent, key, label, hasSecret) { const input = add(parent, key, label, 'password', '', hasSecret ? 'Saved. Leave blank to keep the existing credential.' : 'Not configured yet.'); input.autocomplete = 'new-password'; input.placeholder = hasSecret ? '•••••••• · saved' : 'Enter credential'; const clear = checkbox('Clear saved credential', false); clear.wrap.classList.add('secret-clear'); clear.input.addEventListener('change', () => clear.input.checked ? clearSecrets.add(key) : clearSecrets.delete(key)); parent.append(clear.wrap); }
  function test(parent, service) { const status = feedback(); const run = button('Test saved connection', 'button subtle', async () => { run.disabled = true; setFeedback(status, 'Checking saved configuration…', 'neutral'); try { const result = await api('/api/settings/test', 'POST', { service }); if (!result.ok) throw new Error(result.message || 'Connection test failed.'); setFeedback(status, result.message || 'Connected successfully.', 'success'); if (result.profiles) populateSelect(refs['radarr.qualityProfileId'], result.profiles.map(row => [row.id, row.name])); if (result.rootFolders) populateSelect(refs['radarr.rootFolder'], result.rootFolders.map(row => [row.path, row.path])); if (result.libraries) showLibraries(result.libraries); } catch (error) { setFeedback(status, error.message); } finally { run.disabled = false; } }); parent.append(run, status); }
  function populateSelect(select, options) { const previous = select.value; select.replaceChildren(); const empty = el('option', '', 'Choose…'); empty.value = ''; select.append(empty); options.forEach(([value, label]) => { const option = el('option', '', label); option.value = value; select.append(option); }); if ([...select.options].some(option => option.value === previous)) select.value = previous; }
  function choice(parent, key, label, value, hint) { const options = [['', 'Save & test to load choices']]; if (value !== null && value !== undefined && value !== '') options.push([String(value), String(value)]); const f = selectField(label, options, value ?? '', hint); refs[key] = f.input; parent.append(f.wrap); }
  const radarr = section('Radarr', 'Likes add and monitor the movie using your selected profile, then start a search.'); add(radarr, 'radarr.url', 'Radarr URL', 'url', settings.radarr?.url); refs['radarr.url'].placeholder = 'http://radarr:7878'; secret(radarr, 'radarr.apiKey', 'API key', settings.radarr?.hasApiKey); test(radarr, 'radarr');
  choice(radarr, 'radarr.qualityProfileId', 'Quality profile', settings.radarr?.qualityProfileId, 'Choose the quality profile this app should use.'); choice(radarr, 'radarr.rootFolder', 'Root folder', settings.radarr?.rootFolder);
  const availability = selectField('Minimum availability', [['released', 'Released'], ['inCinemas', 'In cinemas'], ['announced', 'Announced']], settings.radarr?.minimumAvailability || 'released'); radarr.append(availability.wrap); refs['radarr.minimumAvailability'] = availability.input;
  const plex = section('Plex', 'Optional library matching hides films already available in Plex, including films outside Radarr.'); add(plex, 'plex.url', 'Plex server URL', 'url', settings.plex?.url); refs['plex.url'].placeholder = 'http://plex:32400'; secret(plex, 'plex.token', 'Plex token', settings.plex?.hasToken); test(plex, 'plex');
  const libraryBox = el('div', 'library-list'); const selectedLibraries = new Set((settings.plex?.libraryIds || []).map(String)); plex.append(el('span', 'help', 'Movie libraries — no selection scans all movie libraries.'), libraryBox);
  function showLibraries(libraries) { libraryBox.replaceChildren(); if (!libraries.length) { libraryBox.append(el('p', 'library-note', 'No movie libraries were returned.')); return; } libraries.forEach(lib => { const id = String(lib.key ?? lib.id); const item = checkbox(lib.title || lib.name || `Library ${id}`, selectedLibraries.has(id)); item.input.addEventListener('change', () => item.input.checked ? selectedLibraries.add(id) : selectedLibraries.delete(id)); libraryBox.append(item.wrap); }); }
  libraryBox.append(el('p', 'library-note', selectedLibraries.size ? `Selected library IDs: ${[...selectedLibraries].join(', ')}. Test the connection to select by name.` : 'Test the saved Plex connection to choose movie libraries.'));
  const tmdb = section('Movie discovery', 'TMDB supplies the posters, descriptions, release dates and trailer links.'); secret(tmdb, 'tmdb.apiKey', 'TMDB API key or read access token', settings.tmdb?.hasApiKey); test(tmdb, 'tmdb'); add(tmdb, 'region', 'Release region', 'text', settings.region || 'NL', 'Two-letter country code, such as NL, US or GB.'); refs.region.maxLength = 2; refs.region.pattern = '[A-Za-z]{2}';
  const seerr = section('Seerr · optional', 'Route likes through Seerr to keep its request history and request-based protections. Configure auto-approval and matching Radarr defaults in Seerr. Failed Seerr requests will not fall back to a direct Radarr addition.'); const enabled = checkbox('Submit requests through Seerr', settings.seerr?.enabled); seerr.append(enabled.wrap); add(seerr, 'seerr.url', 'Seerr URL', 'url', settings.seerr?.url); refs['seerr.url'].placeholder = 'http://seerr:5055'; secret(seerr, 'seerr.apiKey', 'Seerr API key', settings.seerr?.hasApiKey); test(seerr, 'seerr');
  const general = section('Access & behavior', 'Radarr exclusions are shared across the household. They stop automatic list additions, but do not universally prevent manual requests in other apps.'); const shared = checkbox('Dislikes create shared Radarr import-list exclusions', settings.sharedExclusions !== false); general.append(shared.wrap);
  const authMode = selectField('Allowed sign-in methods', [['plex', 'Plex'], ['both', 'Plex and local'], ['local', 'Local only']], settings.authMode || 'plex'); general.append(authMode.wrap); add(general, 'publicUrl', 'Public Filmderr URL', 'url', settings.publicUrl || '', 'Your externally reachable HTTPS address.'); refs.publicUrl.placeholder = 'https://films.example.com';
  general.append(el('p', 'help', 'Before switching to local-only access, ensure an administrator has a local password. Changing a sign-in method does not create an account.'));
  const status = feedback(); const footer = el('div', 'save-footer'); const save = button('Save configuration', 'button primary'); save.type = 'submit'; footer.append(save); form.append(status, footer);
  form.addEventListener('submit', async event => { event.preventDefault(); save.disabled = true; setFeedback(status, ''); const values = key => refs[key].value.trim();
    const payload = { radarr: { url: values('radarr.url'), apiKey: values('radarr.apiKey'), qualityProfileId: values('radarr.qualityProfileId') ? Number(values('radarr.qualityProfileId')) : null, rootFolder: values('radarr.rootFolder'), minimumAvailability: values('radarr.minimumAvailability') }, plex: { url: values('plex.url'), token: values('plex.token'), libraryIds: [...selectedLibraries] }, tmdb: { apiKey: values('tmdb.apiKey') }, seerr: { enabled: enabled.input.checked, url: values('seerr.url'), apiKey: values('seerr.apiKey') }, sharedExclusions: shared.input.checked, authMode: authMode.input.value, publicUrl: values('publicUrl'), region: values('region').toUpperCase(), clearSecrets: [...clearSecrets] };
    try { const saved = await api('/api/settings', 'PUT', payload); ['radarr.apiKey', 'plex.token', 'tmdb.apiKey', 'seerr.apiKey'].forEach(key => { const [section, secretName] = key.split('.'); const has = Boolean((saved.settings || saved)[section]?.[`has${secretName[0].toUpperCase()}${secretName.slice(1)}`]); refs[key].value = ''; refs[key].placeholder = has ? '•••••••• · saved' : 'Enter credential'; const hint = refs[key].parentElement.querySelector('.field-hint'); if (hint) hint.textContent = has ? 'Saved. Leave blank to keep the existing credential.' : 'Not configured yet.'; }); clearSecrets.clear(); form.querySelectorAll('.secret-clear input').forEach(input => input.checked = false); setFeedback(status, 'Configuration saved. Test your connections, then refresh Discover.', 'success'); toast('Configuration saved.'); } catch (error) { setFeedback(status, error.message); } finally { save.disabled = false; }
  }); body.append(form);
}
async function renderUsers(knownUsers) {
  const body = openSheet('A shared love of film.', 'PEOPLE & ACCESS', 'users'); body.append(el('p', 'intro', 'Invite people by the exact email address on their Plex account. Each person gets their own discovery preferences and history.'));
  let users;
  try { users = knownUsers || (await api('/api/settings')).users || []; } catch (error) { sheetError(body, error, () => renderUsers()); return; }
  const list = el('div', 'user-list'); users.forEach(user => { const row = el('div', 'user-row'); const details = el('div', '', user.name || user.email); details.append(el('p', '', user.email)); const methods = [user.plexLinked ? 'Plex connected' : 'Plex invited', user.localEnabled ? 'Local sign-in enabled' : ''].filter(Boolean); details.append(el('p', '', methods.join(' · '))); row.append(details, el('span', 'user-role', user.role)); list.append(row); }); body.append(list);
  const form = el('form', 'form'); const email = field('Email address', 'email'); email.input.required = true; email.input.autocomplete = 'off'; const name = field('Display name'); name.input.required = true;
  const role = selectField('Role', [['user', 'Member'], ['admin', 'Administrator']], 'user'); const password = field('Local password · optional', 'password', '', 'Only set this if local sign-in is enabled. At least 12 characters.'); password.input.autocomplete = 'new-password'; password.input.minLength = 12;
  const status = feedback(); const submit = button('Invite person', 'button primary'); submit.type = 'submit'; form.append(email.wrap, name.wrap, role.wrap, password.wrap, status, submit);
  form.addEventListener('submit', async event => { event.preventDefault(); submit.disabled = true; try { await api('/api/users', 'POST', { email: email.input.value.trim(), name: name.input.value.trim(), role: role.input.value, ...(password.input.value ? { password: password.input.value } : {}) }); toast('Access created. Share your Filmderr address with them.'); await renderUsers(); } catch (error) { setFeedback(status, error.message); } finally { submit.disabled = false; } }); body.append(form, el('p', 'sync-note', 'Adding access does not send an email. Members sign in at your Filmderr address.'));
  body.append(button('Back to connections', 'button subtle', openSettings));
}

$('#filter-button').append(icon('filter')); $('#like-button').append(icon('heart')); $('#dislike-button').append(icon('close'));
[['#discover-tab', 'discover', 'Discover'], ['#activity-tab', 'history', 'Activity'], ['#settings-tab', 'settings', 'Settings']].forEach(([selector, name, text]) => $(selector).append(icon(name), el('span', '', text)));
$('#like-button').addEventListener('click', () => decide('like')); $('#dislike-button').addEventListener('click', () => decide('dislike')); $('#skip-button').addEventListener('click', () => decide('skip'));
$('#genre-button').addEventListener('click', openGenres); $('#filter-button').addEventListener('click', openPreferences); $('#refresh-button').addEventListener('click', loadDeck); $('#trailer-button').addEventListener('click', () => openTrailer());
$('#activity-tab').addEventListener('click', renderHistory); $('#settings-tab').addEventListener('click', openSettings); $('#account-button').addEventListener('click', openAccount); $('#discover-tab').addEventListener('click', () => { if ($('#sheet').open) $('#sheet').close(); $('#movie-card').focus({ preventScroll: true }); });
$('#sheet-close').addEventListener('click', () => $('#sheet').close()); $('#sheet').addEventListener('close', () => { clearTimeout(state.historyTimer); state.view = ''; });
$('#sheet').addEventListener('click', event => { if (event.target === $('#sheet')) { const rect = $('#sheet').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('#sheet').close(); } });
$('#trailer-close').addEventListener('click', () => $('#trailer-dialog').close()); $('#trailer-dialog').addEventListener('close', () => { $('#trailer-content').replaceChildren(); resetDrag(); $('#movie-card').style.transform = ''; });
window.addEventListener('online', () => { if (state.session?.user && !state.movies.length) loadDeck(); });
loadSession().catch(error => { $('#auth-screen').hidden = false; const screen = $('#auth-screen'); screen.replaceChildren(); authHeader(screen, 'A short intermission.', error.message); screen.append(button('Try again', 'button primary', () => location.reload())); });

