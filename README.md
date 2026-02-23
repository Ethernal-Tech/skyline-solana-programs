# Skyline Solana Programs

## Docker build

Builds the Skyline Solana program in a reproducible, isolated environment.

It installs:
- Rust 1.89.0
- Agave (Solana CLI) v3.0.13
- Node.js 20 LTS + Yarn
- Anchor CLI v0.32.1

It then compiles the program and produces two artifacts:
- `target/deploy/skyline_program.so` — compiled program binary
- `target/deploy/skyline_program-keypair.json` — program keypair (fixed Program ID)

> The `keypairs/skyline_program-keypair.json` is copied into the build to ensure
> the Program ID stays consistent across all builds.

---

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) installed and running
- `keypairs/skyline_program-keypair.json` present in the project root

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
├── keypairs/
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
docker build -t solana-program-builder .
```

> First build takes ~15–20 min (compiles Rust toolchain + Anchor CLI).
> Subsequent builds are faster due to Docker layer caching.

### 2. Verify the Build

```bash
# List compiled artifacts inside the container
docker run --rm solana-program-builder ls -lh /app/target/deploy/

# Print the Program ID
docker run --rm solana-program-builder \
    solana-keygen pubkey target/deploy/skyline_program-keypair.json
```

### 3. Extract Artifacts to Local Machine

```bash
# Create a temporary container
docker create --name skyline-extract solana-program-builder

# Copy compiled program binary
docker cp skyline-extract:/app/target/deploy/skyline_program.so \
    ./target/deploy/skyline_program.so

# Copy IDL file
docker cp skyline-extract:/app/target/idl/skyline_program.json \
    ./target/idl/skyline_program.json

# Copy keypair
docker cp skyline-extract:/app/target/deploy/skyline_program-keypair.json \
    ./target/deploy/skyline_program-keypair.json

# Clean up
docker rm skyline-extract
```

### 4. Interactive Shell

```bash
docker run --rm -it solana-program-builder bash
```

---

## Artifacts

| File | Location (inside container) | Description |
|------|-----------------------------|-------------|
| `skyline_program.so` | `/app/target/deploy/` | Compiled program binary |
| `skyline_program-keypair.json` | `/app/target/deploy/` | Program keypair — determines Program ID |
| `skyline_program.json` | `/app/target/idl/` | Anchor IDL — used by frontend/client |

---
