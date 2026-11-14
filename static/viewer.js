// The viewer: draws the computer's screen from the websocket's JPEG frames, and sends touches, mouse and keys back
// (server.py has the messages). Positions go as parts of the screen, 0 to 1. Keys go as Linux key codes, like a real
// keyboard's (a US one), so they work as they would on a keyboard plugged into the computer.
//
// Trackpad (the default): the phone is a touchpad. One finger moves the pointer, a tap clicks, a tap and then a
// drag holds the button down, two fingers scroll, a two finger tap right clicks. Pinch to zoom in: the view then
// follows the pointer.
// Touch: the pointer goes where you touch. A tap clicks there, holding still right clicks, one finger drags, two
// fingers scroll, a two finger tap right clicks. Pinch to zoom in, and move both fingers to move around.
//
// Keyboard: like the iPhone's, in pages. Letters (with , and .), 123 (numbers and the common symbols), #+= (the
// other symbols) and Fn (F1-F12, Insert, Delete, Home, End, Page Up, Page Down, Caps Lock, Print Screen). Above
// them a strip that is always there: Esc, Tab, Ctrl, Alt, Super and the arrows.
// Shift, Ctrl and Alt: tap for the next key or click, tap twice to keep them on, or hold one while pressing another
// key. Super: tap for Activities, hold for Super+key.
// Phone keyboard: the iPhone's own keyboard instead, for typing text, with the strip (and Shift) above it.
// On a phone on its side the keyboard is a panel at the side, over the screen, and the screen's picture fits next to
// it. Drag its grip to make it wider or narrower, tap the grip to tuck it into the edge and back, ⇄ for the other side.

const canvas = document.getElementById("screen");
const context = canvas.getContext("2d");
const statusBox = document.getElementById("status");
const statusText = document.getElementById("status-text");
const reconnectButton = document.getElementById("reconnect");
const strip = document.getElementById("strip");
const keys = document.getElementById("keys");
const typing = document.getElementById("typing");
const keyboardButton = document.getElementById("keyboard-button");
const phoneButton = document.getElementById("phone-button");
const modeButton = document.getElementById("mode");
const qualitySelect = document.getElementById("quality");
const bottom = document.getElementById("bottom");
const showButton = document.getElementById("show");
const stage = document.getElementById("stage");
const panel = document.getElementById("panel");
const grip = document.getElementById("grip");
const swapButton = document.getElementById("swap");
// The same as the CSS's: a phone on its side.
const sideways = window.matchMedia("(orientation: landscape) and (max-height: 500px)");

// Linux key codes (linux/input-event-codes.h), by the browser's KeyboardEvent.code names.
const KEY_CODES = {
  Escape: 1, Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6, Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10,
  Digit0: 11, Minus: 12, Equal: 13, Backspace: 14, Tab: 15,
  KeyQ: 16, KeyW: 17, KeyE: 18, KeyR: 19, KeyT: 20, KeyY: 21, KeyU: 22, KeyI: 23, KeyO: 24, KeyP: 25,
  BracketLeft: 26, BracketRight: 27, Enter: 28, ControlLeft: 29,
  KeyA: 30, KeyS: 31, KeyD: 32, KeyF: 33, KeyG: 34, KeyH: 35, KeyJ: 36, KeyK: 37, KeyL: 38,
  Semicolon: 39, Quote: 40, Backquote: 41, ShiftLeft: 42, Backslash: 43,
  KeyZ: 44, KeyX: 45, KeyC: 46, KeyV: 47, KeyB: 48, KeyN: 49, KeyM: 50, Comma: 51, Period: 52, Slash: 53,
  ShiftRight: 54, NumpadMultiply: 55, AltLeft: 56, Space: 57, CapsLock: 58,
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68, NumLock: 69, ScrollLock: 70,
  Numpad7: 71, Numpad8: 72, Numpad9: 73, NumpadSubtract: 74, Numpad4: 75, Numpad5: 76, Numpad6: 77, NumpadAdd: 78,
  Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad0: 82, NumpadDecimal: 83, IntlBackslash: 86, F11: 87, F12: 88,
  NumpadEnter: 96, ControlRight: 97, NumpadDivide: 98, PrintScreen: 99, AltRight: 100,
  Home: 102, ArrowUp: 103, PageUp: 104, ArrowLeft: 105, ArrowRight: 106, End: 107, ArrowDown: 108, PageDown: 109,
  Insert: 110, Delete: 111, Pause: 119, MetaLeft: 125, MetaRight: 126, ContextMenu: 127,
};

// A US keyboard's characters: the key, what it types, and what it types with Shift.
const US_KEYS = [
  ["Backquote", "`", "~"], ["Digit1", "1", "!"], ["Digit2", "2", "@"], ["Digit3", "3", "#"], ["Digit4", "4", "$"],
  ["Digit5", "5", "%"], ["Digit6", "6", "^"], ["Digit7", "7", "&"], ["Digit8", "8", "*"], ["Digit9", "9", "("],
  ["Digit0", "0", ")"], ["Minus", "-", "_"], ["Equal", "=", "+"], ["BracketLeft", "[", "{"],
  ["BracketRight", "]", "}"], ["Backslash", "\\", "|"], ["Semicolon", ";", ":"], ["Quote", "'", '"'],
  ["Comma", ",", "<"], ["Period", ".", ">"], ["Slash", "/", "?"],
];
for (const letter of "abcdefghijklmnopqrstuvwxyz") {
  US_KEYS.push(["Key" + letter.toUpperCase(), letter, letter.toUpperCase()]);
}
// A character → [its key, whether it needs Shift]. And a character → what Shift makes of it.
const CHARACTERS = { " ": ["Space", false] };
const SHIFTED = {};
for (const [code, plain, shifted] of US_KEYS) {
  CHARACTERS[plain] = [code, false];
  CHARACTERS[shifted] = [code, true];
  SHIFTED[plain] = shifted;
}

// The keyboard's pages. A key is a character, or [kind, width, value, label]: "key" sends a key, "mod" is a
// modifier, "page" opens another page, "gap" is empty space. A row is 10 wide.
const SPACE = ["key", 3.5, "Space", "space"];
const PAGES = {
  letters: [
    [..."qwertyuiop"],
    [["gap", 0.5], ..."asdfghjkl", ["gap", 0.5]],
    [["mod", 1.25, "ShiftLeft", "⇧"], ["gap", 0.25], ..."zxcvbnm", ["gap", 0.25], ["key", 1.25, "Backspace", "⌫"]],
    [["page", 1.25, "numbers", "123"], ["page", 1.25, "fn", "Fn"], ",", SPACE, ".", ["key", 2, "Enter", "Enter"]],
  ],
  numbers: [
    [..."1234567890"],
    [..."-/:;()$&@\""],
    [["page", 1.5, "symbols", "#+="], ["char", 1.4, "."], ["char", 1.4, ","], ["char", 1.4, "?"], ["char", 1.4, "!"],
      ["char", 1.4, "'"], ["key", 1.5, "Backspace", "⌫"]],
    [["page", 1.25, "letters", "ABC"], ["page", 1.25, "fn", "Fn"], ["key", 5.5, "Space", "space"], ["key", 2, "Enter", "Enter"]],
  ],
  symbols: [
    [..."[]{}#%^*+="],
    [["gap", 1.5], ..."_\\|~<>`", ["gap", 1.5]],
    [["page", 1.5, "numbers", "123"], ["char", 1.4, "."], ["char", 1.4, ","], ["char", 1.4, "?"], ["char", 1.4, "!"],
      ["char", 1.4, "'"], ["key", 1.5, "Backspace", "⌫"]],
    [["page", 1.25, "letters", "ABC"], ["page", 1.25, "fn", "Fn"], ["key", 5.5, "Space", "space"], ["key", 2, "Enter", "Enter"]],
  ],
  fn: [
    [["key", 1, "F1", "F1"], ["key", 1, "F2", "F2"], ["key", 1, "F3", "F3"], ["key", 1, "F4", "F4"],
      ["key", 1, "F5", "F5"], ["key", 1, "F6", "F6"]],
    [["key", 1, "F7", "F7"], ["key", 1, "F8", "F8"], ["key", 1, "F9", "F9"], ["key", 1, "F10", "F10"],
      ["key", 1, "F11", "F11"], ["key", 1, "F12", "F12"]],
    [["key", 1, "Insert", "Ins"], ["key", 1, "Delete", "Del"], ["key", 1, "Home", "Home"], ["key", 1, "End", "End"],
      ["key", 1, "PageUp", "PgUp"], ["key", 1, "PageDown", "PgDn"]],
    [["page", 1.25, "letters", "ABC"], ["mod", 1.75, "ShiftLeft", "⇧"], ["key", 1.5, "CapsLock", "Caps"],
      ["key", 1.5, "PrintScreen", "PrtSc"], ["key", 1.5, "Backspace", "⌫"], ["key", 2.5, "Enter", "Enter"]],
  ],
};
// Always there, above the pages and above the phone's own keyboard. Its Shift shows only with the phone's keyboard.
const STRIP = [
  ["key", 1, "Escape", "Esc"], ["key", 1, "Tab", "Tab"], ["mod", 1.2, "ControlLeft", "Ctrl"],
  ["mod", 1.2, "AltLeft", "Alt"], ["mod", 1.5, "MetaLeft", "Super"], ["mod", 1.2, "ShiftLeft", "⇧"],
  ["key", 1, "ArrowLeft", "←"], ["key", 1, "ArrowUp", "↑"], ["key", 1, "ArrowDown", "↓"], ["key", 1, "ArrowRight", "→"],
];
const MODIFIERS = { ShiftLeft: "Shift", ControlLeft: "Ctrl", AltLeft: "Alt", MetaLeft: "Super" };
// Keys the phone's own keyboard sends as keys rather than text.
const PHONE_KEYS = ["Backspace", "Enter", "Tab", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Delete", "Home", "End", "PageUp", "PageDown"];
// iPhone's smart punctuation, back to what a keyboard has.
const PLAIN = { "‘": "'", "’": "'", "“": '"', "”": '"', "…": "...", "–": "-", "—": "-" };
// The phone's own keyboard types into the hidden textarea, which always holds just this. Backspace takes it away.
const SENTINEL = " ";
const MOUSE_BUTTONS = ["left", "middle", "right"];
const TAP_MS = 300;
const LONG_PRESS_MS = 550;
const MOVE_PX = 8;
const MAX_ZOOM = 8;
const VIEWPORT = document.querySelector("meta[name=viewport]").content;
const PANEL_WIDTH = 340;
const PANEL_MIN = 220;
// Tucked in, this much of the panel (its grip) stays out.
const GRIP_WIDTH = 24;

let socket = null;
let stopped = false;
let retryTimer = null;
// The newest frame drawn (an ImageBitmap), and frame numbers: decoding is async, so an older one may finish later.
let image = null;
let frameCount = 0;
let frameShown = 0;
// The zoom on top of fitting the whole screen, and where the screen's top left corner is on the canvas (CSS px).
let view = { zoom: 1, x: 0, y: 0 };
let pointer = { x: 0.5, y: 0.5 };
let mode = "trackpad";
let gesture = null;
let lastTap = 0;
let lastTouch = 0;
let lastTouchEnd = 0;
let wheelTimer = null;
let drawPending = false;
// "keyboard" (ours), "phone" (the phone's own) or "none".
let keyboardMode = "none";
// The side panel (a phone on its side): its width, which side, whether it is tucked into the edge, and a grip drag.
let panelWidth = PANEL_WIDTH;
let panelSide = "right";
let tucked = false;
let gripDrag = null;
// Modifiers tapped on the keyboard: name → {code, locked}. Not locked: only for the next key or click.
let sticky = new Map();
// Modifier keys a finger holds down: pointer id → {code, name, element, sent (its key went down), used}.
let heldModifiers = new Map();
// Other keys a finger holds down: pointer id → {code, modifiers (codes sent down with it), element}.
let heldKeys = new Map();
// Keys held on a real keyboard (an iPad's, or a computer's): event.code → key code.
let pressed = new Map();

try {
  mode = localStorage.getItem("mode") || "trackpad";
  panelWidth = Number(localStorage.getItem("panelWidth")) || PANEL_WIDTH;
  panelSide = localStorage.getItem("panelSide") || "right";
  tucked = localStorage.getItem("tucked") === "yes";
} catch {}

function send(message) {
  if (socket !== null && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function showStatus(text, canReconnect) {
  statusText.textContent = text;
  reconnectButton.hidden = !canReconnect;
  statusBox.style.display = "flex";
}

function connect() {
  clearTimeout(retryTimer);
  stopped = false;
  showStatus("Connecting…", false);
  const scheme = location.protocol === "https:" ? "wss://" : "ws://";
  const mine = new WebSocket(scheme + location.host + "/desktop/socket");
  socket = mine;
  mine.binaryType = "blob";
  mine.onmessage = (event) => {
    if (typeof event.data === "string") {
      handleMessage(JSON.parse(event.data));
    } else {
      showFrame(event.data);
    }
  };
  mine.onclose = () => {
    if (socket === mine) {
      connectionClosed();
    }
  };
}

function handleMessage(message) {
  if (message.type === "quality") {
    qualitySelect.value = message.quality;
  } else if (message.type === "stopped" || message.type === "error") {
    stopped = true;
    showStatus(message.text, true);
  } else if (message.type === "signed_out") {
    location.href = "/desktop/sign_in";
  }
}

async function connectionClosed() {
  socket = null;
  // The computer let go of everything this viewer held: so does the keyboard.
  heldKeys.clear();
  heldModifiers.clear();
  pressed.clear();
  for (const element of document.querySelectorAll(".down")) {
    element.classList.remove("down");
  }
  showKeys();
  if (stopped) {
    return;
  }
  // Signed out, or only the connection lost?
  try {
    const response = await fetch("/desktop/session");
    if (response.status === 401) {
      location.href = "/desktop/sign_in";
      return;
    }
  } catch {}
  showStatus("Connection lost. Connecting again…", false);
  if (!document.hidden) {
    retryTimer = setTimeout(connect, 2000);
  }
}

async function showFrame(blob) {
  frameCount += 1;
  const number = frameCount;
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {}
  send({ type: "ack" });
  if (bitmap === null) {
    return;
  }
  if (number < frameShown) {
    bitmap.close();
    return;
  }
  frameShown = number;
  const resized = image === null || image.width !== bitmap.width || image.height !== bitmap.height;
  if (image !== null) {
    image.close();
  }
  image = bitmap;
  statusBox.style.display = "none";
  if (resized) {
    clampView();
  }
  draw();
}

// The view: fit, zoom, and where things are.

// The part of the canvas the side panel doesn't cover: the picture fits there, and zoomed in it can be moved
// around in it (it then goes under the panel).
function area() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!document.body.classList.contains("side") || tucked) {
    return { x: 0, y: 0, width: width, height: height };
  }
  const covered = Math.min(panel.offsetWidth, width - 40);
  if (panelSide === "left") {
    return { x: covered, y: 0, width: width - covered, height: height };
  }
  return { x: 0, y: 0, width: width - covered, height: height };
}

function scale() {
  const free = area();
  const fit = Math.min(free.width / image.width, free.height / image.height);
  return fit * view.zoom;
}

function clampView() {
  if (image === null) {
    return;
  }
  const free = area();
  const width = image.width * scale();
  const height = image.height * scale();
  if (width <= free.width) {
    view.x = free.x + (free.width - width) / 2;
  } else {
    view.x = Math.min(free.x, Math.max(free.x + free.width - width, view.x));
  }
  if (height <= free.height) {
    view.y = free.y + (free.height - height) / 2;
  } else {
    view.y = Math.min(free.y, Math.max(free.y + free.height - height, view.y));
  }
}

// A spot on the canvas (CSS px) as a spot on the screen (0 to 1), and back.
function toScreen(spot) {
  const s = scale();
  return { x: (spot.x - view.x) / (image.width * s), y: (spot.y - view.y) / (image.height * s) };
}

function toCanvas(spot) {
  const s = scale();
  return { x: view.x + spot.x * image.width * s, y: view.y + spot.y * image.height * s };
}

// Zooms so that a spot on the screen ends up at a spot on the canvas.
function zoomTo(zoom, screenSpot, canvasSpot) {
  view.zoom = Math.min(MAX_ZOOM, Math.max(1, zoom));
  const s = scale();
  view.x = canvasSpot.x - screenSpot.x * image.width * s;
  view.y = canvasSpot.y - screenSpot.y * image.height * s;
  clampView();
  draw();
}

// Zoomed in, the view moves along when the pointer gets near its edge.
function followPointer() {
  const free = area();
  const spot = toCanvas(pointer);
  const margin = 48;
  if (spot.x < free.x + margin) {
    view.x += free.x + margin - spot.x;
  }
  if (spot.x > free.x + free.width - margin) {
    view.x -= spot.x - (free.x + free.width - margin);
  }
  if (spot.y < free.y + margin) {
    view.y += free.y + margin - spot.y;
  }
  if (spot.y > free.y + free.height - margin) {
    view.y -= spot.y - (free.y + free.height - margin);
  }
  clampView();
}

function resize() {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * ratio);
  canvas.height = Math.round(canvas.clientHeight * ratio);
  clampView();
  draw();
}

function draw() {
  if (drawPending) {
    return;
  }
  drawPending = true;
  requestAnimationFrame(() => {
    drawPending = false;
    const ratio = window.devicePixelRatio || 1;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = "#000";
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (image === null) {
      return;
    }
    const s = scale();
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.imageSmoothingQuality = "high";
    context.drawImage(image, view.x, view.y, image.width * s, image.height * s);
    if (mode === "trackpad") {
      // A small ring where the pointer is: it shows at once, the screen's own pointer a moment later.
      const spot = toCanvas(pointer);
      context.beginPath();
      context.arc(spot.x, spot.y, 4, 0, Math.PI * 2);
      context.lineWidth = 2.5;
      context.strokeStyle = "rgba(0, 0, 0, 0.55)";
      context.stroke();
      context.lineWidth = 1.2;
      context.strokeStyle = "rgba(255, 255, 255, 0.95)";
      context.stroke();
    }
  });
}

// Mouse and keys.

function movePointer(spot) {
  pointer = { x: Math.min(1, Math.max(0, spot.x)), y: Math.min(1, Math.max(0, spot.y)) };
  send({ type: "move", x: pointer.x, y: pointer.y });
  draw();
}

function pressButton(button, down) {
  send({ type: "button", button: button, down: down });
}

function sendKey(code, down) {
  send({ type: "key", code: code, down: down });
}

// Before a key or click: the modifiers a finger holds go down (and stay down until let go), and the tapped ones go
// down too. Returns the tapped ones, which go up after the key or click. Ones tapped once are used up.
function pressModifiers() {
  for (const modifier of heldModifiers.values()) {
    modifier.used = true;
    if (!modifier.sent) {
      sendKey(KEY_CODES[modifier.code], true);
      modifier.sent = true;
    }
  }
  const codes = [];
  for (const [name, modifier] of sticky) {
    codes.push(KEY_CODES[modifier.code]);
    sendKey(KEY_CODES[modifier.code], true);
    if (!modifier.locked) {
      sticky.delete(name);
    }
  }
  showKeys();
  return codes;
}

function releaseModifiers(codes) {
  for (const code of codes.reverse()) {
    sendKey(code, false);
  }
}

function click(button) {
  const codes = pressModifiers();
  pressButton(button, true);
  pressButton(button, false);
  releaseModifiers(codes);
}

function modifierOn(name) {
  if (sticky.has(name)) {
    return true;
  }
  for (const modifier of heldModifiers.values()) {
    if (modifier.name === name) {
      return true;
    }
  }
  return false;
}

// A key (by its code name) pressed and let go, with the modifiers.
function tapKey(name) {
  const codes = pressModifiers();
  sendKey(KEY_CODES[name], true);
  sendKey(KEY_CODES[name], false);
  releaseModifiers(codes);
}

// A character typed with its key, adding Shift when it needs it. Characters a US keyboard doesn't have go as text.
function typeCharacter(character) {
  const found = CHARACTERS[character];
  if (found === undefined) {
    send({ type: "text", text: character });
    return;
  }
  const addShift = found[1] && !modifierOn("Shift");
  const codes = pressModifiers();
  if (addShift) {
    sendKey(KEY_CODES.ShiftLeft, true);
    codes.push(KEY_CODES.ShiftLeft);
  }
  sendKey(KEY_CODES[found[0]], true);
  sendKey(KEY_CODES[found[0]], false);
  releaseModifiers(codes);
}

// Touches on the screen.

function touchSpot(touch) {
  const rect = canvas.getBoundingClientRect();
  return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
}

function twoFingers(touches) {
  const a = touchSpot(touches[0]);
  const b = touchSpot(touches[1]);
  return { middle: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, distance: Math.hypot(a.x - b.x, a.y - b.y) };
}

canvas.addEventListener("touchstart", (event) => {
  event.preventDefault();
  lastTouch = performance.now();
  if (image === null) {
    return;
  }
  // targetTouches: only the fingers on the screen, not one holding a key on the keyboard.
  const touches = event.targetTouches;
  if (touches.length === 1 && gesture === null) {
    const spot = touchSpot(touches[0]);
    gesture = { fingers: 1, start: lastTouch, from: spot, last: spot, moved: false, dragging: false, done: false, timer: null };
    gesture.afterTap = lastTouch - lastTap < TAP_MS;
    if (mode === "touch") {
      gesture.timer = setTimeout(longPress, LONG_PRESS_MS);
    }
    return;
  }
  if (touches.length === 2) {
    // A second finger: whatever the first one did ends.
    if (gesture !== null && gesture.fingers === 1) {
      clearTimeout(gesture.timer);
      if (gesture.dragging) {
        pressButton("left", false);
      }
    }
    const two = twoFingers(touches);
    gesture = { fingers: 2, start: lastTouch, kind: null, from: two.middle, last: two.middle, distance: two.distance, zoom: view.zoom };
    gesture.screenSpot = toScreen(two.middle);
    return;
  }
  // Three or more fingers: nothing.
  if (gesture !== null) {
    gesture.fingers = 3;
  }
}, { passive: false });

canvas.addEventListener("touchmove", (event) => {
  event.preventDefault();
  if (gesture === null || image === null) {
    return;
  }
  const touches = event.targetTouches;
  if (gesture.fingers === 1 && touches.length === 1) {
    moveOneFinger(touchSpot(touches[0]));
  }
  if (gesture.fingers === 2 && touches.length === 2) {
    moveTwoFingers(twoFingers(touches));
  }
}, { passive: false });

function moveOneFinger(spot) {
  if (gesture.done) {
    return;
  }
  if (!gesture.moved) {
    if (Math.hypot(spot.x - gesture.from.x, spot.y - gesture.from.y) < MOVE_PX) {
      return;
    }
    gesture.moved = true;
    clearTimeout(gesture.timer);
    if (mode === "touch") {
      movePointer(toScreen(gesture.from));
      pressButton("left", true);
      gesture.dragging = true;
    } else if (gesture.afterTap) {
      pressButton("left", true);
      gesture.dragging = true;
    }
    gesture.last = spot;
  }
  if (mode === "touch") {
    movePointer(toScreen(spot));
  } else {
    // Faster moves go further, slow ones stay precise.
    const dx = spot.x - gesture.last.x;
    const dy = spot.y - gesture.last.y;
    const gain = 1 + Math.min(Math.hypot(dx, dy) / 12, 1.5);
    const s = scale();
    movePointer({ x: pointer.x + (dx * gain) / (image.width * s), y: pointer.y + (dy * gain) / (image.height * s) });
    followPointer();
  }
  gesture.last = spot;
}

function moveTwoFingers(two) {
  if (gesture.kind === null) {
    if (Math.abs(two.distance - gesture.distance) > 24) {
      gesture.kind = "zoom";
    } else if (Math.hypot(two.middle.x - gesture.from.x, two.middle.y - gesture.from.y) > 10) {
      gesture.kind = "scroll";
      // Touch: scroll what's under the fingers.
      if (mode === "touch") {
        movePointer(toScreen(gesture.from));
      }
    } else {
      return;
    }
  }
  if (gesture.kind === "zoom") {
    zoomTo((gesture.zoom * two.distance) / gesture.distance, gesture.screenSpot, two.middle);
  } else {
    // The page follows the fingers, like scrolling on the phone.
    const s = scale();
    const dx = -(two.middle.x - gesture.last.x) / (image.width * s);
    const dy = -(two.middle.y - gesture.last.y) / (image.height * s);
    send({ type: "scroll", dx: dx, dy: dy, end: false });
  }
  gesture.last = two.middle;
}

function longPress() {
  if (gesture === null || gesture.fingers !== 1 || gesture.moved) {
    return;
  }
  gesture.done = true;
  movePointer(toScreen(gesture.from));
  click("right");
}

function touchEnd(event) {
  event.preventDefault();
  lastTouch = performance.now();
  if (gesture === null || event.targetTouches.length > 0) {
    return;
  }
  const quick = lastTouch - gesture.start < TAP_MS;
  if (gesture.fingers === 1) {
    clearTimeout(gesture.timer);
    if (gesture.dragging) {
      pressButton("left", false);
    } else if (!gesture.moved && !gesture.done && event.type === "touchend") {
      // Trackpad: the pointer goes where the ring is first, which the computer may not know yet.
      movePointer(mode === "touch" ? toScreen(gesture.from) : pointer);
      click("left");
      lastTap = lastTouch;
    }
  }
  if (gesture.fingers === 2) {
    if (gesture.kind === "scroll") {
      send({ type: "scroll", dx: 0, dy: 0, end: true });
    }
    if (gesture.kind === null && quick && event.type === "touchend") {
      movePointer(mode === "touch" ? toScreen(gesture.from) : pointer);
      click("right");
    }
  }
  gesture = null;
}

canvas.addEventListener("touchend", touchEnd, { passive: false });
canvas.addEventListener("touchcancel", touchEnd, { passive: false });

// A real mouse (on a computer, or an iPad's): straight through. Not the mouse events a phone makes after a touch.

function realMouse() {
  return image !== null && performance.now() - lastTouch > 1000;
}

canvas.addEventListener("mousemove", (event) => {
  if (realMouse()) {
    movePointer(toScreen({ x: event.offsetX, y: event.offsetY }));
  }
});
canvas.addEventListener("mousedown", (event) => {
  event.preventDefault();
  if (realMouse() && MOUSE_BUTTONS[event.button]) {
    movePointer(toScreen({ x: event.offsetX, y: event.offsetY }));
    pressButton(MOUSE_BUTTONS[event.button], true);
  }
});
canvas.addEventListener("mouseup", (event) => {
  if (realMouse() && MOUSE_BUTTONS[event.button]) {
    pressButton(MOUSE_BUTTONS[event.button], false);
  }
});
canvas.addEventListener("contextmenu", (event) => event.preventDefault());
canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  if (image === null) {
    return;
  }
  const unit = event.deltaMode === 1 ? 16 : 1;
  const s = scale();
  send({ type: "scroll", dx: (event.deltaX * unit) / (image.width * s), dy: (event.deltaY * unit) / (image.height * s), end: false });
  clearTimeout(wheelTimer);
  wheelTimer = setTimeout(() => send({ type: "scroll", dx: 0, dy: 0, end: true }), 150);
}, { passive: false });

// The keyboard. A key goes down when touched and up when let go, so holding one repeats it.

function makeRow(items) {
  const row = document.createElement("div");
  row.className = "row";
  for (let item of items) {
    if (typeof item === "string") {
      item = ["char", 1, item];
    }
    const [kind, width, value, label] = item;
    const element = document.createElement("div");
    element.style.flexGrow = width;
    if (kind === "gap") {
      element.className = "gap";
      row.append(element);
      continue;
    }
    element.className = "key";
    element.dataset.kind = kind;
    element.dataset.value = value;
    element.textContent = kind === "char" ? value : label;
    if (kind !== "char" && value !== "Space") {
      element.classList.add("special");
    }
    element.addEventListener("pointerdown", keyDown);
    element.addEventListener("pointerup", keyUp);
    element.addEventListener("pointercancel", keyUp);
    element.addEventListener("lostpointercapture", keyUp);
    row.append(element);
  }
  return row;
}

strip.append(makeRow(STRIP));
for (const [name, rows] of Object.entries(PAGES)) {
  const page = document.createElement("div");
  page.className = "page";
  page.dataset.page = name;
  for (const items of rows) {
    page.append(makeRow(items));
  }
  keys.append(page);
}

function showPage(name) {
  for (const page of keys.querySelectorAll(".page")) {
    page.classList.toggle("shown", page.dataset.page === name);
  }
}

function keyDown(event) {
  event.preventDefault();
  const element = event.currentTarget;
  const kind = element.dataset.kind;
  const value = element.dataset.value;
  if (kind === "page") {
    showPage(value);
    return;
  }
  // The key gets this finger's pointerup even if it slides off.
  element.setPointerCapture(event.pointerId);
  element.classList.add("down");
  if (kind === "mod") {
    heldModifiers.set(event.pointerId, { code: value, name: MODIFIERS[value], element: element, sent: false, used: false });
    showKeys();
    return;
  }
  let code = value;
  let addShift = false;
  if (kind === "char") {
    code = CHARACTERS[value][0];
    addShift = CHARACTERS[value][1] && !modifierOn("Shift");
  }
  const codes = pressModifiers();
  if (addShift) {
    sendKey(KEY_CODES.ShiftLeft, true);
    codes.push(KEY_CODES.ShiftLeft);
  }
  sendKey(KEY_CODES[code], true);
  heldKeys.set(event.pointerId, { code: KEY_CODES[code], modifiers: codes, element: element });
}

function keyUp(event) {
  const element = event.currentTarget;
  element.classList.remove("down");
  const modifier = heldModifiers.get(event.pointerId);
  if (modifier) {
    heldModifiers.delete(event.pointerId);
    if (modifier.sent) {
      sendKey(KEY_CODES[modifier.code], false);
    } else if (!modifier.used && event.type === "pointerup") {
      tapModifier(modifier);
    }
    showKeys();
    return;
  }
  const key = heldKeys.get(event.pointerId);
  if (!key) {
    return;
  }
  heldKeys.delete(event.pointerId);
  sendKey(key.code, false);
  releaseModifiers(key.modifiers);
}

// A modifier tapped on its own. Super: Super on its own, which opens Activities. The others: on for the next key,
// then on until tapped again, then off.
function tapModifier(modifier) {
  if (modifier.name === "Super") {
    sendKey(KEY_CODES[modifier.code], true);
    sendKey(KEY_CODES[modifier.code], false);
    return;
  }
  const state = sticky.get(modifier.name);
  if (!state) {
    sticky.set(modifier.name, { code: modifier.code, locked: false });
  } else if (!state.locked) {
    state.locked = true;
  } else {
    sticky.delete(modifier.name);
  }
}

// Labels and lit keys: what Shift makes of the characters while Shift is on.
function showKeys() {
  const shift = modifierOn("Shift");
  for (const element of document.querySelectorAll(".key")) {
    const kind = element.dataset.kind;
    const value = element.dataset.value;
    if (kind === "char") {
      const label = shift && SHIFTED[value] ? SHIFTED[value] : value;
      if (element.textContent !== label) {
        element.textContent = label;
      }
    }
    if (kind === "mod") {
      const state = sticky.get(MODIFIERS[value]);
      element.classList.toggle("on", state !== undefined && !state.locked);
      element.classList.toggle("locked", state !== undefined && state.locked);
    }
  }
}

// The phone's own keyboard, typing into the hidden textarea.

function resetTyping() {
  typing.value = SENTINEL;
  typing.setSelectionRange(1, 1);
}

typing.addEventListener("keydown", (event) => {
  if (event.isComposing || event.key === undefined) {
    return;
  }
  if (PHONE_KEYS.includes(event.key)) {
    event.preventDefault();
    tapKey(event.key);
    return;
  }
  // Ctrl+C and the like, from the strip's Ctrl or a keyboard's.
  if (event.key.length === 1 && (sticky.size > 0 || heldModifiers.size > 0 || event.ctrlKey || event.altKey || event.metaKey)) {
    event.preventDefault();
    if (event.ctrlKey) {
      sticky.set("Ctrl", { code: "ControlLeft", locked: false });
    }
    if (event.altKey) {
      sticky.set("Alt", { code: "AltLeft", locked: false });
    }
    if (event.metaKey) {
      sticky.set("Super", { code: "MetaLeft", locked: false });
    }
    typeCharacter(event.key);
  }
});

function typed() {
  const value = typing.value;
  if (value.length === 0) {
    tapKey("Backspace");
  } else {
    let text = value.startsWith(SENTINEL) ? value.slice(SENTINEL.length) : value;
    text = Array.from(text, (character) => PLAIN[character] ?? character).join("");
    if (text.length > 0 && (sticky.size > 0 || heldModifiers.size > 0)) {
      const first = Array.from(text)[0];
      typeCharacter(first);
      text = text.slice(first.length);
    }
    if (text.length > 0) {
      send({ type: "text", text: text });
    }
  }
  resetTyping();
}

typing.addEventListener("input", (event) => {
  if (!event.isComposing) {
    typed();
  }
});
typing.addEventListener("compositionend", typed);
// The phone's keyboard closed by its own Done or a swipe.
typing.addEventListener("blur", () => {
  if (keyboardMode === "phone") {
    setKeyboard("none");
  }
});

// A real keyboard (an iPad's, or a computer's): each key down and up as it happens.

document.addEventListener("keydown", (event) => {
  if (event.repeat || event.target === typing || event.target === qualitySelect) {
    return;
  }
  const code = KEY_CODES[event.code];
  if (code === undefined) {
    return;
  }
  event.preventDefault();
  pressed.set(event.code, code);
  sendKey(code, true);
});

document.addEventListener("keyup", (event) => {
  const code = pressed.get(event.code);
  if (code === undefined) {
    return;
  }
  event.preventDefault();
  pressed.delete(event.code);
  sendKey(code, false);
});

// Lets go of every key, on every keyboard.
function releaseKeys() {
  for (const code of pressed.values()) {
    sendKey(code, false);
  }
  pressed.clear();
  for (const key of heldKeys.values()) {
    sendKey(key.code, false);
    releaseModifiers(key.modifiers);
    key.element.classList.remove("down");
  }
  heldKeys.clear();
  for (const modifier of heldModifiers.values()) {
    if (modifier.sent) {
      sendKey(KEY_CODES[modifier.code], false);
    }
    modifier.element.classList.remove("down");
  }
  heldModifiers.clear();
  showKeys();
}

window.addEventListener("blur", releaseKeys);

// Safari zooms the whole page on a double tap, and the page can't zoom back out. Nothing here zooms but the
// screen's picture (pinch on it): no double taps, and the keys take their touches whole.
document.addEventListener("touchend", (event) => {
  const now = performance.now();
  if (now - lastTouchEnd < 400 && event.target !== qualitySelect) {
    event.preventDefault();
  }
  lastTouchEnd = now;
}, { passive: false });
panel.addEventListener("touchstart", (event) => event.preventDefault(), { passive: false });
document.addEventListener("gesturestart", (event) => event.preventDefault());

// If the page got zoomed anyway: setting the viewport again brings Safari back to its normal size.
function undoPageZoom() {
  const meta = document.querySelector("meta[name=viewport]");
  meta.content = VIEWPORT + ", minimum-scale=1";
  setTimeout(() => {
    meta.content = VIEWPORT;
  }, 300);
}

// With the phone's keyboard up, the page shrinks to the space above it.
function fitViewport() {
  const viewport = window.visualViewport;
  if (viewport.scale > 1.01) {
    undoPageZoom();
    return;
  }
  document.body.style.height = viewport.height + "px";
  document.body.style.top = viewport.offsetTop + "px";
}

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", fitViewport);
  window.visualViewport.addEventListener("scroll", fitViewport);
}

// The bar.

// Buttons keep the phone's keyboard up: a tap on them doesn't take the focus from the textarea.
document.getElementById("bar").addEventListener("pointerdown", (event) => {
  if (event.target.tagName === "BUTTON") {
    event.preventDefault();
  }
});

// Our keyboard at the bottom, or (a phone on its side) in the side panel over the screen.
function placeKeyboard() {
  const side = sideways.matches && keyboardMode === "keyboard";
  const home = side ? stage : bottom;
  if (panel.parentElement !== home) {
    releaseKeys();
    home.append(panel);
  }
  document.body.classList.toggle("side", side);
  document.body.classList.toggle("panel-left", panelSide === "left");
  panel.classList.toggle("left", panelSide === "left");
  panel.classList.toggle("tucked", tucked);
  panel.style.width = side ? panelWidth + "px" : "";
  clampView();
  draw();
}

function savePanel() {
  try {
    localStorage.setItem("panelWidth", String(Math.round(panelWidth)));
    localStorage.setItem("panelSide", panelSide);
    localStorage.setItem("tucked", tucked ? "yes" : "no");
  } catch {}
}

// The grip: drag for a wider or narrower panel, tap to tuck it into the edge or bring it back.
grip.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  grip.setPointerCapture(event.pointerId);
  gripDrag = { x: event.clientX, width: panelWidth, moved: false };
});

grip.addEventListener("pointermove", (event) => {
  if (gripDrag === null) {
    return;
  }
  let dx = event.clientX - gripDrag.x;
  if (Math.abs(dx) > 6) {
    gripDrag.moved = true;
  }
  if (!gripDrag.moved || tucked) {
    return;
  }
  // The grip is on the panel's inner edge: towards the middle makes it wider.
  if (panelSide === "right") {
    dx = -dx;
  }
  panelWidth = Math.min(stage.clientWidth * 0.75, Math.max(PANEL_MIN, gripDrag.width + dx));
  placeKeyboard();
});

function gripUp() {
  if (gripDrag === null) {
    return;
  }
  if (!gripDrag.moved || tucked) {
    tucked = !tucked;
    if (tucked) {
      releaseKeys();
    }
  }
  gripDrag = null;
  savePanel();
  placeKeyboard();
}

grip.addEventListener("pointerup", gripUp);
grip.addEventListener("pointercancel", gripUp);

// ⇄: the panel to the other side. Its own touch, not the grip's.
swapButton.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  event.stopPropagation();
});
swapButton.addEventListener("pointerup", () => {
  panelSide = panelSide === "right" ? "left" : "right";
  savePanel();
  placeKeyboard();
});

sideways.addEventListener("change", placeKeyboard);

function setKeyboard(newMode) {
  if (newMode !== keyboardMode) {
    releaseKeys();
  }
  keyboardMode = newMode;
  document.body.classList.toggle("keyboard", newMode === "keyboard");
  document.body.classList.toggle("phone", newMode === "phone");
  keyboardButton.classList.toggle("on", newMode === "keyboard");
  phoneButton.classList.toggle("on", newMode === "phone");
  placeKeyboard();
  if (newMode === "phone") {
    resetTyping();
    typing.focus();
  } else if (document.activeElement === typing) {
    typing.blur();
  }
  try {
    localStorage.setItem("keyboard", newMode === "keyboard" ? "open" : "closed");
  } catch {}
}

keyboardButton.onclick = () => setKeyboard(keyboardMode === "keyboard" ? "none" : "keyboard");
phoneButton.onclick = () => setKeyboard(keyboardMode === "phone" ? "none" : "phone");

function showMode() {
  modeButton.textContent = mode === "trackpad" ? "Trackpad" : "Touch";
  draw();
}

modeButton.onclick = () => {
  mode = mode === "trackpad" ? "touch" : "trackpad";
  try {
    localStorage.setItem("mode", mode);
  } catch {}
  showMode();
};

document.getElementById("fit").onclick = () => {
  undoPageZoom();
  view.zoom = 1;
  clampView();
  draw();
};

qualitySelect.onchange = () => send({ type: "quality", quality: qualitySelect.value });

document.getElementById("terminal-button").onclick = () => {
  location.href = "/desktop/terminal";
};

document.getElementById("hide").onclick = () => {
  if (keyboardMode === "phone") {
    setKeyboard("none");
  }
  releaseKeys();
  bottom.style.display = "none";
  showButton.style.display = "block";
};

showButton.onclick = () => {
  bottom.style.display = "block";
  showButton.style.display = "none";
};

const signOutButton = document.getElementById("sign-out");
// On the computer itself there is no sign in.
signOutButton.hidden = location.protocol !== "https:";
signOutButton.onclick = async () => {
  await fetch("/desktop/sign_out", { method: "POST" });
  location.href = "/desktop/sign_in";
};

reconnectButton.onclick = connect;

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    releaseKeys();
  } else if (socket === null && !stopped) {
    connect();
  }
});

let keyboardWasOpen = false;
try {
  keyboardWasOpen = localStorage.getItem("keyboard") === "open";
} catch {}
showPage("letters");
setKeyboard(keyboardWasOpen ? "keyboard" : "none");
new ResizeObserver(resize).observe(canvas);
showMode();
connect();
