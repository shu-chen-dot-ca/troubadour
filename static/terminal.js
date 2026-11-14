// The terminal: a shell on the computer (in tmux, server.py), drawn by xterm.js. Tap the terminal for the phone's
// keyboard. The row at the bottom has the keys a phone keyboard lacks: Esc, Tab, Ctrl and Alt (for the next key),
// Ctrl+C, the arrows, and a few characters that are hard to reach. A− and A+ change the text size.

const keysRow = document.getElementById("keys");
const ctrlButton = document.getElementById("ctrl");
const altButton = document.getElementById("alt");
const SEQUENCES = {
  Escape: "\x1b", Tab: "\t", CtrlC: "\x03",
  ArrowUp: "\x1b[A", ArrowDown: "\x1b[B", ArrowRight: "\x1b[C", ArrowLeft: "\x1b[D",
};

let fontSize = 14;
try {
  fontSize = Number(localStorage.getItem("terminalFontSize")) || 14;
} catch {}

const term = new Terminal({
  fontSize: fontSize,
  fontFamily: "ui-monospace, Menlo, 'DejaVu Sans Mono', monospace",
  cursorBlink: true,
  scrollback: 5000,
  theme: { background: "#0e1015", foreground: "#e6e6ea" },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById("terminal"));

let socket = null;
let retryTimer = null;
let ctrl = false;
let alt = false;

function send(message) {
  if (socket !== null && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function sendSize() {
  send({ type: "resize", rows: term.rows, cols: term.cols });
}

function connect() {
  clearTimeout(retryTimer);
  const scheme = location.protocol === "https:" ? "wss://" : "ws://";
  const mine = new WebSocket(scheme + location.host + "/desktop/terminal/socket");
  socket = mine;
  mine.binaryType = "arraybuffer";
  mine.onopen = sendSize;
  mine.onmessage = (event) => {
    if (typeof event.data === "string") {
      if (JSON.parse(event.data).type === "signed_out") {
        location.href = "/desktop/sign_in";
      }
      return;
    }
    term.write(new Uint8Array(event.data));
  };
  mine.onclose = () => {
    if (socket === mine) {
      connectionClosed();
    }
  };
}

async function connectionClosed() {
  socket = null;
  // Signed out, or only the connection lost?
  try {
    const response = await fetch("/desktop/session");
    if (response.status === 401) {
      location.href = "/desktop/sign_in";
      return;
    }
  } catch {}
  term.write("\r\n\x1b[2m[Connection lost. Connecting again…]\x1b[0m\r\n");
  if (!document.hidden) {
    retryTimer = setTimeout(connect, 2000);
  }
}

function showModifiers() {
  ctrlButton.classList.toggle("on", ctrl);
  altButton.classList.toggle("on", alt);
}

// What the phone's keyboard types, with the row's Ctrl and Alt on it.
term.onData((data) => {
  if (ctrl && data.length === 1) {
    const code = data.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) {
      data = String.fromCharCode(code - 64);
    } else if (data === " ") {
      data = "\x00";
    }
  }
  if (alt) {
    data = "\x1b" + data;
  }
  ctrl = false;
  alt = false;
  showModifiers();
  send({ type: "input", data: data });
});

term.onResize(sendSize);

// The row's buttons keep the phone's keyboard up: a tap on them doesn't take the focus from the terminal.
keysRow.addEventListener("pointerdown", (event) => {
  if (event.target.tagName === "BUTTON") {
    event.preventDefault();
  }
});

for (const button of document.querySelectorAll("[data-key]")) {
  button.onclick = () => {
    const key = button.dataset.key;
    let data = SEQUENCES[key] ?? key;
    if (alt) {
      data = "\x1b" + data;
    }
    ctrl = false;
    alt = false;
    showModifiers();
    send({ type: "input", data: data });
  };
}

ctrlButton.onclick = () => {
  ctrl = !ctrl;
  showModifiers();
};

altButton.onclick = () => {
  alt = !alt;
  showModifiers();
};

function setFontSize(size) {
  fontSize = Math.min(24, Math.max(9, size));
  term.options.fontSize = fontSize;
  fit.fit();
  try {
    localStorage.setItem("terminalFontSize", String(fontSize));
  } catch {}
}

document.getElementById("smaller").onclick = () => setFontSize(fontSize - 1);
document.getElementById("bigger").onclick = () => setFontSize(fontSize + 1);
document.getElementById("desktop").onclick = () => {
  location.href = "/desktop/";
};

// Safari zooms the whole page on a double tap: not here.
let lastTouchEnd = 0;
document.addEventListener("touchend", (event) => {
  const now = performance.now();
  if (now - lastTouchEnd < 400) {
    event.preventDefault();
  }
  lastTouchEnd = now;
}, { passive: false });
document.addEventListener("gesturestart", (event) => event.preventDefault());

// With the phone's keyboard up, the page shrinks to the space above it, and the terminal with it.
function fitViewport() {
  const viewport = window.visualViewport;
  document.body.style.height = viewport.height + "px";
  document.body.style.top = viewport.offsetTop + "px";
  document.body.classList.toggle("typing", viewport.height < window.innerHeight - 100);
  fit.fit();
}

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", fitViewport);
  window.visualViewport.addEventListener("scroll", fitViewport);
}
new ResizeObserver(() => fit.fit()).observe(document.getElementById("terminal"));

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && socket === null) {
    connect();
  }
});

fit.fit();
connect();
