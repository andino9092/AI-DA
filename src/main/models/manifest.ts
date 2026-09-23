/**
 * Every model AI-DA downloads. URLs point at pinned releases/revisions and every file has a
 * SHA-256, so a download can never silently change or be tampered with.
 */
export interface ModelFile {
  url: string;
  /** Path inside the models folder. */
  path: string;
  size: number;
  sha256: string;
  /** Zip archives are extracted into this folder (inside the models folder) after verifying. */
  extractTo?: string;
}

export interface ModelSpec {
  id: ModelId;
  label: string;
  purpose: string;
  files: ModelFile[];
  /** A file that must exist once installed (e.g. an executable inside an extracted zip). */
  readyCheck: string;
}

export type ModelId = 'vad' | 'whisper-runtime' | 'whisper-model' | 'kokoro';

const KOKORO_REV = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';
const KOKORO = `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/${KOKORO_REV}`;
const WHISPER_REV = '5359861c739e955e79d9a303bcbc70fb988958b1';

export const MODELS: ModelSpec[] = [
  {
    id: 'vad',
    label: 'Voice activity detector',
    purpose: 'Notices when you start and stop talking (Silero VAD v6).',
    readyCheck: 'vad/silero_vad.onnx',
    files: [
      {
        url: 'https://raw.githubusercontent.com/snakers4/silero-vad/v6.2.3/src/silero_vad/data/silero_vad.onnx',
        path: 'vad/silero_vad.onnx',
        size: 2_327_524,
        sha256: '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3',
      },
    ],
  },
  {
    id: 'whisper-runtime',
    label: 'Speech recognition engine',
    // The CUDA 11.8 build lacks cuBLAS (it expects the CUDA Toolkit installed); 12.4 bundles it.
    purpose: 'whisper.cpp v1.9.4 with NVIDIA GPU support (CUDA 12.4, cuBLAS included).',
    readyCheck: 'whisper/runtime/Release/whisper-server.exe',
    files: [
      {
        url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-cublas-12.4.0-bin-x64.zip',
        path: 'downloads/whisper-cublas-12.4.0-bin-x64.zip',
        size: 674_539_285,
        sha256: 'af520ddd034d985b55dfeea3e465ed93653ba2aee1a55e865033edc548c272a7',
        extractTo: 'whisper/runtime',
      },
    ],
  },
  {
    id: 'whisper-model',
    label: 'Speech recognition model',
    purpose: 'Whisper large-v3-turbo (q5), accurate and fast on your GPU.',
    readyCheck: 'whisper/ggml-large-v3-turbo-q5_0.bin',
    files: [
      {
        url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_REV}/ggml-large-v3-turbo-q5_0.bin`,
        path: 'whisper/ggml-large-v3-turbo-q5_0.bin',
        size: 574_041_195,
        sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
      },
    ],
  },
  {
    id: 'kokoro',
    label: 'Voice',
    purpose: 'Kokoro 82M text-to-speech, runs on your CPU (~0.4× real time).',
    readyCheck: 'kokoro/onnx/model.onnx',
    files: [
      {
        url: `${KOKORO}/config.json`,
        path: 'kokoro/config.json',
        size: 44,
        sha256: 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f',
      },
      {
        url: `${KOKORO}/tokenizer.json`,
        path: 'kokoro/tokenizer.json',
        size: 3_497,
        sha256: '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34',
      },
      {
        url: `${KOKORO}/tokenizer_config.json`,
        path: 'kokoro/tokenizer_config.json',
        size: 113,
        sha256: 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20',
      },
      {
        // Full precision: the q8 build runs slower than real time on CPUs without VNNI
        // (e.g. Zen 3), and DirectML can't run Kokoro's ConvTranspose layers.
        url: `${KOKORO}/onnx/model.onnx`,
        path: 'kokoro/onnx/model.onnx',
        size: 325_532_232,
        sha256: '8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb',
      },
    ],
  },
];

export const TOTAL_DOWNLOAD_BYTES = MODELS.flatMap((m) => m.files).reduce(
  (sum, f) => sum + f.size,
  0,
);
