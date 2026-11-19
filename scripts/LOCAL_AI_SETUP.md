# Phase 4 Step 1: local runtime/model setup

Status: Phase 4 is implemented and locally validated on 18 November 2026. Official standalone Ollama 0.40.16 and qwen3:4b-instruct-2507-q4_K_M live on D:. Archive checksum/executable signature verified; model digest `0edcdef34593eac1aa2be9c7d06c432dcf81945adca5eca2f27662c18f168ba0` (2,497,293,803 bytes). Initial CPU_REPACK allocation failure was followed by a successful real smoke after more RAM became available: 13.33 seconds, 2.68 GiB allocated, no VRAM. The adapter, 22-case real evaluation and real browser/API/model flow passed. This machine now opts into Ollama via ignored .env; fresh checkouts default to mock.

## Hardware and proposed model

This machine reports Intel i7-13700H, 15.7 GiB physical RAM, Intel Iris Xe + Arc A370M graphics, 2.4 GiB free RAM at inspection, 2.4 GiB free on C: and 128.2 GiB on D:. Windows' AdapterRAM values are not treated as authoritative dedicated VRAM. Use CPU as the initial baseline; GPU availability/performance must be measured, not assumed.

Proposed first candidate: **qwen3:4b-instruct-2507-q4_K_M**, explicit 4B instruct/Q4_K_M tag, listed model download about 2.5 GB. Model disk size is not inference RAM. This is a candidate for later accuracy/latency evaluation, not a claim that it performs adequately. Use one request/model, 2048-token context and bounded output initially. Close unused applications/tabs before first inference; aim for roughly 6 GiB free RAM as a practical headroom target, not a guaranteed model requirement. Do not terminate unrelated services/processes automatically.

Use D: for both runtime and model weights; do not use default C: model storage. Do not commit runtime/model files to this repository. No paid/cloud provider or account/API key is needed for this local route.

## D: standalone setup and daily use

The owner authorized downloading the official standalone Windows AMD64 ZIP to avoid the desktop installer and keep bulk files on D:. Runtime, models, temporary files and logs live outside Git under `D:\FlowPilotAI`:

- `Ollama\ollama.exe`: standalone runtime.
- `models`: model weights and manifests (`OLLAMA_MODELS`, persisted for this Windows user).
- `Downloads`: official runtime archive.
- `tmp`, `logs`: server temporary files and dated logs.
- `start-ollama.ps1`: starts the loopback server hidden, with D: storage; refuses to replace another process using port 11434.

Pinned runtime download: [Ollama v0.40.16 Windows AMD64 ZIP](https://github.com/ollama/ollama/releases/download/v0.40.16/ollama-windows-amd64.zip). Published SHA-256: `50fcf5ad54277f2fa5d173ebfc93bcb017adbc0c9ef2314daabc96ca9e6aa64e`. Verify before extraction. Archive is about 1.6 GB; extracted binaries and model need additional space. Windows may still write small user/OS metadata on C:; bulk AI storage is configured on D:.

Persistent user settings: `OLLAMA_MODELS=D:\FlowPilotAI\models`, `OLLAMA_HOST=127.0.0.1:11434`, `OLLAMA_NO_CLOUD=1`, `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_CONTEXT_LENGTH=2048`, `OLLAMA_VULKAN=0`. The launcher sets these explicitly and assigns TEMP/TMP only to its server child; global Windows temporary storage is unchanged. Vulkan is disabled for the CPU baseline; Intel GPU acceleration is not assumed.

After a restart, start the local server:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\FlowPilotAI\start-ollama.ps1
```

This standalone setup has no desktop app or automatic startup registration. In a new terminal, use `ollama` if PATH has refreshed, or the full path:

```powershell
& 'D:\FlowPilotAI\Ollama\ollama.exe' --version
& 'D:\FlowPilotAI\Ollama\ollama.exe' pull qwen3:4b-instruct-2507-q4_K_M
& 'D:\FlowPilotAI\Ollama\ollama.exe' list
```

From the project root:

```powershell
.\scripts\check-local-ai.ps1 -PreflightOnly
.\scripts\check-local-ai.ps1 -TimeoutSeconds 300
```

The full check uses a fixed synthetic prompt and JSON schema, validates exact output fields/types/values, records actual wall time/runtime version/model digest/allocation if available, then unloads that model. It never reads customer data, touches PostgreSQL, executes model text, supplies tools or confirms a booking. A passing smoke proves one local structured-output request only; it does not establish semantic robustness or acceptable product latency.

## Step 1 completion gate

Installation/pull and a real successful checker run are complete on this machine. Keep runtime version, exact tag/digest and observed smoke latency for the next ticket. If it fails/OOMs or feels too slow while the app is running, report the error/timing before selecting a smaller model; do not silently switch model families or claim success. Fresh checkouts remain on mock until explicitly enabled.

Steps 2-4 are implemented: async local adapter, strict runtime/evidence/semantic validation, timeout and busy fallback, and fixed synthetic ambiguity/invalid-output/injection evaluation. No booking tool or database access is given to the model. See README for local configuration and the commands below.

## Official sources checked 18 November 2026

- Windows requirements/install/model location: https://docs.ollama.com/windows
- Exact tag/size: https://ollama.com/library/qwen3:4b-instruct-2507-q4_K_M
- Structured JSON schema and independent validation: https://docs.ollama.com/capabilities/structured-outputs
- Local-only mode, binding, context and runtime configuration: https://docs.ollama.com/faq
- GPU/Vulkan selection and disable switch: https://docs.ollama.com/gpu

No hosted-cost recommendation was made; COSTS.md is absent. Observed final evaluation: 22/22 fixed cases passed; 16 model-contact cases took 2.927-14.472 seconds, with six deterministic guard cases returning without model contact. The first evaluation was 21/22: an invalid follow-up was rejected. After a prompt example clarified omitted fields, the whole set passed. These are small local observations, not production accuracy/latency guarantees.

## Integrated local demo

Set AI_PROVIDER=ollama, OLLAMA_BASE_URL=http://127.0.0.1:11434 and AI_TIMEOUT_MS=20000 in the ignored .env, then restart pnpm dev. This machine is already configured and running in Ollama mode. Fresh .env.example stays mock; switching back requires AI_PROVIDER=mock and restarting the API. Ordinary test:ui expects mock mode; test:ai:ui is the separate real-provider smoke.

Run pnpm ai:evaluate for the fixed real model evaluation, and pnpm --filter @flowpilot/web test:ai:ui with the Ollama-mode app running. Optional AI_EVAL_REPORT points to a report filename on D:. See docs/phase4-acceptance.md for manual review. Default test suites do not contact Ollama.
