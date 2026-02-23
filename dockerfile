FROM ubuntu:24.04 AS builder

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC

# ── System dependencies ──────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y \
    curl \
    git \
    wget \
    bzip2 \
    build-essential \
    pkg-config \
    libudev-dev \
    llvm \
    clang \
    libssl-dev \
    ca-certificates \
    tzdata \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# ── Install rustup + Rust 1.89.0 ─────────────────────────────────────────────
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
    sh -s -- -y --no-modify-path --profile minimal --default-toolchain 1.89.0 && \
    rustup component add rustfmt clippy

# ── Install Agave (Solana CLI) v3.0.13 ───────────────────────────────────────
# Source: https://github.com/anza-xyz/agave/releases/tag/v3.0.13
ENV AGAVE_VERSION=v3.0.13
ENV SOLANA_INSTALL_DIR=/usr/local/solana

RUN mkdir -p ${SOLANA_INSTALL_DIR} && \
    curl -fsSL "https://github.com/anza-xyz/agave/releases/download/${AGAVE_VERSION}/solana-release-x86_64-unknown-linux-gnu.tar.bz2" \
    -o /tmp/agave.tar.bz2 && \
    tar -xjf /tmp/agave.tar.bz2 -C ${SOLANA_INSTALL_DIR} --strip-components=1 && \
    rm /tmp/agave.tar.bz2

ENV PATH="${SOLANA_INSTALL_DIR}/bin:$PATH"

# ── Verify Agave installed correctly ─────────
RUN solana --version && solana-keygen --version

# ── Install Node.js 20 LTS + Yarn ────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g yarn && \
    rm -rf /var/lib/apt/lists/*

# ── Install Anchor CLI v0.32.1 ────────────────────────────────────────────────
RUN cargo install --git https://github.com/coral-xyz/anchor \
    anchor-cli --tag v0.32.1 --locked

# ── Working directory ─────────────────────────────────────────────────────────
WORKDIR /app

# ── Copy dependency files (layer caching) ────────────────────────────────────
COPY Anchor.toml ./
COPY Cargo.toml ./
COPY Cargo.lock ./
COPY rust-toolchain.toml ./
COPY package.json ./
COPY yarn.lock ./

# ── Copy program source ───────────────────────────────────────────────────────
COPY programs/ ./programs/

# ── Install JS dependencies ───────────────────────────────────────────────────
RUN yarn install --frozen-lockfile

# ── Copy keypair (preserves Program ID) ────────────────────────────────
RUN mkdir -p target/deploy
COPY keypairs/skyline_program-keypair.json ./target/deploy/skyline_program-keypair.json

# ── Verify Program ID ─────────────────────────────────────────────────────────
RUN echo ">>> PROGRAM ID:" && \
    solana-keygen pubkey target/deploy/skyline_program-keypair.json

# ── Build ─────────────────────────────────────────────────────────────────────
RUN anchor build

# Artifacts at:
#   /app/target/deploy/skyline_program.so
#   /app/target/deploy/skyline_program-keypair.json
