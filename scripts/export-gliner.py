#!/usr/bin/env python3
"""
Export GLiNER model to ONNX for myelin's Node.js inference pipeline.

Usage:
    pip install gliner onnx onnxruntime   # or: uv pip install gliner onnx onnxruntime
    python scripts/export-gliner.py

Outputs to models/gliner/:
    model.onnx            Full-precision ONNX model (~583 MB)
    gliner_config.json    Model configuration
    tokenizer.json        DeBERTa v2 tokenizer
    tokenizer_config.json Tokenizer settings

This is a one-time setup step. The exported model is used by
src/memory/ner.ts for pure-TypeScript NER inference.
"""

import os
import sys

MODEL_NAME = "urchade/gliner_small-v2.1"
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "models", "gliner")


def main():
    try:
        from gliner import GLiNER
    except ImportError:
        print("Error: GLiNER not installed. Run:")
        print("  pip install gliner onnx onnxruntime")
        sys.exit(1)

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    print(f"Loading {MODEL_NAME}...")
    model = GLiNER.from_pretrained(MODEL_NAME)
    model.eval()

    print(f"Exporting to ONNX in {OUTPUT_DIR}/...")
    result = model.export_to_onnx(
        save_dir=OUTPUT_DIR,
        onnx_filename="model.onnx",
        quantize=False,
    )
    print(f"Export complete: {result}")

    # Save tokenizer
    tokenizer = model.data_processor.transformer_tokenizer
    tokenizer.save_pretrained(OUTPUT_DIR)
    print("Tokenizer saved.")

    # Summary
    model_size = os.path.getsize(os.path.join(OUTPUT_DIR, "model.onnx"))
    print(f"\nDone! Model size: {model_size / 1024 / 1024:.1f} MB")
    print("The model is gitignored (*.onnx). Run this script on each machine.")


if __name__ == "__main__":
    main()
