# The desktop a CoWork bot works on when its "Works on" setting is "Its own desktop".
# Built locally on first use; CoWork runs one container per bot, as user "bot", with no
# capabilities, resource limits, and only the viewer port published on 127.0.0.1. The viewer
# passwords are written in after start (see start-desktop.sh), never set as environment.
# Its network is limited right after start by cowork-network, run from a separate short-lived
# container that shares its network namespace.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      chromium \
      fonts-dejavu-core \
      fonts-liberation \
      fonts-noto-cjk \
      fonts-noto-color-emoji \
      iptables \
      novnc \
      nodejs \
      openbox \
      procps \
      python3 \
      python3-xlib \
      scrot \
      tini \
      websockify \
      x11vnc \
      xdotool \
      xterm \
      xvfb \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 1000 --shell /bin/bash bot

# The bot's files. Owned by the bot in the image, so a new Docker volume mounted here (on a
# server, or on Linux) starts out writable by the bot instead of owned by root.
RUN install -d -o bot -g bot -m 0755 /home/bot/work

COPY start-desktop.sh /usr/local/bin/start-desktop
# Teach a task: records what the person does on this desktop and plays it back.
COPY cowork-teach.py /usr/local/bin/cowork-teach
# The network limit; only the helper container runs it (as root, with NET_ADMIN).
COPY cowork-network.sh /usr/local/bin/cowork-network
RUN chmod 0755 /usr/local/bin/start-desktop /usr/local/bin/cowork-teach /usr/local/bin/cowork-network

USER bot
WORKDIR /home/bot
ENV DISPLAY=:1 \
    SCREEN_SIZE=1280x800x24

EXPOSE 6080
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/start-desktop"]
