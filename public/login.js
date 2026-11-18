if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

const formEl = document.getElementById('loginForm');
const errorEl = document.getElementById('loginError');
const buttonEl = document.getElementById('loginButton');

async function loadConfig() {
  try {
    const response = await fetch('/api/config');
    const cfg = await response.json();
    document.getElementById('bizLine').textContent = cfg.business.name;
    document.getElementById('avatar').textContent = cfg.business.name
      .split(/\s+/)
      .filter((word) => /^[A-Za-z]/.test(word))
      .slice(0, 2)
      .map((word) => word[0].toUpperCase())
      .join('');
  } catch {
    document.getElementById('bizLine').textContent = 'Appointment dashboard';
  }
}

formEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorEl.hidden = true;
  buttonEl.disabled = true;
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('username').value.trim(),
        password: document.getElementById('password').value
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      errorEl.textContent = payload.error?.message ?? 'Sign-in failed.';
      errorEl.hidden = false;
      return;
    }
    window.location.replace('/admin');
  } catch {
    errorEl.textContent = 'Could not reach the server. Please try again.';
    errorEl.hidden = false;
  } finally {
    buttonEl.disabled = false;
  }
});

loadConfig();
