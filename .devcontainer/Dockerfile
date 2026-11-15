# 26.04, for Mesa 25+: the RADV Vulkan driver for the RDNA4 GPU on the host needs it.
FROM ubuntu:26.04

# Set build arguments
ARG USERNAME="devc"
ARG NODE_VERSION="24.22.2"
ARG PLAYWRIGHT_VERSION="1.64.1"
ARG CHROME_DEVTOOLS_MCP_VERSION="1.12.0"
ARG ADDITIONAL_PACKAGES="ca-certificates curl xz-utils jq python3 make iputils-ping dnsutils \
    xvfb x11vnc novnc websockify fonts-liberation fonts-noto-color-emoji \
    mesa-vulkan-drivers libvulkan1 vulkan-tools"
ARG TARGETARCH

RUN apt update && \
    apt install -y $ADDITIONAL_PACKAGES && \
    apt clean

# Node from the official tarball, because the image must have it before the features run: the
# Playwright step below needs it.
RUN case "$TARGETARCH" in amd64|"") arch=x64 ;; arm64) arch=arm64 ;; *) echo "no node for $TARGETARCH"; exit 1 ;; esac && \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz" \
    | tar -xJ -C /usr/local --strip-components=1 --exclude CHANGELOG.md --exclude README.md --exclude LICENSE

# Chromium, installed when the image builds. At runtime the egress filter blocks the Playwright
# CDN, and the sandbox feature removes sudo, so apt cannot install the libraries then.
# Google Chrome 137 and later ignores --load-extension. This Chromium build does not.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN npx -y "playwright@${PLAYWRIGHT_VERSION}" install --with-deps chromium && \
    chrome="$(find /opt/playwright -type f -name chrome -path '*chrome-linux*' | head -n 1)" && \
    test -x "$chrome" && \
    ln -s "$chrome" /usr/local/bin/chromium && \
    chromium --version && \
    apt clean

# The MCP server that lets Claude drive the browser over CDP. Installed here, so it does not need
# the npm registry each time it starts.
RUN npm install -g "chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION}" && npm cache clean --force

# Rename the stock uid-1000 `ubuntu` user (inherited from the Ubuntu base image) to "devc".
RUN usermod -l $USERNAME -d /home/$USERNAME -m ubuntu && \
    groupmod -n $USERNAME ubuntu

# Where the repo gets mounted. Must match `workspaceFolder` in devcontainer.json and the bind
# mount in docker-compose.yaml.
ARG WORKSPACE_DIR=/workspaces/kneeboard
WORKDIR $WORKSPACE_DIR
