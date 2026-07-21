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
 * GLSL, accepting the three shapes a model actually writes: a Shadertoy
 * mainImage, a modern GLSL ES 3.00 main with its own out, and — the one a
 * small model reaches for most, because it dominates the training data —
 * an old GLSL ES 1.00 main writing gl_FragColor.
 *
 * The common uniform names are supplied under both conventions
 * (iResolution and resolution, iTime and time, iMouse and mouse), and any
 * the shader declares for itself are left to it and still fed each frame.
 * That is what lets a shader that says `uniform float time;` and divides
 * by an undeclared `resolution` run without being rewritten.
 */
const GLSL_RUNNER = `
const source = __SOURCE__;
${FRAME_RUNTIME}
const gl = stage.getContext("webgl2", { antialias: false });
if (!gl) {
  report("unavailable", "WebGL2 is not available in this browser.");
} else {
  const versionStripped = /^\\s*#version/.test(source) ? 1 : 0;
  const stripped = source.replace(/^\\s*#version[^\\n]*\\n/, "");
  const shadertoy = /\\bmainImage\\s*\\(/.test(stripped);
  /* gl_FragColor, varying, texture2D and attribute are GLSL ES 1.00 and
   * gone from 3.00. A shader using any of them is written for 1.00, whatever
   * #version line the model put on top. */
  const es1 =
    !shadertoy &&
    /(gl_FragColor|gl_FragData|\\bvarying\\b|\\btexture2D\\b|\\btextureCube\\b|\\battribute\\b)/.test(stripped);
  const declaresOut = /\\bout\\s+vec4\\b/.test(stripped);

  /* name, type, and how to feed it. Fed by name every frame, so a uniform
   * the shader declared itself is set too — getUniformLocation finds it. */
  const STD = [
    ["iResolution", "vec3", (loc, c) => gl.uniform3f(loc, c.w, c.h, 1)],
    ["resolution", "vec2", (loc, c) => gl.uniform2f(loc, c.w, c.h)],
    ["iTime", "float", (loc, c) => gl.uniform1f(loc, c.t)],
    ["time", "float", (loc, c) => gl.uniform1f(loc, c.t)],
    ["iTimeDelta", "float", (loc, c) => gl.uniform1f(loc, c.dt)],
    ["iMouse", "vec4", (loc, c) => gl.uniform4f(loc, c.mx, c.my, 0, 0)],
    ["mouse", "vec2", (loc, c) => gl.uniform2f(loc, c.mx, c.my)],
    ["iFrame", "int", (loc, c) => gl.uniform1i(loc, c.frame)],
  ];
  /* Declare only the ones the shader did not, so a redeclaration cannot
   * make a valid shader fail to compile. */
  const declared = (name) =>
    new RegExp("\\\\buniform\\\\b[^;]*\\\\b" + name + "\\\\b").test(stripped);
  const uniformDecls = STD.filter(([name]) => !declared(name))
    .map(([name, type]) => "uniform " + type + " " + name + ";")
    .join("\\n");

  const header = es1
    ? "precision highp float;\\n" + uniformDecls + "\\n"
    : "#version 300 es\\nprecision highp float;\\n" + uniformDecls + "\\n";
  let extraLines = 0;
  let fragmentSource;
  if (shadertoy) {
    fragmentSource =
      header + "out vec4 remindmeFragColor;\\n" + stripped +
      "\\nvoid main(){ vec4 c = vec4(0.0,0.0,0.0,1.0);" +
      " mainImage(c, gl_FragCoord.xy); remindmeFragColor = c; }\\n";
    extraLines = 1;
  } else if (es1) {
    fragmentSource = header + stripped;
  } else {
    fragmentSource = header + (declaresOut ? "" : "out vec4 fragColor;\\n") + stripped;
    extraLines = declaresOut ? 0 : 1;
  }

  /* Vertex stage: 3.00 can build the triangle from gl_VertexID, but 1.00
   * has no such thing, so that path feeds a real position attribute. */
  const vertexSource = es1
    ? "attribute vec2 position;\\nvoid main(){ gl_Position = vec4(position, 0.0, 1.0); }"
    : "#version 300 es\\nvoid main(){ vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }";

  /* A reported line is counted in the compiled source; map it back onto the
   * line the author sees, accounting for the header, any wrapper line, and
   * the #version line that was stripped off the top. */
  const headerLines = header.split("\\n").length - 1;
  const offset = headerLines + extraLines - versionStripped;
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
    if (es1) {
      /* A fullscreen triangle for the 1.00 vertex stage's attribute. */
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const location = gl.getAttribLocation(program, "position");
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    }
    /* Resolve each standard uniform once; unused ones return null and are
     * skipped, so nothing has to know which the shader actually reads. */
    const bound = STD.map(([name, , set]) => [gl.getUniformLocation(program, name), set]);
    const started = performance.now();
    let previous = started;
    let frame = 0;
    const draw = (now) => {
      fitCanvas();
      gl.viewport(0, 0, stage.width, stage.height);
      const context = {
        w: stage.width, h: stage.height,
        t: (now - started) / 1000, dt: (now - previous) / 1000,
        mx: pointer.x * stage.width, my: pointer.y * stage.height, frame,
      };
      for (const [location, set] of bound) if (location) set(location, context);
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
