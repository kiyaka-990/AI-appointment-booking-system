/**
 * Booking widget loader for a client's existing website.
 *
 *   <div id="booking-widget"></div>
 *   <script src="https://booking.client.com/embed.js" data-height="680" defer></script>
 *
 * Points data-src at the booking app if that origin differs from where this
 * script is served from. The app must list the embedding site in EMBED_ORIGINS,
 * otherwise the browser will refuse to render the frame.
 */
(function () {
  var script = document.currentScript;
  if (!script) return;

  var scriptUrl = new URL(script.src);
  var origin = script.dataset.src ? script.dataset.src.replace(/\/$/, '') : scriptUrl.origin;
  var target = script.dataset.target || '#booking-widget';
  var mount = document.querySelector(target);
  if (!mount) {
    if (window.console) console.warn('[booking-widget] no element matched ' + target);
    return;
  }

  var height = parseInt(script.dataset.height || '700', 10);
  if (!(height > 0)) height = 700;

  var frame = document.createElement('iframe');
  frame.src = origin + '/?embed=1';
  frame.title = 'Book an appointment';
  frame.loading = 'lazy';
  frame.setAttribute('allow', 'clipboard-write');
  frame.style.cssText = 'width:100%;border:0;display:block;height:' + height + 'px;';
  mount.appendChild(frame);

  window.addEventListener('message', function (event) {
    if (event.origin !== origin) return;
    var data = event.data || {};
    if (data.type !== 'booking-widget:height') return;
    var next = parseInt(data.height, 10);
    if (!(next > 0)) return;
    frame.style.height = Math.max(480, Math.min(next, 1200)) + 'px';
  });
})();
