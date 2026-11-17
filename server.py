"""The desktop's web server: this PC's screen, mouse and keyboard in a phone's browser, at
https://<Seraph's remote access domain>/desktop/.

Seraph's Caddy (~/dev/github_searcher/remote_access/Caddyfile) passes /desktop* here, to 127.0.0.1:PORT. Through the
domain every request needs a desktop session (sign_in.py), except the Sign in page and its two calls. On this
computer (http://localhost:PORT/desktop/) there is no sign in.

- GET /desktop/: the viewer (static/index.html, static/viewer.js).
- GET /desktop/sign_in: Sign in with the passkey. POST /desktop/sign_in/options gives a challenge, POST
  /desktop/sign_in checks the passkey's answer and sets the session cookie. POST /desktop/sign_out ends it.
- GET /desktop/session: 200 while signed in, so the viewer can tell a lost connection from a lost sign in.
- GET /desktop/socket: the websocket. The screen goes to the phone as JPEG frames (binary); the phone sends input as
  JSON, and {"type": "ack"} for each frame it has drawn. A frame goes only while the phone has fewer than
  FRAMES_AHEAD frames it hasn't drawn yet, and always the newest: on a slow network the picture comes less often
  instead of falling behind. Keys and buttons a viewer still holds when it goes are let go.
- GET /desktop/terminal: a terminal (static/terminal.html, terminal.js, xterm.js in static/vendor). Its websocket,
  GET /desktop/terminal/socket, runs a shell on a pseudo terminal: what the shell writes goes to the phone (binary),
  the phone sends {"type": "input", "data"} and {"type": "resize", "rows", "cols"}. The shell is in tmux (the session
  TERMINAL_SESSION), so it keeps running when the connection drops and the next one picks it up. It needs no GNOME
  session: it works at the login screen too, as long as this server runs (it starts at boot, deploy notes in README).

The screen is shared (desktop.py) while a viewer is open, and stops STOP_SECONDS after the last one closes.
"""

import asyncio
import fcntl
import json
import os
import pty
import shutil
import struct
import subprocess
import termios
from pathlib import Path

from aiohttp import WSMsgType, web
from cryptography.exceptions import UnsupportedAlgorithm
from dotenv import load_dotenv

from desktop import Desktop, DesktopError
from sign_in import COOKIE, DOMAIN, ORIGIN, SESSION_DAYS, SignIn, SignInError

load_dotenv(Path(__file__).resolve().parent / ".env", override=True)

PORT = int(os.environ["DESKTOP_PORT"])
STATIC = Path(__file__).resolve().parent / "static"
OPEN_PATHS = ["/desktop/sign_in", "/desktop/sign_in/options"]
# Asked for without a sign in, these send to the Sign in page. Everything else answers 401.
PAGES = ["/desktop", "/desktop/", "/desktop/terminal"]
LOCAL_HOSTS = [f"localhost:{PORT}", f"127.0.0.1:{PORT}"]
FRAMES_AHEAD = 2
STOP_SECONDS = int(os.environ["STOP_SECONDS"])
# How often an open viewer's sign in is checked again (a device removed in Seraph, a session over).
CHECK_SECONDS = 30
# Linux key codes go up to KEY_MAX.
MAX_KEY_CODE = 0x2FF
MAX_TEXT = 2000
TMUX = shutil.which("tmux")
TERMINAL_SESSION = os.environ["TERMINAL_SESSION"]

desktop = Desktop()
sign_in = SignIn()
# The open viewers: {"socket", "wake" (an asyncio.Event: a new frame or an ack), "sent" (the frame number sent last),
# "ahead" (frames sent but not drawn yet), "cookie", "keys" and "buttons" (the ones it holds down right now)}.
viewers = []
start_lock = asyncio.Lock()
loop = None


@web.middleware
async def check_sign_in(request, handler):
    if sign_in.from_outside(request.headers):
        if request.path not in OPEN_PATHS and sign_in.device_for(request.cookies.get(COOKIE)) is None:
            if request.path in PAGES:
                raise web.HTTPFound("/desktop/sign_in")
            raise web.HTTPUnauthorized(text="Not signed in.")
    elif request.headers.get("Host") not in LOCAL_HOSTS:
        # Neither the domain nor this computer's own address: a web page that points its own name at 127.0.0.1.
        raise web.HTTPForbidden(text="Wrong address.")
    response = await handler(request)
    if not response.prepared:
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Frame-Options"] = "DENY"
    return response


async def page(request):
    if request.path == "/desktop":
        raise web.HTTPFound("/desktop/")
    return web.FileResponse(STATIC / "index.html")


async def viewer_script(request):
    return web.FileResponse(STATIC / "viewer.js")


async def session(request):
    return web.json_response({"ok": True})


async def sign_in_page(request):
    return web.FileResponse(STATIC / "sign_in.html")


async def sign_in_options(request):
    try:
        challenge = sign_in.new_challenge()
    except SignInError as error:
        return web.json_response({"detail": str(error)}, status=429)
    return web.json_response({"challenge": challenge, "rp_id": DOMAIN})


async def sign_in_answer(request):
    try:
        body = await request.json()
        assertion = {
            "id": str(body["id"]),
            "client_data": str(body["client_data"]),
            "authenticator_data": str(body["authenticator_data"]),
            "signature": str(body["signature"]),
        }
        cookie = sign_in.sign_in(assertion)
    except SignInError as error:
        return web.json_response({"detail": str(error)}, status=400)
    except (KeyError, TypeError, ValueError, UnsupportedAlgorithm):
        return web.json_response({"detail": "That passkey's answer couldn't be read. Try again."}, status=400)
    response = web.json_response({"ok": True})
    response.set_cookie(COOKIE, cookie, max_age=SESSION_DAYS * 86400, path="/desktop", httponly=True, secure=True, samesite="Lax")
    return response


async def sign_out(request):
    sign_in.sign_out(request.cookies.get(COOKIE))
    response = web.json_response({"ok": True})
    response.del_cookie(COOKIE, path="/desktop")
    return response


def new_frame():
    # GStreamer's thread: wake the viewers on the event loop.
    loop.call_soon_threadsafe(wake_viewers)


def wake_viewers():
    for viewer in viewers:
        viewer["wake"].set()


def sharing_closed(monitor_gone):
    # GLib's thread: Stop in GNOME's top bar, GNOME ended the session, or the monitor went away (the lid closed).
    loop.call_soon_threadsafe(close_viewers, monitor_gone)


def close_viewers(monitor_gone):
    desktop.stop()
    if monitor_gone and len(viewers) > 0:
        # The viewers stay: the picture comes back from whatever screen there is now (a virtual one with the lid closed).
        print("desktop: the monitor went away, starting again", flush=True)
        asyncio.create_task(start_again())
        return
    for viewer in viewers:
        asyncio.create_task(say_and_close(viewer["socket"], {"type": "stopped", "text": "Screen sharing was stopped on the computer."}))


async def start_again():
    async with start_lock:
        try:
            await loop.run_in_executor(None, desktop.start)
        except DesktopError as error:
            for viewer in viewers:
                asyncio.create_task(say_and_close(viewer["socket"], {"type": "error", "text": str(error)}))
            return
    print("desktop: sharing the screen", "(a virtual monitor)" if desktop.virtual else "", flush=True)
    wake_viewers()


async def say(socket, message):
    try:
        await socket.send_json(message)
    except ConnectionResetError:
        pass


async def say_and_close(socket, message):
    await say(socket, message)
    await socket.close()


async def send_frames(viewer):
    socket = viewer["socket"]
    while True:
        await viewer["wake"].wait()
        viewer["wake"].clear()
        if viewer["ahead"] >= FRAMES_AHEAD or desktop.frame is None or viewer["sent"] == desktop.frame_number:
            continue
        viewer["sent"] = desktop.frame_number
        viewer["ahead"] += 1
        try:
            await socket.send_bytes(desktop.frame)
        except ConnectionResetError:
            return


async def check_session(viewer):
    while True:
        await asyncio.sleep(CHECK_SECONDS)
        if sign_in.device_for(viewer["cookie"]) is None:
            await say_and_close(viewer["socket"], {"type": "signed_out"})
            return


def stop_if_unused():
    if len(viewers) == 0 and desktop.running:
        desktop.stop()
        print("desktop: stopped sharing the screen", flush=True)


def handle(viewer, event):
    kind = event.get("type")
    if kind == "ack":
        viewer["ahead"] = max(0, viewer["ahead"] - 1)
        viewer["wake"].set()
    elif kind == "move":
        desktop.move(float(event["x"]), float(event["y"]))
    elif kind == "button":
        button = str(event["button"])
        down = bool(event["down"])
        desktop.button(button, down)
        if down:
            viewer["buttons"].add(button)
        else:
            viewer["buttons"].discard(button)
    elif kind == "scroll":
        desktop.scroll(float(event["dx"]), float(event["dy"]), bool(event["end"]))
    elif kind == "key":
        code = int(event["code"])
        down = bool(event["down"])
        if 0 < code <= MAX_KEY_CODE:
            desktop.key(code, down)
            if down:
                viewer["keys"].add(code)
            else:
                viewer["keys"].discard(code)
    elif kind == "text":
        desktop.type_text(str(event["text"])[:MAX_TEXT])
    elif kind == "quality":
        desktop.set_quality(str(event["quality"]))
        for each in viewers:
            asyncio.create_task(say(each["socket"], {"type": "quality", "quality": desktop.quality}))


def right_origin(request) -> bool:
    """Only this app's own pages may open its websockets: a page elsewhere can't, even in a browser that is signed in."""
    allowed = [f"http://{host}" for host in LOCAL_HOSTS]
    if sign_in.from_outside(request.headers):
        allowed = [ORIGIN]
    return request.headers.get("Origin") in allowed


async def websocket(request):
    if not right_origin(request):
        raise web.HTTPForbidden(text="Wrong origin.")
    outside = sign_in.from_outside(request.headers)

    ws = web.WebSocketResponse(heartbeat=20, max_msg_size=64 * 1024)
    await ws.prepare(request)
    viewer = {"socket": ws, "wake": asyncio.Event(), "sent": 0, "ahead": 0, "cookie": request.cookies.get(COOKIE), "keys": set(), "buttons": set()}
    viewers.append(viewer)
    tasks = []
    try:
        async with start_lock:
            if not desktop.running:
                await loop.run_in_executor(None, desktop.start)
                print("desktop: sharing the screen", "(a virtual monitor)" if desktop.virtual else "", flush=True)
        await say(ws, {"type": "quality", "quality": desktop.quality})
        # The newest frame goes at once, if there is one already.
        viewer["wake"].set()
        tasks.append(asyncio.create_task(send_frames(viewer)))
        if outside:
            tasks.append(asyncio.create_task(check_session(viewer)))
        async for message in ws:
            if message.type != WSMsgType.TEXT:
                continue
            try:
                handle(viewer, json.loads(message.data))
            except (KeyError, TypeError, ValueError, OverflowError, AttributeError):
                pass
    except DesktopError as error:
        await say_and_close(ws, {"type": "error", "text": str(error)})
    except ConnectionResetError:
        pass
    finally:
        for task in tasks:
            task.cancel()
        # A phone that lost its connection with Ctrl held would leave it held on the computer.
        for code in viewer["keys"]:
            desktop.key(code, False)
        for button in viewer["buttons"]:
            desktop.button(button, False)
        viewers.remove(viewer)
        if len(viewers) == 0:
            loop.call_later(STOP_SECONDS, stop_if_unused)
    return ws


async def terminal_page(request):
    return web.FileResponse(STATIC / "terminal.html")


async def terminal_script(request):
    return web.FileResponse(STATIC / "terminal.js")


async def terminal_socket(request):
    if not right_origin(request):
        raise web.HTTPForbidden(text="Wrong origin.")
    ws = web.WebSocketResponse(heartbeat=20, max_msg_size=64 * 1024)
    await ws.prepare(request)

    command = [os.environ.get("SHELL", "/bin/bash"), "-l"]
    if TMUX is not None:
        # Its own systemd scope, so tmux (and the shell in it) also outlives a restart of this server.
        command = ["systemd-run", "--user", "--scope", "--quiet", TMUX, "new-session", "-A", "-s", TERMINAL_SESSION]
    env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor")
    master, slave = pty.openpty()
    # setsid -c: a session of its own, with the pseudo terminal as its controlling terminal (job control, Ctrl+C).
    shell = subprocess.Popen(["setsid", "-c"] + command, stdin=slave, stdout=slave, stderr=slave, cwd=Path.home(), env=env, close_fds=True)
    os.close(slave)
    os.set_blocking(master, False)
    output = asyncio.Queue()

    def readable():
        try:
            data = os.read(master, 65536)
        except BlockingIOError:
            return
        except OSError:
            # EIO: the shell (or the tmux client) ended.
            data = b""
        output.put_nowait(data)
        if not data:
            loop.remove_reader(master)

    async def send_output():
        while True:
            data = await output.get()
            if not data:
                await ws.close()
                return
            try:
                await ws.send_bytes(data)
            except ConnectionResetError:
                return

    loop.add_reader(master, readable)
    tasks = [asyncio.create_task(send_output())]
    if sign_in.from_outside(request.headers):
        tasks.append(asyncio.create_task(check_session({"socket": ws, "cookie": request.cookies.get(COOKIE)})))
    try:
        async for message in ws:
            if message.type != WSMsgType.TEXT:
                continue
            try:
                event = json.loads(message.data)
                if event["type"] == "input":
                    os.write(master, str(event["data"]).encode())
                elif event["type"] == "resize":
                    rows = min(max(int(event["rows"]), 1), 500)
                    cols = min(max(int(event["cols"]), 1), 500)
                    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            except (KeyError, TypeError, ValueError, OSError):
                pass
    finally:
        for task in tasks:
            task.cancel()
        loop.remove_reader(master)
        # Hangs up the terminal: tmux detaches (the shell keeps running in it), a plain shell ends.
        os.close(master)
        try:
            await asyncio.to_thread(shell.wait, 5)
        except subprocess.TimeoutExpired:
            shell.kill()
            await asyncio.to_thread(shell.wait)
    return ws


async def on_startup(app):
    global loop
    loop = asyncio.get_running_loop()
    desktop.on_frame = new_frame
    desktop.on_closed = sharing_closed


async def on_shutdown(app):
    for viewer in list(viewers):
        await viewer["socket"].close()
    desktop.stop()


def main():
    app = web.Application(middlewares=[check_sign_in])
    app.on_startup.append(on_startup)
    app.on_shutdown.append(on_shutdown)
    app.add_routes([
        web.get("/desktop", page),
        web.get("/desktop/", page),
        web.get("/desktop/viewer.js", viewer_script),
        web.get("/desktop/session", session),
        web.get("/desktop/sign_in", sign_in_page),
        web.post("/desktop/sign_in/options", sign_in_options),
        web.post("/desktop/sign_in", sign_in_answer),
        web.post("/desktop/sign_out", sign_out),
        web.get("/desktop/socket", websocket),
        web.get("/desktop/terminal", terminal_page),
        web.get("/desktop/terminal.js", terminal_script),
        web.get("/desktop/terminal/socket", terminal_socket),
        web.static("/desktop/vendor", STATIC / "vendor"),
    ])
    print(f"desktop: http://localhost:{PORT}/desktop/ here, https://{DOMAIN}/desktop/ from your phone", flush=True)
    web.run_app(app, host="127.0.0.1", port=PORT, access_log=None, print=None)


if __name__ == "__main__":
    main()
