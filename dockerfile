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

# ── Install Agave (Solana CLI) v4.2.2 ────────────────────────────────────────
# Source: https://github.com/anza-xyz/agave/releases/tag/v4.2.2
ENV AGAVE_VERSION=v4.2.2
ENV SOLANA_INSTALL_DIR=/usr/local/solana

# SBPF target architecture for the program ELF. Must stay in sync with what the
# deployed cluster's loader accepts; v0 binaries are rejected on deploy/upgrade.
ENV SBF_ARCH=v3

RUN mkdir -p ${SOLANA_INSTALL_DIR} && \
    curl -fsSL "https://github.com/anza-xyz/agave/releases/download/${AGAVE_VERSION}/solana-release-x86_64-unknown-linux-gnu.tar.bz2" \
    -o /tmp/agave.tar.bz2 && \
    tar -xjf /tmp/agave.tar.bz2 -C ${SOLANA_INSTALL_DIR} --strip-components=1 && \
    rm /tmp/agave.tar.bz2

ENV PATH="${SOLANA_INSTALL_DIR}/bin:$PATH"

# ── Verify Agave installed correctly ─────────
RUN solana --version && solana-keygen --version

# ── Verify the pinned toolchain can target ${SBF_ARCH} ───────────────────────
# The possible-values list wraps across lines in --help, hence the tr.
# If this fails, bump AGAVE_VERSION to a release whose cargo-build-sbf lists it.
RUN cargo-build-sbf --help | tr '\n' ' ' | grep -qE "possible values:[^]]*\b${SBF_ARCH}\b" || \
    (echo "ERROR: cargo-build-sbf from Agave ${AGAVE_VERSION} does not support --arch ${SBF_ARCH}" && exit 1)

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
COPY tsconfig.json ./

# ── Copy program source ───────────────────────────────────────────────────────
COPY programs/ ./programs/
COPY tests/ ./tests/

# ── Install JS dependencies ───────────────────────────────────────────────────
RUN yarn install --frozen-lockfile

# ── Copy keypair (preserves Program ID) ────────────────────────────────
RUN mkdir -p target/deploy
COPY program_build/skyline_program-keypair.json ./target/deploy/skyline_program-keypair.json
COPY program_build/mpl_token_metadata.so ./program_build/mpl_token_metadata.so

# ── Verify Program ID ─────────────────────────────────────────────────────────
RUN echo ">>> PROGRAM ID:" && \
    solana-keygen pubkey target/deploy/skyline_program-keypair.json

# ── Build ─────────────────────────────────────────────────────────────────────
# Everything after `--` is forwarded verbatim to cargo-build-sbf, which defaults
# to --arch v0 when left alone. The IDL is built separately because `anchor build`
# forwards these same args to its `cargo test` IDL step, which rejects --arch.
RUN anchor build --no-idl -- --arch ${SBF_ARCH}

# ── Build the IDL + TypeScript types (same artifacts `anchor build` emits) ────
RUN mkdir -p target/idl target/types && \
    anchor idl build \
        -o target/idl/skyline_program.json \
        -t target/types/skyline_program.ts

# ── Verify the produced ELF really is ${SBF_ARCH} ────────────────────────────
# Assert on the artifact, not just on what the toolchain claims to support:
#   e_machine - a BPF/SBF object at all. Agave 4.x emits EM_BPF, which binutils
#               prints as "Linux BPF"; 3.x emitted EM_SBF, printed as 0x107.
#   e_flags   - the SBPF version number: v0 -> 0x0, v3 -> 0x3. Under EM_BPF,
#               binutils appends ", CPU Version: N", hence no end-of-line anchor.
# A silently-v0 binary builds fine here but is rejected by the loader on deploy
# and on upgrade.
RUN readelf -h target/deploy/skyline_program.so | grep -E "Machine:|Flags:" && \
    readelf -h target/deploy/skyline_program.so | grep -qE "Machine:[[:space:]]+(Linux BPF|.*0x107)" && \
    readelf -h target/deploy/skyline_program.so | grep -qE "Flags:[[:space:]]+0x${SBF_ARCH#v}([^0-9a-fA-F]|$)" || \
    (echo "ERROR: skyline_program.so is not an SBPF ${SBF_ARCH} object" && exit 1)

# Artifacts at:
#   /app/target/deploy/skyline_program.so
#   /app/target/deploy/skyline_program-keypair.json
#   /app/target/idl/skyline_program.json

# ── Runtime export directory (mount from host as /artifacts) ─────────────────
RUN mkdir -p /artifacts

# ── Default runtime: export build artifacts to mounted /artifacts ─────────────
CMD ["sh", "-c", "set -e; cp /app/target/deploy/skyline_program-keypair.json /artifacts/; cp /app/target/deploy/skyline_program.so /artifacts/; cp /app/target/idl/skyline_program.json /artifacts/; echo 'Exported artifacts to /artifacts'"]
