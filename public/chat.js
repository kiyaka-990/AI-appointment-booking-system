const logEl = document.getElementById('log');
const formEl = document.getElementById('composer');
const inputEl = document.getElementById('input');
const sendEl = document.getElementById('send');
const statusEl = document.getElementById('status');
const statusTextEl = document.getElementById('statusText');
const suggestionsEl = document.getElementById('suggestions');
const toastEl = document.getElementById('toast');
const bookingSlotEl = document.getElementById('bookingSlot');

const STORAGE_KEY = 'bf_conversation';
const state = {
  conversationId: sessionStorage.getItem(STORAGE_KEY) || null,
  config: null,
  busy: false,
  typingEl: null,
  stream: null
};

/* ------------------------------------------------------------ embed mode */

const embedded = new URLSearchParams(location.search).get('embed') === '1';
if (embedded) document.body.classList.add('embed');

function reportEmbedHeight() {
  if (!embedded) return;
  const height = Math.ceil(document.querySelector('.chat')?.getBoundingClientRect().height ?? 0);
  if (height) window.parent.postMessage({ type: 'booking-widget:height', height }, '*');
}

/* ---------------------------------------------------------------- install */

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

let installPrompt = null;
const installButton = document.getElementById('installApp');
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  installButton.hidden = false;
});
installButton.addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null;
  installButton.hidden = true;
});
window.addEventListener('appinstalled', () => {
  installButton.hidden = true;
  toast('App installed');
});
if (embedded) installButton.hidden = true;
if (embedded && typeof ResizeObserver === 'function') {
  new ResizeObserver(reportEmbedHeight).observe(document.body);
}

/* ------------------------------------------------------------ primitives */

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toastEl.classList.remove('show'), 2400);
}

function setStatus(text, live = true) {
  statusTextEl.textContent = text;
  statusEl.classList.toggle('live', live);
  statusEl.querySelector('.dot').classList.toggle('live', live);
}

function scrollDown(smooth = true) {
  logEl.scrollTo({ top: logEl.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

function timeZone() {
  return state.config?.business.timezone ?? 'Europe/London';
}

function clockLabel(date = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone(),
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function initials() {
  const name = state.config?.business.name ?? 'Booking';
  return name
    .split(/\s+/)
    .filter((word) => /^[A-Za-z]/.test(word))
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join('');
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/* --------------------------------------------------------------- messages */

function addMessage(role, text) {
  const row = element('div', `row ${role}`);
  const wrap = element('div', 'msg-wrap');

  if (role === 'bot') {
    const avatar = element('div', 'bot-avatar', initials());
    avatar.setAttribute('aria-hidden', 'true');
    row.append(avatar);
    wrap.append(element('div', 'bubble', text));
  } else {
    wrap.append(element('div', 'bubble', text));
  }
  wrap.append(element('div', 'stamp', clockLabel()));
  row.append(wrap);
  logEl.append(row);
  scrollDown();
  return row;
}

function showTyping() {
  if (state.typingEl) return;
  const row = element('div', 'row bot');
  const avatar = element('div', 'bot-avatar', initials());
  avatar.setAttribute('aria-hidden', 'true');
  const bubble = element('div', 'bubble typing');
  bubble.setAttribute('aria-label', 'Assistant is typing');
  bubble.innerHTML = '<span></span><span></span><span></span>';
  row.append(avatar, bubble);
  logEl.append(row);
  state.typingEl = row;
  scrollDown();
}

function hideTyping() {
  state.typingEl?.remove();
  state.typingEl = null;
}

/* --------------------------------------------------------------- welcome */

function greet() {
  const name = state.config?.business.name ?? 'us';
  const card = element('div', 'welcome');
  card.append(
    element('h2', null, `Hi — book with ${name} in a few taps`),
    element(
      'p',
      null,
      'I can see live availability, book you in, or move and cancel an appointment. Ask in your own words.'
    )
  );

  const actions = element('div', 'welcome-actions');
  const services = (state.config?.services ?? []).slice(0, 3);
  const shortcuts = [
    ...services.map((service) => ({
      label: `Book ${service.name}`,
      hint: `${service.durationMinutes} min`,
      say: `I would like a ${service.name}`
    })),
    { label: "This week's openings", hint: 'Live diary', say: 'What times are free this week?' }
  ].slice(0, 4);

  for (const shortcut of shortcuts) {
    const button = element('button');
    button.type = 'button';
    button.append(element('span', null, shortcut.label), element('small', null, shortcut.hint));
    button.addEventListener('click', () => send(shortcut.say));
    actions.append(button);
  }

  card.append(actions);
  logEl.append(card);
  scrollDown();
}

/* ----------------------------------------------------------- suggestions */

function defaultSuggestions() {
  const services = (state.config?.services ?? []).slice(0, 2);
  return [
    ...services.map((service) => ({
      label: `Book ${service.name.toLowerCase()}`,
      say: `I would like a ${service.name}`
    })),
    { label: "What's free this week?", say: 'What times are free this week?' },
    { label: 'Reschedule', say: 'I want to reschedule my appointment' },
    { label: 'Cancel a booking', say: 'I want to cancel my appointment' }
  ];
}

function setSuggestions(list, { times = false } = {}) {
  suggestionsEl.replaceChildren();
  const fromReply = Boolean(list?.length);
  const items = fromReply ? list : defaultSuggestions();
  const isTimeList = times && fromReply && items.some((item) => item.send);

  for (const item of items) {
    const say = item.send ?? item.say;
    if (!say) continue;
    const button = element('button', isTimeList ? 'time' : null, item.label ?? item.send);
    button.type = 'button';
    button.addEventListener('click', () => send(say));
    suggestionsEl.append(button);
  }
}

/* ------------------------------------------------------------------ voice */

function setupVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micEl = document.getElementById('mic');
  if (!SpeechRecognition || embedded || !micEl) return;

  const recognition = new SpeechRecognition();
  recognition.lang = state.config?.business.locale ?? navigator.language ?? 'en-GB';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  let listening = false;
  micEl.hidden = false;

  micEl.addEventListener('click', () => {
    if (listening) {
      recognition.stop();
      return;
    }
    try {
      recognition.start();
    } catch {
      toast('Microphone is not available');
    }
  });

  recognition.addEventListener('start', () => {
    listening = true;
    micEl.classList.add('listening');
    micEl.setAttribute('aria-pressed', 'true');
  });
  recognition.addEventListener('end', () => {
    listening = false;
    micEl.classList.remove('listening');
    micEl.removeAttribute('aria-pressed');
  });
  recognition.addEventListener('result', (event) => {
    const transcript = event.results?.[0]?.[0]?.transcript?.trim();
    if (!transcript) return;
    inputEl.value = transcript;
    send(transcript);
  });
  recognition.addEventListener('error', (event) => {
    listening = false;
    micEl.classList.remove('listening');
    if (event.error === 'not-allowed') toast('Microphone permission is blocked');
    else if (event.error !== 'aborted') toast('Voice input did not work — please type');
  });
}

/* ---------------------------------------------------------- appointment */

function formatWhen(ms) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone(),
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  }).format(new Date(ms));
}

function buildIcs(appointment) {
  const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Appointment booking//EN',
    'BEGIN:VEVENT',
    `UID:${appointment.reference}@appointment-booking`,
    `DTSTAMP:${stamp(Date.now())}`,
    `DTSTART:${stamp(appointment.startMs)}`,
    `DTEND:${stamp(appointment.endMs ?? appointment.startMs + 30 * 60000)}`,
    `SUMMARY:${appointment.serviceName}`,
    `LOCATION:${appointment.location ?? ''}`,
    `DESCRIPTION:Reference ${appointment.reference}`,
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
}

function downloadIcs(appointment) {
  const blob = new Blob([buildIcs(appointment)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${appointment.reference}.ics`;
  link.click();
  URL.revokeObjectURL(url);
}

function showBooking(appointment) {
  bookingSlotEl.replaceChildren();
  const card = element('section', 'booking-card');

  const head = element('div', 'bc-head');
  head.append(
    element('div', 'bc-icon', '✓'),
    element('div', 'bc-title', 'Appointment confirmed'),
    element('div', `bc-badge${appointment.status === 'cancelled' ? ' cancelled' : ''}`, appointment.status ?? 'confirmed')
  );

  const timeline = element('div', 'bc-timeline');
  const steps = [
    ['Confirmed', true],
    ['Reminder set', true],
    [formatWhen(appointment.startMs).split(' at ')[0], false]
  ];
  for (const [label, done] of steps) {
    timeline.append(element('div', `bc-step${done ? ' done' : ''}`, label));
  }

  const grid = element('dl', 'bc-grid');
  const rows = [
    ['Service', appointment.serviceName, null],
    ['When', formatWhen(appointment.startMs), null],
    ['Reference', appointment.reference, 'ref'],
    ['Where', appointment.location ?? state.config?.business.location ?? '', null]
  ];
  for (const [label, value, extra] of rows) {
    if (!value) continue;
    grid.append(element('dt', null, label), element('dd', extra, value));
  }

  const actions = element('div', 'bc-actions');
  const copy = element('button', null, 'Copy reference');
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(appointment.reference);
      toast('Reference copied');
    } catch {
      toast(appointment.reference);
    }
  });

  const ics = element('button', null, 'Add to calendar');
  ics.type = 'button';
  ics.addEventListener('click', () => downloadIcs(appointment));

  const manage = element('button', null, 'Manage booking');
  manage.type = 'button';
  manage.addEventListener('click', () => {
    inputEl.value = `Reschedule ${appointment.reference}`;
    inputEl.focus();
    setSuggestions([
      { label: 'Move it earlier', say: `Reschedule ${appointment.reference} to next Tuesday at 10am` },
      { label: 'Cancel instead', say: `Cancel ${appointment.reference}` }
    ]);
  });

  actions.append(copy, ics, manage);

  if ('Notification' in window && Notification.permission === 'default') {
    const alerts = element('button', null, 'Enable alerts');
    alerts.type = 'button';
    alerts.addEventListener('click', async () => {
      const permission = await Notification.requestPermission();
      alerts.remove();
      toast(permission === 'granted' ? 'Alerts on for this device' : 'Alerts stay off');
    });
    actions.append(alerts);
  }

  card.append(head, timeline, grid, actions);
  bookingSlotEl.append(card);
  scrollDown();
}

/* ------------------------------------------------------- live updates */

function notifyDevice(event) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const body = `${event.serviceName ?? 'Appointment'}${event.reference ? ` · ${event.reference}` : ''} is ${event.status}`;
  navigator.serviceWorker?.ready
    .then((registration) => registration.showNotification('Appointment updated', { body, icon: '/icon-192.png' }))
    .catch(() => {});
}

function connectEvents() {
  if (!state.conversationId || !('EventSource' in window)) return;
  if (state.stream) state.stream.close();
  const stream = new EventSource(`/api/events?conversationId=${encodeURIComponent(state.conversationId)}`);
  state.stream = stream;
  stream.addEventListener('appointment', (message) => {
    let event;
    try {
      event = JSON.parse(message.data);
    } catch {
      return;
    }
    const label = event.status === 'cancelled' ? 'cancelled' : event.status === 'rescheduled' ? 'moved' : 'confirmed';
    toast(`Appointment ${label}${event.reference ? ` · ${event.reference}` : ''}`);
    notifyDevice(event);
    if (event.status === 'cancelled') {
      bookingSlotEl.replaceChildren();
      addMessage('note', `Your appointment ${event.reference ?? ''} was cancelled by the clinic.`.trim());
    }
  });
}

/* ------------------------------------------------------------------ send */

let lastMessage = '';

async function send(text) {
  if (state.busy) return;
  const message = String(text ?? '').trim();
  if (!message) return;

  lastMessage = message;
  state.busy = true;
  sendEl.disabled = true;
  addMessage('user', message);
  showTyping();
  suggestionsEl.replaceChildren();

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: state.conversationId, message, channel: 'web-chat' })
    });
    const payload = await response.json().catch(() => ({}));
    hideTyping();

    if (response.status === 404 && state.conversationId) {
      state.conversationId = null;
      sessionStorage.removeItem(STORAGE_KEY);
      state.busy = false;
      sendEl.disabled = false;
      return send(message);
    }

    if (!response.ok) {
      addMessage('note', payload.error?.message ?? 'That request failed.');
      setSuggestions([
        { label: 'Try again', say: lastMessage },
        { label: 'Talk to a human', say: 'I need to speak to someone' }
      ]);
      return;
    }

    state.conversationId = payload.conversationId;
    sessionStorage.setItem(STORAGE_KEY, payload.conversationId);
    addMessage('bot', payload.reply);

    if (payload.appointment?.status === 'cancelled') {
      bookingSlotEl.replaceChildren();
    } else if (payload.appointment) {
      showBooking(payload.appointment);
    }

    setSuggestions(payload.suggestions, { times: true });
    connectEvents();
  } catch {
    hideTyping();
    addMessage('note', 'Could not reach the booking service. Check your connection and try again.');
    setSuggestions([{ label: 'Try again', say: lastMessage }]);
  } finally {
    state.busy = false;
    sendEl.disabled = false;
    if (window.matchMedia('(pointer: fine)').matches) inputEl.focus();
  }
}

formEl.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = inputEl.value;
  inputEl.value = '';
  send(text);
});

document.getElementById('resetChat').addEventListener('click', () => {
  state.conversationId = null;
  state.stream?.close();
  state.stream = null;
  sessionStorage.removeItem(STORAGE_KEY);
  logEl.replaceChildren();
  bookingSlotEl.replaceChildren();
  greet();
  setSuggestions();
  toast('New conversation started');
});

/* ----------------------------------------------------------------- config */

async function loadConfig() {
  try {
    const response = await fetch('/api/config');
    if (!response.ok) throw new Error('config');
    const cfg = await response.json();
    state.config = cfg;

    document.getElementById('bizName').textContent = cfg.business.name;
    document.getElementById('bizLine').textContent = [cfg.business.location, cfg.business.timezone]
      .filter(Boolean)
      .join(' · ');
    document.getElementById('avatar').textContent = initials();

    const phone = document.getElementById('phone');
    phone.textContent = cfg.business.supportPhone || 'the clinic';
    phone.href = `tel:${String(cfg.business.supportPhone ?? '').replace(/\s/g, '')}`;

    const services = document.getElementById('services');
    services.replaceChildren();
    for (const service of cfg.services) {
      const item = document.createElement('li');
      const name = document.createElement('strong');
      name.textContent = service.name;
      const duration = document.createElement('em');
      duration.textContent = service.price ? `${service.durationMinutes} min · ${service.price}` : `${service.durationMinutes} min`;
      name.append(duration);
      item.append(name);
      if (service.description) item.append(element('span', null, service.description));
      services.append(item);
    }

    document.getElementById('instructions').textContent =
      cfg.business.bookingInstructions ?? 'Please arrive a few minutes early.';

    setStatus(cfg.ai?.enabled ? 'AI assistant' : 'online');
    if (window.innerWidth < 620) inputEl.placeholder = 'Type a message';
  } catch {
    setStatus('offline', false);
    document.getElementById('bizLine').textContent = 'Booking service unavailable right now.';
  }
}

await loadConfig();
setupVoice();
greet();
setSuggestions();
connectEvents();
if (window.matchMedia('(pointer: fine)').matches) inputEl.focus();
