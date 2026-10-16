#!/bin/sh
# Starts the bot's desktop: a virtual screen, a window manager, and a password-protected
# web viewer on port 6080. CoWork writes the viewer passwords to $HOME/.vnc/passwd right
# after the container starts (a full-access one, then a view-only one after
# __BEGIN_VIEWONLY__); they never pass through the environment, and x11vnc deletes the file
# once read.
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

i=0
until [ -s "$HOME/.vnc/passwd" ]; do
  i=$((i + 1))
  if [ "$i" -gt 600 ]; then
    echo "No viewer password arrived" >&2
    exit 1
  fi
  sleep 0.1
done

x11vnc -display "$DISPLAY" -passwdfile "rm:$HOME/.vnc/passwd" -localhost -rfbport 5900 \
  -forever -shared -quiet >/tmp/x11vnc.log 2>&1 &

exec websockify --web /usr/share/novnc 6080 localhost:5900
