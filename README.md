# Skyline Solana Programs

## Docker build

Builds the Skyline Solana program in a reproducible, isolated environment.

It installs:
- Rust 1.89.0
- Agave (Solana CLI) v3.0.13
- Node.js 20 LTS + Yarn
- Anchor CLI v0.32.1

It then compiles the program and produces artifacts:
- `target/deploy/skyline_program.so` — compiled program binary
- `target/deploy/skyline_program-keypair.json` — program keypair (fixed Program ID)
- `target/idl/skyline_program.json` — Anchor IDL

> The `program_build/skyline_program-keypair.json` is copied into the build to ensure
> the Program ID stays consistent across all builds.

---

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) installed and running
- `program_build/skyline_program-keypair.json` present in the project root

---

## Project Structure

```
.
├── Dockerfile
├── Anchor.toml
├── Cargo.toml
├── Cargo.lock
├── rust-toolchain.toml
├── package.json
├── yarn.lock
├── program_build/
│   └── skyline_program-keypair.json   ← fixed Program ID keypair
└── programs/
    └── skyline_program/
        └── src/
            └── lib.rs
            ...
```

---

## Usage

### 1. Build the Docker Image

```bash
docker build -f dockerfile -t solana-program-builder .
```

> First build takes ~15–20 min (compiles Rust toolchain + Anchor CLI).
> Subsequent builds are faster due to Docker layer caching.

### 2. Export Artifacts to `program_build`

```bash
# Runs container and automatically copies:
# - skyline_program-keypair.json
# - skyline_program.json
# - skyline_program.so
# into ./program_build on your machine
docker run --rm \
  -v "$(pwd)/program_build:/artifacts" \
  solana-program-builder
```

### 3. Verify Exported Files

```bash
ls -lh ./program_build/
solana-keygen pubkey ./program_build/skyline_program-keypair.json
```

---

## Artifacts

| File | Location (inside container) | Description |
|------|-----------------------------|-------------|
| `skyline_program.so` | `/app/target/deploy/` | Compiled program binary |
| `skyline_program-keypair.json` | `/app/target/deploy/` | Program keypair — determines Program ID |
| `skyline_program.json` | `/app/target/idl/` | Anchor IDL — used by frontend/client |

---
