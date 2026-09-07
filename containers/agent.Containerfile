FROM quay.io/fedora/fedora:44

ARG BUN_VERSION=1.4.0
ARG CODEX_VERSION=0.151.0
# Reviewed 2026-09-07 against Cloudflare's signed Fedora 44 RPM.
ARG WARP_VERSION=2026.7.1377.0
ARG WARP_RELEASE=1.fc44
ARG WARP_RPM_SHA256=266abb94326a59efac259d73a0a277dc6d2c04a463fc9413f5aaf81c892c7374
ARG WARP_KEY_SHA256=0f37fc298c98e88ee3c0ee68c95b69f1dba9eb477abe3167e13982105911264d

RUN dnf install -y \
      bash-completion \
      bzip2 \
      clang \
      cmake \
      coreutils \
      cronie \
      curl \
      diffutils \
      fd-find \
      ffmpeg-free \
      file \
      findutils \
      gcc \
      gcc-c++ \
      gh \
      git \
      git-lfs \
      glibc-langpack-en \
      glibc-langpack-ru \
      ImageMagick \
      jq \
      make \
      nano \
      nodejs \
      npm \
      openssh-clients \
      patch \
      procps-ng \
      python3 \
      python3-pip \
      ripgrep \
      rsync \
      sqlite \
      sudo \
      tar \
      tmux \
      tree \
      unzip \
      util-linux \
      wget \
      which \
      xz \
      zip \
      zstd \
    && curl -fsSL -o /tmp/bun.zip \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
    && unzip -q /tmp/bun.zip -d /tmp/bun \
    && install -m 0755 /tmp/bun/bun-linux-x64/bun /usr/local/bin/bun \
    && ln -s /usr/local/bin/bun /usr/local/bin/bunx \
    && npm install --global "@openai/codex@${CODEX_VERSION}" \
    && curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --retry 3 \
      -o /tmp/cloudflare-warp.rpm \
      "https://pkg.cloudflareclient.com/rpm/44/x86_64/cloudflare-warp-${WARP_VERSION}-${WARP_RELEASE}.x86_64.rpm" \
    && curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --retry 3 \
      -o /tmp/cloudflare-warp-key.gpg \
      https://pkg.cloudflareclient.com/pubkey.gpg \
    && printf '%s  %s\n' "${WARP_RPM_SHA256}" /tmp/cloudflare-warp.rpm | sha256sum -c - \
    && printf '%s  %s\n' "${WARP_KEY_SHA256}" /tmp/cloudflare-warp-key.gpg | sha256sum -c - \
    && rpm --import /tmp/cloudflare-warp-key.gpg \
    && rpmkeys --checksig /tmp/cloudflare-warp.rpm \
    && dnf install -y /tmp/cloudflare-warp.rpm \
    && useradd --create-home --uid 1000 --shell /bin/bash loylex \
    && printf 'loylex ALL=(ALL) NOPASSWD: ALL\n' >/etc/sudoers.d/loylex \
    && chmod 0440 /etc/sudoers.d/loylex \
    && mkdir -p /memory /workspace /opt/loylex/app \
    && chown -R loylex:loylex /memory /workspace /opt/loylex \
    && dnf clean all \
    && rm -rf /tmp/bun /tmp/bun.zip /tmp/cloudflare-warp.rpm /tmp/cloudflare-warp-key.gpg /root/.npm

RUN python3 -m pip install \
      --no-cache-dir \
      --disable-pip-version-check \
      --target /opt/loylex/python \
      "pybooru==4.2.2"

COPY --chown=root:root package.json bun.lock tsconfig.json /opt/loylex/app/
COPY --chown=root:root src /opt/loylex/app/src
COPY --chown=root:root AGENTS.md /opt/loylex/seed/AGENTS.md
COPY --chown=root:root skills /opt/loylex/seed/skills
COPY --chown=root:root memory-seed /opt/loylex/memory-seed
COPY --chmod=0755 containers/agent-entrypoint.sh /usr/local/bin/loylex-agent
COPY --chmod=0755 containers/warp-supervisor.sh /usr/local/bin/loylex-warp-supervisor
COPY --chmod=0755 containers/loylex-warp /usr/local/bin/loylex-warp
COPY --chmod=0755 containers/loylex-cli /usr/local/bin/loylex

USER loylex
WORKDIR /workspace/Loylex

ENV CODEX_HOME=/home/loylex/.codex
ENV LANG=en_US.UTF-8
ENV LOYLEX_MEMORY_PATH=/memory
ENV LOYLEX_REPOSITORY_PATH=/workspace/Loylex
ENV LOYLEX_WARP_PROXY_PORT=40000
ENV PYTHONPATH=/opt/loylex/python
ENV PATH=/home/loylex/.local/bin:/usr/local/bin:/usr/bin

ENTRYPOINT ["loylex-agent"]
