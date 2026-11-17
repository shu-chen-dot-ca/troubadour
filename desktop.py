"""This PC's screen and input, through GNOME's own remote desktop: Mutter's D-Bus API, the same one GNOME's Remote
Desktop (Settings → System → Remote Desktop) uses. No extra server, no permission dialog.

start() makes a Mutter remote desktop session with a screen cast of the main monitor (the mouse cursor drawn in), and
plays the screen cast's PipeWire stream through GStreamer into JPEG frames. Input goes into the same session: the
pointer to a spot on the screen, mouse buttons, scrolling, keys (Linux key codes, as a real keyboard sends) and text.

With no monitor on (the laptop's lid closed, nothing plugged in), it records a virtual monitor instead: a screen of
VIRTUAL_SIZE that GNOME makes for the session, puts the windows on, and takes away when the session ends.

While it runs, GNOME shows its screen sharing icon in the top bar. Stopping it there ends the session (on_closed).
The session belongs to this process: if it stops, Mutter ends the session too. So does the monitor it records going
away (the lid closed while watching): on_closed then says so, and the server starts again on the virtual monitor.

Pointer positions come in as 0..1 of the screen and are sent in the stream's own pixels (the monitor's real pixels,
2560x1600 here, also with fractional scaling).
"""

import os
import threading
from pathlib import Path

import gi
from dotenv import load_dotenv

gi.require_version("Gst", "1.0")
from gi.repository import Gio, GLib, Gst

Gst.init(None)
# D-Bus signals (the stream's PipeWire node, the session closing) and GStreamer bus messages arrive through GLib's
# main loop, which runs on its own thread.
threading.Thread(target=GLib.MainLoop().run, daemon=True).start()

load_dotenv(Path(__file__).resolve().parent / ".env", override=True)

REMOTE_DESKTOP = "org.gnome.Mutter.RemoteDesktop"
SCREEN_CAST = "org.gnome.Mutter.ScreenCast"
# Mutter's flags for scrolling: the scroll came from fingers (smooth), and the fingers lifted.
SCROLL_FINGER = 4
SCROLL_FINISH = 1
# Linux button codes (BTN_LEFT, BTN_RIGHT, BTN_MIDDLE).
BUTTONS = {"left": 0x110, "right": 0x111, "middle": 0x112}
# Frame width and JPEG quality for each Quality setting. None: the screen's real size.
QUALITIES = {"low": (1280, 50), "medium": (1920, 60), "high": (None, 80)}
QUALITY = os.environ["QUALITY"]
if QUALITY not in QUALITIES:
    raise SystemExit("QUALITY in .env is low, medium or high.")
MAX_FPS = int(os.environ["MAX_FPS"])
VIRTUAL_SIZE = tuple(int(number) for number in os.environ["VIRTUAL_SIZE"].split("x"))


class DesktopError(Exception):
    pass


class Desktop:
    def __init__(self):
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION)
        self.running = False
        self.quality = QUALITY
        self.session = None
        self.stream = None
        self.pipeline = None
        self.subscriptions = []
        # Recording a virtual monitor, or which real one (its connector, like eDP-1).
        self.virtual = False
        self.connector = ""
        # The screen's logical size (Mutter's layout) and its real pixels, which pointer positions are in.
        self.logical_width = 0
        self.logical_height = 0
        self.width = 0
        self.height = 0
        # The newest JPEG frame and its number. Both are set on GStreamer's thread.
        self.frame = None
        self.frame_number = 0
        # Set by the server. Both are called on other threads: on_frame on GStreamer's, on_closed on GLib's.
        # on_closed(monitor_gone): True when the monitor it recorded went away, False when stopped in GNOME.
        self.on_frame = None
        self.on_closed = None

    def call_sync(self, name, path, interface, method, args, reply):
        reply_type = GLib.VariantType(reply) if reply else None
        result = self.bus.call_sync(name, path, interface, method, args, reply_type, Gio.DBusCallFlags.NONE, 5000, None)
        if result is None:
            return None
        return result.unpack()

    def start(self) -> None:
        """Starts the session and the frames. Blocks for a moment: run it off the event loop."""
        if self.running:
            return
        try:
            self.session = self.call_sync(REMOTE_DESKTOP, "/org/gnome/Mutter/RemoteDesktop", REMOTE_DESKTOP, "CreateSession", None, "(o)")[0]
            session_id = self.call_sync(REMOTE_DESKTOP, self.session, "org.freedesktop.DBus.Properties", "Get", GLib.Variant("(ss)", (REMOTE_DESKTOP + ".Session", "SessionId")), "(v)")[0]
            # The screen cast belongs to the remote desktop session, so pointer positions can name its stream.
            properties = {"remote-desktop-session-id": GLib.Variant("s", session_id)}
            screen_cast = self.call_sync(SCREEN_CAST, "/org/gnome/Mutter/ScreenCast", SCREEN_CAST, "CreateSession", GLib.Variant("(a{sv})", (properties,)), "(o)")[0]
        except GLib.Error as error:
            raise DesktopError(f"No desktop to show: nobody is logged in to GNOME on the computer, or it isn't running ({error.message}). Terminal still works.")
        # Cursor mode 1: the cursor drawn into the frames.
        record = {"cursor-mode": GLib.Variant("u", 1)}
        try:
            # "": the main monitor.
            self.stream = self.call_sync(SCREEN_CAST, screen_cast, SCREEN_CAST + ".Session", "RecordMonitor", GLib.Variant("(sa{sv})", ("", record)), "(o)")[0]
            self.virtual = False
        except GLib.Error:
            # No monitor on: a virtual one.
            try:
                self.stream = self.call_sync(SCREEN_CAST, screen_cast, SCREEN_CAST + ".Session", "RecordVirtual", GLib.Variant("(a{sv})", (record,)), "(o)")[0]
                self.virtual = True
            except GLib.Error as error:
                self.stop()
                raise DesktopError(f"GNOME didn't start screen sharing: {error.message}")

        node = {}
        added = threading.Event()

        def stream_added(connection, sender, path, interface, signal, parameters):
            node["id"] = parameters.unpack()[0]
            added.set()

        def session_closed(connection, sender, path, interface, signal, parameters):
            # The server calls stop() on its own thread.
            self.running = False
            monitor_gone = not self.virtual and self.connector not in self.monitors_on()
            if self.on_closed is not None:
                self.on_closed(monitor_gone)

        self.subscriptions = [
            self.bus.signal_subscribe(SCREEN_CAST, SCREEN_CAST + ".Stream", "PipeWireStreamAdded", self.stream, None, Gio.DBusSignalFlags.NONE, stream_added),
            self.bus.signal_subscribe(REMOTE_DESKTOP, REMOTE_DESKTOP + ".Session", "Closed", self.session, None, Gio.DBusSignalFlags.NONE, session_closed),
        ]
        try:
            # Starting the remote desktop session starts its screen cast too.
            self.call_sync(REMOTE_DESKTOP, self.session, REMOTE_DESKTOP + ".Session", "Start", None, None)
        except GLib.Error as error:
            self.stop()
            raise DesktopError(f"GNOME didn't start screen sharing: {error.message}")
        if not added.wait(5):
            self.stop()
            raise DesktopError("GNOME started screen sharing but sent no picture.")

        parameters = self.call_sync(SCREEN_CAST, self.stream, "org.freedesktop.DBus.Properties", "Get", GLib.Variant("(ss)", (SCREEN_CAST + ".Stream", "Parameters")), "(v)")[0]
        if self.virtual:
            self.logical_width, self.logical_height = VIRTUAL_SIZE
            self.connector = ""
        else:
            self.logical_width, self.logical_height = parameters["size"]
            self.connector = parameters.get("output-name", "")
        self.node = node["id"]
        self.running = True
        self.start_pipeline()

    def start_pipeline(self) -> None:
        width, quality = QUALITIES[self.quality]
        size = ""
        if width is not None:
            # Never bigger than the screen's logical size, and the screen's shape.
            width = min(width, self.logical_width)
            height = round(width * self.logical_height / self.logical_width / 2) * 2
            size = f",width={width},height={height}"
        # A virtual monitor is as big as the stream asks for.
        source_size = ""
        if self.virtual:
            source_size = f",width={VIRTUAL_SIZE[0]},height={VIRTUAL_SIZE[1]}"
        # I420 makes JPEGs about a third the size of RGB ones. appsink keeps only the newest frame.
        description = (
            f"pipewiresrc name=source path={self.node} do-timestamp=true ! video/x-raw,max-framerate={MAX_FPS}/1{source_size} ! "
            f"videoscale ! videoconvert ! video/x-raw,format=I420{size} ! jpegenc quality={quality} ! "
            "appsink name=sink drop=true max-buffers=1 sync=false emit-signals=true"
        )
        self.pipeline = Gst.parse_launch(description)
        self.pipeline.get_by_name("sink").connect("new-sample", self.new_sample)
        bus = self.pipeline.get_bus()
        bus.add_signal_watch()
        bus.connect("message::error", self.pipeline_error)
        self.pipeline.set_state(Gst.State.PLAYING)

    def monitors_on(self) -> list[str]:
        """The connectors of the monitors that are on right now (eDP-1, HDMI-1, ...)."""
        try:
            state = self.call_sync("org.gnome.Mutter.DisplayConfig", "/org/gnome/Mutter/DisplayConfig", "org.gnome.Mutter.DisplayConfig", "GetCurrentState", None, None)
        except GLib.Error:
            return []
        # (serial, monitors, logical monitors, properties); a logical monitor's 6th field lists its monitors.
        connectors = []
        for logical_monitor in state[2]:
            for monitor in logical_monitor[5]:
                connectors.append(monitor[0])
        return connectors

    def stop_pipeline(self) -> None:
        if self.pipeline is None:
            return
        self.pipeline.get_bus().remove_signal_watch()
        self.pipeline.set_state(Gst.State.NULL)
        self.pipeline = None

    def new_sample(self, sink):
        # GStreamer's thread.
        sample = sink.emit("pull-sample")
        buffer = sample.get_buffer()
        caps = sink.get_parent().get_by_name("source").get_static_pad("src").get_current_caps()
        if caps is not None:
            self.width = caps.get_structure(0).get_value("width")
            self.height = caps.get_structure(0).get_value("height")
        self.frame = buffer.extract_dup(0, buffer.get_size())
        self.frame_number += 1
        if self.on_frame is not None:
            self.on_frame()
        return Gst.FlowReturn.OK

    def pipeline_error(self, bus, message):
        error, debug = message.parse_error()
        print(f"desktop: screen stream error: {error.message} ({debug})", flush=True)

    def set_quality(self, quality: str) -> None:
        if quality not in QUALITIES or quality == self.quality:
            return
        self.quality = quality
        if self.running:
            self.stop_pipeline()
            self.start_pipeline()

    def stop(self) -> None:
        self.running = False
        self.stop_pipeline()
        for subscription in self.subscriptions:
            self.bus.signal_unsubscribe(subscription)
        self.subscriptions = []
        if self.session is not None:
            # It may be closed already (Stop in GNOME's top bar).
            try:
                self.call_sync(REMOTE_DESKTOP, self.session, REMOTE_DESKTOP + ".Session", "Stop", None, None)
            except GLib.Error:
                pass
        self.session = None
        self.stream = None
        self.frame = None
        self.width = 0
        self.height = 0

    def send(self, method: str, args: GLib.Variant) -> None:
        """An input event into the session. It doesn't wait for Mutter's answer, and events keep their order."""
        if not self.running:
            return
        self.bus.call(REMOTE_DESKTOP, self.session, REMOTE_DESKTOP + ".Session", method, args, None, Gio.DBusCallFlags.NONE, -1, None, self.sent, method)

    def sent(self, bus, result, method):
        try:
            bus.call_finish(result)
        except GLib.Error as error:
            print(f"desktop: {method} failed: {error.message}", flush=True)

    def move(self, x: float, y: float) -> None:
        """The pointer to a spot on the screen, x and y from 0 to 1."""
        if self.width == 0:
            return
        x = min(max(x, 0.0), 1.0) * (self.width - 1)
        y = min(max(y, 0.0), 1.0) * (self.height - 1)
        self.send("NotifyPointerMotionAbsolute", GLib.Variant("(sdd)", (self.stream, x, y)))

    def button(self, name: str, pressed: bool) -> None:
        if name not in BUTTONS:
            return
        self.send("NotifyPointerButton", GLib.Variant("(ib)", (BUTTONS[name], pressed)))

    def scroll(self, dx: float, dy: float, finished: bool) -> None:
        """Smooth scrolling, like two fingers on a touchpad. dx and dy are parts of the screen, like move's x and y
        (0.1: a tenth of the screen). finished: the fingers lifted, so the scrolling may glide on."""
        flags = SCROLL_FINGER
        if finished:
            flags = flags | SCROLL_FINISH
        self.send("NotifyPointerAxis", GLib.Variant("(ddu)", (dx * self.logical_width, dy * self.logical_height, flags)))

    def key(self, code: int, pressed: bool) -> None:
        """A key by its Linux key code (KEY_A is 30), like a real keyboard: the keyboard layout decides what it types."""
        self.send("NotifyKeyboardKeycode", GLib.Variant("(ub)", (code, pressed)))

    def type_text(self, text: str) -> None:
        """Types text from the phone's own keyboard: a key press for each character, by its X keysym. Mutter picks the
        key and adds Shift when it needs it; only characters the computer's keyboard layout has come out."""
        for character in text:
            code = ord(character)
            if character == "\n":
                keysym = 0xFF0D
            elif character == "\t":
                keysym = 0xFF09
            elif 0x20 <= code <= 0x7E or 0xA0 <= code <= 0xFF:
                keysym = code
            else:
                # Unicode keysyms.
                keysym = 0x01000000 + code
            self.send("NotifyKeyboardKeysym", GLib.Variant("(ub)", (keysym, True)))
            self.send("NotifyKeyboardKeysym", GLib.Variant("(ub)", (keysym, False)))
