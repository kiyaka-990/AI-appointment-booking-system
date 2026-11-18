const $ = (id) => document.getElementById(id);
const toastEl = $('toast');

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

const state = {
  config: null,
  timeZone: 'Europe/London',
  user: 'staff',
  appointments: [],
  filter: 'upcoming',
  search: '',
  selected: null,
  customers: [],
  customerSearch: '',
  notifications: [],
  notifyFilter: 'pending',
  waitlist: [],
  waitFilter: 'waiting',
  chosenStart: null,
  view: 'appointments'
};

/* ------------------------------------------------------------------ helpers */

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

/* ------------------------------------------------------------ staff live feed */

let staffSource = null;
let liveFailures = 0;
let refreshTimer = null;

function setLiveState(status) {
  const chip = $('liveChip');
  const text = $('liveText');
  if (!chip || !text) return;
  chip.classList.remove('live', 'retrying', 'offline');
  if (status === 'live') {
    chip.classList.add('live');
    text.textContent = 'Live';
  } else if (status === 'retrying') {
    chip.classList.add('retrying');
    text.textContent = 'Reconnecting';
  } else {
    chip.classList.add('offline');
    text.textContent = 'Offline';
  }
}

function describeStaffEvent(event) {
  const action =
    { created: 'New booking', cancelled: 'Booking cancelled', rescheduled: 'Booking moved' }[event.action] ??
    'Booking updated';
  const who = event.customerName ? `${event.customerName} · ` : '';
  const service = event.serviceName ?? 'Appointment';
  const when = event.startMs ? ` · ${fmtDate(event.startMs)} ${fmtTime(event.startMs)}` : '';
  return `${action}: ${who}${service}${when}`;
}

function scheduleLiveRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (state.view === 'appointments') loadAppointments().catch(() => {});
    if (state.view === 'waitlist') loadWaitlist().catch(() => {});
    if (state.view === 'messages') loadNotifications().catch(() => {});
    loadQueueCount();
  }, 250);
}

function handleStaffEvent(event) {
  const chip = $('liveChip');
  if (chip) {
    chip.classList.add('flash');
    clearTimeout(handleStaffEvent._flash);
    handleStaffEvent._flash = setTimeout(() => chip.classList.remove('flash'), 1200);
  }
  toast(describeStaffEvent(event));
  if (event.action === 'created') chime();
  scheduleLiveRefresh();
}

function setupLiveUpdates() {
  if (!('EventSource' in window)) {
    setLiveState('offline');
    return;
  }
  staffSource = new EventSource('/api/events?scope=staff');
  staffSource.addEventListener('open', () => {
    liveFailures = 0;
    setLiveState('live');
  });
  staffSource.addEventListener('booking', (message) => {
    let event;
    try {
      event = JSON.parse(message.data);
    } catch {
      return;
    }
    handleStaffEvent(event);
  });
  staffSource.addEventListener('error', async () => {
    liveFailures += 1;
    setLiveState(liveFailures > 2 ? 'offline' : 'retrying');
    if (liveFailures === 3) {
      try {
        const response = await fetch('/api/auth/session');
        const session = await response.json().catch(() => ({}));
        if (response.ok && session.authenticated === false) window.location.replace('/login');
      } catch {
        // Keep reconnecting; the stream handles its own retry.
      }
    }
  });
}

/* --------------------------------------------------------------- alert sound */

let soundEnabled = true;
let audioCtx = null;

function primeAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  } catch {
    // Audio is a nicety; never break the dashboard for it.
  }
}

function chime() {
  if (!soundEnabled) return;
  primeAudio();
  if (!audioCtx) return;
  try {
    const start = audioCtx.currentTime;
    for (const [frequency, delay] of [
      [880, 0],
      [1320, 0.14]
    ]) {
      const oscillator = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start + delay);
      gain.gain.exponentialRampToValueAtTime(0.16, start + delay + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + delay + 0.34);
      oscillator.connect(gain).connect(audioCtx.destination);
      oscillator.start(start + delay);
      oscillator.stop(start + delay + 0.4);
    }
  } catch {
    // Autoplay policy or a closed device: skip the sound.
  }
}

document.addEventListener('pointerdown', primeAudio, { once: true });
document.addEventListener('keydown', primeAudio, { once: true });

/* ---------------------------------------------------------- cancel booking */

let pendingCancel = null;

function openCancelDialog(appointment, customer) {
  pendingCancel = { reference: appointment.reference };
  $('cancelSummary').textContent = [
    customer?.full_name,
    appointment.serviceName,
    `${fmtDate(appointment.startMs)} at ${fmtTime(appointment.startMs)}`,
    appointment.reference
  ]
    .filter(Boolean)
    .join(' · ');
  $('cancelReason').value = 'Cancelled by staff';
  for (const chip of $('cancelReasons').querySelectorAll('button')) {
    chip.classList.toggle('active', chip.dataset.reason === 'Cancelled by staff');
  }
  $('cancelError').hidden = true;
  $('cancelConfirm').disabled = false;
  $('cancelConfirm').textContent = 'Cancel booking';
  $('cancelDismiss').disabled = false;
  $('cancelDialog').showModal();
  $('cancelDismiss').focus();
}

async function submitCancel(event) {
  event.preventDefault();
  if (!pendingCancel) return;
  const reference = pendingCancel.reference;
  const reason = $('cancelReason').value.trim() || 'Cancelled by staff';
  const confirm = $('cancelConfirm');
  const dismiss = $('cancelDismiss');

  $('cancelError').hidden = true;
  confirm.disabled = true;
  dismiss.disabled = true;
  confirm.textContent = 'Cancelling...';
  $('cancelDialog').setAttribute('aria-busy', 'true');
  try {
    await api(`/api/appointments/${encodeURIComponent(reference)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason })
    });
    $('cancelDialog').close();
    toast('Booking cancelled. The customer has been emailed.');
    await loadAppointments();
    await loadQueueCount();
    await selectAppointment(reference);
  } catch (error) {
    $('cancelError').textContent = error.message;
    $('cancelError').hidden = false;
  } finally {
    $('cancelDialog').removeAttribute('aria-busy');
    confirm.disabled = false;
    dismiss.disabled = false;
    confirm.textContent = 'Cancel booking';
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options
  });
  if (response.status === 401) {
    window.location.replace('/login');
    throw new Error('Sign-in required');
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message ?? `Request failed (${response.status})`);
  return payload;
}

function el(tag, className = null, text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const fmtDate = (ms) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: state.timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric'
  }).format(new Date(ms));
const fmtTime = (ms) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: state.timeZone, hour: '2-digit', minute: '2-digit', hour12: true
  }).format(new Date(ms));
const fmtStamp = (iso) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: state.timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true
  }).format(new Date(iso));
const isoDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: state.timeZone }).format(new Date(ms));

function pill(status) {
  return el('span', `pill ${status}`, status);
}

/* ------------------------------------------------------------- appointments */

function visibleAppointments() {
  const now = Date.now();
  const today = isoDay(now);
  const search = state.search.trim().toLowerCase();
  let rows = state.appointments;

  if (state.filter === 'today') {
    rows = rows.filter((a) => a.status !== 'cancelled' && isoDay(a.startMs) === today);
  } else if (state.filter === 'upcoming') {
    rows = rows.filter((a) => a.status !== 'cancelled' && a.startMs >= now - 60 * 60 * 1000);
  } else if (state.filter === 'cancelled') {
    rows = rows.filter((a) => a.status === 'cancelled');
  }

  if (search) {
    rows = rows.filter((a) =>
      [a.reference, a.serviceName, a.customer?.fullName, a.customer?.email, a.customer?.phone]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(search)
    );
  }
  return rows;
}

function renderStats() {
  const now = Date.now();
  const today = isoDay(now);
  $('statToday').textContent = state.appointments.filter(
    (a) => a.status !== 'cancelled' && isoDay(a.startMs) === today
  ).length;
  $('statUpcoming').textContent = state.appointments.filter(
    (a) => a.status !== 'cancelled' && a.startMs >= now
  ).length;
  $('statCancelled').textContent = state.appointments.filter((a) => a.status === 'cancelled').length;
}

function renderList() {
  const rows = visibleAppointments();
  const list = $('list');
  $('listCount').textContent = `${rows.length} shown`;

  if (!rows.length) {
    list.replaceChildren(el('div', 'empty', 'Nothing here yet.'));
    return;
  }

  const table = el('table');
  const thead = el('thead');
  const headRow = el('tr');
  for (const label of ['When', 'Customer', 'Service', 'Reference', 'Status']) {
    headRow.append(el('th', null, label));
  }
  thead.append(headRow);

  const tbody = el('tbody');
  for (const appointment of rows) {
    const tr = el('tr');
    if (appointment.reference === state.selected) tr.classList.add('selected');

    const when = el('td');
    when.append(el('div', 'cell-main', fmtDate(appointment.startMs)));
    when.append(el('div', 'cell-sub', fmtTime(appointment.startMs)));

    const customer = el('td');
    customer.append(el('div', 'cell-main', appointment.customer?.fullName ?? 'Unknown'));
    customer.append(el('div', 'cell-sub', appointment.customer?.email ?? appointment.customer?.phone ?? ''));

    const service = el('td', 'cell-main', appointment.serviceName);
    const reference = el('td', 'mono', appointment.reference);
    const status = el('td');
    status.append(pill(appointment.status));

    tr.append(when, customer, service, reference, status);
    tr.addEventListener('click', () => selectAppointment(appointment.reference));
    tbody.append(tr);
  }

  table.append(thead, tbody);
  const wrap = el('div', 'table-wrap');
  wrap.append(table);
  list.replaceChildren(wrap);
}

async function loadAppointments() {
  const payload = await api('/api/appointments?limit=500');
  state.appointments = payload.appointments;
  renderList();
  renderStats();
}

/* ------------------------------------------------------------------- detail */

function detailBody() {
  return $('detail').querySelector('.body');
}

function renderDetailShell(appointment, customer) {
  const body = detailBody();
  body.replaceChildren();

  const title = el('h3');
  title.append(el('span', null, appointment.serviceName));
  title.append(pill(appointment.status));
  body.append(title);

  const list = el('dl');
  const rows = [
    ['Reference', appointment.reference],
    ['When', `${fmtDate(appointment.startMs)} at ${fmtTime(appointment.startMs)}`],
    ['Customer', customer?.full_name ?? 'Unknown'],
    ['Email', customer?.email ?? '-'],
    ['Phone', customer?.phone ?? '-'],
    ['Notes', appointment.notes ?? '-'],
    ['Booked via', appointment.source ?? '-']
  ];
  for (const [label, value] of rows) {
    list.append(el('dt', null, label));
    list.append(el('dd', label === 'Reference' ? 'mono' : null, value));
  }
  body.append(list);
  return body;
}

async function selectAppointment(reference) {
  state.selected = reference;
  renderList();
  detailBody().replaceChildren(el('p', 'muted', 'Loading...'));

  try {
    const { appointment, customer, events, notifications } = await api(
      `/api/appointments/${encodeURIComponent(reference)}`
    );
    const body = renderDetailShell(appointment, customer);
    const active = appointment.status === 'confirmed' || appointment.status === 'pending';

    if (active) {
      const reschedule = el('div');
      reschedule.append(el('h4', null, 'Move this booking'));
      const controls = el('div', 'actions');
      const dateInput = document.createElement('input');
      dateInput.type = 'date';
      dateInput.value = isoDay(appointment.startMs);
      dateInput.setAttribute('aria-label', 'New date');
      const moveButton = el('button', null, 'Move booking');
      moveButton.disabled = true;
      controls.append(dateInput, moveButton);
      const slots = el('div', 'slots');
      reschedule.append(controls, slots);

      const cancelButton = el('button', 'danger', 'Cancel booking');
      cancelButton.addEventListener('click', () => openCancelDialog(appointment, customer));

      let chosen = null;
      const paintSlots = async (dateIso) => {
        chosen = null;
        moveButton.disabled = true;
        slots.replaceChildren(el('span', 'muted small', 'Loading times...'));
        try {
          const data = await api(
            `/api/admin/slots?service=${encodeURIComponent(appointment.serviceId)}&date=${encodeURIComponent(dateIso)}`
          );
          slots.replaceChildren();
          if (!data.slots.length) {
            slots.append(el('span', 'muted small', 'No openings on that day.'));
            return;
          }
          for (const slot of data.slots) {
            const button = el('button', null, fmtTime(slot.startMs));
            button.type = 'button';
            button.addEventListener('click', () => {
              chosen = slot.start;
              for (const other of slots.querySelectorAll('button')) other.classList.remove('chosen');
              button.classList.add('chosen');
              moveButton.disabled = false;
            });
            slots.append(button);
          }
        } catch (error) {
          slots.replaceChildren(el('span', 'muted small', error.message));
        }
      };

      dateInput.addEventListener('change', () => paintSlots(dateInput.value));
      moveButton.addEventListener('click', async () => {
        if (!chosen) return;
        try {
          await api(`/api/appointments/${encodeURIComponent(reference)}/reschedule`, {
            method: 'POST',
            body: JSON.stringify({ start: chosen })
          });
          toast('Appointment moved');
          await loadAppointments();
          await selectAppointment(reference);
        } catch (error) {
          toast(error.message);
        }
      });

      body.append(reschedule, cancelButton);
      await paintSlots(dateInput.value);
    }

    if (events?.length) {
      body.append(el('h4', null, 'History'));
      const timeline = el('ul', 'timeline');
      for (const event of events) {
        const item = el('li');
        item.append(el('strong', null, event.type));
        item.append(document.createTextNode(` · ${fmtStamp(event.created_at)}${event.actor ? ` · ${event.actor}` : ''}`));
        timeline.append(item);
      }
      body.append(timeline);
    }

    if (notifications?.length) {
      body.append(el('h4', null, 'Messages'));
      const list = el('ul', 'notif-list');
      for (const row of notifications) {
        const item = el('li', row.status);
        const text = el('div');
        text.append(el('div', 'cell-main', row.template));
        text.append(el('div', 'cell-sub', `${row.recipient ?? 'no recipient'} · ${fmtStamp(row.scheduled_for)}`));
        item.append(text, pill(row.status));
        list.append(item);
      }
      body.append(list);
    }
  } catch (error) {
    detailBody().replaceChildren(el('p', 'muted', error.message));
  }
}

/* ----------------------------------------------------------------- customers */

function renderCustomers() {
  const list = $('customerList');
  $('customerCount').textContent = `${state.customers.length} shown`;
  if (!state.customers.length) {
    list.replaceChildren(el('p', 'muted', 'No customers match that search.'));
    return;
  }
  list.replaceChildren();
  for (const customer of state.customers) {
    const button = el('button', 'customer');
    button.type = 'button';
    button.append(el('strong', null, customer.full_name));
    button.append(el('span', null, `${customer.email ?? customer.phone ?? 'no contact'} · ${customer.active_bookings ?? 0} upcoming`));
    button.addEventListener('click', () => selectCustomer(customer.id));
    list.append(button);
  }
}

async function loadCustomers() {
  const payload = await api(`/api/customers?search=${encodeURIComponent(state.customerSearch)}`);
  state.customers = payload.customers;
  renderCustomers();
}

async function selectCustomer(id) {
  const body = $('customerDetail').querySelector('.body');
  body.replaceChildren(el('p', 'muted', 'Loading...'));
  try {
    const { customer, appointments, conversations } = await api(`/api/customers/${encodeURIComponent(id)}`);
    body.replaceChildren();
    body.append(el('h3', null, customer.full_name));
    const details = el('dl');
    for (const [label, value] of [
      ['Email', customer.email ?? '-'],
      ['Phone', customer.phone ?? '-'],
      ['Source', customer.source ?? '-'],
      ['Notes', customer.notes ?? '-']
    ]) {
      details.append(el('dt', null, label));
      details.append(el('dd', null, value));
    }
    body.append(details);

    body.append(el('h4', null, 'Appointments'));
    if (!appointments.length) {
      body.append(el('p', 'muted small', 'No appointments yet.'));
    } else {
      const list = el('ul', 'timeline');
      for (const appointment of appointments) {
        const item = el('li');
        item.append(el('strong', null, appointment.service_name));
        item.append(document.createTextNode(` · ${fmtDate(Number(appointment.start_ms))} ${fmtTime(Number(appointment.start_ms))} · ${appointment.status}`));
        list.append(item);
      }
      body.append(list);
    }

    if (conversations?.length) {
      body.append(el('h4', null, 'Conversations'));
      const list = el('ul', 'timeline');
      for (const conversation of conversations) {
        const item = el('li');
        item.append(el('strong', null, conversation.channel));
        item.append(document.createTextNode(` · ${conversation.status} · ${fmtStamp(conversation.updated_at)}`));
        if (conversation.summary) item.append(document.createTextNode(` — ${conversation.summary}`));
        list.append(item);
      }
      body.append(list);
    }
  } catch (error) {
    body.replaceChildren(el('p', 'muted', error.message));
  }
}

/* ------------------------------------------------------------------ messages */

async function loadNotifications() {
  const query = state.notifyFilter === 'all' ? '' : `?status=${encodeURIComponent(state.notifyFilter)}`;
  const payload = await api(`/api/notifications${query}${query ? '&' : '?'}limit=200`);
  state.notifications = payload.notifications;
  renderNotifications();
}

function renderNotifications() {
  const list = $('notifList');
  if (!state.notifications.length) {
    list.replaceChildren(el('p', 'muted', 'Nothing queued in this view.'));
    return;
  }
  list.replaceChildren();
  for (const row of state.notifications) {
    const item = el('li', row.status);
    const text = el('div');
    text.append(el('div', 'cell-main', `${row.template} · ${row.reference ?? 'no booking'}`));
    text.append(
      el('div', 'cell-sub', `${row.recipient ?? 'no recipient'} · ${row.status} · ${fmtStamp(row.scheduled_for)}`)
    );
    if (row.last_error) text.append(el('div', 'cell-sub', row.last_error));
    item.append(text);

    if (row.status === 'pending' || row.status === 'failed') {
      const retry = el('button', null, 'Retry');
      retry.type = 'button';
      retry.addEventListener('click', async () => {
        try {
          await api(`/api/notifications/${row.id}/retry`, { method: 'POST' });
          toast('Delivery retried');
          await loadNotifications();
          await loadQueueCount();
        } catch (error) {
          toast(error.message);
        }
      });
      item.append(retry);
    } else {
      item.append(pill(row.status));
    }
    list.append(item);
  }
}

async function loadQueueCount() {
  try {
    const payload = await api('/api/notifications?status=pending&limit=200');
    $('statQueue').textContent = payload.notifications.length;
  } catch {
    $('statQueue').textContent = '-';
  }
}

/* ------------------------------------------------------------------ waitlist */

async function loadWaitlist() {
  const query = state.waitFilter === 'all' ? '' : `?status=${encodeURIComponent(state.waitFilter)}`;
  const payload = await api(`/api/waitlist${query}`);
  state.waitlist = payload.entries;
  renderWaitlist();
}

function waitWindow(entry) {
  const from = entry.from_ms ? fmtDate(entry.from_ms) : null;
  const to = entry.to_ms ? fmtDate(entry.to_ms) : null;
  if (from && to) return `${from} to ${to}`;
  if (from) return `from ${from}`;
  if (to) return `until ${to}`;
  return 'any time';
}

function renderWaitlist() {
  const list = $('waitlistList');
  $('waitlistCount').textContent = `${state.waitlist.length} shown`;
  $('statWaitlist').textContent = state.waitlist.filter((entry) => entry.status === 'waiting').length;

  if (!state.waitlist.length) {
    list.replaceChildren(el('p', 'muted', 'Nobody is waiting right now.'));
    return;
  }

  list.replaceChildren();
  for (const entry of state.waitlist) {
    const item = el('li', entry.status === 'notified' ? 'pending' : entry.status);
    const text = el('div');
    text.append(el('div', 'cell-main', `${entry.full_name} · ${entry.service_name ?? 'any service'}`));
    text.append(
      el(
        'div',
        'cell-sub',
        `${[entry.email, entry.phone].filter(Boolean).join(' · ') || 'no contact'} · ${waitWindow(entry)} · ${entry.status}`
      )
    );
    item.append(text);

    if (entry.status === 'waiting') {
      const remove = el('button', null, 'Remove');
      remove.type = 'button';
      remove.addEventListener('click', async () => {
        try {
          await api(`/api/waitlist/${entry.id}`, { method: 'DELETE' });
          toast('Removed from the waiting list');
          await loadWaitlist();
        } catch (error) {
          toast(error.message);
        }
      });
      item.append(remove);
    } else {
      item.append(pill(entry.status));
    }
    list.append(item);
  }
}

/* ---------------------------------------------------------------- new booking */

function openBookingDialog() {
  const dialog = $('bookingDialog');
  $('bookingError').hidden = true;
  state.chosenStart = null;
  $('bDate').value = state.config ? isoDay(Date.now() + 24 * 60 * 60 * 1000) : '';
  $('bSlots').replaceChildren(el('span', 'muted small', 'Choose a date to see openings.'));
  dialog.showModal();
  $('bName').focus();
  loadBookingSlots();
}

async function loadBookingSlots() {
  const serviceId = $('bService').value;
  const date = $('bDate').value;
  const container = $('bSlots');
  state.chosenStart = null;
  if (!serviceId || !date) {
    container.replaceChildren(el('span', 'muted small', 'Choose a service and date first.'));
    return;
  }
  container.replaceChildren(el('span', 'muted small', 'Loading times...'));
  try {
    const data = await api(
      `/api/admin/slots?service=${encodeURIComponent(serviceId)}&date=${encodeURIComponent(date)}`
    );
    container.replaceChildren();
    if (!data.slots.length) {
      container.append(el('span', 'muted small', 'No openings that day. Try another date.'));
      return;
    }
    for (const slot of data.slots) {
      const button = el('button', null, fmtTime(slot.startMs));
      button.type = 'button';
      button.addEventListener('click', () => {
        state.chosenStart = slot.start;
        for (const other of container.querySelectorAll('button')) other.classList.remove('chosen');
        button.classList.add('chosen');
      });
      container.append(button);
    }
  } catch (error) {
    container.replaceChildren(el('span', 'muted small', error.message));
  }
}

async function submitBooking(event) {
  event.preventDefault();
  const errorEl = $('bookingError');
  errorEl.hidden = true;
  if (!state.chosenStart) {
    errorEl.textContent = 'Choose an available time first.';
    errorEl.hidden = false;
    return;
  }
  const button = $('bookingSubmit');
  button.disabled = true;
  try {
    const payload = await api('/api/admin/bookings', {
      method: 'POST',
      body: JSON.stringify({
        name: $('bName').value.trim(),
        email: $('bEmail').value.trim(),
        phone: $('bPhone').value.trim(),
        service: $('bService').value,
        start: state.chosenStart,
        notes: $('bNotes').value.trim() || null
      })
    });
    $('bookingDialog').close();
    $('bookingForm').reset();
    toast(`Booked ${payload.appointment.reference}`);
    await loadAppointments();
    await loadQueueCount();
    await selectAppointment(payload.appointment.reference);
  } catch (error) {
    errorEl.textContent = error.message;
    errorEl.hidden = false;
  } finally {
    button.disabled = false;
  }
}

/* --------------------------------------------------------------------- chrome */

function switchView(view) {
  state.view = view;
  for (const section of ['appointments', 'customers', 'messages', 'waitlist']) {
    $(`view-${section}`).hidden = section !== view;
  }
  for (const button of $('tabs').querySelectorAll('button')) {
    button.classList.toggle('active', button.dataset.view === view);
  }
  if (view === 'customers' && !state.customers.length) loadCustomers().catch((error) => toast(error.message));
  if (view === 'messages') loadNotifications().catch((error) => toast(error.message));
  if (view === 'waitlist') loadWaitlist().catch((error) => toast(error.message));
}

async function boot() {
  const session = await api('/api/auth/session');
  if (!session.authenticated) {
    window.location.replace('/login');
    return;
  }
  state.user = session.user;
  $('userName').textContent = session.user;

  state.config = await api('/api/config');
  state.timeZone = state.config.business.timezone;
  $('bizLine').textContent = `${state.config.business.name} · ${state.timeZone}`;
  $('avatar').textContent = state.config.business.name
    .split(/\s+/)
    .filter((word) => /^[A-Za-z]/.test(word))
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join('');

  const serviceSelect = $('bService');
  serviceSelect.replaceChildren();
  for (const service of state.config.services) {
    const option = document.createElement('option');
    option.value = service.id;
    option.textContent = `${service.name} (${service.durationMinutes} min)`;
    serviceSelect.append(option);
  }

  $('tabs').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-view]');
    if (button) switchView(button.dataset.view);
  });

  $('search').addEventListener('input', (event) => {
    state.search = event.target.value;
    renderList();
  });

  for (const button of document.querySelectorAll('[data-filter]')) {
    button.addEventListener('click', () => {
      state.filter = button.dataset.filter;
      for (const other of document.querySelectorAll('[data-filter]')) {
        other.classList.toggle('active', other === button);
      }
      renderList();
    });
  }

  for (const button of document.querySelectorAll('[data-notify]')) {
    button.addEventListener('click', () => {
      state.notifyFilter = button.dataset.notify;
      for (const other of document.querySelectorAll('[data-notify]')) {
        other.classList.toggle('active', other === button);
      }
      loadNotifications().catch((error) => toast(error.message));
    });
  }

  for (const button of document.querySelectorAll('[data-wait]')) {
    button.addEventListener('click', () => {
      state.waitFilter = button.dataset.wait;
      for (const other of document.querySelectorAll('[data-wait]')) {
        other.classList.toggle('active', other === button);
      }
      loadWaitlist().catch((error) => toast(error.message));
    });
  }
  $('refreshWaitlist').addEventListener('click', () => loadWaitlist().catch((error) => toast(error.message)));

  $('newBooking').addEventListener('click', openBookingDialog);
  $('bookingCancel').addEventListener('click', () => $('bookingDialog').close());
  $('bookingForm').addEventListener('submit', submitBooking);
  $('bService').addEventListener('change', loadBookingSlots);
  $('bDate').addEventListener('change', loadBookingSlots);

  $('cancelDismiss').addEventListener('click', () => $('cancelDialog').close());
  $('cancelForm').addEventListener('submit', submitCancel);
  $('cancelDialog').addEventListener('close', () => {
    pendingCancel = null;
  });
  $('cancelDialog').addEventListener('click', (event) => {
    if (event.target === $('cancelDialog')) $('cancelDialog').close();
  });
  for (const chip of $('cancelReasons').querySelectorAll('button')) {
    chip.addEventListener('click', () => {
      $('cancelReason').value = chip.dataset.reason;
      for (const other of $('cancelReasons').querySelectorAll('button')) {
        other.classList.toggle('active', other === chip);
      }
      $('cancelReason').focus();
    });
  }
  $('cancelReason').addEventListener('input', () => {
    for (const chip of $('cancelReasons').querySelectorAll('button')) chip.classList.remove('active');
  });

  $('soundToggle').addEventListener('click', () => {
    soundEnabled = !soundEnabled;
    $('soundToggle').setAttribute('aria-pressed', String(soundEnabled));
    $('soundToggle').textContent = soundEnabled ? 'Sound on' : 'Sound off';
    toast(soundEnabled ? 'New-booking sound on' : 'New-booking sound muted');
  });

  $('customerSearch').addEventListener('input', (event) => {
    state.customerSearch = event.target.value;
    loadCustomers().catch((error) => toast(error.message));
  });
  $('refreshCustomers').addEventListener('click', () => loadCustomers().catch((error) => toast(error.message)));

  $('processQueue').addEventListener('click', async () => {
    try {
      const result = await api('/api/notifications/process', { method: 'POST' });
      toast(`Processed ${result.processed} due message(s)`);
      await loadNotifications();
      await loadQueueCount();
    } catch (error) {
      toast(error.message);
    }
  });

  $('logout').addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } finally {
      window.location.replace('/login');
    }
  });

  await loadAppointments();
  await loadQueueCount();
  loadWaitlist().catch(() => {});
  setupLiveUpdates();
  setInterval(() => {
    if (state.view === 'appointments') loadAppointments().catch(() => {});
    if (state.view === 'waitlist') loadWaitlist().catch(() => {});
    loadQueueCount();
  }, 30000);
}

boot().catch((error) => {
  detailBody().replaceChildren(el('p', 'muted', error.message));
});
