// ── Constellation render core ─────────────────────────────────────────────
// A data-agnostic three.js "search results as a blob constellation" view.
// It knows nothing about SearXNG or Obsidian — a host supplies results and a
// few resolvers, and it renders, navigates, and reports opens back.
//
//   import { createConstellation } from "./render-core.js";
//   const view = createConstellation({
//     mount,                       // element to build into (fills it)
//     onSearch: (q) => fetchResults(q),   // optional; wires the search bar
//     onOpen:   (result) => openIt(result),
//     colorFor: (groupKey) => 0x4467d9,   // optional palette override
//   });
//   view.setResults(results);      // [{ title, url, snippet, group, favicon }]
//   view.dispose();                // tear down (Obsidian view close, etc.)
//
// A "result" is any object with at least { title }. Recognised fields:
//   title, url, snippet | content, group | engine, favicon, id
//
// three.js is imported by bare specifier so the host decides how it's provided
// (import map for a served page, a bundler for an Obsidian plugin).

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

// Lucid-protocol palette: cool laboratory surfaces, optic-blue/violet
// specimens, coral annotation. Distinct per group, never neon.
const DEFAULT_COLORS = {
	google: 0x4467d9, bing: 0x2f97b8, duckduckgo: 0x3fb98f, brave: 0xd94b67,
	startpage: 0x5840b8, qwant: 0x6f8fe0, reddit: 0xd9694b, _default: 0x8aa0c8,
};
// A stable spread of palette hues for groups we don't have a named colour for.
const FALLBACK_HUES = [0x4467d9, 0x3fb98f, 0xd94b67, 0x5840b8, 0x6f8fe0, 0x2f97b8, 0xd9694b, 0x8aa0c8];

const domainOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch (_) { return ""; } };
const isHttp = (url) => typeof url === "string" && /^https?:\/\//i.test(url);
const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

let styleInjected = false;
function injectStyle() {
	if (styleInjected) return;
	styleInjected = true;
	const css = `
	.cst-root { --cst-text:#dfe9ff; --cst-muted:#8aa0c8; --cst-mono: ui-monospace,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
		position:absolute; inset:0; overflow:hidden; background:#04060f; color:var(--cst-text);
		font-family: ui-sans-serif, system-ui, sans-serif; }
	.cst-root, .cst-root * { box-sizing:border-box; }
	.cst-gl { position:absolute; inset:0; display:block; width:100%; height:100%; }
	.cst-searchbar { position:absolute; top:22px; left:50%; transform:translateX(-50%); z-index:10; width:min(560px,88%);
		display:flex; align-items:center; gap:10px; padding:10px 16px; border-radius:40px;
		background:rgba(120,160,255,0.08); border:1px solid rgba(150,190,255,0.28);
		backdrop-filter:blur(14px) saturate(1.3); box-shadow:0 8px 40px rgba(40,80,200,0.25), inset 0 1px 0 rgba(255,255,255,0.15); }
	.cst-searchbar input { flex:1; background:transparent; border:0; outline:none; color:var(--cst-text); font-size:1rem; letter-spacing:0.01em; }
	.cst-searchbar input::placeholder { color:var(--cst-muted); }
	.cst-searchbar .cst-dot { width:9px; height:9px; border-radius:50%; background:#7cf6ff; box-shadow:0 0 12px #7cf6ff; }
	.cst-hint { position:absolute; bottom:16px; left:50%; transform:translateX(-50%); z-index:10; color:var(--cst-muted); font-size:12px; letter-spacing:0.08em; opacity:0.7; pointer-events:none; }
	.cst-iconbtn { position:absolute; top:22px; right:22px; z-index:14; width:38px; height:38px; display:grid; place-items:center; font-size:16px; color:#9fb4d8; background:rgba(120,160,255,0.08); border:1px solid rgba(150,190,255,0.28); border-radius:50%; cursor:pointer; backdrop-filter:blur(10px); }
	.cst-iconbtn:hover { color:#fff; border-color:rgba(150,190,255,0.5); }
	.cst-panel { position:absolute; top:70px; right:22px; z-index:14; width:216px; padding:14px 16px 8px; border-radius:16px; background:rgba(10,18,34,0.74); border:1px solid rgba(120,160,220,0.28); backdrop-filter:blur(14px); font-family:var(--cst-mono); box-shadow:0 24px 64px rgba(0,0,0,0.5); }
	.cst-panel[hidden] { display:none; }
	.cst-panel .cst-panel-title { font-size:9.5px; letter-spacing:0.28em; color:#7f97c8; margin-bottom:8px; }
	.cst-panel .cst-row { display:flex; align-items:center; justify-content:space-between; padding:8px 0; font-size:12px; letter-spacing:0.03em; color:#cdd9f2; cursor:pointer; }
	.cst-panel .cst-row input { accent-color:#4467d9; width:16px; height:16px; cursor:pointer; }
	.cst-panel .cst-note { font-size:9px; letter-spacing:0.1em; color:#6f87c8; margin:4px 0 6px; }
	.cst-labels { position:absolute; inset:0; z-index:8; pointer-events:none; }
	.cst-fav { position:absolute; width:30px; height:30px; padding:3px; border-radius:9px; transform:translate(-50%,-50%);
		background:rgba(12,22,34,0.5); border:1px solid rgba(170,200,235,0.35); box-shadow:0 2px 10px rgba(0,0,0,0.4); backdrop-filter:blur(2px);
		transition:opacity 0.15s, width 0.15s, height 0.15s; overflow:hidden; }
	.cst-fav img { width:100%; height:100%; display:block; }
	.cst-fav .cst-fav-mono { display:flex; width:100%; height:100%; align-items:center; justify-content:center; font-family:var(--cst-mono); font-size:13px; font-weight:600; color:#eaf1ff; }
	.cst-tip { position:absolute; z-index:12; pointer-events:none; padding:5px 10px; border-radius:10px; max-width:320px;
		background:rgba(10,16,40,0.72); border:1px solid rgba(150,190,255,0.3); backdrop-filter:blur(8px); transform:translate(-50%,-140%);
		white-space:nowrap; overflow:hidden; text-overflow:ellipsis; opacity:0; transition:opacity 0.12s; font-family:var(--cst-mono); font-size:12px; letter-spacing:0.02em; }
	.cst-tip.on { opacity:1; }
	.cst-mono { position:absolute; z-index:9; transform:translate(-50%,48px); text-align:center; pointer-events:none; font-family:var(--cst-mono); opacity:0; transition:opacity 0.18s; text-shadow:0 2px 12px rgba(0,0,0,0.65); }
	.cst-mono.on { opacity:1; }
	.cst-mono .cst-m-id { font-size:10.5px; letter-spacing:0.3em; color:#6f87c8; }
	.cst-mono .cst-m-dom { font-size:11px; letter-spacing:0.14em; color:#7cc6d8; margin:3px 0 6px; }
	.cst-mono .cst-m-title { font-size:15px; letter-spacing:0.01em; color:#eaf1ff; max-width:440px; margin:0 auto; line-height:1.3; }
	.cst-providers { position:absolute; inset:0; z-index:9; pointer-events:none; }
	.cst-phead { position:absolute; transform:translate(-50%,-50%); display:flex; align-items:center; gap:8px; padding:5px 12px; border-radius:30px;
		font-family:var(--cst-mono); font-size:11.5px; letter-spacing:0.22em; text-transform:uppercase; white-space:nowrap;
		background:rgba(10,20,30,0.35); border:1px solid rgba(120,150,190,0.18);
		transition:opacity 0.2s, transform 0.2s, background 0.2s, border-color 0.2s; pointer-events:auto; cursor:pointer; }
	.cst-phead:hover { border-color:rgba(150,190,255,0.6); background:rgba(20,40,60,0.5); }
	.cst-phead .cst-pdot { width:9px; height:9px; border-radius:50%; background:currentColor; box-shadow:0 0 10px currentColor; }
	.cst-phead .cst-pname { color:#b9c9e8; }
	.cst-phead .cst-pcount { color:#6f87c8; font-size:10px; letter-spacing:0.1em; }
	.cst-phead.active { background:rgba(20,40,60,0.6); border-color:rgba(150,190,255,0.5); }
	.cst-phead.active .cst-pname { color:#fff; }
	.cst-map { position:absolute; left:18px; bottom:18px; z-index:10; width:205px; padding:10px 12px 8px; border-radius:16px; background:rgba(10,18,34,0.5); border:1px solid rgba(120,160,220,0.22); backdrop-filter:blur(10px); font-family:var(--cst-mono); }
	.cst-map .cst-map-title { display:flex; align-items:center; justify-content:space-between; gap:10px; font-size:9.5px; letter-spacing:0.28em; color:#7f97c8; margin-bottom:4px; }
	.cst-map-toggle { font-family:var(--cst-mono); font-size:12px; line-height:1; color:#9fb4d8; background:rgba(120,160,255,0.10); border:1px solid rgba(150,190,255,0.28); border-radius:8px; padding:3px 7px; cursor:pointer; }
	.cst-map-toggle:hover { border-color:rgba(150,190,255,0.6); color:#eaf1ff; }
	.cst-map svg { width:100%; height:150px; display:block; touch-action:none; }
	.cst-map .cst-map-hint { display:none; font-size:9px; letter-spacing:0.14em; color:#6f87c8; margin-top:6px; text-align:center; }
	.cst-map.expanded { left:50%; bottom:50%; transform:translate(-50%,50%); width:min(760px,92%); padding:16px 18px 12px; box-shadow:0 30px 90px rgba(0,0,0,0.6); z-index:13; }
	.cst-map.expanded .cst-map-title { font-size:11px; }
	.cst-map.expanded svg { height:min(66vh,560px); cursor:grab; }
	.cst-map.expanded svg:active { cursor:grabbing; }
	.cst-map.expanded svg .mnode, .cst-map.expanded svg .mhub { cursor:pointer; }
	.cst-map.expanded .cst-map-hint { display:block; }
	.cst-read { position:absolute; z-index:12; top:50%; right:26px; transform:translateY(-50%) translateX(30px); width:min(420px,90%); max-height:78%; overflow:auto; padding:24px 26px;
		border-radius:34px 34px 40px 30px / 40px 30px 34px 40px; background:rgba(18,26,60,0.55); border:1px solid rgba(150,190,255,0.32);
		backdrop-filter:blur(20px) saturate(1.4); box-shadow:0 20px 70px rgba(30,60,180,0.35), inset 0 1px 0 rgba(255,255,255,0.18);
		opacity:0; pointer-events:none; transition:opacity 0.2s, transform 0.2s; }
	.cst-read.on { opacity:1; pointer-events:auto; transform:translateY(-50%) translateX(0); }
	.cst-read .cst-eng { display:inline-block; font-size:11px; letter-spacing:0.12em; text-transform:uppercase; padding:3px 10px; border-radius:20px; margin-bottom:12px; border:1px solid currentColor; }
	.cst-read h2 { margin:0 0 6px; font-size:1.28rem; line-height:1.25; }
	.cst-read a.cst-src { color:#7cf6ff; text-decoration:none; font-size:0.82rem; word-break:break-all; }
	.cst-read p { color:#c3d2f2; line-height:1.55; margin:14px 0 20px; }
	.cst-read .cst-open { display:inline-block; padding:10px 20px; border-radius:30px; border:0; cursor:pointer; font:inherit;
		background:linear-gradient(120deg,#6cf0ff,#9a7bff); color:#06122a; font-weight:600; text-decoration:none; box-shadow:0 8px 30px rgba(120,160,255,0.45); }
	.cst-read .cst-close { position:absolute; top:14px; right:18px; cursor:pointer; color:var(--cst-muted); font-size:18px; background:none; border:0; }
	`;
	const s = document.createElement("style");
	s.setAttribute("data-cst", "");
	s.textContent = css;
	document.head.appendChild(s);
}

const TEMPLATE = `
	<canvas class="cst-gl"></canvas>
	<div class="cst-labels"></div>
	<div class="cst-providers"></div>
	<form class="cst-searchbar" hidden><span class="cst-dot"></span><input class="cst-q" type="text" autocomplete="off" spellcheck="false" /></form>
	<button class="cst-iconbtn cst-settings-btn" aria-label="Display settings" title="Settings">⚙</button>
	<div class="cst-panel cst-settings-panel" hidden>
		<div class="cst-panel-title">DISPLAY</div>
		<label class="cst-row"><span>Motion</span><input type="checkbox" class="cst-set-motion" /></label>
		<label class="cst-row"><span>Refractive glass</span><input type="checkbox" class="cst-set-glass" checked /></label>
		<label class="cst-row"><span>Nebula</span><input type="checkbox" class="cst-set-nebula" checked /></label>
		<label class="cst-row"><span>Bloom</span><input type="checkbox" class="cst-set-bloom" checked /></label>
		<div class="cst-note">Motion respects your reduced-motion setting.</div>
	</div>
	<div class="cst-tip"></div>
	<div class="cst-mono"><div class="cst-m-id"></div><div class="cst-m-dom"></div><div class="cst-m-title"></div></div>
	<div class="cst-read">
		<button class="cst-close" aria-label="Close">✕</button>
		<span class="cst-eng"></span>
		<h2 class="cst-title"></h2>
		<a class="cst-src" target="_blank" rel="noopener noreferrer"></a>
		<p class="cst-snippet"></p>
		<button class="cst-open" type="button">Open ↗</button>
	</div>
	<div class="cst-hint">← → / drag providers · ↑ ↓ results · enter / click to open</div>
	<div class="cst-map"><div class="cst-map-title"><span>RELATION MAP</span><button class="cst-map-toggle" aria-label="Expand relation map" title="Expand">⤢</button></div><svg class="cst-map-svg" viewBox="0 0 190 170" preserveAspectRatio="xMidYMid meet"></svg><div class="cst-map-hint">drag to pan · scroll to zoom · click a node to open</div></div>
`;

export function createConstellation(config = {}) {
	injectStyle();

	// ── Config with defaults ──
	const mount = config.mount || document.body;
	const groupOf = config.groupOf || ((r) => String(r.group || r.engine || "web").toLowerCase());
	const snippetOf = config.snippetOf || ((r) => r.snippet || r.content || "");
	const subtitleOf = config.subtitleOf || ((r) => (isHttp(r.url) ? domainOf(r.url) : r.subtitle || ""));
	const linkKeyOf = config.linkKeyOf || ((r) => (isHttp(r.url) ? domainOf(r.url) : ""));
	const onOpen = config.onOpen || ((r) => { if (isHttp(r.url)) window.open(r.url, "_blank", "noopener"); });
	const onSearch = config.onSearch || null;
	// Prefer a favicon the host supplied (already same-origin/proxied). The
	// third-party fallback is opt-in via config — never assume it's safe.
	const faviconFor = config.faviconFor || ((r) => r.favicon || null);
	// Colour resolver: named palette, else a stable per-key fallback hue.
	const colorCache = new Map();
	const colorFor = config.colorFor || ((key) => {
		if (DEFAULT_COLORS[key] != null) return DEFAULT_COLORS[key];
		if (!colorCache.has(key)) {
			let h = 0; for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
			colorCache.set(key, FALLBACK_HUES[h % FALLBACK_HUES.length]);
		}
		return colorCache.get(key);
	});

	// ── Build DOM ──
	const root = document.createElement("div");
	root.className = "cst-root";
	root.tabIndex = 0; // so keyboard navigation only fires when this view is focused
	root.innerHTML = TEMPLATE;
	mount.appendChild(root);
	const $ = (sel) => root.querySelector(sel);
	const canvas = $(".cst-gl");
	const labelsEl = $(".cst-labels");
	const providersEl = $(".cst-providers");
	const tip = $(".cst-tip");
	const read = $(".cst-read");
	const mono = $(".cst-mono");
	const searchForm = $(".cst-searchbar");
	const searchInput = $(".cst-q");

	const W = () => root.clientWidth || window.innerWidth;
	const H = () => root.clientHeight || window.innerHeight;

	// ── Renderer / scene ──
	const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
	renderer.setSize(W(), H());
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1.1;

	const scene = new THREE.Scene();
	scene.background = new THREE.Color(0x03040b);
	scene.fog = new THREE.FogExp2(0x03040b, 0.03);

	// Drifting dust clouds — blue core + a smaller offset violet veil.
	function makeCloud(w, h, pos, cols, dens) {
		const m = new THREE.Mesh(
			new THREE.PlaneGeometry(w, h),
			new THREE.ShaderMaterial({
				transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
				uniforms: { uTime: { value: 0 } },
				vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
				fragmentShader: `varying vec2 vUv; uniform float uTime;
					float hash(vec2 p){return fract(sin(dot(p,vec2(41.3,289.1)))*43758.5453);}
					float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
						return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
					float fbm(vec2 p){float s=0.0,a=0.5;for(int i=0;i<5;i++){s+=a*noise(p);p=p*2.02+vec2(3.1,1.7);a*=0.5;}return s;}
					void main(){ vec2 uv=vUv-0.5; float d=length(uv*vec2(${dens[0].toFixed(2)},${dens[1].toFixed(2)})); vec2 p=uv*3.2;
						float n1=fbm(p+vec2(uTime*0.06,uTime*0.035)+0.5*sin(uTime*0.1+p.yx)); float n2=fbm(p*2.3-vec2(uTime*0.05,-uTime*0.055)); float wisps=n1*0.65+n2*0.35;
						float cloud=smoothstep(0.64,0.04,d)*(0.22+0.95*wisps);
						vec3 deep=vec3(${cols.deep}); vec3 mid=vec3(${cols.mid}); vec3 hot=vec3(${cols.hot});
						vec3 col=mix(deep,mid,smoothstep(0.10,0.60,wisps)); col=mix(col,hot,smoothstep(0.58,0.96,wisps));
						gl_FragColor=vec4(col*cloud, cloud*0.9); }`,
			})
		);
		m.position.copy(pos); scene.add(m); return m;
	}
	const clouds = [
		makeCloud(84, 58, new THREE.Vector3(0, 0, -17), { deep: "0.02,0.04,0.15", mid: "0.13,0.22,0.55", hot: "0.27,0.40,0.85" }, [1.35, 1.85]),
		makeCloud(38, 34, new THREE.Vector3(19, -11, -25), { deep: "0.07,0.03,0.15", mid: "0.24,0.13,0.44", hot: "0.35,0.25,0.72" }, [1.5, 1.6]),
	];
	clouds.forEach((c, i) => { c.userData.base = c.position.clone(); c.userData.ph = i * 2.3; });

	const pmrem = new THREE.PMREMGenerator(renderer);
	function makeEnvTexture() {
		const c = document.createElement("canvas"); c.width = 8; c.height = 256;
		const g = c.getContext("2d");
		const grd = g.createLinearGradient(0, 0, 0, 256);
		grd.addColorStop(0.00, "#0b1540"); grd.addColorStop(0.38, "#2f56ea"); grd.addColorStop(0.60, "#6a4fd0");
		grd.addColorStop(0.82, "#241247"); grd.addColorStop(1.00, "#04050d");
		g.fillStyle = grd; g.fillRect(0, 0, 8, 256);
		const tex = new THREE.CanvasTexture(c);
		tex.mapping = THREE.EquirectangularReflectionMapping; tex.colorSpace = THREE.SRGBColorSpace;
		return tex;
	}
	const envRT = pmrem.fromEquirectangular(makeEnvTexture());
	scene.environment = envRT.texture;

	scene.add(new THREE.HemisphereLight(0xbfe0ff, 0x0a1436, 1.1));
	const key = new THREE.PointLight(0xcfe4ff, 55, 60, 1.4); key.position.set(8, 9, 14); scene.add(key);
	const rim = new THREE.PointLight(0xb488ff, 45, 60, 1.4); rim.position.set(-9, -5, 9); scene.add(rim);

	// Glass cubes — coloured environment reflections + Fresnel + iridescence,
	// mild transmission, emissive floor so faces never go black over the void.
	const cubes = new THREE.Group(); scene.add(cubes);
	const cubeGeo = new THREE.BoxGeometry(1, 1, 1);
	const cubeMat = new THREE.MeshPhysicalMaterial({
		color: 0xdfeeff, metalness: 0.0, roughness: 0.03,
		transmission: 0.35, thickness: 0.6, ior: 1.5,
		attenuationColor: new THREE.Color(0x9fc4ff), attenuationDistance: 4.0,
		clearcoat: 1.0, clearcoatRoughness: 0.03,
		iridescence: 1.0, iridescenceIOR: 1.3, iridescenceThicknessRange: [140, 500],
		specularIntensity: 1.0, envMapIntensity: 3.6,
		emissive: new THREE.Color(0x14305e), emissiveIntensity: 0.16, transparent: true,
	});
	function setGlassMode(high) {
		if (high) { cubeMat.transmission = 0.35; cubeMat.opacity = 1.0; cubeMat.depthWrite = true; cubeMat.roughness = 0.03; cubeMat.envMapIntensity = 3.6; cubeMat.emissiveIntensity = 0.16; }
		else { cubeMat.transmission = 0.0; cubeMat.opacity = 0.5; cubeMat.depthWrite = false; cubeMat.roughness = 0.06; cubeMat.envMapIntensity = 2.6; cubeMat.emissiveIntensity = 0.3; }
		cubeMat.needsUpdate = true;
	}
	function seedCube(m) {
		const a = Math.random() * Math.PI * 2;
		const dir = new THREE.Vector3(Math.cos(a), Math.sin(a) * 0.72, -(0.05 + Math.random() * 0.3)).normalize();
		m.position.copy(dir).multiplyScalar(2 + Math.random() * 5); m.position.z -= 3;
		m.userData.drift = dir.clone().multiplyScalar(0.45 + Math.random() * 0.8);
		m.userData.spin = new THREE.Vector3((Math.random() - 0.5) * 0.008, (Math.random() - 0.5) * 0.008, (Math.random() - 0.5) * 0.008);
	}
	for (let i = 0; i < 24; i++) {
		const m = new THREE.Mesh(cubeGeo, cubeMat);
		const s = 0.55 + Math.random() * 1.25;
		m.userData = { base: new THREE.Vector3(s, s * (0.75 + Math.random() * 0.5), s) };
		m.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
		seedCube(m); m.position.setLength(7 + Math.random() * 22); m.scale.set(0, 0, 0);
		cubes.add(m);
	}

	const comets = [];
	const cometColors = [0xff3a4a, 0x35ff70, 0x3a6bff];
	for (let i = 0; i < 3; i++) {
		const hist = new Float32Array(56 * 3);
		const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(hist, 3));
		const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: cometColors[i], transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
		scene.add(line);
		const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 8), new THREE.MeshBasicMaterial({ color: cometColors[i], blending: THREE.AdditiveBlending, depthWrite: false }));
		scene.add(head);
		comets.push({ line, head, geo, hist, phase: Math.random() * 6, speed: 0.25 + Math.random() * 0.2, radius: 6 + Math.random() * 4 });
	}

	const camera = new THREE.PerspectiveCamera(50, W() / H(), 0.1, 100);
	camera.position.set(0, 0, 13); camera.lookAt(0, 0, 0);
	const parallax = new THREE.Vector2(0, 0);
	let providers = [];
	let activeProvider = 0, activeItem = 0;
	const GAPX = 5.0, GAPY = 3.3;
	let motion = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

	const composer = new EffectComposer(renderer);
	composer.addPass(new RenderPass(scene, camera));
	const bloom = new UnrealBloomPass(new THREE.Vector2(W(), H()), 0.5, 0.6, 0.9);
	composer.addPass(bloom);

	const SNOISE = `
		vec4 permute(vec4 x){return mod(((x*34.0)+1.0)*x,289.0);}
		vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
		float snoise(vec3 v){const vec2 C=vec2(1.0/6.0,1.0/3.0);const vec4 D=vec4(0.0,0.5,1.0,2.0);
		vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.0-g;
		vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);vec3 x1=x0-i1+1.0*C.xxx;vec3 x2=x0-i2+2.0*C.xxx;
		vec3 x3=x0-1.0+3.0*C.xxx;i=mod(i,289.0);
		vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
		float n_=1.0/7.0;vec3 ns=n_*D.wyz-D.xzx;vec4 j=p-49.0*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.0*x_);
		vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.0-abs(x)-abs(y);vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
		vec4 s0=floor(b0)*2.0+1.0;vec4 s1=floor(b1)*2.0+1.0;vec4 sh=-step(h,vec4(0.0));
		vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
		vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
		vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
		vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);m=m*m;
		return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));}`;

	function makeBlob(color, seed) {
		const geo = new THREE.IcosahedronGeometry(1, 24);
		const mat = new THREE.MeshPhysicalMaterial({
			color, roughness: 0.18, metalness: 0.0,
			transmission: 0.62, thickness: 1.6, ior: 1.38, attenuationDistance: 3.0,
			attenuationColor: new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.4),
			iridescence: 0.3, iridescenceIOR: 1.5, clearcoat: 1.0, clearcoatRoughness: 0.2,
			emissive: new THREE.Color(color).multiplyScalar(0.04),
		});
		mat.onBeforeCompile = (sh) => {
			sh.uniforms.uTime = { value: 0 }; sh.uniforms.uSeed = { value: seed }; sh.uniforms.uHover = { value: 0 };
			sh.vertexShader = `uniform float uTime; uniform float uSeed; uniform float uHover;\n${SNOISE}\n` + sh.vertexShader;
			sh.vertexShader = sh.vertexShader.replace("#include <begin_vertex>",
				`vec3 transformed = vec3(position);
				 float n = snoise(normalize(position)*1.05 + vec3(0.0,0.0,uTime*0.22+uSeed*10.0));
				 transformed += normal * n * (0.10 + uHover*0.05);`);
			mat.userData.sh = sh;
		};
		return new THREE.Mesh(geo, mat);
	}

	const raycaster = new THREE.Raycaster();
	const pointer = new THREE.Vector2();
	let blobs = [];
	const group = new THREE.Group(); scene.add(group);
	let hovered = null, selected = null;

	function build(results) {
		for (const b of blobs) { group.remove(b.mesh); b.mesh.geometry.dispose(); b.mesh.material.dispose(); b.fav.remove(); }
		blobs = [];
		const groups = {};
		(results || []).forEach((res) => { const k = groupOf(res); (groups[k] = groups[k] || []).push(res); });
		providers = Object.keys(groups).map((k) => ({ key: k, items: groups[k] }));
		activeProvider = 0; activeItem = 0;
		providersEl.innerHTML = "";
		providers.forEach((prov, pi) => {
			const color = colorFor(prov.key);
			const hex = "#" + new THREE.Color(color).getHexString();
			const h = document.createElement("div"); h.className = "cst-phead";
			const dot = document.createElement("span"); dot.className = "cst-pdot"; dot.style.color = hex;
			const name = document.createElement("span"); name.className = "cst-pname"; name.textContent = prov.key;
			const count = document.createElement("span"); count.className = "cst-pcount"; count.textContent = prov.items.length;
			h.append(dot, name, count); providersEl.appendChild(h); prov.headerEl = h;
			h.addEventListener("click", () => { activeProvider = pi; activeItem = 0; read.classList.remove("on"); selected = null; updateTargets(); });
			prov.items.forEach((res, ii) => {
				const mesh = makeBlob(color, Math.random());
				const baseScale = 0.95; mesh.scale.setScalar(baseScale);
				mesh.position.set((pi - activeProvider) * GAPX, 0, -9);
				mesh.userData = { res, pi, ii, hover: 0, baseScale };
				group.add(mesh);
				const fav = document.createElement("div"); fav.className = "cst-fav"; fav.style.borderColor = hex;
				const url = faviconFor(res);
				if (url) { const img = document.createElement("img"); img.src = url; img.alt = ""; img.onerror = () => { img.remove(); fav.appendChild(monoFav(res)); }; fav.appendChild(img); }
				else fav.appendChild(monoFav(res));
				labelsEl.appendChild(fav);
				blobs.push({ mesh, res, fav, pi, ii });
			});
		});
		computeMap(); updateTargets();
	}
	// Fallback favicon: first letter of the title, tinted — for note-like results.
	function monoFav(res) { const d = document.createElement("div"); d.className = "cst-fav-mono"; d.textContent = (res.title || "•").trim().charAt(0).toUpperCase(); return d; }

	function clampNav() {
		activeProvider = Math.max(0, Math.min(activeProvider, providers.length - 1));
		const len = providers[activeProvider] ? providers[activeProvider].items.length : 1;
		activeItem = Math.max(0, Math.min(activeItem, len - 1));
	}
	function updateTargets() {
		clampNav();
		for (const b of blobs) {
			const activeCol = b.pi === activeProvider;
			b.mesh.userData.target = new THREE.Vector3((b.pi - activeProvider) * GAPX, activeCol ? (b.ii - activeItem) * GAPY : 0, activeCol ? 0 : -3.0);
		}
		drawMap();
	}
	function focusedBlob() { return blobs.find((b) => b.pi === activeProvider && b.ii === activeItem); }

	// ── Relation map ──
	let mapNodes = [];
	function computeMap() {
		mapNodes = [];
		const cx = 95, cy = 86, R = 56;
		providers.forEach((prov, pi) => {
			const ang = (pi / Math.max(1, providers.length)) * Math.PI * 2 - Math.PI / 2;
			prov.map = { x: cx + Math.cos(ang) * R, y: cy + Math.sin(ang) * R, color: "#" + new THREE.Color(colorFor(prov.key)).getHexString() };
			const n = prov.items.length;
			prov.items.forEach((res, ii) => {
				const a2 = ang + (ii - (n - 1) / 2) * 0.55; const rr = n > 1 ? 20 : 12;
				mapNodes.push({ pi, ii, x: prov.map.x + Math.cos(a2) * rr, y: prov.map.y + Math.sin(a2) * rr, color: prov.map.color, link: linkKeyOf(res) });
			});
		});
	}
	function drawMap() {
		if (!mapSvg || !providers.length) return;
		let s = "";
		for (const nd of mapNodes) { const h = providers[nd.pi].map; s += `<line x1="${h.x}" y1="${h.y}" x2="${nd.x}" y2="${nd.y}" stroke="${nd.color}" stroke-opacity="0.3" stroke-width="0.7"/>`; }
		for (let i = 0; i < mapNodes.length; i++) for (let j = i + 1; j < mapNodes.length; j++) {
			const a = mapNodes[i], b = mapNodes[j];
			if (a.pi !== b.pi && a.link && a.link === b.link) s += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#7f9fe0" stroke-opacity="0.5" stroke-dasharray="2 2" stroke-width="0.7"/>`;
		}
		const hk = mapExpanded ? 1.5 : 1, nk = mapExpanded ? 1.7 : 1;
		providers.forEach((prov, pi) => { const h = prov.map, act = pi === activeProvider; s += `<circle class="mhub" data-pi="${pi}" cx="${h.x}" cy="${h.y}" r="${(act ? 4.5 : 3) * hk}" fill="${h.color}" fill-opacity="${act ? 1 : 0.55}"/>`; });
		if (mapExpanded) providers.forEach((prov, pi) => { const h = prov.map; s += `<text x="${h.x}" y="${h.y - 9}" text-anchor="middle" font-family="ui-monospace,monospace" font-size="5.5" letter-spacing="0.5" fill="${h.color}" fill-opacity="${pi === activeProvider ? 1 : 0.7}" pointer-events="none">${escapeXml((prov.key || "web").toUpperCase())}</text>`; });
		for (const nd of mapNodes) { const focus = nd.pi === activeProvider && nd.ii === activeItem; s += `<circle class="mnode" data-pi="${nd.pi}" data-ii="${nd.ii}" cx="${nd.x}" cy="${nd.y}" r="${(focus ? 3.2 : 2) * nk}" fill="${nd.color}" fill-opacity="${nd.pi === activeProvider ? 1 : 0.45}"/>`; if (focus) s += `<circle cx="${nd.x}" cy="${nd.y}" r="${6 * nk}" fill="none" stroke="#fff" stroke-opacity="0.85" stroke-width="0.8" pointer-events="none"/>`; }
		mapSvg.innerHTML = s;
	}
	function escapeXml(str) { return String(str).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])); }

	let mapExpanded = false;
	const mapEl = $(".cst-map");
	const mapSvg = $(".cst-map-svg");
	const mapToggle = $(".cst-map-toggle");
	const BASE_VIEW = { x: 0, y: 0, w: 190, h: 170 };
	let mapView = { ...BASE_VIEW };
	function setMapView() { mapSvg.setAttribute("viewBox", `${mapView.x} ${mapView.y} ${mapView.w} ${mapView.h}`); }
	function toggleMap(on) {
		mapExpanded = on ?? !mapExpanded;
		mapEl.classList.toggle("expanded", mapExpanded);
		mapToggle.textContent = mapExpanded ? "✕" : "⤢";
		mapToggle.title = mapExpanded ? "Collapse" : "Expand";
		mapView = { ...BASE_VIEW }; setMapView(); drawMap();
	}
	mapToggle.addEventListener("click", (e) => { e.stopPropagation(); toggleMap(); });
	["pointerdown", "pointerup", "pointermove", "click", "wheel"].forEach((ev) => mapEl.addEventListener(ev, (e) => e.stopPropagation(), { passive: false }));

	function selectNode(t) {
		if (!t || !t.classList) return;
		if (t.classList.contains("mnode")) {
			const pi = +t.dataset.pi, ii = +t.dataset.ii;
			activeProvider = pi; activeItem = ii; updateTargets();
			const b = blobs.find((x) => x.pi === pi && x.ii === ii);
			if (b) { selected = b.mesh; openRead(b.res, b.mesh.material.color.getHexString()); }
		} else if (t.classList.contains("mhub")) { activeProvider = +t.dataset.pi; activeItem = 0; updateTargets(); }
	}
	let mapDrag = null, mapPanned = false;
	mapSvg.addEventListener("pointerdown", (e) => { if (!mapExpanded) return; mapDrag = { x: e.clientX, y: e.clientY, vx: mapView.x, vy: mapView.y }; mapPanned = false; });
	mapSvg.addEventListener("pointermove", (e) => {
		if (!mapDrag) return;
		const r = mapSvg.getBoundingClientRect();
		const dx = (e.clientX - mapDrag.x) * (mapView.w / r.width), dy = (e.clientY - mapDrag.y) * (mapView.h / r.height);
		if (!mapPanned && Math.abs(e.clientX - mapDrag.x) + Math.abs(e.clientY - mapDrag.y) > 3) { mapPanned = true; try { mapSvg.setPointerCapture(e.pointerId); } catch (_) {} }
		mapView.x = mapDrag.vx - dx; mapView.y = mapDrag.vy - dy; setMapView();
	});
	mapSvg.addEventListener("click", (e) => { if (mapExpanded && !mapPanned) selectNode(e.target); });
	mapSvg.addEventListener("pointerup", (e) => { mapDrag = null; try { mapSvg.releasePointerCapture(e.pointerId); } catch (_) {} });
	mapSvg.addEventListener("wheel", (e) => {
		if (!mapExpanded) return; e.preventDefault();
		const r = mapSvg.getBoundingClientRect();
		const mx = mapView.x + ((e.clientX - r.left) / r.width) * mapView.w, my = mapView.y + ((e.clientY - r.top) / r.height) * mapView.h;
		const f = e.deltaY > 0 ? 1.12 : 0.89, nw = Math.min(380, Math.max(45, mapView.w * f)), k = nw / mapView.w;
		mapView.x = mx - (mx - mapView.x) * k; mapView.y = my - (my - mapView.y) * k; mapView.w = nw; mapView.h *= k; setMapView();
	}, { passive: false });

	// ── Read panel ──
	let readRes = null;
	function openRead(res, hex) {
		readRes = res;
		$(".cst-eng").textContent = groupOf(res);
		$(".cst-eng").style.color = "#" + hex;
		$(".cst-title").textContent = res.title || "";
		const u = $(".cst-src"); const sub = subtitleOf(res);
		u.textContent = sub; if (isHttp(res.url)) { u.href = res.url; u.style.display = ""; } else u.style.display = sub ? "" : "none";
		$(".cst-snippet").textContent = snippetOf(res);
		read.classList.add("on");
	}
	$(".cst-close").addEventListener("click", () => { read.classList.remove("on"); selected = null; });
	$(".cst-open").addEventListener("click", () => { if (readRes) onOpen(readRes); });

	// ── Settings panel ──
	const settingsBtn = $(".cst-settings-btn");
	const settingsPanel = $(".cst-settings-panel");
	settingsBtn.addEventListener("click", () => { settingsPanel.hidden = !settingsPanel.hidden; });
	root.addEventListener("pointerdown", (e) => { if (!settingsPanel.hidden && !settingsPanel.contains(e.target) && e.target !== settingsBtn) settingsPanel.hidden = true; });
	["pointerdown", "pointerup", "click", "wheel"].forEach((ev) => { settingsPanel.addEventListener(ev, (e) => e.stopPropagation()); settingsBtn.addEventListener(ev, (e) => e.stopPropagation()); });
	const setMotionEl = $(".cst-set-motion");
	setMotionEl.checked = motion;
	setMotionEl.addEventListener("change", () => { motion = setMotionEl.checked; });
	$(".cst-set-glass").addEventListener("change", (e) => setGlassMode(e.target.checked));
	$(".cst-set-nebula").addEventListener("change", (e) => clouds.forEach((c) => (c.visible = e.target.checked)));
	$(".cst-set-bloom").addEventListener("change", (e) => { bloom.enabled = e.target.checked; });
	$(".cst-set-glass").checked = true; $(".cst-set-nebula").checked = true; $(".cst-set-bloom").checked = bloom.enabled;

	// ── Search bar (only if the host gave us a data source) ──
	if (onSearch) {
		searchForm.hidden = false;
		if (config.placeholder) searchInput.placeholder = config.placeholder;
		if (config.initialQuery) searchInput.value = config.initialQuery;
		searchForm.addEventListener("submit", async (e) => {
			e.preventDefault();
			const q = searchInput.value.trim(); if (!q) return;
			read.classList.remove("on");
			try { build(await onSearch(q)); } catch (err) { console.error("[constellation] search failed", err); }
		});
	}

	// ── Pointer / keyboard interaction ──
	function ndc(e) { const r = canvas.getBoundingClientRect(); pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1; pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1; }
	let downXY = null, dragBaseProvider = 0, dragging = false;

	const onPointerMove = (e) => {
		ndc(e); parallax.set(pointer.x, pointer.y);
		if (downXY) {
			const dx = e.clientX - downXY[0];
			if (Math.abs(dx) > 6) dragging = true;
			const np = Math.max(0, Math.min(providers.length - 1, dragBaseProvider - Math.round(dx / 150)));
			if (np !== activeProvider) { activeProvider = np; activeItem = 0; read.classList.remove("on"); selected = null; updateTargets(); }
		}
		raycaster.setFromCamera(pointer, camera);
		const hit = raycaster.intersectObjects(group.children, false)[0];
		hovered = hit ? hit.object : null;
		if (hovered) {
			const r = canvas.getBoundingClientRect();
			tip.textContent = hovered.userData.res.title;
			tip.style.left = (e.clientX - r.left) + "px"; tip.style.top = (e.clientY - r.top) + "px";
			tip.classList.add("on"); root.style.cursor = "pointer";
		} else { tip.classList.remove("on"); root.style.cursor = "grab"; }
	};
	const onPointerDown = (e) => {
		if (mapEl.contains(e.target) || settingsPanel.contains(e.target) || settingsBtn.contains(e.target) || searchForm.contains(e.target) || read.contains(e.target)) return;
		downXY = [e.clientX, e.clientY]; dragBaseProvider = activeProvider; dragging = false;
	};
	const onPointerUp = (e) => {
		if (!downXY) return;
		const wasDrag = dragging; downXY = null; dragging = false;
		if (wasDrag) return;
		ndc(e); raycaster.setFromCamera(pointer, camera);
		const hit = raycaster.intersectObjects(group.children, false)[0];
		if (hit) { const b = blobs.find((x) => x.mesh === hit.object); if (b) { activeProvider = b.pi; activeItem = b.ii; updateTargets(); selected = hit.object; openRead(b.res, hit.object.material.color.getHexString()); } }
	};
	const onKeyDown = (e) => {
		let moved = true;
		if (e.key === "ArrowLeft") { activeProvider--; activeItem = 0; }
		else if (e.key === "ArrowRight") { activeProvider++; activeItem = 0; }
		else if (e.key === "ArrowUp") activeItem--;
		else if (e.key === "ArrowDown") activeItem++;
		else if (e.key === "Enter") { const b = focusedBlob(); if (b) { selected = b.mesh; openRead(b.res, b.mesh.material.color.getHexString()); } moved = false; }
		else if (e.key === "Escape") { if (mapExpanded) toggleMap(false); read.classList.remove("on"); selected = null; moved = false; }
		else return;
		if (moved) { e.preventDefault(); read.classList.remove("on"); selected = null; updateTargets(); }
	};
	// Drag/hover span the whole view; keys only while focused.
	root.addEventListener("pointerdown", onPointerDown);
	window.addEventListener("pointermove", onPointerMove);
	window.addEventListener("pointerup", onPointerUp);
	root.addEventListener("keydown", onKeyDown);

	// ── Resize ──
	function resize() {
		const w = W(), h = H(); if (!w || !h) return;
		camera.aspect = w / h; camera.updateProjectionMatrix();
		renderer.setSize(w, h); composer.setSize(w, h);
	}
	const ro = new ResizeObserver(resize); ro.observe(root);

	// ── Loop ──
	const clock = new THREE.Clock();
	const _v = new THREE.Vector3(), _f = new THREE.Vector3();
	let rafId = 0, disposed = false;
	function tick() {
		if (disposed) return;
		const t = clock.getElapsedTime();
		const w = W(), h = H();
		if (motion) {
			clouds.forEach((c, i) => {
				c.material.uniforms.uTime.value = i ? t * 0.7 + 40.0 : t;
				const b = c.userData.base, ph = c.userData.ph;
				c.position.x = b.x + Math.sin(t * 0.05 + ph) * 2.4;
				c.position.y = b.y + Math.cos(t * 0.043 + ph * 1.3) * 1.7;
				c.rotation.z = Math.sin(t * 0.021 + ph) * 0.16;
				const s = 1 + Math.sin(t * 0.08 + ph) * 0.07; c.scale.set(s, s, 1);
			});
			for (const c of cubes.children) {
				c.position.addScaledVector(c.userData.drift, 0.03);
				c.rotation.x += c.userData.spin.x; c.rotation.y += c.userData.spin.y; c.rotation.z += c.userData.spin.z;
				const d = c.position.length();
				if (d > 36) { seedCube(c); c.scale.set(0, 0, 0); continue; }
				const fade = smoothstep(2.0, 8.0, d) * (1 - smoothstep(26.0, 34.0, d));
				const b = c.userData.base; c.scale.set(b.x * fade, b.y * fade, b.z * fade);
			}
			for (const cm of comets) {
				cm.phase += cm.speed * 0.01;
				const px = Math.sin(cm.phase * 1.3) * cm.radius, py = Math.cos(cm.phase * 0.9) * cm.radius * 0.6, pz = Math.sin(cm.phase * 0.7) * cm.radius - 5;
				cm.head.position.set(px, py, pz);
				cm.hist.copyWithin(3, 0, cm.hist.length - 3); cm.hist[0] = px; cm.hist[1] = py; cm.hist[2] = pz;
				cm.geo.attributes.position.needsUpdate = true;
			}
		}
		const foc = focusedBlob();
		for (const b of blobs) {
			const m = b.mesh;
			if (m.userData.target) m.position.lerp(m.userData.target, 0.14);
			const lit = b === foc || m === hovered;
			m.userData.hover += ((lit ? 1 : 0) - m.userData.hover) * 0.15;
			const sh = m.material.userData.sh;
			if (sh) { sh.uniforms.uTime.value = motion ? t : 0; sh.uniforms.uHover.value = m.userData.hover; }
			m.scale.setScalar(m.userData.baseScale * (1 + m.userData.hover * 0.2));
			if (motion) m.rotation.y += 0.0016;
			m.material.emissive.copy(m.material.color).multiplyScalar(0.025 + m.userData.hover * 0.55);
			_v.copy(m.position); _v.project(camera);
			const behind = _v.z > 1;
			b.fav.style.left = (_v.x * 0.5 + 0.5) * w + "px"; b.fav.style.top = (-_v.y * 0.5 + 0.5) * h + "px";
			const colDim = b.pi === activeProvider ? 0.85 : 0.4;
			b.fav.style.opacity = behind ? "0" : lit ? "1" : String(colDim);
			const sz = lit ? 42 : 27; b.fav.style.width = sz + "px"; b.fav.style.height = sz + "px";
		}
		for (let pi = 0; pi < providers.length; pi++) {
			const prov = providers[pi], active = pi === activeProvider;
			_v.set((pi - activeProvider) * GAPX, 5.0, active ? 0 : -3).project(camera);
			const behind = _v.z > 1;
			prov.headerEl.style.left = (_v.x * 0.5 + 0.5) * w + "px"; prov.headerEl.style.top = (-_v.y * 0.5 + 0.5) * h + "px";
			prov.headerEl.style.opacity = behind ? "0" : active ? "1" : "0.45";
			prov.headerEl.classList.toggle("active", active);
		}
		if (foc && providers[activeProvider]) {
			_f.copy(foc.mesh.position); _f.project(camera);
			mono.style.left = (_f.x * 0.5 + 0.5) * w + "px"; mono.style.top = (-_f.y * 0.5 + 0.5) * h + "px";
			const len = providers[activeProvider].items.length;
			mono.querySelector(".cst-m-id").textContent = "SPECIMEN " + String(activeItem + 1).padStart(2, "0") + " / " + String(len).padStart(2, "0") + " · " + providers[activeProvider].key.toUpperCase();
			mono.querySelector(".cst-m-dom").textContent = subtitleOf(foc.res);
			mono.querySelector(".cst-m-title").textContent = foc.res.title;
			mono.classList.add("on");
		} else mono.classList.remove("on");
		const px = motion ? parallax.x : 0, py = motion ? parallax.y : 0;
		camera.position.x += (px * 1.4 - camera.position.x) * 0.05;
		camera.position.y += (py * 0.9 - camera.position.y) * 0.05;
		camera.lookAt(0, 0, 0);
		composer.render();
		rafId = requestAnimationFrame(tick);
	}
	tick();

	// ── Public API ──
	function dispose() {
		disposed = true; cancelAnimationFrame(rafId); ro.disconnect();
		window.removeEventListener("pointermove", onPointerMove);
		window.removeEventListener("pointerup", onPointerUp);
		for (const b of blobs) { b.mesh.geometry.dispose(); b.mesh.material.dispose(); }
		cubeGeo.dispose(); cubeMat.dispose();
		clouds.forEach((c) => { c.geometry.dispose(); c.material.dispose(); });
		envRT.texture.dispose(); pmrem.dispose(); composer.dispose(); renderer.dispose();
		root.remove();
	}

	return {
		el: root,
		setResults: build,
		search: async (q) => { if (onSearch) build(await onSearch(q)); },
		setMotion: (on) => { motion = on; setMotionEl.checked = on; },
		focus: () => root.focus(),
		dispose,
	};
}
