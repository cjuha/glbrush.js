/*
 * Copyright Olli Etuaho 2013.
 */

/**
 * A shader program generator. Inherited objects must generate 1 shader program
 * and implement uniforms(width, height), vertexSource(), and fragmentSource().
 * uniforms() must return an array of uniforms with name, type, shortType
 * (postfix to gl.uniform*), inVertex (whether it's used in vertex shader),
 * inFragment (whether it's used in fragment shader), defaultValue, arraySize
 * (how many items in the uniform array). fragmentSource() and vertexSource()
 * must return complete shader source strings.
 */
var ShaderGenerator = function() {
};

/**
 * Initialize the shader generator.
 */
ShaderGenerator.prototype.initShaderGenerator = function() {
    this.cachedGl = null;
    this.cachedProgram = null;
};

/**
 * Computes the types of uniforms used in the shader program.
 * @return {Object.<string, string>} Map from uniform name to uniform short type
 * to be used as postfix to gl.uniform* function call.
 */
ShaderGenerator.prototype.uniformTypes = function() {
    var us = this.uniforms();
    var result = {};
    for (var i = 0; i < us.length; ++i) {
        result[us[i].name] = us[i].shortType;
    }
    return result;
};

/**
 * @param {WebGLRenderingContext} gl The context to place the shader program in.
 * Note that this function only acts as an efficient cache for one gl context at
 * a time.
 * @return {ShaderProgram} Shader program for rasterizing circles.
 */
ShaderGenerator.prototype.programInstance = function(gl) {
    // TODO: Limitation: can only work with one context at a time
    if (this.cachedGl !== gl) {
        this.cachedProgram =
            new ShaderProgram(gl, this.fragmentSource(),
                              this.vertexSource(), this.uniformTypes());
        this.cachedGl = gl;
    }
    return this.cachedProgram;
};

/**
 * @param {number} width Width of the canvas in pixels. Used to determine the
 * initial values of uniforms.
 * @param {number} height Height of the canvas in pixels. Used to determine the
 * initial values of uniforms.
 * @return {Object.<string, *>} Map from uniform names to uniform values that
 * should be filled in and passed to the shader program to draw.
 */
ShaderGenerator.prototype.uniformParameters = function(width, height) {
    var us = this.uniforms(width, height);
    var parameters = {};
    for (var i = 0; i < us.length; ++i) {
        var u = us[i];
        if (u.shortType === '2fv' || u.shortType === '3fv' ||
            u.shortType === '4fv') {
            parameters[u.name] = new Float32Array(u.defaultValue);
        } else {
            parameters[u.name] = u.defaultValue;
        }
    }
    return parameters;
};


/**
 * Computes the uniform definition code for the fragment shader.
 * @return {Array<string>} Shader source code lines.
 */
ShaderGenerator.prototype.fragmentUniformSource = function() {
    var us = this.uniforms();
    var src = [];
    for (var i = 0; i < us.length; ++i) {
        if (us[i].inFragment) {
            var line = 'uniform ' + us[i].type + ' ' + us[i].name;
            if (us[i].arraySize !== undefined) {
                line += '[' + us[i].arraySize + ']';
            }
            line += ';';
            if (us[i].comment !== undefined) {
                line += ' // ' + us[i].comment;
            }
            src.push(line);
        }
    }
    return src;
};

/**
 * Computes the uniform definition code for the vertex shader.
 * @return {Array<string>} Shader source code lines.
 */
ShaderGenerator.prototype.vertexUniformSource = function() {
    var us = this.uniforms();
    var src = [];
    for (var i = 0; i < us.length; ++i) {
        if (us[i].inVertex) {
            var line = 'uniform ' + us[i].type + ' ' + us[i].name;
            if (us[i].arraySize !== undefined) {
                line += '[' + us[i].arraySize + ']';
            }
            line += ';';
            if (us[i].comment !== undefined) {
                line += ' // ' + us[i].comment;
            }
            src.push(line);
        }
    }
    return src;
};


/**
 * A shader program for blending together a bunch of monochrome circles.
 * @constructor
 * @param {GLRasterizerFormat} format Format of the rasterizer's backing.
 * Affects whether to blend with a UINT8 source texture or a floating point
 * framebuffer.
 * @param {boolean} soft Use soft brush.
 * @param {number} circles Amount of circles to draw in a single pass.
 * @param {boolean} dynamicCircles The amount of circles drawn in a single pass
 * can be set at run-time using an uniform.
 * @param {RasterizeShader.ParameterMode} parameterMode How are circle
 * parameters passed to the shader?
 * @param {boolean=} unroll Unroll the loop. By default unrolling happens if
 * parameterMode is parametersInUniforms.
 */
var RasterizeShader = function(format, soft, circles, dynamicCircles,
                               parameterMode, unroll) {
    if (unroll === undefined) {
        unroll = parameterMode !== RasterizeShader.ParameterMode.inTex;
    }
    if (circles + 2 > glUtils.maxVaryingVectors &&
        parameterMode !== RasterizeShader.ParameterMode.inTex) {
        console.log('Invalid RasterizeShader requested! Too many circles.');
        return;
    }
    this.doubleBuffered = (format === GLRasterizerFormat.redGreen);
    this.soft = soft;
    this.circles = circles;
    this.dynamicCircles = dynamicCircles;
    this.parameterMode = parameterMode;
    this.unroll = unroll;
    this.initShaderGenerator();
};

RasterizeShader.prototype = new ShaderGenerator();

/**
 * How to pass parameters to the shader.
 * @enum {number}
 */
RasterizeShader.ParameterMode = {
    inTex: 0,
    inUniforms: 1
};

/**
 * Computes the uniforms used in the shader program.
 * @param {number=} width Width of the canvas in pixels. Defaults to 1.
 * @param {number=} height Height of the canvas in pixels. Defaults to 1.
 * @return {Array.<Object>} An array of uniforms with name, type, shortType
 * (postfix to gl.uniform*), inVertex (whether it's used in vertex shader),
 * inFragment (whether it's used in fragment shader), defaultValue, arraySize
 * (how many items in the uniform array).
 */
RasterizeShader.prototype.uniforms = function(width, height) {
    var i;
    if (width === undefined || height === undefined) {
        width = 1.0;
        height = 1.0;
    }
    var us = [];
    if (this.doubleBuffered) {
        us.push({name: 'uSrcTex', type: 'sampler2D', shortType: 'tex2d',
                 inFragment: true, inVertex: false, defaultValue: null});
    }
    if (this.dynamicCircles) {
        var countInVertex =
            this.parameterMode === RasterizeShader.ParameterMode.inUniforms;
        us.push({name: 'uCircleCount', type: 'int', shortType: '1i',
                 inFragment: true, inVertex: countInVertex, defaultValue: 1});
    }
    if (this.parameterMode === RasterizeShader.ParameterMode.inTex) {
        us.push({name: 'uCircleParameters', type: 'sampler2D',
                 shortType: 'tex2d', inFragment: true, inVertex: false,
                 defaultValue: null});
    } else {
        if (this.unroll) {
            for (i = 0; i < this.circles; ++i) {
                us.push({name: 'uCircle' + i, type: 'vec3', shortType: '3fv',
                         inFragment: false, inVertex: true,
                         defaultValue: [0.0, 0.0, 1.0],
                         comment: 'in gl viewport space, radius in pixels'});
            }
        } else {
            var def = [];
            for (i = 0; i < this.circles; ++i) {
                def.push(0.0, 0.0, 1.0);
            }
            us.push({name: 'uCircle', type: 'vec3', arraySize: this.circles,
                     shortType: '3fv', inFragment: false, inVertex: true,
                     defaultValue: def,
                     comment: 'in gl viewport space, radius in pixels'});
        }
    }
    us.push({name: 'uFlowAlpha', type: 'float', shortType: '1f',
             inFragment: true, inVertex: false, defaultValue: 1.0});
    us.push({name: 'uPixelPitch', type: 'vec2', shortType: '2fv',
             inFragment: false, inVertex: true,
             defaultValue: [2.0 / width, 2.0 / height],
             comment: 'in gl viewport space'});
    return us;
};

/**
 * Computes the varying definition code for both vertex and fragment shader.
 * @return {Array<string>} Shader source code lines.
 */
RasterizeShader.prototype.varyingSource = function() {
    var src = [];
    if (this.doubleBuffered) {
        src.push('varying vec2 vSrcTexCoord;');
    }
    if (this.parameterMode === RasterizeShader.ParameterMode.inTex) {
        src.push('varying vec2 vPixelCoords; // in pixels');
    } else {
        if (this.unroll) {
            for (var i = 0; i < this.circles; ++i) {
                src.push('varying vec3 vCircle' + i + ';');
            }
        } else {
            src.push('varying vec3 vCircle[' + this.circles + '];');
        }
    }
    return src;
};

/**
 * Computes the minimum circle radius for rasterization purposes.
 * @return {number} Minimum circle radius.
 */
RasterizeShader.prototype.minRadius = function() {
    return this.soft ? 1.0 : 0.5;
};

/**
 * Generates fragment shader source that calculates alpha for a single circle.
 * @param {string} assignTo The variable name where the result is assigned.
 * @param {string} indent Prefix for each line, intended for indentation.
 * @return {Array<string>} Shader source code lines.
 */
RasterizeShader.prototype.fragmentAlphaSource = function(assignTo, indent) {
    // Generated shader assumes that:
    // 1. circleRadius contains the intended perceived radius of the circle.
    // 2. centerDist contains the fragment's distance from the circle center.
    var src = [];
    src.push(indent + 'float radius = max(circleRadius, ' +
             this.minRadius().toFixed(1) + ');');
    src.push(indent + 'float flowAlpha = (circleRadius < ' +
             this.minRadius().toFixed(1) +
             ') ? uFlowAlpha * circleRadius * circleRadius * ' +
             Math.pow(1.0 / this.minRadius(), 2).toFixed(1) + ': uFlowAlpha;');
    src.push(indent + 'float antialiasMult = ' +
             'clamp((radius + 1.0 - centerDist) * 0.5, 0.0, 1.0);');
    if (this.soft) {
        src.push(indent + assignTo + ' = max((1.0 - centerDist / radius) ' +
                 '* flowAlpha * antialiasMult, 0.0);');
    } else {
        src.push(indent + assignTo + ' = flowAlpha * antialiasMult;');
    }
    return src;
};

/**
 * Generates source for the inner loop of the fragment shader that blends a
 * circle with the "destAlpha" value from previous rounds.
 * @param {number} index Index of the circle.
 * @param {string=} arrayIndex Postfix for vCircle, so that it can be either an
 * array or just a bunch of separate varyings to work around bugs. Defaults to
 * array. Does not matter if circle parameters are taken from a texture.
 * @return {Array<string>} Shader source code lines.
 */
RasterizeShader.prototype.fragmentInnerLoopSource = function(index,
                                                             arrayIndex) {
    var src = [];
    if (this.dynamicCircles) {
        src.push('    if (' + index + ' < uCircleCount) {');
        // Note that this probably qualifies as non-uniform flow control. See
        // GLSL ES 1.0.17 spec Appendix A.6.
        // TODO: See if moving the texture2D call outside the if would help
        // performance or compatibility. It would be required by the spec if it
        // was mipmapped.
    } else {
        src.push('    {');
    }
    if (this.parameterMode === RasterizeShader.ParameterMode.inTex) {
        src.push('      vec4 parameterColor = texture2D(uCircleParameters,' +
                 'vec2((float(' + index + ') + 0.5) / ' + this.circles +
                 '.0, 0.5));');
        src.push('      vec2 center = parameterColor.xy;');
        src.push('      float circleRadius = parameterColor.z;');
        src.push('      float centerDist = length(center - vPixelCoords);');
    } else {
        if (arrayIndex === undefined) {
            arrayIndex = '[' + index + ']';
        }
        src.push('      float circleRadius = vCircle' + arrayIndex + '.z;');
        src.push('      float centerDist = length(vCircle' + arrayIndex +
                 '.xy);');
    }
    src.push.apply(src, this.fragmentAlphaSource('float circleAlpha',
                   '      '));
    src.push('      destAlpha = clamp(circleAlpha + (1.0 - circleAlpha) ' +
             '* destAlpha, 0.0, 1.0);');
    src.push('    }'); // if
    return src;
};

/**
 * @return {string} Fragment shader source.
 */
RasterizeShader.prototype.fragmentSource = function() {
    var src = ['precision highp float;'];
    src.push.apply(src, this.varyingSource());
    src.push.apply(src, this.fragmentUniformSource());
    src.push('void main(void) {');
    if (this.doubleBuffered) {
        src.push('  vec4 src = texture2D(uSrcTex, vSrcTexCoord);');
        src.push('  float srcAlpha = src.x + src.y / 256.0;');
    }
    src.push('  float destAlpha = 0.0;');
    if (this.unroll) {
        for (var i = 0; i < this.circles; ++i) {
            src.push.apply(src, this.fragmentInnerLoopSource(i, i));
        }
    } else {
        src.push('  for (int i = 0; i < ' + this.circles + '; ++i) {');
        src.push.apply(src, this.fragmentInnerLoopSource('i'));
        src.push('  }'); // for
    }
    if (this.doubleBuffered) {
        src.push('  float alpha = destAlpha + (1.0 - destAlpha) * srcAlpha;');
        src.push('  int bytes = int(alpha * 255.0 * 256.0);');
        src.push('  int highByte = bytes / 256;');
        src.push('  int lowByte = bytes - highByte * 256;');
        src.push('  gl_FragColor = vec4(float(highByte) / 255.0, ' +
                 'float(lowByte) / 255.0, 0.0, 1.0);');
    } else {
        src.push('  gl_FragColor = vec4(0.0, 0.0, 0.0, destAlpha);');
    }
    src.push('}'); // void main(void)
    return src.join('\n');
};

/**
 * @param {number} index Index of the circle.
 * @param {string} arrayIndex Postfix for vCircle and uCircle, so that they can
 * be either arrays or just a bunch of separate varyings/uniforms to work around
 * bugs. Defaults to arrays. Does not matter if circle parameters are taken from
 * a texture.
 * @return {Array<string>} Vertex shader inner loop lines.
 */
RasterizeShader.prototype.vertexInnerLoopSource = function(index, arrayIndex) {
    var src = [];
    if (this.parameterMode === RasterizeShader.ParameterMode.inUniforms) {
        if (arrayIndex === undefined) {
            arrayIndex = '[' + index + ']';
        }
        if (this.dynamicCircles) {
            src.push('  if (' + index + ' < uCircleCount) {');
        } else {
            src.push('  {');
        }
        src.push('    vec2 relPosition = (uCircle' + arrayIndex +
                 '.xy - aVertexPosition) / uPixelPitch;');
        src.push('    vCircle' + arrayIndex + ' = vec3(relPosition, uCircle' +
                 arrayIndex + '.z);');
        if (this.dynamicCircles) {
            src.push('  } else {');
            src.push('    vCircle' + arrayIndex + ' = vec3(0.0, 0.0, 0.0);');
        }
        src.push('  }');
    }
    return src;
};

/**
 * @return {string} Vertex shader source.
 */
RasterizeShader.prototype.vertexSource = function() {
    var src = ['precision highp float;']; // TODO: This probably isn't necessary
    src.push('attribute vec2 aVertexPosition; ' +
             '// expecting a vertex array with corners at ' +
             '-1 and 1 x and y coordinates');
    src.push.apply(src, this.varyingSource());
    src.push.apply(src, this.vertexUniformSource());
    src.push('void main(void) {');
    if (this.doubleBuffered) {
        src.push('  vSrcTexCoord = vec2((aVertexPosition.x + 1.0) * 0.5, ' +
                 '(aVertexPosition.y + 1.0) * 0.5);');
    }
    if (this.parameterMode === RasterizeShader.ParameterMode.inTex) {
        src.push('  vPixelCoords = vec2(aVertexPosition.x + 1.0, ' +
                 '1.0 - aVertexPosition.y) / uPixelPitch;');
    }
    if (this.vertexInnerLoopSource('').length > 0) {
        if (this.unroll) {
            for (var i = 0; i < this.circles; ++i) {
                src.push.apply(src, this.vertexInnerLoopSource(i, i));
            }
        } else {
            src.push('  for (int i = 0; i < ' + this.circles + '; ++i) {');
            src.push.apply(src, this.vertexInnerLoopSource('i'));
            src.push('  }'); // for
        }
    }
    src.push('  gl_Position = vec4(aVertexPosition, 0.0, 1.0);');
    src.push('}');
    return src.join('\n');
};
