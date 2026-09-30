// On-screen log so errors on the iPhone can be seen without a Mac.
// Wraps console.* and catches uncaught errors.

const MAX_LINES = 300;
const lines = [];
let panel = null;
let renderQueued = false;

function format(arg) {
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  if (arg && typeof arg === 'object') {
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

function render() {
  renderQueued = false;
  if (!panel) return;
  panel.textContent = lines.join('\n');
  panel.scrollTop = panel.scrollHeight;
}

export function log(level, ...args) {
  const t = (performance.now() / 1000).toFixed(2);
  lines.push(`${t}s ${level.toUpperCase()} ${args.map(format).join(' ')}`);
  if (lines.length > MAX_LINES) lines.shift();
  if (panel && !renderQueued) {
    renderQueued = true;
    requestAnimationFrame(render);
  }
}

export function installDebugLog(el) {
  panel = el;
  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      log(level, ...args);
    };
  }
  window.addEventListener('error', (e) => log('error', e.message, `${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => log('error', 'Unhandled:', e.reason));
}

export function getLogLines() {
  return lines.slice();
}
