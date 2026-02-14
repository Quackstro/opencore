#!/bin/bash
#
# Install faster-whisper for voice-call-open plugin
#
# Usage: ./install-whisper.sh [model]
#   model: tiny, base, small, medium, large (default: base)
#

set -e

MODEL="${1:-base}"
CACHE_DIR="${HOME}/.cache/huggingface/hub"

echo "============================================"
echo "  Installing faster-whisper (model: $MODEL)"
echo "============================================"

# Check Python version
if ! command -v python3 &> /dev/null; then
    echo "Error: python3 not found. Please install Python 3.8+."
    exit 1
fi

PYTHON_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
echo "Python version: $PYTHON_VERSION"

# Check pip
if ! python3 -m pip --version &> /dev/null; then
    echo "Error: pip not found. Please install pip."
    exit 1
fi

# Install faster-whisper
echo ""
echo "Installing faster-whisper..."
python3 -m pip install --upgrade faster-whisper

# Download model
echo ""
echo "Downloading Whisper model: $MODEL"
echo "This may take a while for larger models..."

python3 << EOF
from faster_whisper import WhisperModel

print(f"Loading model: $MODEL")
print(f"Cache directory: $CACHE_DIR")

# This will download the model if not cached
model = WhisperModel("$MODEL", device="cpu", compute_type="int8")

print("Model loaded successfully!")
print(f"Model size: $MODEL")
EOF

echo ""
echo "============================================"
echo "  Installation complete!"
echo "============================================"
echo ""
echo "faster-whisper is ready to use with model: $MODEL"
echo ""
echo "To verify, run:"
echo "  python3 -c \"from faster_whisper import WhisperModel; print('OK')\""
echo ""
echo "Model files are cached at: $CACHE_DIR"
