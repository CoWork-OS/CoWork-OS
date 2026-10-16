# The desktop a CoWork bot works on when its "Works on" setting is "Its own desktop".
# Built locally on first use; CoWork runs one container per bot, as user "bot", with no
# capabilities, resource limits, and only the viewer port published on 127.0.0.1. The viewer
# passwords are written in after start (see start-desktop.sh), never set as environment.
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
      novnc \
      openbox \
      procps \
      scrot \
      tini \
      websockify \
      x11vnc \
      xdotool \
      xterm \
      xvfb \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 1000 --shell /bin/bash bot

COPY start-desktop.sh /usr/local/bin/start-desktop
RUN chmod 0755 /usr/local/bin/start-desktop

USER bot
WORKDIR /home/bot
ENV DISPLAY=:1 \
    SCREEN_SIZE=1280x800x24

EXPOSE 6080
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/start-desktop"]
