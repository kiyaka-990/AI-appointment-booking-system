/**
 * Tiny in-process pub/sub used to push booking updates to an open chat window
 * (server-sent events). It carries no customer data: only status, reference and
 * the appointment time, so a listen-only stream cannot leak personal details.
 */
const listeners = new Map();

export function subscribe(conversationId, handler) {
  if (!conversationId) return () => {};
  const set = listeners.get(conversationId) ?? new Set();
  set.add(handler);
  listeners.set(conversationId, set);
  return () => {
    set.delete(handler);
    if (!set.size) listeners.delete(conversationId);
  };
}

export function publish(conversationId, event) {
  if (!conversationId) return 0;
  const set = listeners.get(conversationId);
  if (!set?.size) return 0;
  let delivered = 0;
  for (const handler of [...set]) {
    try {
      handler(event);
      delivered += 1;
    } catch {
      // A broken listener must never fail a booking.
    }
  }
  return delivered;
}

export function appointmentEvent(appointment, status) {
  return {
    type: 'appointment',
    status,
    reference: appointment?.reference ?? null,
    startMs: appointment?.startMs ?? null,
    serviceName: appointment?.serviceName ?? null
  };
}

export function listenerCount(conversationId) {
  return listeners.get(conversationId)?.size ?? 0;
}
