# WebGPU shader compiler runtime

Pinned to Babylon.js 9.23.0, matching the game engine dependency. These runtime
files ship locally under `generated/webgpu/`; gameplay requires no third-party
CDN requests. Existing custom GLSL materials are translated to WebGPU WGSL in the game-owned
shader compiler Worker. The build copies its source beside these four resources.

Downloaded from the official versioned distribution:
`https://cdn.babylonjs.com/v9.23.0/glslang/` and
`https://cdn.babylonjs.com/v9.23.0/twgsl/`.

SHA-256:

- glslang.js: c3a3c2a47284b16b60293fa08a5842fbe8689ac617edc857ab6cb8134a590db4
- glslang.wasm: d79453e0803ebcdf3753c6b1d8d51543b52fed96f7f0d4aec94acd847e225169
- twgsl.js: b4f1f66263b801210f955f74aa71f1939be647ce0fd80ea5befd12a78499d5ff
- twgsl.wasm: a434c2decdbb38caadf5f486d806384a1543554828c983c77922b2d92579914c
