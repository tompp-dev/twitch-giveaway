const channelInput = document.querySelector('#channelInput');
const phraseInput = document.querySelector('#phraseInput');
const toggleButton = document.querySelector('#toggleButton');
const redrawButton = document.querySelector('#redrawButton');
const excludeVipsCheckbox = document.querySelector('#excludeVipsCheckbox');
const excludeModsCheckbox = document.querySelector('#excludeModsCheckbox');
const statusEl = document.querySelector('#status');
const winnerEl = document.querySelector('#winner');
const entriesList = document.querySelector('#entriesList');
const entryCount = document.querySelector('#entryCount');

const TWITCH_IRC_WS_URL = 'wss://irc-ws.chat.twitch.tv:443';

let socket = null;
let giveawayActive = false;
let requiredPhrase = '';
let activeChannel = '';
let entries = new Map();
let joinedTimeoutId = null;
let excludeVips = false;
let excludeMods = false;

renderEntries();

redrawButton.addEventListener('click', () => {
  chooseWinner(true);
});

toggleButton.addEventListener('click', async () => {
  if (giveawayActive) {
    stopGiveaway();
    return;
  }

  startGiveaway();
});

function startGiveaway() {
  const channel = normalizeChannel(channelInput.value);
  const phrase = phraseInput.value.trim();

  winnerEl.textContent = '';
  redrawButton.hidden = true;

  if (!isValidChannel(channel)) {
    setStatus('Enter a valid Twitch channel name', 'error');
    channelInput.focus();
    return;
  }

  if (!phrase) {
    setStatus('Enter a phrase chatters must type', 'error');
    phraseInput.focus();
    return;
  }

  cleanupSocket();

  requiredPhrase = phrase;
  activeChannel = channel;
  excludeVips = excludeVipsCheckbox.checked;
  excludeMods = excludeModsCheckbox.checked;
  entries = new Map();
  renderEntries();
  setLoading(true);
  setStatus(`Connecting to Twitch chat for #${channel}…`, 'waiting');

  const anonymousUsername = `justinfan${Math.floor(Math.random() * 100000)}`;
  socket = new WebSocket(TWITCH_IRC_WS_URL);

  socket.addEventListener('open', () => {
    // Twitch IRC supports anonymous read-only connections with a justinfan username.
    socket.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
    socket.send('PASS SCHMOOPIIE');
    socket.send(`NICK ${anonymousUsername}`);
    socket.send(`JOIN #${channel}`);

    joinedTimeoutId = window.setTimeout(() => {
      if (!giveawayActive && socket?.readyState === WebSocket.OPEN) {
        markGiveawayLive();
      }
    }, 2500);
  });

  socket.addEventListener('message', event => {
    const lines = String(event.data).split('\r\n').filter(Boolean);
    for (const line of lines) handleIrcLine(line);
  });

  socket.addEventListener('error', () => {
    if (!giveawayActive) {
      setStatus('Could not open a WebSocket connection to Twitch chat. Check your internet connection or browser console.', 'error');
      setLoading(false);
    }
  });

  socket.addEventListener('close', () => {
    window.clearTimeout(joinedTimeoutId);
    joinedTimeoutId = null;

    if (giveawayActive) {
      giveawayActive = false;
      setInputsDisabled(false);
      toggleButton.textContent = 'Start giveaway';
      toggleButton.classList.remove('stop');
      setLoading(false);
      setStatus('Disconnected from Twitch chat.', 'error');
    }
  });
}

function stopGiveaway() {
  giveawayActive = false;
  setLoading(true);
  cleanupSocket();

  setInputsDisabled(false);
  toggleButton.textContent = 'Start giveaway';
  toggleButton.classList.remove('stop');
  setLoading(false);

  const entrants = [...entries.values()];
  if (entrants.length === 0) {
    setStatus('Giveaway ended. No valid entries were received.', 'waiting');
    winnerEl.textContent = 'No winner this time.';
    redrawButton.hidden = true;
    return;
  }

  setStatus(`Giveaway ended with ${entrants.length} entr${entrants.length === 1 ? 'y' : 'ies'}.`, 'idle');
  chooseWinner(false);
  redrawButton.hidden = false;
}

function chooseWinner(isRedraw) {
  const entrants = [...entries.values()];
  if (entrants.length === 0) return;

  const winner = entrants[Math.floor(Math.random() * entrants.length)];
  winnerEl.textContent = `${isRedraw ? 'Winner' : 'Winner'}: ${winner.displayName}`;
}

function handleIrcLine(line) {
  if (line.startsWith('PING ')) {
    socket?.send(line.replace('PING', 'PONG'));
    return;
  }

  const parsed = parseIrcMessage(line);
  if (!parsed) return;

  if (parsed.command === '001' || parsed.command === '366' || parsed.command === 'JOIN') {
    markGiveawayLive();
    return;
  }

  if (parsed.command === 'NOTICE') {
    const message = parsed.trailing || '';
    if (/Login authentication failed|Improperly formatted auth/i.test(message)) {
      setStatus('Twitch rejected the anonymous chat connection.', 'error');
      cleanupSocket();
      setLoading(false);
      return;
    }
  }

  if (parsed.command !== 'PRIVMSG' || !giveawayActive) return;
  if (parsed.channel !== `#${activeChannel}`) return;
  if (parsed.trailing !== requiredPhrase) return;

  const username = (parsed.tags.login || parsed.prefixName || '').toLowerCase();
  if (!username || entries.has(username)) return;
  if (!isChatterEligible(parsed.tags)) return;

  entries.set(username, {
    username,
    displayName: parsed.tags['display-name'] || parsed.prefixName || username,
    enteredAt: new Date()
  });

  renderEntries();
}

function isChatterEligible(tags) {
  const badges = parseBadges(tags.badges || '');
  const isVip = badges.has('vip');
  const isModerator = badges.has('moderator') || tags.mod === '1';

  if (excludeVips && isVip) return false;
  if (excludeMods && isModerator) return false;
  return true;
}

function parseBadges(rawBadges) {
  const badges = new Set();
  if (!rawBadges) return badges;

  for (const badge of rawBadges.split(',')) {
    const [name] = badge.split('/');
    if (name) badges.add(name);
  }

  return badges;
}

function markGiveawayLive() {
  if (giveawayActive) return;

  window.clearTimeout(joinedTimeoutId);
  joinedTimeoutId = null;
  giveawayActive = true;
  setInputsDisabled(true);
  toggleButton.textContent = 'Stop giveaway';
  toggleButton.classList.add('stop');
  setLoading(false);

  const filters = [];
  if (excludeVips) filters.push('VIPs excluded');
  if (excludeMods) filters.push('moderators excluded');
  const filterText = filters.length ? ` (${filters.join(', ')})` : '';

  setStatus(`Live in #${activeChannel}. Waiting for exact phrase: “${requiredPhrase}”${filterText}`, 'live');
}

function parseIrcMessage(rawLine) {
  let rest = rawLine;
  const tags = {};
  let prefix = '';
  let trailing = '';

  if (rest.startsWith('@')) {
    const tagEnd = rest.indexOf(' ');
    const rawTags = rest.slice(1, tagEnd);
    rest = rest.slice(tagEnd + 1);
    for (const tag of rawTags.split(';')) {
      const [key, value = ''] = tag.split('=');
      tags[key] = unescapeIrcTag(value);
    }
  }

  if (rest.startsWith(':')) {
    const prefixEnd = rest.indexOf(' ');
    prefix = rest.slice(1, prefixEnd);
    rest = rest.slice(prefixEnd + 1);
  }

  const trailingIndex = rest.indexOf(' :');
  if (trailingIndex !== -1) {
    trailing = rest.slice(trailingIndex + 2);
    rest = rest.slice(0, trailingIndex);
  }

  const parts = rest.split(' ').filter(Boolean);
  const command = parts[0];
  const channel = parts.find(part => part.startsWith('#')) || '';
  const prefixName = prefix.split('!')[0] || '';

  return { command, channel, trailing, tags, prefixName };
}

function unescapeIrcTag(value) {
  return value
    .replace(/\\s/g, ' ')
    .replace(/\\:/g, ';')
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n')
    .replace(/\\\\/g, '\\');
}

function renderEntries() {
  const entrants = [...entries.values()];
  entryCount.textContent = `${entrants.length} chatter${entrants.length === 1 ? '' : 's'}`;

  if (entrants.length === 0) {
    entriesList.innerHTML = '<div class="empty">No entries yet.</div>';
    return;
  }

  entriesList.innerHTML = entrants.map((entrant, index) => `
    <div class="entry">
      <span>${escapeHtml(entrant.displayName)}</span>
      <small>#${index + 1}</small>
    </div>
  `).join('');

  entriesList.scrollTop = entriesList.scrollHeight;
}

function cleanupSocket() {
  window.clearTimeout(joinedTimeoutId);
  joinedTimeoutId = null;

  if (!socket) return;

  try {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  } catch (error) {
    console.warn('Cleanup error:', error);
  } finally {
    socket = null;
  }
}

function normalizeChannel(value) {
  return value.trim().replace(/^#/, '').replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '').split(/[/?#]/)[0].toLowerCase();
}

function isValidChannel(channel) {
  return /^[a-z0-9_]{3,25}$/.test(channel);
}

function setStatus(message, type = 'idle') {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
}

function setLoading(isLoading) {
  toggleButton.disabled = isLoading;
}

function setInputsDisabled(disabled) {
  channelInput.disabled = disabled;
  phraseInput.disabled = disabled;
  excludeVipsCheckbox.disabled = disabled;
  excludeModsCheckbox.disabled = disabled;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[char]));
}
