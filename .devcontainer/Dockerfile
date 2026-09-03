FROM mcr.microsoft.com/devcontainers/base:bookworm

# chromium: scripts/print_slides_pdfs.py drives it headless.
# fonts-urw-base35: metric-compatible Palatino/Book Antiqua, as the CI job installs.
RUN apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        fonts-urw-base35 \
    && rm -rf /var/lib/apt/lists/*

# Chrome's own sandbox needs namespace privileges the container deliberately
# lacks; it only ever loads locally rendered decks here.
RUN printf '%s\n' 'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --no-sandbox --disable-dev-shm-usage"' \
        > /etc/chromium.d/container

ENV UV_INSTALL_DIR=/usr/local/bin
RUN curl -LsSf https://astral.sh/uv/install.sh | sh

# Owned by vscode so the uv cache and Claude config volumes are writable without sudo.
RUN install -d -o vscode -g vscode /home/vscode/.cache /home/vscode/.cache/uv /home/vscode/.claude

# Put the venv on PATH for login shells too (remoteEnv only covers the CLI/editor).
RUN printf '%s\n' '[ -n "$VIRTUAL_ENV" ] && PATH="$VIRTUAL_ENV/bin:$PATH"' > /etc/profile.d/10-venv.sh
