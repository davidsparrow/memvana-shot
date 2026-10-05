# Third-party notices

Memvana Shot's own code is under the MIT License (see [LICENSE](LICENSE)).

## Bundled packages

`mcp/dist/` contains bundled copies of a few npm packages (the MCP SDK, zod,
Hugging Face tokenizers and their dependencies). Their licenses are reproduced
in [mcp/dist/THIRD_PARTY_NOTICES.md](mcp/dist/THIRD_PARTY_NOTICES.md).

## Downloaded when you turn on semantic search

Semantic search is optional. Nothing below is included in this repository.
When you agree to set it up, Memvana Shot downloads these components once,
checks each file against a pinned hash, and runs them on your Mac.

### EmbeddingGemma 300M

- Publisher: Google
- Files: the 4-bit ONNX export published by
  [onnx-community/embeddinggemma-300m-ONNX](https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX),
  pinned to revision `5090578d9565bb06545b4552f76e6bc2c93e4a66`
- License: [Gemma Terms of Use](https://ai.google.dev/gemma/terms)

Gemma is provided under and subject to the Gemma Terms of Use found at
ai.google.dev/gemma/terms

Use of the model is subject to the
[Gemma Prohibited Use Policy](https://ai.google.dev/gemma/prohibited_use_policy).
By setting up semantic search you agree not to use the model for any purpose
that policy prohibits. Google claims no rights in the model's outputs (the
search vectors Memvana Shot stores).

### ONNX Runtime 1.30.0

- Publisher: Microsoft
- Files: the `onnxruntime-node` and `onnxruntime-common` npm packages (only the
  Apple Silicon macOS binaries are kept)
- License: MIT ([github.com/microsoft/onnxruntime](https://github.com/microsoft/onnxruntime/blob/main/LICENSE))
