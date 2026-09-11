/**
 * WatercolorBackground.js
 * Dual-Canvas Watercolor Fluid Simulation (Context-Safe, Flicker-Free & Color-Preserving)
 */
class WatercolorBackground {
  constructor(frontCanvas, backCanvas, options = {}) {
    this.frontCanvas = frontCanvas; // 2D Mask Overlay Canvas
    this.backCanvas = backCanvas;   // WebGL Background Canvas

    if (!this.frontCanvas || !this.backCanvas) {
      throw new Error("WatercolorBackground requires both a front and back canvas.");
    }

    this.ctxFront = this.frontCanvas.getContext('2d');

    this.config = {
      vorticity: options.vorticity ?? 20.0,
      dissipation: options.dissipation ?? 0.995,
      velocityDissipation: options.velocityDissipation ?? 0.97,
      dryingRate: options.dryingRate ?? 0.64,
      viscosityThickness: options.viscosityThickness ?? 1.0,
      drySaturationCap: options.drySaturationCap ?? 1.0,
      brushRadius: options.brushRadius ?? (window.innerWidth < 768 ? 0.00065 : 0.001),
      pressureSolveIterations: options.pressureSolveIterations ?? 10,
      impulseForceScale: options.impulseForceScale ?? 2200.0,
      inkColor: options.inkColor ?? { r: 1.0, g: 0.08, b: 0.39 },
      paperColor: options.paperColor ?? { r: 0.071, g: 0.067, b: 0.078 },
      enableScrollEvents: options.enableScrollEvents ?? true,
      enablePointerEvents: options.enablePointerEvents ?? true
    };

    this.simWidth = 64;
    this.simHeight = 64;

    this.isRevealing = false;
    this.revealStartTime = 0;
    this.REVEAL_DURATION_MS = 2000;
    this.SWEEP_CYCLES = 8.0;
    this.lastSweepPoint = { x: 0.14, y: 1.04 };
    this.accumulatedSweepDistance = 0;

    this.autoRevealTimeoutId = null;
    this.isGlobalFadeActive = false;
    this.globalFadeStartTime = 0;
    this.GLOBAL_FADE_DURATION_MS = 2000;
    this.AUTO_REVEAL_DELAY_MS = 1200;

    this.lastScrollY = window.scrollY;
    this.scrollDeltaAccumulator = 0;
    this.scrollStepIndex = 0;
    this.lastScrollPoint = { x: 0.5, y: 0.5 };

    this.isInteracting = false;
    this.lastPointerState = { x: 0.5, y: 0.5, timestamp: performance.now() };

    this.lastFrameTimestamp = performance.now();
    this.animationFrameId = null;

    this._initWebGL();
    this._bindEvents();
  }

  _initWebGL() {
    this.gl = this.backCanvas.getContext('webgl2', {
      alpha: true,
      depth: false,
      stencil: false,
      antialias: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance'
    });

    if (!this.gl) throw new Error("WebGL2 is not supported.");

    const gl = this.gl;
    this.extColorBufferFloat = gl.getExtension('EXT_color_buffer_float');
    this.textureFilter = gl.getExtension('OES_texture_float_linear') ? gl.LINEAR : gl.NEAREST;

    this.paperTexture = this._generatePaperTexture(512);
    this._setupQuad();
    this._setupShaders();
    this._setupBuffers();
  }

  _generatePaperTexture(dimension = 512) {
    const gl = this.gl;
    const texCanvas = document.createElement('canvas');
    texCanvas.width = dimension;
    texCanvas.height = dimension;
    const ctx = texCanvas.getContext('2d');

    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, dimension, dimension);

    const imageData = ctx.getImageData(0, 0, dimension, dimension);
    const pixels = imageData.data;
    let randomSeed = 42819;

    const nextRandom = () => {
      randomSeed = (randomSeed * 16807) % 2147483647;
      return (randomSeed - 1) / 2147483646;
    };

    for (let i = 0; i < dimension * dimension; i++) {
      const noise = (nextRandom() - 0.5) * 20;
      const index = i * 4;
      pixels[index] = Math.min(255, Math.max(0, pixels[index] + noise));
      pixels[index + 1] = Math.min(255, Math.max(0, pixels[index + 1] + noise));
      pixels[index + 2] = Math.min(255, Math.max(0, pixels[index + 2] + noise));
    }
    ctx.putImageData(imageData, 0, 0);

    ctx.lineWidth = 0.5;
    for (let f = 0; f < 380; f++) {
      const startX = nextRandom() * dimension;
      const startY = nextRandom() * dimension;
      const length = 6 + nextRandom() * 24;
      const angle = nextRandom() * Math.PI * 2;

      ctx.strokeStyle = nextRandom() > 0.5 ? 'rgba(50, 50, 50, 0.22)' : 'rgba(255, 255, 255, 0.18)';
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.quadraticCurveTo(
        startX + Math.cos(angle) * length * 0.5 + (nextRandom() - 0.5) * 6,
        startY + Math.sin(angle) * length * 0.5 + (nextRandom() - 0.5) * 6,
        startX + Math.cos(angle) * length,
        startY + Math.sin(angle) * length
      );
      ctx.stroke();
    }

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, texCanvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return texture;
  }

  _createShader(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source.trim());
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  _createProgram(vertexSource, fragmentSource) {
    const gl = this.gl;
    const vs = this._createShader(gl.VERTEX_SHADER, vertexSource);
    const fs = this._createShader(gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
    return program;
  }

  _setupQuad() {
    const gl = this.gl;
    this.quadVao = gl.createVertexArray();
    gl.bindVertexArray(this.quadVao);
    const quadVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 1, -1, -1, 1,
      -1, 1, 1, -1, 1, 1
    ]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  }

  _setupShaders() {
    const screenQuadVS = `#version 300 es
    precision highp float;
    layout(location = 0) in vec2 aPosition;
    out vec2 vUv;
    void main() {
      vUv = aPosition * 0.5 + 0.5;
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }`;

    const precisionHeaderFS = `#version 300 es
    precision highp float;
    in vec2 vUv;
    out vec4 outColor;
    uniform vec2 uTexelSize;
    vec4 sampleLeft(sampler2D tex)   { return texture(tex, vUv - vec2(uTexelSize.x, 0.0)); }
    vec4 sampleRight(sampler2D tex)  { return texture(tex, vUv + vec2(uTexelSize.x, 0.0)); }
    vec4 sampleBottom(sampler2D tex) { return texture(tex, vUv - vec2(0.0, uTexelSize.y)); }
    vec4 sampleTop(sampler2D tex)    { return texture(tex, vUv + vec2(0.0, uTexelSize.y)); }
    `;

    const advectionFS = `${precisionHeaderFS}
    uniform sampler2D uVelocity;
    uniform sampler2D uSource;
    uniform float dt;
    uniform float dissipation;
    void main() {
      vec2 vel = texture(uVelocity, vUv).xy;
      vec2 coord = vUv - dt * vel * uTexelSize;
      outColor = dissipation * texture(uSource, coord);
    }`;

    const divergenceFS = `${precisionHeaderFS}
    uniform sampler2D uVelocity;
    void main() {
      vec4 left = sampleLeft(uVelocity);
      vec4 right = sampleRight(uVelocity);
      vec4 bottom = sampleBottom(uVelocity);
      vec4 top = sampleTop(uVelocity);
      outColor = vec4(0.5 * (right.x - left.x + top.y - bottom.y), 0.0, 0.0, 1.0);
    }`;

    const pressureSolveFS = `${precisionHeaderFS}
    uniform sampler2D uPressure;
    uniform sampler2D uDivergence;
    void main() {
      vec4 left = sampleLeft(uPressure);
      vec4 right = sampleRight(uPressure);
      vec4 bottom = sampleBottom(uPressure);
      vec4 top = sampleTop(uPressure);
      float div = texture(uDivergence, vUv).x;
      outColor = vec4((left.x + right.x + bottom.x + top.x - div) * 0.25, 0.0, 0.0, 1.0);
    }`;

    const gradientSubtractionFS = `${precisionHeaderFS}
    uniform sampler2D uPressure;
    uniform sampler2D uVelocity;
    void main() {
      vec4 left = sampleLeft(uPressure);
      vec4 right = sampleRight(uPressure);
      vec4 bottom = sampleBottom(uPressure);
      vec4 top = sampleTop(uPressure);
      vec2 vel = texture(uVelocity, vUv).xy;
      outColor = vec4(vel - 0.5 * vec2(right.x - left.x, top.y - bottom.y), 0.0, 1.0);
    }`;

    const vorticityCurlFS = `${precisionHeaderFS}
    uniform sampler2D uVelocity;
    void main() {
      vec2 off = uTexelSize * 2.0;
      float right = texture(uVelocity, vUv + vec2(off.x, 0.0)).y;
      float left  = texture(uVelocity, vUv - vec2(off.x, 0.0)).y;
      float top   = texture(uVelocity, vUv + vec2(0.0, off.y)).x;
      float bottom= texture(uVelocity, vUv - vec2(0.0, off.y)).x;
      outColor = vec4(0.5 * (right - left - (top - bottom)), 0.0, 0.0, 1.0);
    }`;

    const vorticityForceFS = `${precisionHeaderFS}
    uniform sampler2D uVelocity;
    uniform sampler2D uCurl;
    uniform float dt;
    uniform float strength;
    void main() {
      vec2 off = uTexelSize * 5.2;
      float right = abs(texture(uCurl, vUv + vec2(off.x, 0.0)).x);
      float left  = abs(texture(uCurl, vUv - vec2(off.x, 0.0)).x);
      float top   = abs(texture(uCurl, vUv + vec2(0.0, off.y)).x);
      float bottom= abs(texture(uCurl, vUv - vec2(0.0, off.y)).x);
      float center = texture(uCurl, vUv).x;
      vec2 force = 0.5 * vec2(top - bottom, right - left);
      force /= length(force) + 0.0001;
      force *= strength * center * vec2(1.0, -1.0);
      vec2 vel = texture(uVelocity, vUv).xy;
      outColor = vec4(vel + force * dt, 0.0, 1.0);
    }`;

    const boundaryClampFS = `${precisionHeaderFS}
    uniform sampler2D uTarget;
    uniform float scale;
    void main() {
      vec2 uv = vUv;
      vec4 data = texture(uTarget, uv);
      if (uv.x < uTexelSize.x) data = scale * texture(uTarget, uv + vec2(uTexelSize.x, 0.0));
      if (uv.x > 1.0 - uTexelSize.x) data = scale * texture(uTarget, uv - vec2(uTexelSize.x, 0.0));
      if (uv.y < uTexelSize.y) data = scale * texture(uTarget, uv + vec2(0.0, uTexelSize.y));
      if (uv.y > 1.0 - uTexelSize.y) data = scale * texture(uTarget, uv - vec2(0.0, uTexelSize.y));
      outColor = data;
    }`;

    const splatFS = `${precisionHeaderFS}
    uniform sampler2D uTarget;
    uniform float uAspect;
    uniform vec2 uPoint;
    uniform vec2 uDir;
    uniform float uRadius;
    uniform vec4 uColor;
    uniform float uShape;

    void main() {
      vec2 p = vUv - uPoint;
      p.x *= uAspect;

      if (uShape > 0.5) {
        vec2 d = normalize(uDir + vec2(0.0001));
        vec2 perp = vec2(-d.y, d.x);
        float along = dot(p, d);
        float across = dot(p, perp);
        p = vec2(along * 0.48, across * 1.42);
      }

      float m = exp(-dot(p, p) / max(uRadius, 0.000001));
      vec4 base = texture(uTarget, vUv);
      outColor = base + m * uColor;
    }`;

    const pigmentFixationFS = `${precisionHeaderFS}
    uniform sampler2D uWet;
    uniform sampler2D uDry;
    uniform float dryRate;
    uniform float dt;
    uniform float thicknessK;

    void main() {
      vec4 w = texture(uWet, vUv);
      vec4 d = texture(uDry, vUv);
      float wet0 = clamp(w.a, 0.0, 1.0);
      float density = max(max(w.r, w.g), w.b);
      float thicknessFactor = 1.0 / (1.0 + density * thicknessK);
      float dried = min(dryRate * thicknessFactor * dt, wet0);
      float frac = wet0 > 0.0001 ? (dried / wet0) : 0.0;
      
      // Transfer pigment gradually to dry state
      vec3 transfer = w.rgb * frac * 4.0;
      outColor = vec4(d.rgb + transfer, min(d.a + dried, 1.0));
    }`;

    const solventEvaporationFS = `${precisionHeaderFS}
    uniform sampler2D uWet;
    uniform float dryRate;
    uniform float dt;
    uniform float thicknessK;

    void main() {
      vec4 w = texture(uWet, vUv);
      float wet0 = clamp(w.a, 0.0, 1.0);
      float density = max(max(w.r, w.g), w.b);
      float thicknessFactor = 1.0 / (1.0 + density * thicknessK);
      float wet1 = max(wet0 - dryRate * thicknessFactor * dt, 0.0);
      float keep = wet0 > 0.0001 ? (wet1 / wet0) : 0.0;
      outColor = vec4(w.rgb * keep, wet1);
    }`;

    // Color-safe Front Mask Shader
    const compositeMaskFS = `#version 300 es
    precision highp float;
    in vec2 vUv;
    out vec4 outColor;

    uniform sampler2D uWet;
    uniform sampler2D uDry;
    uniform sampler2D uPaper;
    uniform vec2 uResolution;
    uniform vec3 uPaperColor;
    uniform vec3 uInkColor;

    void main() {
      vec4 wet = texture(uWet, vUv);
      vec4 dry = texture(uDry, vUv);
      vec2 screenCoord = vUv * uResolution;
      vec3 paperTex = texture(uPaper, screenCoord / 512.0).rgb;

      vec3 paper = uPaperColor * (0.82 + paperTex.r * 0.36);

      float wetDensity = max(max(wet.r, wet.g), wet.b);
      float dryDensity = max(max(dry.r, dry.g), dry.b);

      // Wet pigment slightly overshoots for vibrancy...
      vec3 wetPigment = (wetDensity > 0.0001) ? clamp((wet.rgb / wetDensity) * 1.25, 0.0, 1.0) : uInkColor;
      
      // ...while Dry pigment cleanly settles directly to exact uInkColor
      float dryCoverage = 1.0 - exp(-dryDensity * 1.2);
      vec3 dryPigment = mix(paper, uInkColor, dryCoverage);

      float totalDensity = wetDensity + dryDensity;
      float totalCoverage = 1.0 - exp(-totalDensity * 1.0);
      
      vec3 basePigment = mix(dryPigment, wetPigment, clamp(wetDensity / max(totalDensity, 0.0001), 0.0, 1.0));
      vec3 color = mix(paper, basePigment, totalCoverage);

      float wetAmt = clamp(wet.a, 0.0, 1.0);
      float density = max(wetDensity, dryDensity);
      float edge = smoothstep(0.002, 0.018, length(vec2(dFdx(density), dFdy(density))));

      float rawAlpha = clamp(density * 0.42 + wetAmt * 0.16 + edge * 0.08, 0.0, 0.45);
      float washAmount = clamp(density * 0.85 + wetAmt * 0.6, 0.0, 1.0);
      float reveal = smoothstep(0.02, 0.42, washAmount);

      float finalAlpha = mix(1.0, rawAlpha, reveal);
      outColor = vec4(clamp(color, 0.0, 1.0) * finalAlpha, finalAlpha);
    }`;

    // Color-safe Back Background Shader
    const compositeBackgroundFS = `#version 300 es
    precision highp float;
    in vec2 vUv;
    out vec4 outColor;

    uniform sampler2D uWet;
    uniform sampler2D uDry;
    uniform sampler2D uPaper;
    uniform vec2 uResolution;
    uniform vec3 uPaperColor;
    uniform vec3 uInkColor;

    void main() {
      vec4 wet = texture(uWet, vUv);
      vec4 dry = texture(uDry, vUv);
      vec2 screenCoord = vUv * uResolution;
      vec3 paperTex = texture(uPaper, screenCoord / 512.0).rgb;

      vec3 paper = uPaperColor * (0.82 + paperTex.r * 0.36);

      float wetDensity = max(max(wet.r, wet.g), wet.b);
      float dryDensity = max(max(dry.r, dry.g), dry.b);

      // Wet pigment overshoots initially...
      vec3 wetPigment = (wetDensity > 0.0001) ? clamp((wet.rgb / wetDensity) * 1.25, 0.0, 1.0) : uInkColor;
      
      // ...while Dry pigment cleanly settles into exact target uInkColor
      float dryCoverage = 1.0 - exp(-dryDensity * 1.2);
      vec3 dryPigment = mix(paper, uInkColor, dryCoverage);

      float totalDensity = wetDensity + dryDensity;
      float totalCoverage = 1.0 - exp(-totalDensity * 1.0);

      vec3 basePigment = mix(dryPigment, wetPigment, clamp(wetDensity / max(totalDensity, 0.0001), 0.0, 1.0));
      vec3 color = mix(paper, basePigment, totalCoverage);

      float grain = fract(sin(dot(screenCoord * 0.72, vec2(12.9898, 78.233))) * 43758.5453);
      color += (grain - 0.5) * 0.022 * totalCoverage * uInkColor;

      outColor = vec4(clamp(color, 0.0, 1.0), 1.0);
    }`;

    const copyFS = `#version 300 es
    precision highp float;
    in vec2 vUv;
    out vec4 outColor;
    uniform sampler2D uSource;
    void main() {
      outColor = texture(uSource, vUv);
    }`;

    this.programs = {
      advect: this._createProgram(screenQuadVS, advectionFS),
      divergence: this._createProgram(screenQuadVS, divergenceFS),
      pressure: this._createProgram(screenQuadVS, pressureSolveFS),
      gradient: this._createProgram(screenQuadVS, gradientSubtractionFS),
      curl: this._createProgram(screenQuadVS, vorticityCurlFS),
      vorticity: this._createProgram(screenQuadVS, vorticityForceFS),
      boundary: this._createProgram(screenQuadVS, boundaryClampFS),
      splat: this._createProgram(screenQuadVS, splatFS),
      pigmentFixation: this._createProgram(screenQuadVS, pigmentFixationFS),
      solventEvaporation: this._createProgram(screenQuadVS, solventEvaporationFS),
      compositeFront: this._createProgram(screenQuadVS, compositeMaskFS),
      compositeBack: this._createProgram(screenQuadVS, compositeBackgroundFS),
      copy: this._createProgram(screenQuadVS, copyFS)
    };
  }

  _createRenderTarget(width, height) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);

    const internalFormat = this.extColorBufferFloat ? gl.RGBA16F : gl.RGBA;
    const type = this.extColorBufferFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;

    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, gl.RGBA, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, this.textureFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, this.textureFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    return { fbo, texture: tex, width, height };
  }

  _resizeRenderTarget(target, width, height) {
    const gl = this.gl;
    if (target.width === width && target.height === height) return;
    
    const oldTexture = target.texture;
    const newTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, newTexture);

    const internalFormat = this.extColorBufferFloat ? gl.RGBA16F : gl.RGBA;
    const type = this.extColorBufferFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;

    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, gl.RGBA, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, this.textureFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, this.textureFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, newTexture, 0);

    if (this.programs.copy && oldTexture) {
      gl.viewport(0, 0, width, height);
      gl.useProgram(this.programs.copy);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, oldTexture);
      gl.uniform1i(gl.getUniformLocation(this.programs.copy, 'uSource'), 0);
      gl.bindVertexArray(this.quadVao);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    gl.deleteTexture(oldTexture);
    target.texture = newTexture;
    target.width = width;
    target.height = height;
  }

  _createDoubleBuffer(width, height) {
    let readTarget = this._createRenderTarget(width, height);
    let writeTarget = this._createRenderTarget(width, height);
    return {
      get read() { return readTarget; },
      get write() { return writeTarget; },
      swap() {
        const temp = readTarget;
        readTarget = writeTarget;
        writeTarget = temp;
      },
      clear: () => {
        [readTarget, writeTarget].forEach(target => {
          this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, target.fbo);
          this.gl.clearColor(0, 0, 0, 0);
          this.gl.clear(this.gl.COLOR_BUFFER_BIT);
        });
      },
      resize: (w, h) => {
        this._resizeRenderTarget(readTarget, w, h);
        this._resizeRenderTarget(writeTarget, w, h);
      }
    };
  }

  _setupBuffers() {
    this.velocityBuffer = this._createDoubleBuffer(this.simWidth, this.simHeight);
    this.wetBuffer = this._createDoubleBuffer(this.simWidth, this.simHeight);
    this.dryBuffer = this._createDoubleBuffer(this.simWidth, this.simHeight);
    this.pressureBuffer = this._createDoubleBuffer(this.simWidth, this.simHeight);
    this.divergenceTarget = this._createRenderTarget(this.simWidth, this.simHeight);
    this.curlTarget = this._createRenderTarget(this.simWidth, this.simHeight);
  }

  _renderPass(program, setupUniformsFn, targetFBO) {
    if (!program) return;
    const gl = this.gl;
    const w = targetFBO ? targetFBO.width : this.simWidth;
    const h = targetFBO ? targetFBO.height : this.simHeight;
    gl.viewport(0, 0, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFBO ? targetFBO.fbo : null);
    gl.useProgram(program);

    const texelLocation = gl.getUniformLocation(program, 'uTexelSize');
    if (texelLocation) gl.uniform2f(texelLocation, 1.0 / w, 1.0 / h);

    if (setupUniformsFn) setupUniformsFn(program);

    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  _applyBoundaryConditions(doubleBuffer, scale) {
    const gl = this.gl;
    this._renderPass(this.programs.boundary, (p) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, doubleBuffer.read.texture);
      gl.uniform1i(gl.getUniformLocation(p, 'uTarget'), 0);
      gl.uniform1f(gl.getUniformLocation(p, 'scale'), scale);
    }, doubleBuffer.write);
    doubleBuffer.swap();
  }

  _applySplat(doubleBuffer, uvX, uvY, r, g, b, a, radius, shape, dirX, dirY) {
    const gl = this.gl;
    this._renderPass(this.programs.splat, (p) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, doubleBuffer.read.texture);
      gl.uniform1i(gl.getUniformLocation(p, 'uTarget'), 0);

      const aspect = this.backCanvas.width / Math.max(1, this.backCanvas.height);
      gl.uniform1f(gl.getUniformLocation(p, 'uAspect'), aspect);
      gl.uniform2f(gl.getUniformLocation(p, 'uPoint'), uvX, uvY);
      gl.uniform2f(gl.getUniformLocation(p, 'uDir'), dirX, dirY);
      gl.uniform1f(gl.getUniformLocation(p, 'uRadius'), radius);
      gl.uniform4f(gl.getUniformLocation(p, 'uColor'), r, g, b, a);
      gl.uniform1f(gl.getUniformLocation(p, 'uShape'), shape);
    }, doubleBuffer.write);
    doubleBuffer.swap();
  }

  injectInkStroke(x, y, deltaX, deltaY, baseRadius, pigment, isWater = false, pressure = 0.6) {
    const aspect = this.backCanvas.width / Math.max(1, this.backCanvas.height);
    const isoDx = deltaX * aspect;
    const isoDy = deltaY;
    const distance = Math.hypot(isoDx, isoDy);
    const normDirX = distance > 1e-5 ? isoDx / distance : 1.0;
    const normDirY = distance > 1e-5 ? isoDy / distance : 0.0;

    const radius = baseRadius + pressure * 0.00045;
    const velocityImpulse = Math.min(46.0, 8.0 + distance * this.config.impulseForceScale);
    const opacity = Math.min(0.60, 0.28 + pressure * 0.08);

    this._applySplat(
      this.velocityBuffer,
      x, y,
      normDirX * velocityImpulse, normDirY * velocityImpulse, 0.0, 1.0,
      radius * 1.25,
      0.0, normDirX, normDirY
    );

    if (!isWater && pigment) {
      // Slightly higher wet density injection to create an initial color bloom
      this._applySplat(
        this.wetBuffer,
        x, y,
        pigment.r * opacity * 0.35,
        pigment.g * opacity * 0.35,
        pigment.b * opacity * 0.35,
        opacity,
        radius,
        distance > 0.0009 ? 1.0 : 0.0,
        normDirX, normDirY
      );
    }

    const satelliteRadius = Math.sqrt(radius) * 0.62;
    for (let s = 0; s < 6; s++) {
      const angle = (s / 6) * Math.PI * 2;
      const cosAngle = Math.cos(angle);
      const sinAngle = Math.sin(angle);
      const satX = Math.max(0.001, Math.min(0.999, x + (cosAngle * satelliteRadius) / aspect));
      const satY = Math.max(0.001, Math.min(0.999, y + sinAngle * satelliteRadius));

      this._applySplat(
        this.velocityBuffer,
        satX, satY,
        (cosAngle * 26.0) / aspect, sinAngle * 26.0, 0.0, 1.0,
        radius * 1.08,
        0.0, cosAngle, sinAngle
      );
    }
  }

  createInkSplatter(originX, originY, baseRadius, pigment) {
    const aspect = this.backCanvas.width / Math.max(1, this.backCanvas.height);
    const splatterRadius = baseRadius * (2.2 + Math.random() * 1.6);
    const pressure = 0.85 + Math.random() * 0.3;

    const angle = Math.random() * Math.PI * 2;
    const speed = 0.04 + Math.random() * 0.08;
    this.injectInkStroke(
      originX, originY,
      (Math.cos(angle) * speed) / aspect, Math.sin(angle) * speed,
      splatterRadius, pigment, false, pressure
    );

    const dropletCount = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < dropletCount; i++) {
      const dropAngle = Math.random() * Math.PI * 2;
      const dropDistance = 0.015 + Math.random() * 0.04;
      const dropX = Math.max(0.10, Math.min(0.90, originX + (Math.cos(dropAngle) * dropDistance) / aspect));
      const dropY = Math.max(0.04, Math.min(0.96, originY + Math.sin(dropAngle) * dropDistance));
      const dropRadius = baseRadius * (0.6 + Math.random() * 0.6);

      this.injectInkStroke(
        dropX, dropY,
        (Math.cos(dropAngle) * 0.03) / aspect, Math.sin(dropAngle) * 0.03,
        dropRadius, pigment, false, 0.68
      );
    }
  }

  _simulateFluid(dt) {
    const gl = this.gl;
    const effectiveVelocityDissipation = Math.pow(this.config.velocityDissipation, dt * 60.0);
    const effectivePigmentDissipation = Math.pow(this.config.dissipation, dt * 60.0);

    this._renderPass(this.programs.curl, (p) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.velocityBuffer.read.texture);
      gl.uniform1i(gl.getUniformLocation(p, 'uVelocity'), 0);
    }, this.curlTarget);

    this._renderPass(this.programs.vorticity, (p) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.velocityBuffer.read.texture);
      gl.uniform1i(gl.getUniformLocation(p, 'uVelocity'), 0);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.curlTarget.texture);
      gl.uniform1i(gl.getUniformLocation(p, 'uCurl'), 1);

      gl.uniform1f(gl.getUniformLocation(p, 'dt'), dt);
      gl.uniform1f(gl.getUniformLocation(p, 'strength'), this.config.vorticity);
    }, this.velocityBuffer.write);
    this.velocityBuffer.swap();

    this._renderPass(this.programs.advect, (p) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.velocityBuffer.read.texture);
      gl.uniform1i(gl.getUniformLocation(p, 'uVelocity'), 0);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.velocityBuffer.read.texture);
      gl.uniform1i(gl.getUniformLocation(p, 'uSource'), 1);

      gl.uniform1f(gl.getUniformLocation(p, 'dt'), dt);
      gl.uniform1f(gl.getUniformLocation(p, 'dissipation'), effectiveVelocityDissipation);
    }, this.velocityBuffer.write);
    this.velocityBuffer.swap();
    this._applyBoundaryConditions(this.velocityBuffer, -1.0);

    this._renderPass(this.programs.advect, (p) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.velocityBuffer.read.texture);
      gl.uniform1i(gl.getUniformLocation(p, 'uVelocity'), 0);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.wetBuffer.read.texture);
      gl.uniform1i(gl.getUniformLocation(p, 'uSource'), 1);

      gl.uniform1f(gl.getUniformLocation(p, 'dt'), dt);
      gl.uniform1f(gl.getUniformLocation(p, 'dissipation'), effectivePigmentDissipation);
    }, this.wetBuffer.write);
    this.wetBuffer.swap();
    this._applyBoundaryConditions(this.wetBuffer, 0.0);

    if (this.config.dryingRate > 0.0) {
      this._renderPass(this.programs.pigmentFixation, (p) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.wetBuffer.read.texture);
        gl.uniform1i(gl.getUniformLocation(p, 'uWet'), 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.dryBuffer.read.texture);
        gl.uniform1i(gl.getUniformLocation(p, 'uDry'), 1);

        gl.uniform1f(gl.getUniformLocation(p, 'dryRate'), this.config.dryingRate);
        gl.uniform1f(gl.getUniformLocation(p, 'dt'), dt);
        gl.uniform1f(gl.getUniformLocation(p, 'thicknessK'), this.config.viscosityThickness);
      }, this.dryBuffer.write);
      this.dryBuffer.swap();

      this._renderPass(this.programs.solventEvaporation, (p) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.wetBuffer.read.texture);
        gl.uniform1i(gl.getUniformLocation(p, 'uWet'), 0);

        gl.uniform1f(gl.getUniformLocation(p, 'dryRate'), this.config.dryingRate);
        gl.uniform1f(gl.getUniformLocation(p, 'dt'), dt);
        gl.uniform1f(gl.getUniformLocation(p, 'thicknessK'), this.config.viscosityThickness);
      }, this.wetBuffer.write);
      this.wetBuffer.swap();
    }

    this._renderPass(this.programs.divergence, (p) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.velocityBuffer.read.texture);
      gl.uniform1i(gl.getUniformLocation(p, 'uVelocity'), 0);
    }, this.divergenceTarget);

    this.pressureBuffer.clear();
    for (let i = 0; i < this.config.pressureSolveIterations; i++) {
      this._renderPass(this.programs.pressure, (p) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.pressureBuffer.read.texture);
        gl.uniform1i(gl.getUniformLocation(p, 'uPressure'), 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.divergenceTarget.texture);
        gl.uniform1i(gl.getUniformLocation(p, 'uDivergence'), 1);
      }, this.pressureBuffer.write);
      this.pressureBuffer.swap();
      this._applyBoundaryConditions(this.pressureBuffer, 1.0);
    }

    this._renderPass(this.programs.gradient, (p) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.pressureBuffer.read.texture);
      gl.uniform1i(gl.getUniformLocation(p, 'uPressure'), 0);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.velocityBuffer.read.texture);
      gl.uniform1i(gl.getUniformLocation(p, 'uVelocity'), 1);
    }, this.velocityBuffer.write);
    this.velocityBuffer.swap();
    this._applyBoundaryConditions(this.velocityBuffer, -1.0);
  }

  triggerGlobalFade() {
    if (this.isGlobalFadeActive) return;
    this.isGlobalFadeActive = true;
    this.globalFadeStartTime = performance.now();
  }

  initiateRevealSweep() {
    this.velocityBuffer.clear();
    this.wetBuffer.clear();
    this.dryBuffer.clear();
    this.pressureBuffer.clear();

    if (this.autoRevealTimeoutId) {
      clearTimeout(this.autoRevealTimeoutId);
      this.autoRevealTimeoutId = null;
    }

    this.isGlobalFadeActive = false;
    this.isRevealing = true;
    this.revealStartTime = performance.now();
    this.lastSweepPoint = { x: 0.14, y: 1.04 };
    this.accumulatedSweepDistance = 0;

    this.autoRevealTimeoutId = setTimeout(() => {
      this.triggerGlobalFade();
    }, this.AUTO_REVEAL_DELAY_MS);
  }

  _processRevealSweep(currentTime) {
    if (!this.isRevealing) return;

    const elapsed = currentTime - this.revealStartTime;
    const progress = Math.min(1.0, elapsed / this.REVEAL_DURATION_MS);

    const pathX = 0.14 + progress * 0.72;
    const pathY = 1.04 - progress * 1.10;
    const theta = progress * this.SWEEP_CYCLES * Math.PI;

    const amplitude = 0.30 * (0.72 + 0.28 * Math.sin(progress * Math.PI));
    const oscillation = -Math.cos(theta) * amplitude;

    const currentX = Math.max(0.14, Math.min(0.86, pathX + oscillation * 0.65));
    const currentY = pathY + oscillation * 0.52;

    const dx = currentX - this.lastSweepPoint.x;
    const dy = currentY - this.lastSweepPoint.y;
    const aspect = this.backCanvas.width / Math.max(1, this.backCanvas.height);
    const segmentDistance = Math.hypot(dx * aspect, dy);

    const STEP_DISTANCE = 0.0135;
    this.accumulatedSweepDistance += segmentDistance;

    if (this.accumulatedSweepDistance >= STEP_DISTANCE) {
      const steps = Math.min(6, Math.floor(this.accumulatedSweepDistance / STEP_DISTANCE));
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const subX = this.lastSweepPoint.x + dx * t;
        const subY = this.lastSweepPoint.y + dy * t;
        const subDx = dx / steps;
        const subDy = (dy / steps) - 0.005;

        const isoDx = subDx * aspect;
        const length = Math.hypot(isoDx, subDy) || 0.001;
        const normalX = (-subDy / length) / aspect;
        const normalY = isoDx / length;
        const span = 0.034;

        this.injectInkStroke(subX, subY, subDx * 4.5, subDy * 3.5, this.config.brushRadius, this.config.inkColor, false, 0.75);
        this.injectInkStroke(subX + normalX * span, subY + normalY * span, subDx * 3.8, subDy * 3.2, this.config.brushRadius * 0.88, this.config.inkColor, false, 0.62);
        this.injectInkStroke(subX - normalX * span, subY - normalY * span, subDx * 3.8, subDy * 3.2, this.config.brushRadius * 0.88, this.config.inkColor, false, 0.62);
      }
      this.accumulatedSweepDistance -= steps * STEP_DISTANCE;
    }

    this.lastSweepPoint = { x: currentX, y: currentY };

    if (progress >= 1.0) {
      this.isRevealing = false;
      if (!this.isGlobalFadeActive) {
        this.triggerGlobalFade();
      }
    }
  }

  _bindEvents() {
    this._handleResize = () => this.resizeCanvasViewport();
    window.addEventListener('resize', this._handleResize);

    if (this.config.enableScrollEvents) {
      this._handleScroll = () => {
        const currentScrollY = window.scrollY;
        const delta = Math.abs(currentScrollY - this.lastScrollY);
        this.lastScrollY = currentScrollY;

        if (delta <= 0) return;

        this.scrollDeltaAccumulator += delta;
        const SCROLL_THRESHOLD = 18;
        let iterations = 0;

        while (this.scrollDeltaAccumulator >= SCROLL_THRESHOLD && iterations < 4) {
          this.scrollDeltaAccumulator -= SCROLL_THRESHOLD;
          this.scrollStepIndex++;
          iterations++;

          const tX = currentScrollY * 0.0034 + this.scrollStepIndex * 0.048;
          const tY = currentScrollY * 0.0046 + this.scrollStepIndex * 0.041 + 1.1;

          const posX = 0.5 + 0.33 * (0.72 * Math.sin(tX) + 0.28 * Math.sin(tX * 2.31 + 1.2));
          const posY = 0.5 + 0.41 * (0.72 * Math.cos(tY) + 0.28 * Math.cos(tY * 1.77 + 2.4));

          const isSplatter = Math.random() < 0.30;
          const aspect = this.backCanvas.width / Math.max(1, this.backCanvas.height);

          if (isSplatter) {
            const jitterX = ((Math.random() - 0.5) * 0.03) / aspect;
            const jitterY = (Math.random() - 0.5) * 0.04;
            const splatX = Math.max(0.11, Math.min(0.89, posX + jitterX));
            const splatY = Math.max(0.08, Math.min(0.92, posY + jitterY));

            this.createInkSplatter(splatX, splatY, this.config.brushRadius, this.config.inkColor);
            this.lastScrollPoint = { x: splatX, y: splatY };
          } else {
            const clampedX = Math.max(0.11, Math.min(0.89, posX));
            const clampedY = Math.max(0.07, Math.min(0.93, posY));
            const dx = (clampedX - this.lastScrollPoint.x) * 0.65;
            const dy = (clampedY - this.lastScrollPoint.y) * 0.65;

            this.injectInkStroke(
              clampedX, clampedY,
              dx, dy,
              this.config.brushRadius * (1.15 + Math.random() * 0.45),
              this.config.inkColor, false, 0.75
            );
            this.lastScrollPoint = { x: clampedX, y: clampedY };
          }
        }

        if (iterations >= 4) {
          this.scrollDeltaAccumulator = Math.min(this.scrollDeltaAccumulator, SCROLL_THRESHOLD * 0.5);
        }
      };
      window.addEventListener('scroll', this._handleScroll, { passive: true });
    }

    if (this.config.enablePointerEvents) {
      const mapCoords = (e) => {
        const bounds = this.backCanvas.getBoundingClientRect();
        const touch = e.touches && e.touches.length > 0 ? e.touches[0] : null;
        const clientX = touch ? touch.clientX : e.clientX;
        const clientY = touch ? touch.clientY : e.clientY;
        return {
          uvX: (clientX - bounds.left) / bounds.width,
          uvY: 1.0 - ((clientY - bounds.top) / bounds.height)
        };
      };

      this._handlePointerDown = (e) => {
        this.isInteracting = true;
        const { uvX, uvY } = mapCoords(e);
        this.lastPointerState = { x: uvX, y: uvY, timestamp: performance.now() };
        this.injectInkStroke(uvX, uvY, 0.001, 0.001, this.config.brushRadius, this.config.inkColor, false, 0.85);
      };

      this._handlePointerMove = (e) => {
        if (!this.isInteracting) return;
        const { uvX, uvY } = mapCoords(e);
        const currentTime = performance.now();
        const dt = Math.max((currentTime - this.lastPointerState.timestamp) * 0.001, 0.001);

        const dx = uvX - this.lastPointerState.x;
        const dy = uvY - this.lastPointerState.y;
        const aspect = this.backCanvas.width / Math.max(1, this.backCanvas.height);
        const travelDistance = Math.hypot(dx * aspect, dy);

        if (travelDistance > 0.002) {
          const velocityX = (dx / dt) * 0.012;
          const velocityY = (dy / dt) * 0.012;
          const subSteps = Math.max(1, Math.min(4, Math.ceil(travelDistance / 0.018)));

          for (let i = 1; i <= subSteps; i++) {
            const t = i / subSteps;
            const interpX = this.lastPointerState.x + dx * t;
            const interpY = this.lastPointerState.y + dy * t;
            this.injectInkStroke(interpX, interpY, velocityX, velocityY, this.config.brushRadius, this.config.inkColor, false, Math.min(1.0, 0.5 + travelDistance * 12.0));
          }

          this.lastPointerState = { x: uvX, y: uvY, timestamp: currentTime };
        }
      };

      this._handlePointerUp = () => { this.isInteracting = false; };

      window.addEventListener('mousedown', this._handlePointerDown);
      window.addEventListener('mousemove', this._handlePointerMove);
      window.addEventListener('mouseup', this._handlePointerUp);
      window.addEventListener('touchstart', this._handlePointerDown, { passive: true });
      window.addEventListener('touchmove', this._handlePointerMove, { passive: true });
      window.addEventListener('touchend', this._handlePointerUp, { passive: true });
    }
  }

  resizeCanvasViewport() {
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
    const targetWidth = Math.round(window.innerWidth * pixelRatio);
    const targetHeight = Math.round(window.innerHeight * pixelRatio);

    [this.frontCanvas, this.backCanvas].forEach(canvas => {
      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
      }
    });

    const aspect = this.backCanvas.width / Math.max(1, this.backCanvas.height);
    const BASE_SIM_DIMENSION = 512;
    const sqrtAspect = Math.sqrt(aspect);
    const newWidth = Math.max(128, Math.round(BASE_SIM_DIMENSION * sqrtAspect));
    const newHeight = Math.max(128, Math.round(BASE_SIM_DIMENSION / sqrtAspect));

    if (newWidth !== this.simWidth || newHeight !== this.simHeight) {
      this.simWidth = newWidth;
      this.simHeight = newHeight;

      this.velocityBuffer.resize(this.simWidth, this.simHeight);
      this.wetBuffer.resize(this.simWidth, this.simHeight);
      this.dryBuffer.resize(this.simWidth, this.simHeight);
      this.pressureBuffer.resize(this.simWidth, this.simHeight);
      this._resizeRenderTarget(this.divergenceTarget, this.simWidth, this.simHeight);
      this._resizeRenderTarget(this.curlTarget, this.simWidth, this.simHeight);
    }
  }

  drawCompositePass() {
    const gl = this.gl;

    // 1. Render Mask Frame to Front 2D Overlay
    if (this.frontCanvas.style.display !== 'none') {
      gl.viewport(0, 0, this.backCanvas.width, this.backCanvas.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.useProgram(this.programs.compositeFront);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.wetBuffer.read.texture);
      gl.uniform1i(gl.getUniformLocation(this.programs.compositeFront, 'uWet'), 0);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.dryBuffer.read.texture);
      gl.uniform1i(gl.getUniformLocation(this.programs.compositeFront, 'uDry'), 1);

      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.paperTexture);
      gl.uniform1i(gl.getUniformLocation(this.programs.compositeFront, 'uPaper'), 2);

      gl.uniform2f(gl.getUniformLocation(this.programs.compositeFront, 'uResolution'), this.backCanvas.width, this.backCanvas.height);
      gl.uniform3f(gl.getUniformLocation(this.programs.compositeFront, 'uPaperColor'), this.config.paperColor.r, this.config.paperColor.g, this.config.paperColor.b);
      gl.uniform3f(gl.getUniformLocation(this.programs.compositeFront, 'uInkColor'), this.config.inkColor.r, this.config.inkColor.g, this.config.inkColor.b);

      gl.bindVertexArray(this.quadVao);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      this.ctxFront.clearRect(0, 0, this.frontCanvas.width, this.frontCanvas.height);
      this.ctxFront.drawImage(this.backCanvas, 0, 0);
    }

    // 2. Render Opaque Frame to Back Background Canvas
    gl.viewport(0, 0, this.backCanvas.width, this.backCanvas.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(this.programs.compositeBack);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.wetBuffer.read.texture);
    gl.uniform1i(gl.getUniformLocation(this.programs.compositeBack, 'uWet'), 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.dryBuffer.read.texture);
    gl.uniform1i(gl.getUniformLocation(this.programs.compositeBack, 'uDry'), 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.paperTexture);
    gl.uniform1i(gl.getUniformLocation(this.programs.compositeBack, 'uPaper'), 2);

    gl.uniform2f(gl.getUniformLocation(this.programs.compositeBack, 'uResolution'), this.backCanvas.width, this.backCanvas.height);
    gl.uniform3f(gl.getUniformLocation(this.programs.compositeBack, 'uPaperColor'), this.config.paperColor.r, this.config.paperColor.g, this.config.paperColor.b);
    gl.uniform3f(gl.getUniformLocation(this.programs.compositeBack, 'uInkColor'), this.config.inkColor.r, this.config.inkColor.g, this.config.inkColor.b);

    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  start() {
    this.resizeCanvasViewport();
    this.drawCompositePass();
    this.initiateRevealSweep();

    const loop = (currentTime) => {
      const elapsedSeconds = Math.max(0.0001, Math.min((currentTime - this.lastFrameTimestamp) * 0.001, 0.1));
      this.lastFrameTimestamp = currentTime;

      this._processRevealSweep(currentTime);

      if (this.isGlobalFadeActive) {
        const elapsedFade = currentTime - this.globalFadeStartTime;
        const progress = Math.min(1.0, elapsedFade / this.GLOBAL_FADE_DURATION_MS);

        this.frontCanvas.style.opacity = (1.0 - progress).toString();

        if (progress >= 1.0) {
          this.isGlobalFadeActive = false;
          this.frontCanvas.style.display = 'none';
        }
      }

      const MAX_PHYSICS_SUBSTEP = 0.01667;
      const substepCount = Math.max(1, Math.min(4, Math.ceil(elapsedSeconds / MAX_PHYSICS_SUBSTEP)));
      const subDt = elapsedSeconds / substepCount;

      for (let s = 0; s < substepCount; s++) {
        this._simulateFluid(subDt);
      }

      this.drawCompositePass();
      this.animationFrameId = requestAnimationFrame(loop);
    };

    this.animationFrameId = requestAnimationFrame(loop);
  }

  stop() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  destroy() {
    this.stop();
    window.removeEventListener('resize', this._handleResize);
    if (this.config.enableScrollEvents) window.removeEventListener('scroll', this._handleScroll);
    if (this.config.enablePointerEvents) {
      window.removeEventListener('mousedown', this._handlePointerDown);
      window.removeEventListener('mousemove', this._handlePointerMove);
      window.removeEventListener('mouseup', this._handlePointerUp);
      window.removeEventListener('touchstart', this._handlePointerDown);
      window.removeEventListener('touchmove', this._handlePointerMove);
      window.removeEventListener('touchend', this._handlePointerUp);
    }
  }
}