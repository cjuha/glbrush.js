/*
 * Copyright Olli Etuaho 2012-2013.
 */

/**
 * @constructor
 * @param {number} id Picture's unique id number.
 * @param {Rect} boundsRect Picture bounds. x and y should always be zero.
 * @param {number} bitmapScale Scale for rasterizing the picture. Events that
 * are pushed to this picture get this scale applied to them.
 * @param {string=} mode Either 'webgl', 'no-texdata-webgl' or 'canvas'.
 * Defaults to 'webgl'.
 */
var Picture = function(id, boundsRect, bitmapScale, mode) {
    this.id = id;
    if (mode === undefined) {
        mode = 'webgl';
    }
    this.mode = mode;
    this.parsedVersion = null;

    this.animating = false;

    this.activeSid = 0;
    this.activeSessionEventId = 0;

    this.buffers = [];
    this.mergedBuffers = []; // Merged buffers. Events can still be undone from
    // these buffers.
    this.currentEventAttachment = -1;
    this.currentEvent = null;
    this.currentEventMode = PictureEvent.Mode.normal;
    this.currentEventColor = [255, 255, 255];

    this.boundsRect = boundsRect;
    this.bitmapScale = bitmapScale;
    var bitmapWidth = Math.floor(this.boundsRect.width() * this.bitmapScale);
    var bitmapHeight = Math.floor(this.boundsRect.height() * this.bitmapScale);
    this.bitmapRect = new Rect(0, bitmapWidth, 0, bitmapHeight);

    // Shouldn't use more GPU memory than this for buffers and rasterizers
    // combined. Just guessing for a good generic limit, since WebGL won't give
    // out an exact one. Assuming that 2D canvas elements count towards this.
    this.memoryBudget = 256 * 1024 * 1024;
    // Allocate space for the compositing buffer
    this.memoryUse = this.bitmapWidth() * this.bitmapHeight() * 4;

    this.container = null;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.bitmapWidth();
    this.canvas.height = this.bitmapHeight();

    if (this.usesWebGl()) {
        this.gl = Picture.initWebGL(this.canvas);
        if (this.gl === null || !this.setupGLState()) {
            this.mode = undefined;
            return;
        }
    } else if (this.mode === 'canvas') {
        this.ctx = this.canvas.getContext('2d');
        this.compositor = new CanvasCompositor(this.ctx);
        this.initRasterizers();
    } else {
        this.mode = undefined;
        return;
    }
};

/**
 * Set up state in an existing gl context.
 * @return {boolean} Whether buffer initialization succeeded.
 */
Picture.prototype.setupGLState = function() {
    this.glManager = glStateManager(this.gl);

    var useFloatRasterizer = (this.mode === 'webgl' ||
                              this.mode === 'no-texdata-webgl');
    if (useFloatRasterizer) {
        if (this.glManager.extensionTextureFloat === null) {
            return false;
        }
        if (this.mode === 'webgl') {
            this.glRasterizerConstructor = GLFloatTexDataRasterizer;
        } else {
            this.glRasterizerConstructor = GLFloatRasterizer;
        }
    } else {
        this.glRasterizerConstructor = GLDoubleBufferedRasterizer;
    }

    this.texBlitProgram = this.glManager.shaderProgram(blitShader.blitSrc,
                                                       blitShader.blitVertSrc,
                                                       {'uSrcTex': 'tex2d'});
    this.texBlitUniforms = {
        'uSrcTex': null
    };

    if (!this.initRasterizers()) {
        console.log('WebGL accelerated rasterizer did not pass sanity test ' +
                    '(mode ' + this.mode + '). Update your graphics drivers ' +
                    'or try switching browsers if possible.');
        return false;
    }

    this.compositor = new GLCompositor(this.glManager, this.gl,
                                       glUtils.maxTextureUnits);
    return true;
};

/**
 * Add a buffer to the top of the buffer stack.
 * @param {number} id Identifier for this buffer. Unique at the Picture level.
 * Should be an integer >= 0.
 * @param {Array.<number>} clearColor 4-component array with RGBA color that's
 * used to clear this buffer.
 * @param {boolean} hasAlpha Does the buffer have an alpha channel?
 */
Picture.prototype.addBuffer = function(id, clearColor, hasAlpha) {
    var addEvent = this.createBufferAddEvent(id, hasAlpha, clearColor);
    this.pushEvent(id, addEvent);
};

/**
 * Mark a buffer as removed from the stack. It won't be composited, but it can
 * still be changed.
 * @param {number} id Identifier for the removed buffer.
 */
Picture.prototype.removeBuffer = function(id) {
    var removeEvent = this.createBufferRemoveEvent(id);
    this.pushEvent(id, removeEvent);
};

/**
 * Move a buffer to the given index in the buffer stack. Current event stays
 * attached to the moved buffer, if it exists.
 * @param {number} movedId The id of the buffer to move.
 * @param {number} toIndex The index to move this buffer to. Must be an integer
 * between 0 and Picture.buffers.length - 1.
 */
Picture.prototype.moveBuffer = function(movedId, toIndex) {
    var moveEvent = this.createBufferMoveEvent(movedId, toIndex);
    this.pushEvent(movedId, moveEvent);
};

/**
 * Find a buffer with the given id from this picture.
 * @param {Array.<PictureBuffer>} buffers Array to search for the buffer.
 * @param {number} id Identifier of the buffer to find.
 * @return {number} Index of the buffer or -1 if not found.
 * @protected
 */
Picture.prototype.findBufferIndex = function(buffers, id) {
    for (var i = 0; i < buffers.length; ++i) {
        if (buffers[i].id === id) {
            return i;
        }
    }
    return -1;
};

/**
 * Find a buffer with the given id from this picture.
 * @param {number} id Identifier of the buffer to find.
 * @return {PictureBuffer} Buffer or null if not found.
 * @protected
 */
Picture.prototype.findBuffer = function(id) {
    var ind = this.findBufferIndex(this.buffers, id);
    if (ind !== -1) {
        return this.buffers[ind];
    }
    ind = this.findBufferIndex(this.mergedBuffers, id);
    if (ind !== -1) {
        return this.mergedBuffers[ind];
    }
    return null;
};

/**
 * Find the buffer that contains the given event.
 * @param {PictureEvent} event The event to look for.
 * @return {number} The buffer's id or -1 if not found.
 */
Picture.prototype.findBufferContainingEvent = function(event) {
    for (var i = 0; i < this.buffers.length; ++i) {
        if (this.buffers[i].eventIndexBySessionId(event.sid,
            event.sessionEventId) >= 0) {
            return this.buffers[i].id;
        }
    }
    return -1;
};

/**
 * @return {number} Id of the topmost composited buffer.
 */
Picture.prototype.topCompositedBufferId = function() {
    var i = this.buffers.length;
    while (i > 0) {
        --i;
        if (this.buffers[i].isComposited()) {
            return this.buffers[i].id;
        }
    }
    return -1;
};

/**
 * Update the current event compositing mode and color.
 * @protected
 */
Picture.prototype.updateCurrentEventMode = function() {
    if (this.currentEvent !== null && this.currentEventAttachment >= 0) {
        this.currentEventMode = this.currentEvent.mode;
        this.currentEventColor = this.currentEvent.color;
        var buffer = this.findBuffer(this.currentEventAttachment);
        // TODO: assert(buffer !== null)
        if (this.currentEventMode === PictureEvent.Mode.erase &&
            !buffer.hasAlpha) {
            this.currentEventMode = PictureEvent.Mode.normal;
            this.currentEventColor = buffer.events[0].clearColor;
        }
    }
};

/**
 * Attach the current event to the given buffer in the stack.
 * @param {number} attachment Which buffer id to attach the picture's current
 * event to. Can be set to -1 if no current event is needed.
 */
Picture.prototype.setCurrentEventAttachment = function(attachment) {
    this.currentEventAttachment = attachment;
    this.updateCurrentEventMode();
};

/**
 * Set one of this picture's buffers visible or invisible.
 * @param {number} bufferId The id of the buffer to adjust.
 * @param {boolean} visible Is the buffer visible?
 */
Picture.prototype.setBufferVisible = function(bufferId, visible) {
    this.findBuffer(bufferId).visible = visible;
};

/**
 * Set the opacity of one of this picture's buffers.
 * @param {number} bufferId The id of the buffer to adjust.
 * @param {number} opacity Opacity value to set, range from 0 to 1.
 */
Picture.prototype.setBufferOpacity = function(bufferId, opacity) {
    this.findBuffer(bufferId).events[0].opacity = opacity;
};

/**
 * Create a Picture object.
 * @param {number} id Picture's unique id number.
 * @param {number} width Picture width.
 * @param {number} height Picture height.
 * @param {number} bitmapScale Scale for rasterizing the picture. Events that
 * are pushed to this picture get this scale applied to them.
 * @param {Array.<string>} modesToTry Modes to try to initialize the picture.
 * Can contain either 'webgl', 'no-texdata-webgl', 'no-float-webgl' or 'canvas'.
 * Modes are tried in the order they are in the array.
 * @return {Picture} The created picture or null if one couldn't be created.
 */
Picture.create = function(id, width, height, bitmapScale, modesToTry) {
    var pictureBounds = new Rect(0, width, 0, height);
    var i = 0;
    var pic = null;
    while (i < modesToTry.length && pic === null) {
        var mode = modesToTry[i];
        if (glUtils.supportsTextureUnits(4) || mode === 'canvas') {
            pic = new Picture(id, pictureBounds, bitmapScale, mode);
            if (pic.mode === undefined) {
                pic = null;
            }
        }
        i++;
    }
    return pic;
};

/**
 * Create a picture object by parsing a serialization of it.
 * @param {number} id Unique identifier for the picture.
 * @param {string} serialization Serialization of the picture as generated by
 * Picture.prototype.serialize(). May optionally have metadata not handled by
 * the Picture object at the end, separated by line "metadata".
 * @param {number} bitmapScale Scale for rasterizing the picture. Events that
 * are pushed to this picture get this scale applied to them.
 * @param {Array.<string>} modesToTry Modes to try to initialize the picture.
 * Can contain either 'webgl', 'no-texdata-webgl', 'no-float-webgl' or 'canvas'.
 * Modes are tried in the order they are in the array.
 * @return {Object} Object containing key 'picture' for the created picture, key
 * 'metadata' for the metadata lines, and 'generationTime' for generation time
 * in milliseconds, or null if picture couldn't be created.
 */
Picture.parse = function(id, serialization, bitmapScale, modesToTry) {
    var startTime = new Date().getTime();
    var eventStrings = serialization.split(/\r?\n/);
    var pictureParams = eventStrings[0].split(' ');
    var version = 0;
    var width = 0;
    var height = 0;
    if (pictureParams[1] !== 'version') {
        width = parseInt(pictureParams[1]);
        height = parseInt(pictureParams[2]);
    } else {
        version = parseInt(pictureParams[2]);
        width = parseInt(pictureParams[3]);
        height = parseInt(pictureParams[4]);
    }
    var pic = Picture.create(id, width, height, bitmapScale, modesToTry);
    pic.parsedVersion = version;
    pic.moveBufferInternal = function() {}; // Move events can be processed out
    // of order here, so we don't apply them. Instead rely on buffers being
    // already in the correct order.
    // TODO: Maybe serialization and parsing would be simpler and more reliable
    // if events were serialized and parsed in the order they were applied?
    var i = 1;
    var currentId = -1;
    while (i < eventStrings.length) {
        if (eventStrings[i] === 'metadata') {
            break;
        } else {
            var arr = eventStrings[i].split(' ');
            var pictureEvent = PictureEvent.parse(arr, 0, version);
            pictureEvent.scale(bitmapScale);
            pic.pushEvent(currentId, pictureEvent);
            currentId = pic.buffers[pic.buffers.length - 1].id;
            ++i;
        }
    }
    var metadata = [];
    if (i < eventStrings.length && eventStrings[i] === 'metadata') {
        metadata = eventStrings.slice(i);
    }
    for (i = 0; i < pic.buffers.length; ++i) {
        pic.buffers[i].insertionPoint = pic.buffers[i].events[0].insertionPoint;
    }
    for (i = 0; i < pic.mergedBuffers.length; ++i) {
        pic.mergedBuffers[i].insertionPoint =
            pic.mergedBuffers[i].events[0].insertionPoint;
    }
    delete pic.moveBufferInternal; // switch back to prototype's move function
    var generationTime = new Date().getTime() - startTime;
    return {picture: pic, metadata: metadata, generationTime: generationTime};
};

/**
 * Create a resized copy of the given picture at the given scale.
 * @param {Picture} pic The picture to resize.
 * @param {number} bitmapScale The scale to set to the new picture. The new
 * picture's bitmap width will be the old picture's width() * bitmapScale.
 * @return {Picture} A new, resized picture.
 */
Picture.resize = function(pic, bitmapScale) {
    var serialization = pic.serialize();
    var pic2 = Picture.parse(pic.id, serialization, bitmapScale,
                             [pic.mode]).picture;
    pic2.setCurrentEventAttachment(pic.currentEventAttachment);
    return pic2;
};

/**
 * @return {number} The maximum scale to which this picture can be reliably
 * resized on the current configuration.
 */
Picture.prototype.maxBitmapScale = function() {
    // Note: if WebGL is unsupported, falls back to default (unconfirmed)
    // glUtils.maxFramebufferSize. This is a reasonable value for 2D canvas.
    return glUtils.maxFramebufferSize / Math.max(this.width(), this.height());
};

/** @const */
Picture.formatVersion = 1;

/**
 * @return {string} A serialization of this Picture. Can be parsed into a new
 * Picture by calling Picture.parse. Compatibility is guaranteed between at
 * least two subsequent versions.
 */
Picture.prototype.serialize = function() {
    var serializationScale = 1.0 / this.bitmapScale;
    var serialization = ['picture version ' + Picture.formatVersion + ' ' +
                         this.width() + ' ' + this.height()];
    var i;
    var buffer;
    for (i = 0; i < this.mergedBuffers.length; ++i) {
        buffer = this.mergedBuffers[i];
        buffer.events[0].insertionPoint = buffer.insertionPoint;
        for (var j = 0; j < buffer.events.length; ++j) {
            serialization.push(buffer.events[j].serialize(serializationScale));
        }
    }
    for (i = 0; i < this.buffers.length; ++i) {
        buffer = this.buffers[i];
        buffer.events[0].insertionPoint = buffer.insertionPoint;
        for (var j = 0; j < buffer.events.length; ++j) {
            serialization.push(buffer.events[j].serialize(serializationScale));
        }
    }
    return serialization.join('\n');
};

/**
 * @return {number} The total event count in all buffers, undone or not.
 */
Picture.prototype.getEventCount = function() {
    var count = 0;
    for (var i = 0; i < this.buffers.length; ++i) {
        count += this.buffers[i].events.length;
    }
    return count;
};

/**
 * Set the session with the given sid active for purposes of createBrushEvent,
 * createScatterEvent, createGradientEvent, createMergeEvent,
 * createBufferAddEvent, addBuffer, createBufferRemoveEvent,
 * createBufferMoveEvent, removeBuffer and undoLatest.
 * @param {number} sid The session id to activate. Must be a positive integer.
 */
Picture.prototype.setActiveSession = function(sid) {
    this.activeSid = sid;
    this.activeSessionEventId = 0;
    var latest = this.findLatest(sid, true);
    if (latest !== null) {
        this.activeSessionEventId = latest.sessionEventId + 1;
    }
};

/**
 * Create a brush event using the current active session. The event is marked as
 * not undone.
 * @param {Uint8Array|Array.<number>} color The RGB color of the stroke. Channel
 * values are between 0-255.
 * @param {number} flow Alpha value controlling blending individual brush
 * samples (circles) to each other in the rasterizer. Range 0 to 1. Normalized
 * to represent the resulting maximum alpha value in the rasterizer's bitmap in
 * case of a straight stroke and the maximum pressure.
 * @param {number} opacity Alpha value controlling blending the rasterizer
 * stroke to the target buffer. Range 0 to 1.
 * @param {number} radius The stroke radius in pixels.
 * @param {number} softness Value controlling the softness. Range 0 to 1.
 * @param {PictureEvent.Mode} mode Blending mode to use.
 * @return {BrushEvent} The created brush event.
 */
Picture.prototype.createBrushEvent = function(color, flow, opacity, radius,
                                              softness, mode) {
    var event = new BrushEvent(this.activeSid, this.activeSessionEventId, false,
                               color, flow, opacity, radius, softness, mode);
    this.activeSessionEventId++;
    return event;
};

/**
 * Create a scatter event using the current active session. The event is marked
 * as not undone.
 * @param {Uint8Array|Array.<number>} color The RGB color of the event. Channel
 * values are between 0-255.
 * @param {number} flow Alpha value controlling blending individual brush
 * samples (circles) to each other in the rasterizer. Range 0 to 1.
 * @param {number} opacity Alpha value controlling blending the rasterizer data
 * to the target buffer. Range 0 to 1.
 * @param {number} radius The circle radius in pixels.
 * @param {number} softness Value controlling the softness. Range 0 to 1.
 * @param {PictureEvent.Mode} mode Blending mode to use.
 * @return {BrushEvent} The created brush event.
 */
Picture.prototype.createScatterEvent = function(color, flow, opacity, radius,
                                                softness, mode) {
    var event = new ScatterEvent(this.activeSid, this.activeSessionEventId,
                                 false, color, flow, opacity, radius, softness,
                                 mode);
    this.activeSessionEventId++;
    return event;
};

/**
 * Create a gradient event using the current active session. The event is marked
 * as not undone.
 * @param {Uint8Array|Array.<number>} color The RGB color of the gradient.
 * Channel values are between 0-255.
 * @param {number} opacity Alpha value controlling blending the rasterized
 * gradient to the target buffer. Range 0 to 1.
 * @param {PictureEvent.Mode} mode Blending mode to use.
 * @return {GradientEvent} The created gradient event.
 */
Picture.prototype.createGradientEvent = function(color, opacity, mode) {
    var event = new GradientEvent(this.activeSid, this.activeSessionEventId,
                                  false, color, opacity, mode);
    this.activeSessionEventId++;
    return event;
};

/**
 * Create a buffer add event using the current active session. The event is
 * marked as not undone.
 * @param {number} id Id of the added buffer. Unique at the Picture level.
 * @param {boolean} hasAlpha Whether the buffer has an alpha channel.
 * @param {Uint8Array|Array.<number>} clearColor The RGB(A) color used to clear
 * the buffer. Channel values are integers between 0-255.
 * @return {BufferAddEvent} The created buffer adding event.
 */
Picture.prototype.createBufferAddEvent = function(id, hasAlpha, clearColor) {
    var createEvent = new BufferAddEvent(this.activeSid,
                                         this.activeSessionEventId, false, id,
                                         hasAlpha, clearColor, 1.0, 0);
    this.activeSessionEventId++;
    return createEvent;
};

/**
 * Create a buffer removal event using the current active session. The event is
 * marked as not undone.
 * @param {number} id Id of the removed buffer.
 * @return {BufferRemoveEvent} The created buffer adding event.
 */
Picture.prototype.createBufferRemoveEvent = function(id) {
    // TODO: assert(this.findBufferIndex(this.buffers, id) >= 0);
    var removeEvent = new BufferRemoveEvent(this.activeSid,
                                            this.activeSessionEventId, false,
                                            id);
    this.activeSessionEventId++;
    return removeEvent;
};

/**
 * Create a buffer move event using the current active session. The event is
 * marked as not undone.
 * @param {number} movedId Id of the moved buffer.
 * @param {number} toIndex Index to move the buffer to.
 * @return {BufferMoveEvent} The created buffer move event.
 */
Picture.prototype.createBufferMoveEvent = function(movedId, toIndex) {
    var fromIndex = this.findBufferIndex(this.buffers, movedId);
    // TODO: assert(fromIndex >= 0);
    var moveEvent = new BufferMoveEvent(this.activeSid,
                                        this.activeSessionEventId, false,
                                        movedId, fromIndex, toIndex);
    this.activeSessionEventId++;
    return moveEvent;
};

/**
 * Create a merge event merging a buffer to the one below.
 * @param {number} mergedBufferIndex The index of the top buffer that will be
 * merged. The buffer must not be already merged.
 * @param {number} opacity Alpha value controlling blending the top buffer.
 * Range 0 to 1.
 * @return {BufferMergeEvent} The created merge event.
 */
Picture.prototype.createMergeEvent = function(mergedBufferIndex, opacity) {
    // TODO: assert(mergedBufferIndex >= 0);
    var event = new BufferMergeEvent(this.activeSid, this.activeSessionEventId,
                                     false, opacity,
                                     this.buffers[mergedBufferIndex]);
    this.activeSessionEventId++;
    return event;
};

/**
 * Create an event that hides the specified event.
 * @param {number} hiddenSid The session identifier of the hidden event.
 * @param {number} hiddenSessionEventId Event/session specific identifier of the
 * hidden event.
 * @return {EventHideEvent} The created hide event.
 */
Picture.prototype.createEventHideEvent = function(hiddenSid,
                                                  hiddenSessionEventId) {
    var event = new EventHideEvent(this.activeSid, this.activeSessionEventId,
                                   false, hiddenSid, hiddenSessionEventId);
    this.activeSessionEventId++;
    return event;
};

/**
 * @param {HTMLCanvasElement} canvas Canvas to use for rasterization.
 * @return {WebGLRenderingContext} Context to use or null if unsuccessful.
 */
Picture.initWebGL = function(canvas) {
    var contextAttribs = {
        antialias: false,
        stencil: false,
        depth: false,
        premultipliedAlpha: true
    };
    var gl = glUtils.initGl(canvas, contextAttribs, 4);
    if (!gl) {
        return null;
    }

    gl.clearColor(1.0, 1.0, 1.0, 1.0);
    gl.disable(gl.DEPTH_TEST);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.BLEND);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, canvas.width, canvas.height);
    return gl;
};

/**
 * @return {boolean} Does the picture use WebGL?
 */
Picture.prototype.usesWebGl = function() {
    return (this.mode === 'webgl' || this.mode === 'no-float-webgl' ||
            this.mode === 'no-texdata-webgl');
};

/**
 * Set a containing widget for this picture. The container is expected to add
 * what's returned from pictureElement() under a displayed HTML element.
 * @param {Object} container The container.
 */
Picture.prototype.setContainer = function(container) {
    this.container = container;
};

/**
 * @return {HTMLCanvasElement} the element that displays the rasterized picture.
 */
Picture.prototype.pictureElement = function() {
    return this.canvas;
};

/**
 * Initialize rasterizers.
 * @return {boolean} True on success.
 * @protected
 */
Picture.prototype.initRasterizers = function() {
    this.currentEventRasterizer = this.createRasterizer();
    if (!this.currentEventRasterizer.checkSanity()) {
        this.currentEventRasterizer.free();
        return false;
    }
    this.genericRasterizer = this.createRasterizer();
    this.memoryUse += this.currentEventRasterizer.getMemoryBytes();
    this.memoryUse += this.genericRasterizer.getMemoryBytes();
    return true;
};

/**
 * @param {GLBuffer|CanvasBuffer} buffer The buffer to consider.
 * @return {number} The priority for selecting this buffer for reducing memory
 * budget. Higher priority means that the buffer's memory is more likely to be
 * reduced.
 */
Picture.prototype.bufferFreeingPriority = function(buffer) {
    var priority = buffer.undoStateBudget;
    if ((buffer.isRemoved() || buffer.mergedTo !== null) &&
        buffer.undoStateBudget > 1) {
        priority += buffer.undoStateBudget - 1.5;
    }
    priority -= buffer.undoStates.length * 0.1;
    // TODO: Spice this up with a LRU scheme?
    return priority;
};

/**
 * Attempt to stay within the given memory budget.
 * @param {number} requestedFreeBytes how much space to leave free.
 */
Picture.prototype.stayWithinMemoryBudget = function(requestedFreeBytes) {
    var available = this.memoryBudget - requestedFreeBytes;
    var needToFree = this.memoryUse - available;
    var freeingPossible = true;
    while (needToFree > 0 && freeingPossible) {
        freeingPossible = false;
        var selectedBuffer = null;
        var selectedPriority = 0;
        var i;
        for (i = 0; i < this.buffers.length; ++i) {
            if (this.buffers[i].undoStateBudget > 1 && !this.buffers[i].freed) {
                freeingPossible = true;
                var priority = this.bufferFreeingPriority(this.buffers[i]);
                if (priority > selectedPriority) {
                    selectedBuffer = this.buffers[i];
                    selectedPriority = priority;
                }
            }
        }
        for (i = 0; i < this.mergedBuffers.length; ++i) {
            if (this.mergedBuffers[i].undoStateBudget > 1 &&
                !this.buffers[i].freed) {
                freeingPossible = true;
                var priority =
                    this.bufferFreeingPriority(this.mergedBuffers[i]);
                if (priority > selectedPriority) {
                    selectedBuffer = this.mergedBuffers[i];
                    selectedPriority = priority;
                }
            }
        }
        if (selectedBuffer !== null) {
            var newBudget = selectedBuffer.undoStateBudget - 1;
            selectedBuffer.setUndoStateBudget(newBudget);
            this.memoryUse -= selectedBuffer.getStateMemoryBytes();
        }
        needToFree = this.memoryUse - available;
    }
    return;
};

/**
 * @return {number} The average undo state budget of buffers that are not
 * removed or merged.
 */
Picture.prototype.averageUndoStateBudgetOfActiveBuffers = function() {
    var n = 0;
    var sum = 0;
    for (var i = 0; i < this.buffers.length; ++i) {
        if (!this.buffers[i].isRemoved()) {
            sum += this.buffers[i].undoStateBudget;
            ++n;
        }
    }
    if (n > 0) {
        return sum / n;
    } else {
        return 5;
    }
};

/**
 * Free a buffer and do the related memory accounting. Can be called on a buffer
 * that is already freed, in which case the function has no effect.
 * @param {CanvasBuffer|GLBuffer} buffer Buffer to regenerate.
 * @protected
 */
Picture.prototype.freeBuffer = function(buffer) {
    if (!buffer.freed) {
        buffer.free();
        this.memoryUse -= buffer.getMemoryNeededForReservingStates();
    }
};

/**
 * Regenerate a buffer and do the related memory accounting. Can be called on a
 * buffer that is not freed, in which case the function has no effect.
 * @param {CanvasBuffer|GLBuffer} buffer Buffer to regenerate.
 * @protected
 */
Picture.prototype.regenerateBuffer = function(buffer) {
    if (buffer.freed) {
        var memIncrease = buffer.getMemoryNeededForReservingStates();
        this.stayWithinMemoryBudget(memIncrease);
        buffer.regenerate(true, this.genericRasterizer);
        this.memoryUse += memIncrease;
    }
};

/**
 * Create a single buffer using the mode specified for this picture.
 * @param {BufferAddEvent} createEvent Event that initializes the buffer.
 * @param {boolean} hasUndoStates Does the buffer store undo states?
 * @return {GLBuffer|CanvasBuffer} The buffer.
 * @protected
 */
Picture.prototype.createBuffer = function(createEvent, hasUndoStates) {
    var buffer;
    if (this.usesWebGl()) {
        buffer = new GLBuffer(this.gl, this.glManager, this.compositor,
                              this.texBlitProgram, createEvent,
                              this.bitmapWidth(), this.bitmapHeight(),
                              hasUndoStates);
    } else if (this.mode === 'canvas') {
        buffer = new CanvasBuffer(createEvent, this.bitmapWidth(),
                                  this.bitmapHeight(), hasUndoStates);
    }
    if (hasUndoStates) {
        if (buffer.events[0].undone) {
            var avgBudget = this.averageUndoStateBudgetOfActiveBuffers();
            buffer.setUndoStateBudget(avgBudget);
            return buffer;
        }
        // Buffers always store their current state
        this.memoryUse += buffer.getStateMemoryBytes();
        var avgBudget = this.averageUndoStateBudgetOfActiveBuffers();
        avgBudget = Math.floor(avgBudget);
        // Request free space for current average amount of undo states.
        this.stayWithinMemoryBudget(buffer.getStateMemoryBytes() * avgBudget);
        var spaceLeftStates = Math.floor((this.memoryBudget - this.memoryUse) /
                                         buffer.getStateMemoryBytes());
        if (spaceLeftStates < 0) {
            console.log('Running out of GPU memory, budget set at ' +
                        (this.memoryBudget / (1024 * 1024)) + ' MB');
            spaceLeftStates = 0;
        }
        if (spaceLeftStates > 5) {
            spaceLeftStates = 5; // More is a waste for a new buffer
        }
        buffer.setUndoStateBudget(spaceLeftStates);
        this.memoryUse += spaceLeftStates * buffer.getStateMemoryBytes();
        if (false) { // Debug logging
            console.log('Undo state budgets');
            for (var i = 0; i < this.buffers.length; ++i) {
                console.log(this.buffers[i].undoStateBudget);
            }
            console.log(buffer.undoStateBudget);
            console.log('GPU memory use ' +
                        (this.memoryUse / (1024 * 1024)) + ' MB');
        }
    }
    return buffer;
};

/**
 * Create a single rasterizer using the mode specified for this picture.
 * @param {boolean=} saveMemory Choose a rasterizer that uses the least possible
 * memory as opposed to one that has the best performance. Defaults to false.
 * @return {BaseRasterizer} The rasterizer.
 */
Picture.prototype.createRasterizer = function(saveMemory) {
    if (saveMemory === undefined) {
        saveMemory = false;
    }
    if (this.glRasterizerConstructor !== undefined) {
        if (saveMemory) {
            return new GLDoubleBufferedRasterizer(this.gl, this.glManager,
                                                  this.bitmapWidth(),
                                                  this.bitmapHeight());
        } else {
            return new this.glRasterizerConstructor(this.gl, this.glManager,
                                                    this.bitmapWidth(),
                                                    this.bitmapHeight());
        }
    } else {
        return new Rasterizer(this.bitmapWidth(), this.bitmapHeight());
    }
};

/**
 * @return {number} The rasterizer bitmap width of the picture in pixels.
 */
Picture.prototype.bitmapWidth = function() {
    return this.bitmapRect.width();
};

/**
 * @return {number} The rasterizer bitmap height of the picture in pixels.
 */
Picture.prototype.bitmapHeight = function() {
    return this.bitmapRect.height();
};

/**
 * @return {number} The width of the picture.
 */
Picture.prototype.width = function() {
    return this.boundsRect.width();
};

/**
 * @return {number} The height of the picture.
 */
Picture.prototype.height = function() {
    return this.boundsRect.height();
};

/**
 * Scale the parsed event according to this picture's bitmap scale. The event's
 * data is scaled, but it will still be serialized using the original
 * coordinates, within floating point accuracy.
 * @param {PictureEvent} event Event to scale.
 */
Picture.prototype.scaleParsedEvent = function(event) {
    event.scale(this.bitmapScale);
};

/**
 * Do memory management after adding/redoing a remove event to a buffer.
 * @param {PictureBuffer} buffer The buffer that the remove event was applied
 * to. The event is allowed to be undone, which can cause the buffer to be not
 * actually removed.
 * @protected
 */
Picture.prototype.afterRemove = function(buffer) {
    if (buffer.events.length < buffer.undoStateInterval * 2 &&
        buffer.isRemoved()) {
        // The buffer's bitmap isn't very costly to regenerate, so it
        // can be freed.
        this.freeBuffer(buffer);
    }
};

/**
 * Add an event to the top of one of this picture's buffers.
 * @param {number} targetBufferId The id of the buffer to apply the event to. In
 * case the event is a buffer add event, the id is ignored.
 * @param {PictureEvent} event Event to add.
 */
Picture.prototype.pushEvent = function(targetBufferId, event) {
    if (event.isBufferStackChange()) {
        if (event.eventType === 'bufferAdd') {
            var buffer = this.createBuffer(event, true);
            this.buffers.push(buffer);
            return;
        } else if (event.eventType === 'bufferRemove') {
            var bufferIndex = this.findBufferIndex(this.buffers,
                                                   event.bufferId);
            // TODO: assert(bufferIndex >= 0);
            this.buffers[bufferIndex].pushEvent(event, this.genericRasterizer);
            this.afterRemove(this.buffers[bufferIndex]);
            return;
        } else if (event.eventType === 'bufferMove') {
            var fromIndex = this.findBufferIndex(this.buffers, event.movedId);
            this.buffers[fromIndex].pushEvent(event);
            if (!event.undone) {
                this.moveBufferInternal(fromIndex, event.toIndex);
            }
            return;
        }
    }
    var targetBuffer = this.findBuffer(targetBufferId);
    if (this.currentEventRasterizer.drawEvent === event) {
        targetBuffer.pushEvent(event, this.currentEventRasterizer);
    } else {
        if (event.eventType === 'bufferMerge') {
            var mergedBufferIndex = this.findBufferIndex(this.buffers,
                                                         event.mergedBuffer.id);
            if (event.mergedBuffer.isDummy) {
                event.mergedBuffer = this.buffers[mergedBufferIndex];
            }
            // TODO: assert(event.mergedBuffer !== targetBuffer);
            targetBuffer.pushEvent(event, this.genericRasterizer);
            if (!event.undone) {
                this.buffers.splice(mergedBufferIndex, 1);
                this.mergedBuffers.push(event.mergedBuffer);
            }
        } else {
            targetBuffer.pushEvent(event, this.genericRasterizer);
        }
    }
};

/**
 * Add an event to the insertion point of one of this picture's buffers and
 * increment the insertion point. Note that performance is good only if the
 * insertion point is relatively close to the top of the buffer, and that the
 * event should maintain the rule that events with higher sessionEventIds from
 * the same session are closer to the top of the buffer than events with lower
 * sessionEventIds.
 * @param {number} targetBufferId The id of the buffer to insert the event to.
 * @param {PictureEvent} event Event to insert. Can not be a BufferAddEvent or
 * a BufferMoveEvent. TODO: Fix this for BufferMoveEvent.
 */
Picture.prototype.insertEvent = function(targetBufferId, event) {
    // TODO: assert(event.eventType !== 'bufferAdd' &&
    //              event.eventType !== 'bufferMove');
    if (event.eventType === 'bufferRemove') {
        var bufferIndex = this.findBufferIndex(this.buffers, event.bufferId);
        // TODO: assert(bufferIndex >= 0);
        this.buffers[bufferIndex].insertEvent(event, this.genericRasterizer);
        this.afterRemove(this.buffers[bufferIndex]);
        return;
    }
    var targetBuffer = this.findBuffer(targetBufferId);
    if (event.eventType === 'bufferMerge') {
        var mergedBufferIndex = this.findBufferIndex(this.buffers,
                                                     event.mergedBuffer.id);
        if (event.mergedBuffer.isDummy) {
            event.mergedBuffer = this.buffers[mergedBufferIndex];
        }
        // TODO: assert(event.mergedBuffer !== targetBuffer);
        targetBuffer.insertEvent(event, this.genericRasterizer);
        if (!event.undone) {
            this.buffers.splice(mergedBufferIndex, 1);
            this.mergedBuffers.push(event.mergedBuffer);
        }
    } else {
        targetBuffer.insertEvent(event, this.genericRasterizer);
    }
};

/**
 * Find the latest event from the given session.
 * @param {number} sid The session id to search.
 * @param {boolean} canBeUndone Whether to consider undone events.
 * @return {Object} The latest event indices or null if no event found. The
 * object will have keys eventIndex, bufferIndex, inRemovedBuffer and
 * sessionEventId.
 * @protected
 */
Picture.prototype.findLatest = function(sid, canBeUndone) {
    var latestIdx = 0;
    var latestBufferIndex = 0;
    var latestId = -1;
    var latestInRemovedBuffer = false;
    var i;
    for (i = 0; i < this.buffers.length; ++i) {
        var candidateIndex = this.buffers[i].findLatest(sid, canBeUndone);
        if (candidateIndex >= 0 &&
            this.buffers[i].events[candidateIndex].sessionEventId > latestId) {
            latestBufferIndex = i;
            latestIdx = candidateIndex;
            latestId = this.buffers[i].events[latestIdx].sessionEventId;
        }
    }
    for (i = 0; i < this.mergedBuffers.length; ++i) {
        var candidateIndex = this.mergedBuffers[i].findLatest(sid,
                                                              canBeUndone);
        if (candidateIndex >= 0 &&
            this.mergedBuffers[i].events[candidateIndex].sessionEventId >
            latestId) {
            latestBufferIndex = i;
            latestIdx = candidateIndex;
            latestId = this.mergedBuffers[i].events[latestIdx].sessionEventId;
            latestInRemovedBuffer = true;
        }
    }
    if (latestId >= 0) {
        return {eventIndex: latestIdx, bufferIndex: latestBufferIndex,
            sessionEventId: latestId, inRemovedBuffer: latestInRemovedBuffer};
    }
    return null;
};

/**
 * Move a buffer in the buffer stack.
 * @param {number} fromIndex Index to move the buffer from.
 * @param {number} toIndex Index to move the buffer to.
 * @protected
 */
Picture.prototype.moveBufferInternal = function(fromIndex, toIndex) {
    // TODO: assert(fromIndex < this.buffers.length);
    // TODO: assert(toIndex < this.buffers.length);
    var buffer = this.buffers[fromIndex];
    this.buffers.splice(fromIndex, 1);
    this.buffers.splice(toIndex, 0, buffer);
};

/**
 * Undo the latest non-undone event applied to this picture by the current
 * active session. Won't do anything in case the latest event is a merge event
 * applied to a buffer that is itself removed or merged.
 * @param {boolean} keepLastBuffer Don't undo the last remaining buffer.
 * Defaults to true.
 * @return {PictureEvent} The event that was undone or null if no event found.
 */
Picture.prototype.undoLatest = function(keepLastBuffer) {
    var latest = this.findLatest(this.activeSid, false);
    if (latest === null) {
        return null;
    }
    var buffer;
    if (latest.inRemovedBuffer) {
        buffer = this.mergedBuffers[latest.bufferIndex];
    } else {
        buffer = this.buffers[latest.bufferIndex];
        if (keepLastBuffer === undefined) {
            keepLastBuffer = true;
        }
        if (keepLastBuffer && latest.eventIndex === 0) {
            var buffersLeft = 0;
            for (var i = 0; i < this.buffers.length; ++i) {
                if (!this.buffers[i].isRemoved()) {
                    ++buffersLeft;
                }
            }
            if (buffersLeft === 1) {
                return null;
            }
        }
    }
    var undone = this.undoEventIndex(buffer, latest.eventIndex,
                                     latest.inRemovedBuffer);
    return undone;
};

/**
 * Undo the event specified by the given index from the given buffer. Will
 * handle events that change the buffer stack. All undo operations go through
 * here.
 * @param {PictureBuffer} buffer Buffer to undo from.
 * @param {number} eventIndex Index of the event in the buffer.
 * @param {boolean} isBufferMerged Is the buffer in mergedBuffers?
 * @return {PictureEvent} Undone event or null if couldn't undo.
 * @protected
 */
Picture.prototype.undoEventIndex = function(buffer, eventIndex,
                                            isBufferMerged) {
    // Disallowing undoing merge events from merged buffers. Must avoid head
    // exploding from complexity...
    var allowUndoMerge = !isBufferMerged;
    var undone = buffer.undoEventIndex(eventIndex, this.genericRasterizer,
                                       allowUndoMerge);
    if (undone) {
        if (eventIndex === 0) {
            // TODO: assert(undone.eventType === 'bufferAdd');
            this.freeBuffer(buffer);
        } else if (undone.eventType === 'bufferRemove') {
            if (!buffer.isRemoved()) { // Removed buffers can be freed
                this.regenerateBuffer(buffer);
            }
        } else if (undone.eventType === 'bufferMerge') {
            // TODO: assert(allowUndoMerge);
            var bufferIndex = this.findBufferIndex(this.buffers, buffer.id);
            this.buffers.splice(bufferIndex + 1, 0, undone.mergedBuffer);
            bufferIndex = this.findBufferIndex(this.mergedBuffers,
                                               undone.mergedBuffer.id);
            this.mergedBuffers.splice(bufferIndex, 1);
        } else if (undone.eventType === 'bufferMove' && !isBufferMerged) {
            // TODO: a better solution for undoing move events. This way works
            // for in-sequence undo but out-of-sequence undo will behave
            // unintuitively. Also, undoing moves for merged buffers is
            // simply ignored.
            var undoneIndex = this.findBufferIndex(this.buffers, buffer.id);
            var toIndex = Math.min(this.buffers.length - 1, undone.fromIndex);
            this.moveBufferInternal(undoneIndex, toIndex);
        }
    }
    return undone;
};

/**
 * Undo the specified event applied to this picture.
 * @param {number} sid The session id of the event.
 * @param {number} sessionEventId The session-specific event id of the event.
 * @return {PictureEvent} Undone event or null if couldn't undo.
 */
Picture.prototype.undoEventSessionId = function(sid, sessionEventId) {
    var undone = this.undoEventFromBuffers(this.buffers, sid, sessionEventId);
    if (undone !== null) {
        return undone;
    }
    return this.undoEventFromBuffers(this.mergedBuffers, sid, sessionEventId);
};

/**
 * Undo the specified event from the given buffer collection.
 * @param {Array.<PictureBuffer>} buffers Buffers to search from.
 * @param {number} sid The session id of the event.
 * @param {number} sessionEventId The session-specific event id of the event.
 * @return {PictureEvent} Undone event or null if couldn't undo.
 * @protected
 */
Picture.prototype.undoEventFromBuffers = function(buffers, sid,
                                                  sessionEventId) {
    var j = buffers.length;
    while (j >= 1) {
        --j;
        var i = buffers[j].eventIndexBySessionId(sid, sessionEventId);
        if (i >= 0) {
            if (!buffers[j].events[i].undone) {
                return this.undoEventIndex(buffers[j], i,
                                           buffers === this.mergedBuffers);
            }
            return buffers[j].events[i];
        }
    }
    return null;
};

/**
 * Redo the specified event applied to this picture by marking it not undone.
 * @param {number} sid The session id of the event.
 * @param {number} sessionEventId The session-specific event id of the event.
 * @return {boolean} True if the event was found.
 */
Picture.prototype.redoEventSessionId = function(sid, sessionEventId) {
    if (this.redoEventFromBuffers(this.buffers, sid, sessionEventId)) {
        return true;
    }
    return this.redoEventFromBuffers(this.mergedBuffers, sid, sessionEventId);
};

/**
 * Redo the specified event from the buffer collection by marking it not undone.
 * @param {Array.<PictureBuffer>} buffers Buffers to search from.
 * @param {number} sid The session id of the event.
 * @param {number} sessionEventId The session-specific event id of the event.
 * @return {boolean} True if the event was found from the given buffers.
 * @protected
 */
Picture.prototype.redoEventFromBuffers = function(buffers, sid,
                                                  sessionEventId) {
    var j = buffers.length;
    while (j >= 1) {
       --j;
        var i = buffers[j].eventIndexBySessionId(sid, sessionEventId);
        if (i >= 0) {
            var event = buffers[j].events[i];
            if (event.undone) {
                // TODO: Maybe this logic should be refactored so that it can be
                // shared with pushEvent
                if (event.eventType === 'bufferMerge') {
                    var mergedBufferIndex =
                        this.findBufferIndex(this.buffers,
                                             event.mergedBuffer.id);
                    // TODO: assert(mergedBufferIndex !== j);
                    // TODO: assert(!event.mergedBuffer.isDummy);
                    buffers[j].redoEventIndex(i, this.genericRasterizer);
                    this.buffers.splice(mergedBufferIndex, 1);
                    this.mergedBuffers.push(event.mergedBuffer);
                } else if (event.eventType === 'bufferRemove') {
                    buffers[j].redoEventIndex(i, this.genericRasterizer);
                    this.afterRemove(buffers[j]);
                } else {
                    if (i === 0) {
                        // TODO: assert(event.eventType === 'bufferAdd');
                        this.regenerateBuffer(buffers[j]);
                    }
                    buffers[j].redoEventIndex(i, this.genericRasterizer);
                }
            }
            return true;
        }
    }
    return false;
};

/**
 * Remove the specified event from this picture entirely.
 * @param {number} sid The session id of the event.
 * @param {number} sessionEventId The session-specific event id of the event.
 * @return {boolean} True on success.
 */
Picture.prototype.removeEventSessionId = function(sid, sessionEventId) {
    if (this.removeEventFromBuffers(this.buffers, sid, sessionEventId)) {
        return true;
    }
    return this.removeEventFromBuffers(this.mergedBuffers, sid,
                                       sessionEventId);
};

/**
 * Remove the specified event from this picture entirely.
 * @param {Array.<PictureBuffer>} buffers Buffers to search from.
 * @param {number} sid The session id of the event.
 * @param {number} sessionEventId The session-specific event id of the event.
 * @return {boolean} True on success.
 * @protected
 */
Picture.prototype.removeEventFromBuffers = function(buffers, sid,
                                                    sessionEventId) {
    var j = buffers.length;
    while (j >= 1) {
       --j;
        var i = buffers[j].eventIndexBySessionId(sid, sessionEventId);
        if (i >= 0) {
            var undone = true;
            if (!buffers[j].events[i].undone) {
                // Don't undo merge events from merged buffers
                undone = this.undoEventIndex(buffers[j], i,
                                             buffers === this.mergedBuffers);
            }
            if (undone) {
                buffers[j].removeEventIndex(i, this.genericRasterizer);
                return true;
            } else {
                return false; // The event was not undoable
            }
        }
    }
    return false;
};

/**
 * Update the currentEvent of this picture, meant to contain the event that the
 * user is currently drawing. The event is assumed to already be in the picture
 * bitmap coordinates in pixels, not in the picture coordinates.
 * @param {PictureEvent} cEvent The event the user is currently drawing or null.
 */
Picture.prototype.setCurrentEvent = function(cEvent) {
    this.currentEvent = cEvent;
    if (this.currentEvent) {
        this.currentEventRasterizer.resetClip();
        this.currentEvent.drawTo(this.currentEventRasterizer);
    }
    this.updateCurrentEventMode();
};

/**
 * Search for event from sourceBuffer, remove it from there if it is found, and
 * push it to targetBuffer.
 * @param {number} targetBufferId The id of the buffer to push the event to.
 * @param {number} sourceBufferId The id of the buffer to search the event
 * from.
 * @param {PictureEvent} event The event to transfer.
 */
Picture.prototype.moveEvent = function(targetBufferId, sourceBufferId, event) {
    var src = this.findBuffer(sourceBufferId);
    var eventIndex = src.eventIndexBySessionId(event.sid, event.sessionEventId);
    if (eventIndex >= 0) {
        src.removeEventIndex(eventIndex, this.genericRasterizer);
    }
    this.pushEvent(targetBufferId, event);
};

/**
 * Display the latest updated buffers of this picture. Call after doing changes
 * to any of the picture's buffers.
 */
Picture.prototype.display = function() {
    if (this.animating) {
        return;
    }
    if (this.usesWebGl()) {
        this.glManager.useFbo(null);
        this.gl.scissor(0, 0, this.bitmapWidth(), this.bitmapHeight());
    }
    for (var i = 0; i < this.buffers.length; ++i) {
        if (this.buffers[i].isComposited()) {
            this.compositor.pushBuffer(this.buffers[i]);
            if (this.currentEventAttachment === this.buffers[i].id) {
                if (this.currentEvent) {
                    this.compositor.pushRasterizer(this.currentEventRasterizer,
                                                   this.currentEventColor,
                                                   this.currentEvent.opacity,
                                                   this.currentEventMode,
                             this.currentEvent.getBoundingBox(this.bitmapRect));
                } else {
                    // Even if there's no this.currentEvent at the moment, push
                    // so that the GLCompositor can avoid extra shader changes.
                    this.compositor.pushRasterizer(this.currentEventRasterizer,
                                                   [0, 0, 0], 0,
                                                   this.currentEventMode,
                                                   null);
                }
            }
        }
    }
    this.compositor.flush();
};

/**
 * Play back an animation displaying the progress of this picture from start to
 * finish.
 * @param {number} simultaneousStrokes How many subsequent events to animate
 * simultaneously. Must be at least 1.
 * @param {number} speed Speed at which to animate the individual events. Must
 * be between 0 and 1.
 * @param {function()=} animationFinishedCallBack Function to call when the
 * animation has finished.
 * @return {boolean} Returns true if the animation was started or is still in
 * progress from an earlier call.
 */
Picture.prototype.animate = function(simultaneousStrokes, speed,
                                     animationFinishedCallBack) {
    if (this.animating) {
        return true;
    }
    var that = this;
    this.animating = true;
    if (this.buffers.length === 0) {
        setTimeout(function() {
            that.animating = false;
            if (animationFinishedCallBack !== undefined) {
                animationFinishedCallBack();
            }
        }, 0);
        return true;
    }
    if (speed === undefined) {
        speed = 0.05;
    }
    this.animationSpeed = speed;

    this.totalEvents = 0;
    this.animationBuffers = [];
    // TODO: Currently playback is from bottom to top and doesn't support merge
    // events. Switch to a timestamp-based approach.
    for (var i = 0; i < this.buffers.length; ++i) {
        if (!this.buffers[i].isRemoved()) {
            // Create event doesn't count
            this.totalEvents += this.buffers[i].events.length - 1;
            var createEvent = new BufferAddEvent(-1, -1, false, -1,
                                                 this.buffers[i].hasAlpha,
                                           this.buffers[i].events[0].clearColor,
                                             this.buffers[i].events[0].opacity);
            var buffer = this.createBuffer(createEvent, false);
            this.animationBuffers.push(buffer);
        }
    }

    simultaneousStrokes = Math.min(simultaneousStrokes, this.totalEvents);
    var j = -1;
    this.eventToAnimate = function(index) {
        for (var i = 0; i < that.buffers.length; ++i) {
            if (!this.buffers[i].isRemoved()) {
                if (index < that.buffers[i].events.length - 1) {
                    return {event: that.buffers[i].events[index + 1],
                            bufferIndex: i};
                } else {
                    index -= that.buffers[i].events.length - 1;
                }
            }
        }
        return null; // should not be reached
    };

    function getNextEventIndexToAnimate() {
        ++j;
        while (j < that.totalEvents && (that.eventToAnimate(j).event.undone ||
               !that.eventToAnimate(j).event.isRasterized() ||
               that.eventToAnimate(j).event.hideCount > 0)) {
            ++j;
        }
        var bufferIndex = 0;
        var eventToAnimate = that.eventToAnimate(j);
        if (eventToAnimate !== null) {
            bufferIndex = eventToAnimate.bufferIndex;
        }
        return {eventIndex: j, bufferIndex: bufferIndex};
    };

    this.animators = [];
    var Animator = function(animationPos) {
        this.rasterizer = that.createRasterizer(true);
        var indices = getNextEventIndexToAnimate();
        this.bufferIndex = indices.bufferIndex;
        this.eventIndex = indices.eventIndex;
        this.animationPos = animationPos;
    };

    for (var i = 0; i < simultaneousStrokes; ++i) {
        this.animators.push(new Animator(-i / simultaneousStrokes));
    }

    var animationFrame = function() {
        if (!that.animating) {
            return;
        }
        var finishedRasterizers = 0;
        for (var i = 0; i < simultaneousStrokes; ++i) {
            var eventIndex = that.animators[i].eventIndex;
            if (eventIndex < that.totalEvents) {
                that.animators[i].animationPos += that.animationSpeed;
                if (that.animators[i].animationPos > 0) {
                    var eventToAnimate = that.eventToAnimate(eventIndex);
                    var event = eventToAnimate.event;
                    if (that.animators[i].animationPos >= 1.0) {
                        event.drawTo(that.animators[i].rasterizer);
                        var buffer = that.animationBuffers[
                            that.animators[i].bufferIndex];
                        buffer.pushEvent(event, that.animators[i].rasterizer);
                        var indices = getNextEventIndexToAnimate();
                        that.animators[i].eventIndex = indices.eventIndex;
                        that.animators[i].bufferIndex = indices.bufferIndex;
                        that.animators[i].rasterizer.clear();
                        that.animators[i].rasterizer.resetClip();
                        that.animators[i].animationPos -= 1.0;
                    } else if (event.eventType === 'brush') {
                        var untilCoord = event.coords.length *
                                      that.animators[i].animationPos;
                        event.animationCoord = untilCoord;
                        untilCoord = Math.ceil(untilCoord / 3) * 3;
                        event.drawTo(that.animators[i].rasterizer,
                                     untilCoord);
                    }
                }
            } else {
                if (that.animators[i].rasterizer !== null) {
                    that.animators[i].rasterizer.free();
                    that.animators[i].rasterizer = null;
                }
                ++finishedRasterizers;
            }
        }
        if (finishedRasterizers !== simultaneousStrokes) {
            that.displayAnimation();
            requestAnimationFrame(animationFrame);
        } else {
            that.stopAnimating();
            if (animationFinishedCallBack !== undefined) {
                animationFinishedCallBack();
            }
        }
    };
    requestAnimationFrame(animationFrame);
    return true;
};

/**
 * Stop animating if animation is in progress.
 */
Picture.prototype.stopAnimating = function() {
    if (this.animating) {
        this.animating = false;
        var i;
        for (i = 0; i < this.animators.length; ++i) {
            if (this.animators[i].rasterizer !== null) {
                this.animators[i].rasterizer.free();
                this.animators[i].rasterizer = null;
            }
        }
        for (i = 0; i < this.animationBuffers.length; ++i) {
            this.animationBuffers[i].free();
        }
        this.animationBuffers = null;
        this.eventToAnimate = null;
        this.display();
    }
};

/**
 * Display the current animation frame on the canvas.
 * @protected
 */
Picture.prototype.displayAnimation = function() {
    if (this.usesWebGl()) {
        this.glManager.useFbo(null);
        this.gl.scissor(0, 0, this.bitmapWidth(), this.bitmapHeight());
    }
    var i, j;
    var rasterizerIndexOffset = 0;
    for (i = 0; i < this.animators.length; ++i) {
        if (this.animators[i].eventIndex <
            this.animators[rasterizerIndexOffset].eventIndex) {
            rasterizerIndexOffset = i;
        }
    }
    for (i = 0; i < this.animationBuffers.length; ++i) {
        this.compositor.pushBuffer(this.animationBuffers[i]);
        for (j = 0; j < this.animators.length; ++j) {
            // Start from the rasterizer that's first in the bottom-to-top order
            var ri = (j + rasterizerIndexOffset) % this.animators.length;
            if (this.animators[ri].eventIndex < this.totalEvents &&
                this.animators[ri].bufferIndex === i) {
                var event = this.eventToAnimate(
                                 this.animators[ri].eventIndex).event;
                this.compositor.pushRasterizer(this.animators[ri].rasterizer,
                                               event.color, event.opacity,
                                               event.mode,
                                         event.getBoundingBox(this.bitmapRect));
            }
        }
    }
    this.compositor.flush();
};

/**
 * Return objects that contain events touching the given pixel. The objects
 * have two keys: event, and alpha which determines that event's alpha value
 * affecting this pixel. The objects are sorted from newest to oldest.
 * @param {Vec2} coords Position of the pixel in bitmap coordinates.
 * @return {Array.<Object>} Objects that contain events touching this pixel.
 */
Picture.prototype.blamePixel = function(coords) {
    var blame = [];
    var j = this.buffers.length;
    while (j >= 1) {
        --j;
        if (this.buffers[j].events.length > 1 && !this.buffers[j].isRemoved()) {
            var bufferBlame = this.buffers[j].blamePixel(coords);
            if (bufferBlame.length > 0) {
                blame = blame.concat(bufferBlame);
            }
        }
    }
    return blame;
};

/**
 * Get a pixel from the composited picture. Displays the latest changes to the
 * picture as a side effect.
 * @param {Vec2} coords Position of the pixel in bitmap coordinates.
 * @return {Uint8Array|Uint8ClampedArray} Unpremultiplied RGBA value.
 */
Picture.prototype.getPixelRGBA = function(coords) {
    this.display();
    if (this.usesWebGl()) {
        var buffer = new ArrayBuffer(4);
        var pixelData = new Uint8Array(buffer);
        var glX = Math.min(Math.floor(coords.x), this.bitmapWidth() - 1);
        var glY = Math.max(0, this.bitmapHeight() - 1 - Math.floor(coords.y));
        this.gl.readPixels(glX, glY, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE,
                           pixelData);
        pixelData = colorUtil.unpremultiply(pixelData);
        return pixelData;
    } else {
        return this.ctx.getImageData(Math.floor(coords.x),
                                     Math.floor(coords.y), 1, 1).data;
    }
};

/**
 * Generate a data URL representing this picture. Displays the latest changes to
 * the picture as a side effect.
 * @return {string} PNG data URL representing this picture.
 */
Picture.prototype.toDataURL = function() {
    this.display();
    return this.canvas.toDataURL();
};
