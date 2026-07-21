import { FRAME_RUNTIME, buildFrame, encodeForScript } from "./frameShell";

/**
 * Runnable documents for shader artifacts.
 *
 * The artifact frame already allows what these need and nothing more: it
 * runs inline script, holds an opaque origin, and has no network. WebGL2
 * and WebGPU both work there under the existing policy, so a shader is the
 * one executable artifact that costs no loosening of the sandbox and no
 * vendored runtime — the GPU driver is the interpreter.
 *
 * Both shells report compile errors into the frame. A model writing GLSL
 * gets it wrong often, and a black rectangle says nothing about why.
 */

/**
 * GLSL, accepting both conventions a model is likely to have seen: a
 * Shadertoy `mainImage`, or a plain fragment shader with its own `main`.
 */
const GLSL_RUNNER = `
const source = __SOURCE__;
${FRAME_RUNTIME}
const gl = stage.getContext("webgl2", { antialias: false });
if (!gl) {
  report("unavailable", "WebGL2 is not available in this browser.");
} else {
  const stripped = source.replace(/^\\s*#version[^\\n]*\\n/, "");
  const shadertoy = /\\bmainImage\\s*\\(/.test(stripped);
  const declaresOut = /\\bout\\s+vec4\\b/.test(stripped);
  const preamble =
    "#version 300 es\\nprecision highp float;\\n" +
    "uniform vec3 iResolution;\\nuniform float iTime;\\n" +
    "uniform float iTimeDelta;\\nuniform int iFrame;\\nuniform vec4 iMouse;\\n";
  /* The wrapper's own output is named apart from anything the shader is
   * likely to declare, so a Shadertoy paste and a hand-written main can
   * both compile against the same preamble. */
  const fragmentSource = shadertoy
    ? preamble + "out vec4 remindmeColor;\\n" + stripped +
      "\\nvoid main(){ vec4 c = vec4(0.0,0.0,0.0,1.0);" +
      " mainImage(c, gl_FragCoord.xy); remindmeColor = c; }\\n"
    : preamble + (declaresOut ? "" : "out vec4 fragColor;\\n") + stripped;
  const vertexSource =
    "#version 300 es\\nvoid main(){ vec2 p = vec2((gl_VertexID << 1) & 2," +
    " gl_VertexID & 2); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }";

  /* Line numbers come back counted from the preamble; shift them so they
   * point at the line the author actually wrote. */
  const offset = preamble.split("\\n").length - 1 + (shadertoy ? 1 : declaresOut ? 0 : 1);
  function compile(type, text, shiftLines) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, text);
    gl.compileShader(shader);
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
    const raw = gl.getShaderInfoLog(shader) || "Unknown compile error";
    gl.deleteShader(shader);
    throw new Error(
      shiftLines
        ? raw.replace(/(\\d+):(\\d+)/g, (m, col, line) => col + ":" + Math.max(1, Number(line) - offset))
        : raw,
    );
  }
  try {
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource, false));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource, true));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(program) || "Link failed");
    gl.useProgram(program);
    const uniform = (name) => gl.getUniformLocation(program, name);
    const uResolution = uniform("iResolution");
    const uTime = uniform("iTime");
    const uDelta = uniform("iTimeDelta");
    const uFrame = uniform("iFrame");
    const uMouse = uniform("iMouse");
    const started = performance.now();
    let previous = started;
    let frame = 0;
    const draw = (now) => {
      fitCanvas();
      gl.viewport(0, 0, stage.width, stage.height);
      if (uResolution) gl.uniform3f(uResolution, stage.width, stage.height, 1);
      if (uTime) gl.uniform1f(uTime, (now - started) / 1000);
      if (uDelta) gl.uniform1f(uDelta, (now - previous) / 1000);
      if (uFrame) gl.uniform1i(uFrame, frame);
      if (uMouse)
        gl.uniform4f(uMouse, pointer.x * stage.width, pointer.y * stage.height, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      previous = now;
      frame += 1;
      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
  } catch (error) {
    report("compile failed", String(error.message || error));
  }
}
`;

/**
 * WGSL. The preamble supplies the fullscreen triangle and the uniform
 * block; the shader supplies `@fragment fn fs_main`.
 */
const WGSL_PREAMBLE = `struct Uniforms {
  resolution: vec2f,
  time: f32,
  timeDelta: f32,
  mouse: vec2f,
  frame: f32,
  _pad: f32,
};
@group(0) @binding(0) var<uniform> U: Uniforms;
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  var points = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(points[index], 0.0, 1.0);
}
`;

const WGSL_RUNNER = `
const source = __SOURCE__;
const preamble = __PREAMBLE__;
${FRAME_RUNTIME}
(async () => {
  if (!navigator.gpu) {
    report(
      "unavailable",
      "WebGPU is not available here. It needs a secure context — https, or " +
      "localhost — and a browser with WebGPU enabled. Over a plain http:// " +
      "address navigator.gpu is undefined no matter the hardware.",
    );
    return;
  }
  let device;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) { report("no adapter", "WebGPU found no usable adapter."); return; }
    device = await adapter.requestDevice();
  } catch (error) {
    report("device failed", String(error.message || error));
    return;
  }
  const context = stage.getContext("webgpu");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });

  const module = device.createShaderModule({ code: preamble + source });
  /* Diagnostics are reported against the combined source, so shift the
   * line numbers back onto the author's own. */
  const offset = preamble.split("\\n").length - 1;
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((message) => message.type === "error");
  if (errors.length) {
    report(
      "compile failed",
      errors
        .map((m) => "line " + Math.max(1, m.lineNum - offset) + ": " + m.message)
        .join("\\n"),
    );
    return;
  }

  let pipeline;
  try {
    pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs_main" },
      fragment: { module, entryPoint: "fs_main", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
  } catch (error) {
    report("pipeline failed", String(error.message || error));
    return;
  }

  const uniforms = new Float32Array(8);
  const buffer = device.createBuffer({
    size: uniforms.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer } }],
  });

  device.addEventListener("uncapturederror", (event) => {
    report("gpu error", String(event.error?.message || event.error));
  });

  const started = performance.now();
  let previous = started;
  let frame = 0;
  const draw = (now) => {
    fitCanvas();
    uniforms.set([
      stage.width,
      stage.height,
      (now - started) / 1000,
      (now - previous) / 1000,
      pointer.x * stage.width,
      pointer.y * stage.height,
      frame,
      0,
    ]);
    device.queue.writeBuffer(buffer, 0, uniforms);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
    previous = now;
    frame += 1;
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
})();
`;

export function glslDocument(source: string): string {
	return buildFrame([GLSL_RUNNER.replace("__SOURCE__", encodeForScript(source))]);
}

export function wgslDocument(source: string): string {
	return buildFrame([
		WGSL_RUNNER.replace("__SOURCE__", encodeForScript(source)).replace(
			"__PREAMBLE__",
			encodeForScript(WGSL_PREAMBLE),
		),
	]);
}
