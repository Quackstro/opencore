#!/bin/bash
#
# Install Piper TTS for voice-call-open plugin
#
# Usage: ./install-piper.sh [voice]
#   voice: e.g., en_US-amy-medium, en_US-lessac-medium (default: en_US-amy-medium)
#

set -e

VOICE="${1:-en_US-amy-medium}"
PIPER_DIR="${HOME}/.openclaw/piper"
PIPER_VERSION="2023.11.14-2"

echo "============================================"
echo "  Installing Piper TTS (voice: $VOICE)"
echo "============================================"

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
    x86_64)
        PIPER_ARCH="amd64"
        ;;
    aarch64)
        PIPER_ARCH="arm64"
        ;;
    armv7l)
        PIPER_ARCH="armv7"
        ;;
    *)
        echo "Error: Unsupported architecture: $ARCH"
        exit 1
        ;;
esac

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
echo "Detected: $OS $ARCH -> piper $PIPER_ARCH"

# Create directories
mkdir -p "$PIPER_DIR"
mkdir -p "${HOME}/.local/bin"

# Check if Piper is already installed
if command -v piper &> /dev/null; then
    PIPER_PATH=$(command -v piper)
    echo "Piper already installed at: $PIPER_PATH"
    PIPER_INSTALLED=true
else
    PIPER_INSTALLED=false
fi

# Download and install Piper binary if not installed
if [ "$PIPER_INSTALLED" = false ]; then
    echo ""
    echo "Downloading Piper binary..."

    PIPER_RELEASE="https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}"
    PIPER_FILE="piper_${OS}_${PIPER_ARCH}.tar.gz"
    PIPER_URL="${PIPER_RELEASE}/${PIPER_FILE}"

    cd /tmp
    curl -L -o "$PIPER_FILE" "$PIPER_URL"
    tar -xzf "$PIPER_FILE"
    
    # Install to local bin
    mv piper/piper "${HOME}/.local/bin/"
    mv piper/piper_phonemize.so "${HOME}/.local/bin/" 2>/dev/null || true
    mv piper/espeak-ng-data "${HOME}/.local/share/" 2>/dev/null || true
    rm -rf piper "$PIPER_FILE"

    chmod +x "${HOME}/.local/bin/piper"
    echo "Piper installed to: ${HOME}/.local/bin/piper"

    # Add to PATH if needed
    if [[ ":$PATH:" != *":${HOME}/.local/bin:"* ]]; then
        echo ""
        echo "NOTE: Add this to your shell profile (.bashrc, .zshrc, etc.):"
        echo "  export PATH=\"\${HOME}/.local/bin:\$PATH\""
    fi
fi

# Download voice model
echo ""
echo "Downloading voice model: $VOICE"

# Parse voice name
# Format: {lang}_{region}-{name}-{quality}
# Example: en_US-amy-medium

LANG=$(echo "$VOICE" | cut -d'-' -f1)
NAME=$(echo "$VOICE" | cut -d'-' -f2)
QUALITY=$(echo "$VOICE" | cut -d'-' -f3)

VOICE_DIR="${PIPER_DIR}/${VOICE}"
mkdir -p "$VOICE_DIR"

BASE_URL="https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0"
MODEL_URL="${BASE_URL}/${LANG}/${VOICE}/${VOICE}.onnx"
CONFIG_URL="${BASE_URL}/${LANG}/${VOICE}/${VOICE}.onnx.json"

echo "Downloading model..."
curl -L -o "${VOICE_DIR}/${VOICE}.onnx" "$MODEL_URL"

echo "Downloading config..."
curl -L -o "${VOICE_DIR}/${VOICE}.onnx.json" "$CONFIG_URL"

echo ""
echo "============================================"
echo "  Installation complete!"
echo "============================================"
echo ""
echo "Piper TTS is ready with voice: $VOICE"
echo ""
echo "Voice files installed at: $VOICE_DIR"
echo ""
echo "To test, run:"
echo "  echo 'Hello, this is a test.' | ${HOME}/.local/bin/piper --model ${VOICE_DIR}/${VOICE}.onnx --output_file test.wav"
echo "  aplay test.wav  # or ffplay test.wav"
echo ""
echo "Available voices: https://rhasspy.github.io/piper-samples/"
echo ""
echo "To install additional voices:"
echo "  $0 <voice_name>"
