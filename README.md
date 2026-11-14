# Desktop

This computer's whole screen on your phone, with mouse and keyboard, at `https://h.shuchen.ca/desktop/`. A proof of concept.

```text
phone ──► h.shuchen.ca ──► forwarder ──► Seraph's Caddy ──► /desktop* ──► server.py (127.0.0.1:8020)
                                                                              │
                                              GNOME (Mutter's remote desktop API) ◄─┘  screen as JPEG frames, input back
```

- **No new setup.** It rides on Seraph's remote access: the same domain, tunnel and Caddy (`~/dev/github_searcher/remote_access/Caddyfile` passes `/desktop*` here), and the same passkeys. Your phone signs in with Face ID and the passkey it already has for Seraph.
- **Its own sign in.** Seraph's session doesn't open the desktop: you sign in here once more, and a desktop session lasts 7 days. Removing the phone in Seraph (Settings → Remote access) also ends its desktop sessions within 30 seconds.
- **GNOME's own screen sharing.** It uses Mutter's D-Bus API, the one GNOME's Remote Desktop uses, so it works on Wayland without a permission dialog. While the phone views, GNOME shows its screen sharing icon in the top bar. Stopping it there disconnects the phone.
- **On this computer** `http://localhost:8020/desktop/` opens it without sign in (a mirror of your own screen).

## Run

```bash
cp fedora-remote.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user start fedora-remote          # now
systemctl --user enable fedora-remote         # also at every boot (with lingering on: loginctl enable-linger)
journalctl --user -u fedora-remote -f         # log
```

It is enabled, and lingering is on, so it starts at boot before anyone logs in, like Seraph's `seraph-caddy` and `seraph-tunnel`.

Or `python3 server.py` in the foreground. It uses the system Python (Fedora's `python3-gobject`, `python3-aiohttp`, `python3-cryptography`, GStreamer with `pipewire-gstreamer`).

## On the phone

Open `https://h.shuchen.ca/desktop/` in Safari. Share → **Add to Home Screen** makes it open full screen like an app (it signs in once more there).

- **Trackpad** (the default): one finger moves the pointer (the small ring), tap to click, tap then drag to drag, two fingers to scroll, two finger tap to right click, pinch to zoom (the view follows the pointer).
- **Touch**: tap where you want to click, hold to right click, one finger drags, two fingers scroll, pinch to zoom and move around.
- **Keyboard** (the bar at the bottom) opens a keyboard laid out like the iPhone's, in pages:
  - **Letters**, with `,` and `.` (Shift makes them `<` and `>`). **123**: numbers and the common symbols. **#+=**: the other symbols. **Fn**: F1–F12, Insert, Delete, Home, End, Page Up, Page Down, Caps Lock, Print Screen.
  - Above every page, a strip: **Esc**, **Tab**, **Ctrl**, **Alt**, **Super** and the arrows.
  - Keys go down when touched and up when let go, as real key presses, so holding one repeats it.
  - **⇧**, **Ctrl** and **Alt**: tap for the next key or click, tap twice to keep them on (a white line), tap again for off. Or hold one with a finger while pressing another key.
  - **Super**: tap for Activities, hold it for Super+key.
  - A key still held when the connection drops is let go on the computer.
- **On its side** the keyboard is a panel at the side, over the screen, and the screen's picture fits in the space next to it. Drag the panel's grip to make the keyboard wider or narrower, tap the grip to tuck the keyboard into the edge (the picture gets the whole width) and tap it again to bring it back. **⇄** moves it to the other side. Width, side and tucked are remembered.
- **Phone keyboard** brings up the iPhone's own keyboard instead, for typing text (dictation and predictions work), with the strip and a ⇧ above it, so Ctrl+C and the like still work.
- The page itself never zooms (no double tap zoom). **Fit** zooms the screen back out, and undoes a page zoom if one got through.
- **Quality**: Low (1280 wide), Medium (1920), High (the screen's full 2560). Frames only go as fast as the phone draws them, so a slow network makes the picture slower, not later.
- **Hide** hides the bar and keyboard, **Show** brings them back.
- **Terminal** (in the bar, or `https://h.shuchen.ca/desktop/terminal`) is a shell on the computer, behind the same sign in. Tap it for the phone's keyboard; the row at the bottom has Esc, Tab, Ctrl, Alt, ^C, the arrows and A−/A+ for the text size. The shell runs in tmux (session `phone`), so it keeps running when the phone's connection drops, and the next visit picks it up. It needs no GNOME session: it works at the login screen too.
- **Lid closed**: with no monitor on, the picture comes from a virtual 1920x1200 monitor that GNOME makes for the session (and removes after). Closing the lid while watching switches to it by itself.

## Away from the computer

What keeps it reachable, and what still needs someone at the computer.

- **Already set:** the computer never sleeps (lid close is ignored, `/etc/systemd/logind.conf.d/90-lid-ignore.conf`, and GNOME's automatic suspend is off), lingering is on, and this server, Caddy and the tunnel start at boot. Wi-Fi (`BG-YG`) is a system connection, so it connects before anyone logs in.
- **A reboot stops at the disk password** (the disk is encrypted with LUKS) until it is unlocked by the TPM:

  ```bash
  sudo systemd-cryptenroll --tpm2-device=auto --tpm2-pcrs=7 /dev/nvme0n1p3
  # then in /etc/crypttab add tpm2-device=auto to that disk's options (the 4th column), and:
  echo 'add_dracutmodules+=" tpm2-tss "' | sudo tee /etc/dracut.conf.d/tpm2.conf
  sudo dracut -f
  ```

  The passphrase still works too. Someone who takes the laptop then gets to the login screen without it (they still need your password there).
- **After a reboot, the screen view needs a GNOME session.** Without one, Terminal still works. For the screen view too: Settings → System → Users → Automatic Login (anyone who powers it on gets your desktop).
- **Off** (power cut, empty battery) can't be undone from afar. Keep it plugged in; some BIOSes can power on by themselves when power comes back.
- **The `/desktop` route in Seraph's Caddyfile** isn't committed in `~/dev/github_searcher`: commit it, or a checkout can lose it.
- **New devices** are only added on the computer (Seraph → Settings → Remote access): add a second one before leaving, in case the phone is lost.

## Files

- `desktop.py`: the screen (Mutter screen cast → PipeWire → GStreamer → JPEG) and input (Mutter remote desktop session).
- `sign_in.py`: the passkey check, against Seraph's devices in `~/seraph/data/remote_access.json` (read only), and the desktop's sessions in `data/sessions.json`.
- `server.py`: the web server, the screen's websocket and the terminal's.
- `static/`: the viewer (`index.html`, `viewer.js`), the terminal (`terminal.html`, `terminal.js`, xterm.js in `vendor/`) and the Sign in page.

## Limits

- The main monitor only (or the virtual one when none is on).
- The keyboard is a US one: the labels match a US layout on the computer.
- A locked computer: the lock screen should show and take the password (not tried yet). A suspended or powered off one can't be reached.
