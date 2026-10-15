#!/bin/sh
# Starts the bot's desktop: a virtual screen, a window manager, and a password-protected
# web viewer on port 6080. VNC_PASSWORD comes from CoWork and is not kept in the environment.
set -eu

mkdir -p "$HOME/.vnc" "$HOME/work"

Xvfb "$DISPLAY" -screen 0 "$SCREEN_SIZE" -nolisten tcp >/tmp/xvfb.log 2>&1 &
i=0
until xdotool getdisplaygeometry >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 100 ]; then
    echo "The virtual screen did not start" >&2
    exit 1
  fi
  sleep 0.1
done

openbox >/tmp/openbox.log 2>&1 &

x11vnc -storepasswd "${VNC_PASSWORD:?VNC_PASSWORD is required}" "$HOME/.vnc/passwd" >/dev/null 2>&1
unset VNC_PASSWORD
x11vnc -display "$DISPLAY" -rfbauth "$HOME/.vnc/passwd" -localhost -rfbport 5900 \
  -forever -shared -quiet >/tmp/x11vnc.log 2>&1 &

exec websockify --web /usr/share/novnc 6080 localhost:5900
